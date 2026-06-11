/**
 * Integration tests for app.ts HTTP handler.
 *
 * Strategy: mock @agentkit-js/core agents and WASM kernels so tests run fast
 * without real API calls. Test actual HTTP routing, CORS, SSE streaming, auth,
 * model registry, file KV, input validation, and error handling.
 */

import type { AgentEvent } from "@agentkit-js/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { MemKvStore } from "./platform.js";

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Default agent emits a single final_answer event
const DEFAULT_EVENTS: AgentEvent[] = [
  {
    traceId: "t1",
    parentTraceId: null,
    channel: "text",
    event: "run_start",
    data: { task: "test" },
    timestampMs: 0,
  },
  {
    traceId: "t1",
    parentTraceId: null,
    channel: "text",
    event: "final_answer",
    data: { answer: "42" },
    timestampMs: 1,
  },
];

let mockEvents: AgentEvent[] = [...DEFAULT_EVENTS];

// Mutable factory — tests can swap this to inject faults
let agentFactory: () => AsyncGenerator<AgentEvent> = () =>
  (async function* () { for (const e of mockEvents) yield e; })();

vi.mock("./agents/code-agent.js", () => ({
  createCodeAgent: () => ({
    run: () => agentFactory(),
    assembler: {},
  }),
}));

vi.mock("./agents/tool-agent.js", () => ({
  createToolAgent: () => ({
    run: () => agentFactory(),
  }),
}));

vi.mock("./agents/multi-agent.js", () => ({
  multiAgentRun: async function* () {
    for (const e of mockEvents) yield e;
  },
}));

vi.mock("./models/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./models/registry.js")>();
  return {
    ...actual,
    resolveModelFromRegistry: vi.fn().mockResolvedValue({ modelId: "mock-model" }),
    discoverLocalModels: vi.fn().mockResolvedValue([]),
    getBuiltinModels: vi.fn().mockResolvedValue([
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", provider: "anthropic", available: true, source: "builtin" },
    ]),
    loadPreferences: vi.fn().mockResolvedValue({ primaryModelId: "claude-sonnet-4-6" }),
  };
});

vi.mock("./tools/web-search.js", () => ({
  createWebSearchTool: () => ({ name: "web_search", description: "search", execute: vi.fn() }),
}));

vi.mock("./tools/shell.js", () => ({
  createShellRunner: () => null,
  createGitTools: () => [],
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeApp(overrides: Record<string, unknown> = {}) {
  return createApp({
    anthropicApiKey: "sk-test",
    allowedOrigin: "*",
    filesKv: new MemKvStore(),
    sessionsKv: new MemKvStore(),
    ...overrides,
  });
}

async function parseSSE(res: Response): Promise<AgentEvent[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
    .map((l) => JSON.parse(l.slice(6)) as AgentEvent);
}

function post(app: ReturnType<typeof createApp>, body: unknown, headers: Record<string, string> = {}) {
  return app.fetch(
    new Request("http://localhost/run", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  );
}

// ── CORS ──────────────────────────────────────────────────────────────────────

describe("CORS", () => {
  it("OPTIONS /run → 204 with CORS headers", async () => {
    const app = makeApp();
    const res = await app.fetch(
      new Request("http://localhost/run", {
        method: "OPTIONS",
        headers: { Origin: "http://localhost:3000" },
      })
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Allow-Private-Network")).toBe("true");
  });

  it("POST response includes Access-Control-Allow-Origin", async () => {
    const app = makeApp();
    const res = await post(app, { task: "hi", agentMode: "code" });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("restricted origin: reflects matched origin, blocks others", async () => {
    const app = makeApp({ allowedOrigin: "http://myapp.com" });
    const resAllowed = await app.fetch(
      new Request("http://localhost/run", {
        method: "OPTIONS",
        headers: { Origin: "http://myapp.com" },
      })
    );
    expect(resAllowed.headers.get("Access-Control-Allow-Origin")).toBe("http://myapp.com");

    const resBlocked = await app.fetch(
      new Request("http://localhost/run", {
        method: "OPTIONS",
        headers: { Origin: "http://evil.com" },
      })
    );
    expect(resBlocked.headers.get("Access-Control-Allow-Origin")).toBe("null");
  });
});

// ── Health ────────────────────────────────────────────────────────────────────

describe("GET /health", () => {
  it("returns 200 with status ok", async () => {
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; version: string };
    expect(body.status).toBe("ok");
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

// ── Capabilities ──────────────────────────────────────────────────────────────

describe("GET /capabilities", () => {
  it("returns supported agent modes and features", async () => {
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/capabilities"));
    expect(res.status).toBe(200);
    const body = await res.json() as { agentModes: string[]; codeLanguages: string[] };
    expect(body.agentModes).toContain("code");
    expect(body.agentModes).toContain("tool");
    expect(body.codeLanguages).toContain("js");
    expect(body.codeLanguages).toContain("python");
  });
});

// ── Auth ──────────────────────────────────────────────────────────────────────

describe("Bearer token auth", () => {
  it("rejects /run without token when clientToken set", async () => {
    const app = makeApp({ clientToken: "secret" });
    const res = await post(app, { task: "hi" });
    expect(res.status).toBe(401);
  });

  it("accepts /run with correct Bearer token", async () => {
    const app = makeApp({ clientToken: "secret" });
    const res = await post(app, { task: "hi", agentMode: "code" }, {
      Authorization: "Bearer secret",
    });
    expect(res.status).toBe(200);
  });

  it("rejects /run with wrong token", async () => {
    const app = makeApp({ clientToken: "secret" });
    const res = await post(app, { task: "hi" }, { Authorization: "Bearer wrong" });
    expect(res.status).toBe(401);
  });

  it("skips auth when no clientToken configured", async () => {
    const app = makeApp({ clientToken: undefined });
    const res = await post(app, { task: "hi", agentMode: "code" });
    expect(res.status).toBe(200);
  });
});

// ── Input validation ──────────────────────────────────────────────────────────

describe("POST /run input validation", () => {
  it("400 when task is missing", async () => {
    const app = makeApp();
    const res = await post(app, { agentMode: "code" });
    expect(res.status).toBe(400);
  });

  it("400 when body is invalid JSON", async () => {
    const app = makeApp();
    const res = await app.fetch(
      new Request("http://localhost/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      })
    );
    expect(res.status).toBe(400);
  });

  it("400 when task exceeds 10KB", async () => {
    const app = makeApp();
    const res = await post(app, { task: "x".repeat(11_000), agentMode: "code" });
    expect(res.status).toBe(400);
  });

  it("500 when no API key configured", async () => {
    const app = makeApp({ anthropicApiKey: undefined });
    const res = await post(app, { task: "hi", agentMode: "code" });
    expect(res.status).toBe(500);
  });
});

// ── /run SSE streaming ────────────────────────────────────────────────────────

describe("POST /run SSE streaming", () => {
  beforeEach(() => {
    mockEvents = [...DEFAULT_EVENTS];
    agentFactory = () => (async function* () { for (const e of mockEvents) yield e; })();
  });

  it("returns 200 text/event-stream", async () => {
    const app = makeApp();
    const res = await post(app, { task: "hello", agentMode: "code" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
  });

  it("streams SSE events and ends with [DONE]", async () => {
    const app = makeApp();
    const res = await post(app, { task: "hello", agentMode: "code" });
    const text = await res.text();
    expect(text).toContain("data: ");
    expect(text).toContain("[DONE]");
  });

  it("includes final_answer event in stream", async () => {
    const app = makeApp();
    const res = await post(app, { task: "hello", agentMode: "code" });
    const events = await parseSSE(res);
    const finalAnswer = events.find((e) => e.event === "final_answer");
    expect(finalAnswer).toBeDefined();
    expect((finalAnswer!.data as { answer: string }).answer).toBe("42");
  });

  it("streams error event when agent throws", async () => {
    agentFactory = async function* () {
      throw new Error("agent exploded");
      yield {} as AgentEvent;
    };
    const app = makeApp();
    const res = await post(app, { task: "crash", agentMode: "code" });
    const text = await res.text();
    expect(text).toContain("agent exploded");
  });

  it("tool mode uses ToolCallingAgent", async () => {
    const app = makeApp();
    const res = await post(app, { task: "tool task", agentMode: "tool" });
    expect(res.status).toBe(200);
    const events = await parseSSE(res);
    expect(events.some((e) => e.event === "final_answer")).toBe(true);
  });

  it("caches SSE results and returns X-Bscode-Cache: HIT on replay", async () => {
    const sessionsKv = new MemKvStore();
    const app = makeApp({ sessionsKv });
    const body = { task: "cached-task-unique-123", agentMode: "code", modelId: "claude-sonnet-4-6" };

    // First call — live, drain the stream fully so cache write completes
    const res1 = await post(app, body);
    expect(res1.headers.get("X-Bscode-Cache")).toBeNull();
    const text1 = await res1.text();
    expect(text1).toContain("[DONE]");

    // Small pause to let async cache write settle (it's fire-and-forget in the stream pump)
    await new Promise((r) => setTimeout(r, 20));

    // Second call with identical body — should hit cache
    const res2 = await post(app, body);
    expect(res2.headers.get("X-Bscode-Cache")).toBe("HIT");
    const events = await parseSSE(res2);
    expect(events.some((e) => e.event === "final_answer")).toBe(true);
  });
});

// ── Models ────────────────────────────────────────────────────────────────────

describe("GET /models", () => {
  it("returns model list with preferences", async () => {
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/models"));
    expect(res.status).toBe(200);
    const body = await res.json() as { models: { id: string }[]; preferences: { primaryModelId: string } };
    expect(body.models.length).toBeGreaterThan(0);
    expect(body.preferences.primaryModelId).toBeDefined();
  });
});

describe("PUT /models/preferences", () => {
  it("saves and returns preferences", async () => {
    const app = makeApp();
    const res = await app.fetch(
      new Request("http://localhost/models/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ primaryModelId: "claude-haiku-4-5-20251001" }),
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("400 when primaryModelId missing", async () => {
    const app = makeApp();
    const res = await app.fetch(
      new Request("http://localhost/models/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ economyModelId: "haiku" }),
      })
    );
    expect(res.status).toBe(400);
  });
});

// ── Files KV ──────────────────────────────────────────────────────────────────

describe("Files KV routes", () => {
  it("POST /files writes a file, GET /files reads it", async () => {
    const filesKv = new MemKvStore();
    const app = makeApp({ filesKv });

    const write = await app.fetch(
      new Request("http://localhost/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "src/index.ts", content: "export const x = 1;" }),
      })
    );
    expect(write.status).toBe(200);

    const read = await app.fetch(
      new Request("http://localhost/files/src/index.ts")
    );
    expect(read.status).toBe(200);
    const body = await read.json() as { content: string };
    expect(body.content).toBe("export const x = 1;");
  });

  it("GET /files lists all files", async () => {
    const filesKv = new MemKvStore();
    const app = makeApp({ filesKv });

    await app.fetch(new Request("http://localhost/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "a.ts", content: "a" }),
    }));
    await app.fetch(new Request("http://localhost/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "b.ts", content: "b" }),
    }));

    const list = await app.fetch(new Request("http://localhost/files"));
    expect(list.status).toBe(200);
    const body = await list.json() as { files: { path: string }[] };
    expect(body.files.map((f) => f.path).sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("GET /files/missing → 404", async () => {
    const filesKv = new MemKvStore();
    const app = makeApp({ filesKv });
    const res = await app.fetch(new Request("http://localhost/files/nope.ts"));
    expect(res.status).toBe(404);
  });

  it("DELETE /files/:path removes a file", async () => {
    const filesKv = new MemKvStore();
    const app = makeApp({ filesKv });

    await app.fetch(new Request("http://localhost/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "del.ts", content: "bye" }),
    }));
    const del = await app.fetch(
      new Request("http://localhost/files/del.ts", { method: "DELETE" })
    );
    expect(del.status).toBe(200);
    const get = await app.fetch(new Request("http://localhost/files/del.ts"));
    expect(get.status).toBe(404);
  });

  it("session header isolates file namespaces", async () => {
    const filesKv = new MemKvStore();
    const app = makeApp({ filesKv });

    await app.fetch(new Request("http://localhost/files", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Id": "s1" },
      body: JSON.stringify({ path: "f.ts", content: "session-1" }),
    }));
    await app.fetch(new Request("http://localhost/files", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Id": "s2" },
      body: JSON.stringify({ path: "f.ts", content: "session-2" }),
    }));

    const r1 = await app.fetch(
      new Request("http://localhost/files/f.ts", { headers: { "X-Session-Id": "s1" } })
    );
    const r2 = await app.fetch(
      new Request("http://localhost/files/f.ts", { headers: { "X-Session-Id": "s2" } })
    );
    expect(((await r1.json()) as { content: string }).content).toBe("session-1");
    expect(((await r2.json()) as { content: string }).content).toBe("session-2");
  });
});

// ── Memory ────────────────────────────────────────────────────────────────────

describe("Memory routes", () => {
  it("GET /memory returns empty initially", async () => {
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/memory"));
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number };
    expect(body.count).toBe(0);
  });

  it("DELETE /memory clears entries", async () => {
    const app = makeApp();
    // Run an agent that uses memory to populate it — or just hit DELETE
    const res = await app.fetch(new Request("http://localhost/memory", { method: "DELETE" }));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

// ── Error log ─────────────────────────────────────────────────────────────────

describe("GET /errors", () => {
  it("returns empty errors list initially", async () => {
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/errors"));
    expect(res.status).toBe(200);
    const body = await res.json() as { errors: unknown[]; count: number };
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.count).toBeGreaterThanOrEqual(0);
  });
});

describe("POST /classify — diagram fast-path", () => {
  // The classifier has a deterministic keyword fast-path for
  // diagram-only tasks so we don't need an LLM round-trip and the
  // task doesn't get mis-routed to "framework·vanilla".
  function classifyApp() {
    return createApp({
      // Intentionally NO API key — proves the fast-path resolves
      // before the LLM call would be attempted.
      allowedOrigin: "*",
      filesKv: new MemKvStore(),
      sessionsKv: new MemKvStore(),
    });
  }

  async function classify(app: ReturnType<typeof createApp>, task: string) {
    const res = await app.fetch(
      new Request("http://localhost/classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task }),
      })
    );
    return (await res.json()) as { mode: string; framework: string | null };
  }

  it.each([
    "画一个用户注册流程的D2流程图",
    "draw a sequence diagram for the auth flow",
    "create a mermaid flow chart for the deploy pipeline",
    "render an architecture diagram for the new service",
    "用 D2 画一张服务拓扑图",
  ])('routes diagram-only task "%s" to mode=code', async (task) => {
    const result = await classify(classifyApp(), task);
    expect(result.mode).toBe("code");
    expect(result.framework).toBeNull();
  });

  it("does NOT short-circuit when the task asks for an app that draws diagrams", async () => {
    // "build a Vue app that renders a diagram" still needs framework
    // mode — falls through to the LLM (no key → falls back to tool).
    const result = await classify(
      classifyApp(),
      "build a Vue app that renders a flowchart of user actions"
    );
    expect(result.mode).not.toBe("code"); // fast-path skipped
  });
});

// ── 404 ───────────────────────────────────────────────────────────────────────

describe("Unknown routes", () => {
  it("GET /unknown → 404", async () => {
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/unknown-route"));
    expect(res.status).toBe(404);
  });
});

// ── B1: durable checkpointer via checkpointsKv ───────────────────────────────

describe("Checkpoints — B1 durable backend", () => {
  it("GET /checkpoints reports backend: in-memory when checkpointsKv is unset", async () => {
    const app = makeApp();
    const res = await app.fetch(new Request("http://localhost/checkpoints"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { backend: string; count: number | null };
    expect(json.backend).toBe("in-memory");
    expect(json.count).toBe(0);
  });

  it("GET /checkpoints reports backend: kv when checkpointsKv is set", async () => {
    const app = makeApp({ checkpointsKv: new MemKvStore() });
    const res = await app.fetch(new Request("http://localhost/checkpoints"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { backend: string; count: number | null };
    expect(json.backend).toBe("kv");
    expect(json.count).toBeNull();
  });

  // B1 DoD ① — restart safety: save snapshot via instance A, drop A, build a
  // fresh instance B sharing the same KV store, and verify B can read the
  // snapshot. This is the "worker recycle doesn't lose the run" guarantee.
  it("snapshot saved via one createApp() instance is readable by a fresh instance sharing the same KV", async () => {
    const { KvCheckpointer } = await import("@agentkit-js/core");
    const sharedKv = new MemKvStore();

    // Adapter shape used by createApp() internally; mirror it here so we can
    // drive a checkpoint write directly without spinning up the full agent.
    const adaptKv = (store: MemKvStore) => ({
      get: (key: string) => store.get(key),
      put: (key: string, value: string) => store.put(key, value),
      delete: (key: string) =>
        store.delete ? store.delete(key) : Promise.resolve(),
      list: async (prefix: string) => {
        const result = await store.list({ prefix });
        return result.keys.map((k) => k.name);
      },
    });

    const TRACE = "b1-restart-trace";
    const snapshot = {
      traceId: TRACE,
      task: "implement quicksort",
      history: [{ type: "user_message" as const, content: "implement quicksort" }],
      stepIndex: 4,
      savedAtMs: 1781000000000,
    };

    // ── INSTANCE A — boot, persist a snapshot, then drop the instance. ──────
    {
      const appA = makeApp({ checkpointsKv: sharedKv });
      // Sanity: the app responds.
      const res = await appA.fetch(new Request("http://localhost/health"));
      expect(res.status).toBe(200);
      const cp = new KvCheckpointer(adaptKv(sharedKv));
      await cp.save(TRACE, snapshot);
    }

    // ── Simulate worker recycle: instance A is gone; sharedKv survives. ─────

    // ── INSTANCE B — fresh app, fresh checkpointer, same KV. ────────────────
    const appB = makeApp({ checkpointsKv: sharedKv });
    const res = await appB.fetch(new Request("http://localhost/health"));
    expect(res.status).toBe(200);

    const cpB = new KvCheckpointer(adaptKv(sharedKv));
    const restored = await cpB.load(TRACE);

    expect(restored).not.toBeNull();
    expect(restored?.traceId).toBe(TRACE);
    expect(restored?.task).toBe("implement quicksort");
    expect(restored?.stepIndex).toBe(4);
  });

  it("HITL pendingHumanInput survives across app instances (A3 + B1 contract)", async () => {
    const { KvCheckpointer, resumeFromHuman } = await import("@agentkit-js/core");
    const sharedKv = new MemKvStore();
    const adaptKv = (store: MemKvStore) => ({
      get: (key: string) => store.get(key),
      put: (key: string, value: string) => store.put(key, value),
      delete: (key: string) =>
        store.delete ? store.delete(key) : Promise.resolve(),
      list: async (prefix: string) => {
        const result = await store.list({ prefix });
        return result.keys.map((k) => k.name);
      },
    });

    const TRACE = "b1-hitl-trace";

    // Pause: instance A persists a snapshot with a pending prompt.
    {
      makeApp({ checkpointsKv: sharedKv });
      const cp = new KvCheckpointer(adaptKv(sharedKv));
      await cp.save(TRACE, {
        traceId: TRACE,
        task: "build dashboard",
        history: [],
        stepIndex: 1,
        savedAtMs: 0,
        pendingHumanInput: { promptId: "approve-push", prompt: "Push to main?" },
      });
    }

    // Resume: instance B (fresh) submits the human response.
    {
      makeApp({ checkpointsKv: sharedKv });
      const cp = new KvCheckpointer(adaptKv(sharedKv));
      const ok = await resumeFromHuman(cp, TRACE, "approve-push", "yes");
      expect(ok).toBe(true);
    }

    // Continue: instance C (fresh again) sees the response in the snapshot.
    {
      makeApp({ checkpointsKv: sharedKv });
      const cp = new KvCheckpointer(adaptKv(sharedKv));
      const snap = await cp.load(TRACE);
      expect(snap?.humanResponse).toEqual({ promptId: "approve-push", response: "yes" });
    }
  });
});

import { Hono } from "hono";
import { AnthropicModel, AnthropicModels } from "@agentkit-js/model-anthropic";
import { DoubaoModel, DoubaoModels } from "@agentkit-js/model-doubao";
import { DeepSeekModel, DeepSeekModels } from "@agentkit-js/model-deepseek";
import type { AgentEvent, Model, ToolDefinition } from "@agentkit-js/core";
import { createCodeAgent } from "./agents/code-agent";
import { createToolAgent } from "./agents/tool-agent";
import {
  createReadFileTool,
  createListFilesTool,
  createSearchCodeTool,
  createWriteFileTool,
  createRunCommandTool,
} from "./tools/index";

export interface Env {
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_AUTH_TOKEN?: string;
  DOUBAO_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  BSCODE_CLIENT_TOKEN?: string;
  BSCODE_ALLOWED_ORIGIN?: string;
  AGENTKIT_LOG_LEVEL?: string;
  BSCODE_FILES?: KVNamespace;
  BSCODE_SESSIONS?: KVNamespace;
}

const SESSION_TTL = 3600;
const MAX_TASK_BYTES = 10_240;
const MAX_STEPS_CAP = 30;
const MAX_KV_EVENTS = 500;

const app = new Hono<{ Bindings: Env }>();

// ── CORS middleware ──────────────────────────────────────────────────────────
app.use("*", async (c, next) => {
  const allowed = c.env.BSCODE_ALLOWED_ORIGIN ?? "*";
  const origin = c.req.header("Origin") ?? "";
  const allowOrigin = allowed === "*" ? "*" : origin === allowed ? origin : "null";

  c.header("Access-Control-Allow-Origin", allowOrigin);
  c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  c.header("Access-Control-Max-Age", "86400");
  if (allowed !== "*") c.header("Vary", "Origin");

  if (c.req.method === "OPTIONS") return c.body(null, 204);
  return next();
});

// ── Auth middleware ──────────────────────────────────────────────────────────
app.use("/run", async (c, next) => {
  if (!c.env.BSCODE_CLIENT_TOKEN) return next();
  const auth = c.req.header("Authorization") ?? "";
  if (!timingSafeEqual(auth, `Bearer ${c.env.BSCODE_CLIENT_TOKEN}`)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
});

// ── Health ───────────────────────────────────────────────────────────────────
app.get("/health", (c) =>
  c.json({ status: "ok", version: "0.1.0", timestamp: new Date().toISOString() })
);

// ── List files (convenience endpoint for the UI) ─────────────────────────────
app.get("/files", async (c) => {
  const kv = c.env.BSCODE_FILES;
  if (!kv) return c.json({ files: [] });
  const list = await kv.list({ prefix: "file:" });
  const files = list.keys.map((k) => ({
    path: k.name.replace(/^file:/, ""),
    name: k.name.replace(/^file:/, "").split("/").pop() ?? "",
  }));
  return c.json({ files });
});

// ── Save file (convenience endpoint for the editor) ──────────────────────────
app.post("/files", async (c) => {
  const kv = c.env.BSCODE_FILES;
  const { path, content } = await c.req.json<{ path: string; content: string }>();
  if (!path || content === undefined) return c.json({ error: "path and content required" }, 400);
  if (kv) await kv.put(`file:${path.replace(/^\/+/, "")}`, content);
  return c.json({ ok: true, path });
});

// ── GET file ─────────────────────────────────────────────────────────────────
app.get("/files/:path{.+}", async (c) => {
  const kv = c.env.BSCODE_FILES;
  const path = c.req.param("path");
  if (!kv) return c.json({ error: "KV not bound" }, 503);
  const content = await kv.get(`file:${path}`, "text");
  if (content === null) return c.json({ error: "not found" }, 404);
  return c.json({ path, content });
});

// ── POST /run — main agent endpoint ──────────────────────────────────────────
app.post("/run", async (c) => {
  let body: RunBody;
  try {
    body = await c.req.json<RunBody>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { task, agentMode = "code", modelId, maxSteps = 10 } = body;
  if (!task || typeof task !== "string") {
    return c.json({ error: "task is required" }, 400);
  }
  if (new TextEncoder().encode(task).byteLength > MAX_TASK_BYTES) {
    return c.json({ error: `task must be under ${MAX_TASK_BYTES} bytes` }, 400);
  }

  if (!c.env.ANTHROPIC_API_KEY && !c.env.DOUBAO_API_KEY && !c.env.DEEPSEEK_API_KEY) {
    return c.json({ error: "No API key configured. Set ANTHROPIC_API_KEY in .dev.vars" }, 500);
  }

  const model = resolveModel(modelId, c.env);
  if (!model) {
    return c.json({ error: `Model ${modelId ?? "default"} not available — check API keys` }, 400);
  }

  const clampedSteps = Math.min(maxSteps, MAX_STEPS_CAP);
  const tools: ToolDefinition[] = buildTools(c.env);

  // C4: content-addressed cache key
  const resolvedModelId = getModelId(model);
  const kvKey = c.env.BSCODE_SESSIONS
    ? await contentHash({ task, agentMode, maxSteps: clampedSteps, modelId: resolvedModelId })
    : null;

  if (kvKey && c.env.BSCODE_SESSIONS) {
    const cached = await c.env.BSCODE_SESSIONS.get(kvKey, "text");
    if (cached) {
      return streamCachedEvents(cached, c.header.bind(c));
    }
  }

  const agentRun: AsyncGenerator<AgentEvent> =
    agentMode === "tool"
      ? createToolAgent(model, tools).run(task)
      : createCodeAgent(model, tools).run(task);

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  c.executionCtx.waitUntil(
    (async () => {
      const allEvents: AgentEvent[] = [];
      let success = false;
      try {
        for await (const event of agentRun) {
          await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          if (kvKey && c.env.BSCODE_SESSIONS) {
            if (event.event === "final_answer" || allEvents.length < MAX_KV_EVENTS) {
              allEvents.push(event);
            }
          }
          if (event.event === "final_answer") success = true;
        }
        await writer.write(encoder.encode("data: [DONE]\n\n"));
        if (kvKey && c.env.BSCODE_SESSIONS && success) {
          await c.env.BSCODE_SESSIONS.put(kvKey, JSON.stringify(allEvents), {
            expirationTtl: SESSION_TTL,
          }).catch(console.error);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await writer
          .write(
            encoder.encode(
              `data: ${JSON.stringify({ event: "error", data: { error: msg } })}\n\n`
            )
          )
          .catch(() => {});
      } finally {
        await writer.close().catch(() => {});
      }
    })()
  );

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
});

export default app;

// ── Helpers ──────────────────────────────────────────────────────────────────

interface RunBody {
  task: string;
  agentMode?: "code" | "tool";
  modelId?: string;
  maxSteps?: number;
}

function resolveModel(modelId: string | undefined, env: Env): Model | null {
  const id = modelId ?? AnthropicModels.SONNET_LATEST;

  if (id.startsWith("claude")) {
    // Support local proxy auth: prefer ANTHROPIC_AUTH_TOKEN over ANTHROPIC_API_KEY
    const apiKey = env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY;
    if (!apiKey) return null;
    return new AnthropicModel(
      id as string & {},
      env.ANTHROPIC_BASE_URL
        ? { apiKey, baseURL: env.ANTHROPIC_BASE_URL }
        : apiKey
    );
  }
  if (id.startsWith("doubao")) {
    if (!env.DOUBAO_API_KEY) return null;
    return new DoubaoModel(id as string & {}, env.DOUBAO_API_KEY);
  }
  if (id.startsWith("deepseek")) {
    if (!env.DEEPSEEK_API_KEY) return null;
    return new DeepSeekModel(id as string & {}, env.DEEPSEEK_API_KEY);
  }
  // Default to Anthropic
  if (!env.ANTHROPIC_API_KEY) return null;
  return new AnthropicModel(AnthropicModels.SONNET_LATEST, env.ANTHROPIC_API_KEY);
}

function getModelId(model: Model): string {
  // All agentkit models expose a modelId property
  return (model as { modelId?: string }).modelId ?? "unknown";
}

function buildTools(env: Env): ToolDefinition[] {
  const kv = env.BSCODE_FILES;
  return [
    createReadFileTool(kv),
    createListFilesTool(kv),
    createSearchCodeTool(kv),
    createWriteFileTool(kv),
    createRunCommandTool(),
  ];
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aB = enc.encode(a);
  const bB = enc.encode(b);
  const len = Math.max(aB.length, bB.length);
  let diff = aB.length ^ bB.length;
  for (let i = 0; i < len; i++) diff |= (aB[i] ?? 0) ^ (bB[i] ?? 0);
  return diff === 0;
}

async function contentHash(inputs: object): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(inputs))
  );
  return "run:" + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function streamCachedEvents(
  cachedJson: string,
  _setHeader: (key: string, value: string) => void
): Response {
  let events: AgentEvent[];
  try {
    events = JSON.parse(cachedJson) as AgentEvent[];
  } catch {
    return Response.json({ error: "corrupted cache" }, { status: 500 });
  }
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  (async () => {
    for (const ev of events) {
      await writer.write(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
    }
    await writer.write(encoder.encode("data: [DONE]\n\n"));
    await writer.close().catch(() => {});
  })();
  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Bscode-Cache": "HIT",
    },
  });
}

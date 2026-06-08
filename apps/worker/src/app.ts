import { Hono } from "hono";
import { AnthropicModel, AnthropicModels } from "@agentkit-js/model-anthropic";
import { DoubaoModel } from "@agentkit-js/model-doubao";
import { DeepSeekModel } from "@agentkit-js/model-deepseek";
import type { AgentEvent, Model, ToolDefinition } from "@agentkit-js/core";
import { createCodeAgent } from "./agents/code-agent.js";
import { createToolAgent } from "./agents/tool-agent.js";
import {
  createReadFileTool,
  createListFilesTool,
  createSearchCodeTool,
  createWriteFileTool,
  createRunCommandTool,
} from "./tools/index.js";
import { type AppConfig, type KvStore } from "./platform.js";

export { type AppConfig } from "./platform.js";

const SESSION_TTL = 3600;
const MAX_TASK_BYTES = 10_240;
const MAX_STEPS_CAP = 30;
const MAX_KV_EVENTS = 500;

// ── Core Hono application (platform-independent) ─────────────────────────────
export function createApp(config: AppConfig) {
  const app = new Hono();

  // ── CORS middleware ────────────────────────────────────────────────────────
  app.use("*", async (c, next) => {
    const allowed = config.allowedOrigin ?? "*";
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

  // ── Auth middleware ────────────────────────────────────────────────────────
  app.use("/run", async (c, next) => {
    if (!config.clientToken) return next();
    const auth = c.req.header("Authorization") ?? "";
    if (!timingSafeEqual(auth, `Bearer ${config.clientToken}`)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return next();
  });

  // ── Health ─────────────────────────────────────────────────────────────────
  app.get("/health", (c) =>
    c.json({ status: "ok", version: "0.1.0", timestamp: new Date().toISOString() })
  );

  // ── List files ─────────────────────────────────────────────────────────────
  app.get("/files", async (c) => {
    const kv = config.filesKv;
    if (!kv) return c.json({ files: [] });
    const list = await kv.list({ prefix: "file:" });
    const files = list.keys.map((k) => ({
      path: k.name.replace(/^file:/, ""),
      name: k.name.replace(/^file:/, "").split("/").pop() ?? "",
    }));
    return c.json({ files });
  });

  // ── Save file ──────────────────────────────────────────────────────────────
  app.post("/files", async (c) => {
    const kv = config.filesKv;
    const { path, content } = await c.req.json<{ path: string; content: string }>();
    if (!path || content === undefined) return c.json({ error: "path and content required" }, 400);
    if (kv) await kv.put(`file:${path.replace(/^\/+/, "")}`, content);
    return c.json({ ok: true, path });
  });

  // ── Get file ───────────────────────────────────────────────────────────────
  app.get("/files/:path{.+}", async (c) => {
    const kv = config.filesKv;
    const path = c.req.param("path");
    if (!kv) return c.json({ error: "KV not bound" }, 503);
    const content = await kv.get(`file:${path}`);
    if (content === null) return c.json({ error: "not found" }, 404);
    return c.json({ path, content });
  });

  // ── POST /run — main agent endpoint ───────────────────────────────────────
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

    if (!config.anthropicApiKey && !config.anthropicAuthToken && !config.doubaoApiKey && !config.deepseekApiKey) {
      return c.json({ error: "No API key configured" }, 500);
    }

    const model = resolveModel(modelId, config);
    if (!model) {
      return c.json({ error: `Model ${modelId ?? "default"} not available — check API keys` }, 400);
    }

    const clampedSteps = Math.min(maxSteps, MAX_STEPS_CAP);
    const tools: ToolDefinition[] = buildTools(config.filesKv);

    const resolvedModelId = getModelId(model);
    const sessionsKv = config.sessionsKv;
    const kvKey = sessionsKv
      ? await contentHash({ task, agentMode, maxSteps: clampedSteps, modelId: resolvedModelId })
      : null;

    if (kvKey && sessionsKv) {
      const cached = await sessionsKv.get(kvKey);
      if (cached) return streamCachedEvents(cached);
    }

    const agentRun: AsyncGenerator<AgentEvent> =
      agentMode === "tool"
        ? createToolAgent(model, tools).run(task)
        : createCodeAgent(model, tools).run(task);

    const stream = agentEventStream(agentRun, kvKey, sessionsKv);
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      },
    });
  });

  return app;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

interface RunBody {
  task: string;
  agentMode?: "code" | "tool";
  modelId?: string;
  maxSteps?: number;
}

function resolveModel(modelId: string | undefined, config: AppConfig): Model | null {
  const id = modelId ?? AnthropicModels.SONNET_LATEST;

  if (id.startsWith("claude")) {
    const apiKey = config.anthropicAuthToken ?? config.anthropicApiKey;
    if (!apiKey) return null;
    return new AnthropicModel(
      id as string & {},
      config.anthropicBaseUrl ? { apiKey, baseURL: config.anthropicBaseUrl } : apiKey
    );
  }
  if (id.startsWith("doubao")) {
    if (!config.doubaoApiKey) return null;
    return new DoubaoModel(id as string & {}, config.doubaoApiKey);
  }
  if (id.startsWith("deepseek")) {
    if (!config.deepseekApiKey) return null;
    return new DeepSeekModel(id as string & {}, config.deepseekApiKey);
  }
  const apiKey = config.anthropicAuthToken ?? config.anthropicApiKey;
  if (!apiKey) return null;
  return new AnthropicModel(
    AnthropicModels.SONNET_LATEST,
    config.anthropicBaseUrl ? { apiKey, baseURL: config.anthropicBaseUrl } : apiKey
  );
}

function getModelId(model: Model): string {
  return (model as { modelId?: string }).modelId ?? "unknown";
}

function buildTools(filesKv: KvStore | undefined): ToolDefinition[] {
  return [
    createReadFileTool(filesKv),
    createListFilesTool(filesKv),
    createSearchCodeTool(filesKv),
    createWriteFileTool(filesKv),
    createRunCommandTool(),
  ];
}

/** Creates a ReadableStream of SSE data from an agent run. */
function agentEventStream(
  run: AsyncGenerator<AgentEvent>,
  kvKey: string | null,
  sessionsKv: KvStore | undefined
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const allEvents: AgentEvent[] = [];
      let success = false;
      try {
        for await (const event of run) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          if (kvKey && sessionsKv) {
            if (event.event === "final_answer" || allEvents.length < MAX_KV_EVENTS) {
              allEvents.push(event);
            }
          }
          if (event.event === "final_answer") success = true;
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        if (kvKey && sessionsKv && success) {
          await sessionsKv.put(kvKey, JSON.stringify(allEvents), { expirationTtl: SESSION_TTL })
            .catch(console.error);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ event: "error", data: { error: msg } })}\n\n`)
        );
      } finally {
        controller.close();
      }
    },
  });
}

function streamCachedEvents(cachedJson: string): Response {
  let events: AgentEvent[];
  try {
    events = JSON.parse(cachedJson) as AgentEvent[];
  } catch {
    return Response.json({ error: "corrupted cache" }, { status: 500 });
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Bscode-Cache": "HIT",
    },
  });
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

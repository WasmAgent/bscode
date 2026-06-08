import type { AgentEvent, Model, ToolDefinition } from "@agentkit-js/core";
import {
  InMemoryCheckpointer,
  CheckpointableRun,
  createMemoryTool,
  MapKvBackend,
  forbiddenPhrases,
  maxInputLength,
  SelfConsistencyRunner,
  ReflectRefineRunner,
  BudgetForcingRunner,
} from "@agentkit-js/core";
import { AnthropicModel, AnthropicModels } from "@agentkit-js/model-anthropic";
import { DeepSeekModel } from "@agentkit-js/model-deepseek";
import { DoubaoModel } from "@agentkit-js/model-doubao";
import { Hono } from "hono";
import { createCodeAgent } from "./agents/code-agent.js";
import { createToolAgent } from "./agents/tool-agent.js";
import type { AppConfig, KvStore } from "./platform.js";
import {
  createListFilesTool,
  createReadFileTool,
  createRunCommandTool,
  createSearchCodeTool,
  createWriteFileTool,
} from "./tools/index.js";

export type { AppConfig } from "./platform.js";

const SESSION_TTL = 3600;
const MAX_TASK_BYTES = 10_240;
const MAX_STEPS_CAP = 30;
const MAX_KV_EVENTS = 500;

// In-process memory backend shared across requests (resets on server restart)
const globalMemoryBackend = new MapKvBackend();

// In-process checkpointer shared across requests
const globalCheckpointer = new InMemoryCheckpointer();

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

  // ── Capabilities info ─────────────────────────────────────────────────────
  app.get("/capabilities", (c) =>
    c.json({
      agentModes: ["code", "tool"],
      enhancements: ["self-consistency", "reflect-refine", "budget-forcing"],
      features: [
        "planning",
        "guardrails",
        "memory-tool",
        "checkpointing",
        "prompt-cache",
        "dag-scheduler",
        "stop-conditions",
      ],
      tools: ["read_file", "write_file", "list_files", "search_code", "run_command", "memory"],
    })
  );

  // ── Memory inspect endpoint ───────────────────────────────────────────────
  app.get("/memory", async (c) => {
    const keys = await globalMemoryBackend.list("mem:");
    const entries: Record<string, string> = {};
    for (const key of keys) {
      const val = await globalMemoryBackend.get(key);
      if (val !== null) entries[key.replace(/^mem:/, "")] = val;
    }
    return c.json({ entries, count: keys.length });
  });

  app.delete("/memory", async (c) => {
    const keys = await globalMemoryBackend.list("mem:");
    for (const key of keys) await globalMemoryBackend.delete(key);
    return c.json({ ok: true, cleared: keys.length });
  });

  // ── Checkpoint inspect endpoint ───────────────────────────────────────────
  app.get("/checkpoints", (c) => {
    return c.json({ count: globalCheckpointer.size });
  });

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

  app.post("/files", async (c) => {
    const kv = config.filesKv;
    const { path, content } = await c.req.json<{ path: string; content: string }>();
    if (!path || content === undefined) return c.json({ error: "path and content required" }, 400);
    if (kv) await kv.put(`file:${path.replace(/^\/+/, "")}`, content);
    return c.json({ ok: true, path });
  });

  app.get("/files/:path{.+}", async (c) => {
    const kv = config.filesKv;
    const path = c.req.param("path");
    if (!kv) return c.json({ error: "KV not bound" }, 503);
    const content = await kv.get(`file:${path}`);
    if (content === null) return c.json({ error: "not found" }, 404);
    return c.json({ path, content });
  });

  // ── POST /run — main agent endpoint ──────────────────────────────────────
  app.post("/run", async (c) => {
    let body: RunBody;
    try {
      body = await c.req.json<RunBody>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const {
      task,
      agentMode = "code",
      modelId,
      maxSteps = 10,
      // Enhancement runner
      enhancement,
      // Advanced agent options
      planningInterval,
      // Guardrail options
      guardrails,
      // Feature flags
      useMemory = false,
      useCheckpoint = false,
      checkpointId,
    } = body;

    if (!task || typeof task !== "string") return c.json({ error: "task is required" }, 400);
    if (new TextEncoder().encode(task).byteLength > MAX_TASK_BYTES)
      return c.json({ error: `task must be under ${MAX_TASK_BYTES} bytes` }, 400);

    if (!config.anthropicApiKey && !config.anthropicAuthToken && !config.doubaoApiKey && !config.deepseekApiKey)
      return c.json({ error: "No API key configured" }, 500);

    const model = resolveModel(modelId, config);
    if (!model) return c.json({ error: `Model ${modelId ?? "default"} not available` }, 400);

    const clampedSteps = Math.min(maxSteps, MAX_STEPS_CAP);

    // Build tools — optionally add memory tool
    const tools: ToolDefinition[] = buildTools(config.filesKv, useMemory);

    // Build guardrails
    const inputGuardrails = buildInputGuardrails(guardrails);
    const outputGuardrails = buildOutputGuardrails(guardrails);

    // Build agent (only needed for non-enhancement runs)
    const agent =
      agentMode === "tool"
        ? createToolAgent(model, tools, {
            maxSteps: clampedSteps,
            planningInterval,
            inputGuardrails,
            outputGuardrails,
          })
        : createCodeAgent(model, tools, {
            maxSteps: clampedSteps,
            planningInterval,
            inputGuardrails,
            outputGuardrails,
          });

    // Resolve agent run generator (enhancement runners work at model level)
    let agentRun: AsyncGenerator<AgentEvent>;

    if (enhancement === "self-consistency") {
      const runner = new SelfConsistencyRunner({ n: 3, earlyStopThreshold: 0.67 });
      agentRun = enhancedAgentRun(model, runner, task);
    } else if (enhancement === "reflect-refine") {
      const runner = new ReflectRefineRunner({ maxCycles: 2 });
      agentRun = enhancedAgentRun(model, runner, task);
    } else if (enhancement === "budget-forcing") {
      const runner = new BudgetForcingRunner({ maxBudgetTokens: 2000 });
      agentRun = enhancedAgentRun(model, runner, task);
    } else if (useCheckpoint) {
      const cpId = checkpointId ?? task.slice(0, 40);
      const cpRun = new CheckpointableRun(
        { checkpointer: globalCheckpointer },
        agent.assembler
      );
      const cpTraceId = `cp-${cpId}-${Date.now()}`;
      agentRun = cpRun.run(agent.run(task, cpTraceId), task, cpTraceId);
    } else {
      agentRun = agent.run(task);
    }

    // Prompt-cache session key
    const resolvedModelId = getModelId(model);
    const sessionsKv = config.sessionsKv;
    const kvKey = sessionsKv
      ? await contentHash({ task, agentMode, maxSteps: clampedSteps, modelId: resolvedModelId, enhancement })
      : null;

    if (kvKey && sessionsKv) {
      const cached = await sessionsKv.get(kvKey);
      if (cached) return streamCachedEvents(cached);
    }

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
  // Enhancement runner: "self-consistency" | "reflect-refine" | "budget-forcing"
  enhancement?: string;
  // Emit a planning step every N action steps
  planningInterval?: number;
  // Guardrail config
  guardrails?: {
    maxInputChars?: number;
    forbiddenOutputPhrases?: string[];
    deniedTools?: string[];
  };
  // Enable persistent memory tool
  useMemory?: boolean;
  // Enable checkpointing
  useCheckpoint?: boolean;
  checkpointId?: string;
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

function buildTools(filesKv: KvStore | undefined, useMemory: boolean): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    createReadFileTool(filesKv),
    createListFilesTool(filesKv),
    createSearchCodeTool(filesKv),
    createWriteFileTool(filesKv),
    createRunCommandTool(),
  ];
  if (useMemory) {
    const memTool = createMemoryTool({
      backend: globalMemoryBackend,
      description: "Read and write persistent memory across conversations",
    });
    // Override schema: Anthropic requires explicit type:object on each discriminated union variant
    tools.push({
      ...memTool,
      rawInputJsonSchema: {
        type: "object",
        description: "Perform memory operations: read, write, list, or delete",
        properties: {
          op: {
            type: "string",
            enum: ["read", "write", "list", "delete"],
            description: "Operation to perform",
          },
          key: { type: "string", description: "Key to read, write, or delete" },
          value: { type: "string", description: "Value to write (for op=write)" },
          prefix: { type: "string", description: "Key prefix filter (for op=list)" },
        },
        required: ["op"],
      },
    });
  }
  return tools;
}

function buildInputGuardrails(guardrails?: RunBody["guardrails"]) {
  if (!guardrails) return [];
  const guards = [];
  if (guardrails.maxInputChars) guards.push(maxInputLength(guardrails.maxInputChars));
  return guards;
}

function buildOutputGuardrails(guardrails?: RunBody["guardrails"]) {
  if (!guardrails) return [];
  const guards = [];
  if (guardrails.forbiddenOutputPhrases?.length) {
    guards.push(forbiddenPhrases(guardrails.forbiddenOutputPhrases));
  }
  return guards;
}

/** Wraps enhancement runner result into a fake AgentEvent stream for SSE. */
async function* enhancedAgentRun(
  model: Model,
  runner: SelfConsistencyRunner | ReflectRefineRunner | BudgetForcingRunner,
  task: string
): AsyncGenerator<AgentEvent> {
  const traceId = `enhanced-${Date.now()}`;
  const base = { traceId, parentTraceId: null, timestampMs: Date.now() };
  const messages: import("@agentkit-js/core").ModelMessage[] = [
    { role: "user", content: task },
  ];

  yield { ...base, channel: "text", event: "run_start", data: { task } } as AgentEvent;
  yield { ...base, channel: "thinking", event: "step_start", data: { step: 1 } } as AgentEvent;

  try {
    // Run the enhancement with periodic heartbeat thinking_deltas to prevent stream timeout
    const runnerPromise = runner.run(model, messages, { stream: true });
    const heartbeat = setInterval(() => {
      // can't yield inside setInterval, so we just log
    }, 5_000);

    const result = await runnerPromise;
    clearInterval(heartbeat);

    const runnerName = runner.constructor.name;
    const meta =
      "votes" in result
        ? `votes=${result.votes}/${result.totalCandidates}`
        : "cyclesUsed" in result
          ? `cyclesUsed=${result.cyclesUsed}`
          : "waitRoundsUsed" in result
            ? `waitRoundsUsed=${result.waitRoundsUsed}`
            : "";
    yield {
      ...base,
      channel: "thinking",
      event: "thinking_delta",
      data: { delta: `[${runnerName}] ${meta}`, step: 1 },
    } as AgentEvent;
    yield {
      ...base,
      channel: "text",
      event: "final_answer",
      data: { answer: result.answer },
    } as AgentEvent;
  } catch (err) {
    yield {
      ...base,
      channel: "text",
      event: "error",
      data: { error: err instanceof Error ? err.message : String(err) },
    } as AgentEvent;
  }
}

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
          await sessionsKv
            .put(kvKey, JSON.stringify(allEvents), { expirationTtl: SESSION_TTL })
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

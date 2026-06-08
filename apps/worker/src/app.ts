import type { AgentEvent, Model, ModelMessage, ToolDefinition } from "@agentkit-js/core";
import {
  BudgetForcingRunner,
  CheckpointableRun,
  createMemoryTool,
  exactMatch,
  FallbackModel,
  finalAnswerLength,
  forbiddenPhrases,
  InMemoryCheckpointer,
  InMemorySpanExporter,
  MapKvBackend,
  maxInputLength,
  OtelBridge,
  ProgrammaticOrchestrator,
  ReflectRefineRunner,
  runEval,
  SelfConsistencyRunner,
  ToolRegistry,
  toolCallAccuracy,
  trajectoryValidity,
  withOtel,
} from "@agentkit-js/core";
import { AnthropicModel, AnthropicModels } from "@agentkit-js/model-anthropic";
import { DeepSeekModel } from "@agentkit-js/model-deepseek";
import { DoubaoModel } from "@agentkit-js/model-doubao";
import { Hono } from "hono";
import { createCodeAgent } from "./agents/code-agent.js";
import { createToolAgent } from "./agents/tool-agent.js";
import type { AppConfig, KvStore } from "./platform.js";
import { SessionKvStore } from "./platform.js";
import {
  createDeleteFileTool,
  createListFilesTool,
  createPatchFileTool,
  createReadFileTool,
  createRenameFileTool,
  createRunCommandTool,
  createSearchCodeTool,
  createWriteFileTool,
} from "./tools/index.js";
import { createGitTools, createShellRunner } from "./tools/shell.js";

export type { AppConfig } from "./platform.js";

const SESSION_TTL = 3600;
const MAX_TASK_BYTES = 10_240;
const MAX_STEPS_CAP = 30;
const MAX_KV_EVENTS = 500;

// In-process shared state (resets on server restart)
const globalMemoryBackend = new MapKvBackend();
const globalCheckpointer = new InMemoryCheckpointer();

// ── Core Hono application (platform-independent) ─────────────────────────────
export function createApp(config: AppConfig) {
  const app = new Hono();

  // ── CORS ──────────────────────────────────────────────────────────────────
  app.use("*", async (c, next) => {
    const allowed = config.allowedOrigin ?? "*";
    const origin = c.req.header("Origin") ?? "";
    const allowOrigin = allowed === "*" ? "*" : origin === allowed ? origin : "null";
    c.header("Access-Control-Allow-Origin", allowOrigin);
    c.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    c.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Session-Id");
    c.header("Access-Control-Max-Age", "86400");
    if (allowed !== "*") c.header("Vary", "Origin");
    if (c.req.method === "OPTIONS") return c.body(null, 204);
    return next();
  });

  // ── Auth ───────────────────────────────────────────────────────────────────
  app.use("/run", async (c, next) => {
    if (!config.clientToken) return next();
    const auth = c.req.header("Authorization") ?? "";
    if (!timingSafeEqual(auth, `Bearer ${config.clientToken}`))
      return c.json({ error: "Unauthorized" }, 401);
    return next();
  });

  // ── Health ────────────────────────────────────────────────────────────────
  app.get("/health", (c) =>
    c.json({ status: "ok", version: "0.2.0", timestamp: new Date().toISOString() })
  );

  // ── Capabilities ──────────────────────────────────────────────────────────
  app.get("/capabilities", (c) =>
    c.json({
      agentModes: ["code", "tool", "multi", "ptc"],
      codeLanguages: ["js", "python", "node"],
      enhancements: ["self-consistency", "reflect-refine", "budget-forcing"],
      features: [
        "planning",
        "guardrails",
        "memory-tool",
        "checkpointing",
        "prompt-cache",
        "dag-scheduler",
        "stop-conditions",
        "fallback-model",
        "otel-bridge",
        "session-isolation",
        "real-shell",
        "real-fs",
        "git-tools",
        "patch-file",
        "evals",
        "ptc",
      ],
      tools: [
        "read_file",
        "write_file",
        "patch_file",
        "delete_file",
        "rename_file",
        "list_files",
        "search_code",
        "run_command",
        "memory",
        ...(config.enableShell
          ? ["git_status", "git_diff", "git_log", "git_commit", "git_checkout"]
          : []),
      ],
      shell: config.enableShell ?? false,
      workdir: config.workdir ?? null,
    })
  );

  // ── Memory ────────────────────────────────────────────────────────────────
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

  // ── Checkpoints ───────────────────────────────────────────────────────────
  app.get("/checkpoints", (c) => c.json({ count: globalCheckpointer.size }));

  // ── Files ─────────────────────────────────────────────────────────────────
  app.get("/files", async (c) => {
    const kv = resolveFilesKv(c.req.header("X-Session-Id"), config);
    if (!kv) return c.json({ files: [] });
    const list = await kv.list({ prefix: "file:" });
    const files = list.keys.map((k) => ({
      path: k.name.replace(/^file:/, ""),
      name:
        k.name
          .replace(/^file:/, "")
          .split("/")
          .pop() ?? "",
    }));
    return c.json({ files });
  });

  app.post("/files", async (c) => {
    const kv = resolveFilesKv(c.req.header("X-Session-Id"), config);
    const { path, content } = await c.req.json<{ path: string; content: string }>();
    if (!path || content === undefined) return c.json({ error: "path and content required" }, 400);
    if (kv) await kv.put(`file:${path.replace(/^\/+/, "")}`, content);
    return c.json({ ok: true, path });
  });

  app.get("/files/:path{.+}", async (c) => {
    const kv = resolveFilesKv(c.req.header("X-Session-Id"), config);
    const path = c.req.param("path");
    if (!kv) return c.json({ error: "KV not bound" }, 503);
    const content = await kv.get(`file:${path}`);
    if (content === null) return c.json({ error: "not found" }, 404);
    return c.json({ path, content });
  });

  app.delete("/files/:path{.+}", async (c) => {
    const kv = resolveFilesKv(c.req.header("X-Session-Id"), config);
    const path = c.req.param("path");
    if (!kv) return c.json({ error: "KV not bound" }, 503);
    await kv.delete?.(`file:${path}`);
    return c.json({ ok: true, path });
  });

  // ── POST /run ─────────────────────────────────────────────────────────────
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
      modelIds,
      maxSteps = 10,
      codeLanguage = "js",
      enhancement,
      planningInterval,
      guardrails,
      useMemory = false,
      useCheckpoint = false,
      checkpointId,
      projectContext = false,
      useOtel = false,
    } = body;

    if (!task || typeof task !== "string") return c.json({ error: "task is required" }, 400);
    if (new TextEncoder().encode(task).byteLength > MAX_TASK_BYTES)
      return c.json({ error: `task must be under ${MAX_TASK_BYTES} bytes` }, 400);

    if (
      !config.anthropicApiKey &&
      !config.anthropicAuthToken &&
      !config.doubaoApiKey &&
      !config.deepseekApiKey
    )
      return c.json({ error: "No API key configured" }, 500);

    const model = resolveModel(modelId, modelIds, config);
    if (!model) return c.json({ error: `Model not available — check API keys` }, 400);

    const clampedSteps = Math.min(maxSteps, MAX_STEPS_CAP);
    const sessionId = c.req.header("X-Session-Id");
    const filesKv = resolveFilesKv(sessionId, config);

    // Optionally prepend project context
    let finalTask = task;
    if (projectContext && config.enableShell) {
      const shell = createShellRunner(config);
      if (shell) {
        const [status, readme, pkg] = await Promise.all([
          shell("git status --short 2>/dev/null || echo '(not a git repo)'"),
          filesKv?.get("file:README.md") ?? Promise.resolve(null),
          filesKv?.get("file:package.json") ?? Promise.resolve(null),
        ]);
        const ctx = [
          "## Project Context",
          `Git status:\n${status}`,
          readme ? `README:\n${readme.slice(0, 1000)}` : null,
          pkg ? `package.json:\n${pkg.slice(0, 500)}` : null,
        ]
          .filter(Boolean)
          .join("\n\n");
        finalTask = `${ctx}\n\n---\n\n${task}`;
      }
    }

    const tools = buildTools(filesKv, useMemory, config);
    const inputGuardrails = buildInputGuardrails(guardrails);
    const outputGuardrails = buildOutputGuardrails(guardrails);

    const agentExtras = {
      maxSteps: clampedSteps,
      planningInterval,
      inputGuardrails,
      outputGuardrails,
    };

    let agentRun: AsyncGenerator<AgentEvent>;

    if (enhancement === "self-consistency") {
      const runner = new SelfConsistencyRunner({ n: 3, earlyStopThreshold: 0.67 });
      agentRun = enhancedAgentRun(model, runner, finalTask);
    } else if (enhancement === "reflect-refine") {
      const runner = new ReflectRefineRunner({ maxCycles: 2 });
      agentRun = enhancedAgentRun(model, runner, finalTask);
    } else if (enhancement === "budget-forcing") {
      const runner = new BudgetForcingRunner({ maxBudgetTokens: 2000 });
      agentRun = enhancedAgentRun(model, runner, finalTask);
    } else if (agentMode === "ptc") {
      agentRun = ptcAgentRun(model, tools, finalTask, codeLanguage, config);
    } else {
      const agent =
        agentMode === "tool"
          ? createToolAgent(model, tools, agentExtras)
          : createCodeAgent(model, tools, {
              ...agentExtras,
              codeLanguage,
              e2bApiKey: config.e2bApiKey,
            });

      if (useCheckpoint) {
        const cpId = checkpointId ?? finalTask.slice(0, 40);
        const cpTraceId = `cp-${cpId}-${Date.now()}`;
        const cpRun = new CheckpointableRun({ checkpointer: globalCheckpointer }, agent.assembler);
        agentRun = cpRun.run(agent.run(finalTask, cpTraceId), finalTask, cpTraceId);
      } else {
        agentRun = agent.run(finalTask);
      }
    }

    // Wrap with OtelBridge to emit model_start/model_done events
    if (useOtel) {
      const bridge = new OtelBridge({ exporter: new InMemorySpanExporter() });
      agentRun = withOtel(agentRun, bridge);
    }

    // Content-addressed session cache
    const resolvedModelId = getModelId(model);
    const sessionsKv = sessionId
      ? config.sessionsKv
        ? new SessionKvStore(config.sessionsKv, sessionId)
        : config.sessionsKv
      : config.sessionsKv;
    const kvKey = sessionsKv
      ? await contentHash({
          task: finalTask,
          agentMode,
          maxSteps: clampedSteps,
          modelId: resolvedModelId,
          enhancement,
        })
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

  // ── POST /eval ────────────────────────────────────────────────────────────
  app.post("/eval", async (c) => {
    const {
      samples,
      scorerNames = ["exactMatch"],
      modelId,
      agentMode = "tool",
      maxSteps = 5,
    } = await c.req.json();
    if (!Array.isArray(samples) || samples.length === 0)
      return c.json({ error: "samples array required" }, 400);

    const model = resolveModel(modelId, undefined, config);
    if (!model) return c.json({ error: "Model not available" }, 400);

    const tools = buildTools(config.filesKv, false, config);
    const agent =
      agentMode === "code"
        ? createCodeAgent(model, tools, { maxSteps })
        : createToolAgent(model, tools, { maxSteps });

    const scorerMap: Record<string, ReturnType<typeof exactMatch>> = {
      exactMatch: exactMatch,
      toolCallAccuracy: toolCallAccuracy,
      trajectoryValidity: trajectoryValidity,
      finalAnswerLength: finalAnswerLength(200),
    };
    const scorers = (scorerNames as string[]).map((n) => scorerMap[n]).filter(Boolean);

    const results = await runEval(samples, (task: string) => agent.run(task), scorers);
    return c.json(results);
  });

  return app;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

interface RunBody {
  task: string;
  agentMode?: "code" | "tool" | "multi" | "ptc";
  modelId?: string;
  modelIds?: string[];
  maxSteps?: number;
  codeLanguage?: "js" | "python" | "node";
  enhancement?: string;
  planningInterval?: number;
  guardrails?: {
    maxInputChars?: number;
    forbiddenOutputPhrases?: string[];
    deniedTools?: string[];
  };
  useMemory?: boolean;
  useCheckpoint?: boolean;
  checkpointId?: string;
  projectContext?: boolean;
  useOtel?: boolean;
}

function resolveModel(
  modelId: string | undefined,
  modelIds: string[] | undefined,
  config: AppConfig
): Model | null {
  // FallbackModel when multiple IDs provided
  if (modelIds && modelIds.length > 1) {
    const models = modelIds
      .map((id) => resolveSingleModel(id, config))
      .filter((m): m is Model => m !== null);
    if (models.length === 0) return null;
    return models.length === 1 ? models[0] : new FallbackModel(models);
  }
  return resolveSingleModel(modelId, config);
}

function resolveSingleModel(modelId: string | undefined, config: AppConfig): Model | null {
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

function resolveFilesKv(sessionId: string | undefined, config: AppConfig): KvStore | undefined {
  if (!config.filesKv) return undefined;
  if (sessionId) return new SessionKvStore(config.filesKv, sessionId);
  return config.filesKv;
}

function buildTools(
  filesKv: KvStore | undefined,
  useMemory: boolean,
  config: AppConfig
): ToolDefinition[] {
  const shellRunner = createShellRunner(config);
  const tools: ToolDefinition[] = [
    createReadFileTool(filesKv),
    createListFilesTool(filesKv),
    createSearchCodeTool(filesKv),
    createWriteFileTool(filesKv),
    createPatchFileTool(filesKv),
    createDeleteFileTool(filesKv),
    createRenameFileTool(filesKv),
    createRunCommandTool(shellRunner),
    ...createGitTools(config),
  ];
  if (useMemory) {
    const memTool = createMemoryTool({ backend: globalMemoryBackend });
    tools.push({
      ...memTool,
      rawInputJsonSchema: {
        type: "object",
        description: "Perform memory operations: read, write, list, or delete",
        properties: {
          op: { type: "string", enum: ["read", "write", "list", "delete"] },
          key: { type: "string" },
          value: { type: "string" },
          prefix: { type: "string" },
        },
        required: ["op"],
      },
    });
  }
  return tools;
}

function buildInputGuardrails(guardrails?: RunBody["guardrails"]) {
  if (!guardrails?.maxInputChars) return [];
  return [maxInputLength(guardrails.maxInputChars)];
}

function buildOutputGuardrails(guardrails?: RunBody["guardrails"]) {
  if (!guardrails?.forbiddenOutputPhrases?.length) return [];
  return [forbiddenPhrases(guardrails.forbiddenOutputPhrases)];
}

async function* enhancedAgentRun(
  model: Model,
  runner: SelfConsistencyRunner | ReflectRefineRunner | BudgetForcingRunner,
  task: string
): AsyncGenerator<AgentEvent> {
  const traceId = `enhanced-${Date.now()}`;
  const base = { traceId, parentTraceId: null, timestampMs: Date.now() };
  const messages: ModelMessage[] = [{ role: "user", content: task }];

  yield { ...base, channel: "text", event: "run_start", data: { task } } as AgentEvent;
  yield { ...base, channel: "thinking", event: "step_start", data: { step: 1 } } as AgentEvent;

  try {
    const result = await runner.run(model, messages, { stream: true });
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

async function* ptcAgentRun(
  model: Model,
  tools: ToolDefinition[],
  task: string,
  _codeLanguage: string,
  _config: AppConfig
): AsyncGenerator<AgentEvent> {
  const traceId = `ptc-${Date.now()}`;
  const base = { traceId, parentTraceId: null, timestampMs: Date.now() };

  yield { ...base, channel: "text", event: "run_start", data: { task } } as AgentEvent;
  yield { ...base, channel: "thinking", event: "step_start", data: { step: 1 } } as AgentEvent;
  yield {
    ...base,
    channel: "thinking",
    event: "thinking_delta",
    data: { delta: "[PTC] Generating orchestration script…", step: 1 },
  } as AgentEvent;

  try {
    const { QuickJSKernel } = await import("@agentkit-js/kernel-quickjs");
    const { newQuickJSWASMModuleFromVariant } = await import("quickjs-emscripten-core");
    const cfVariant = (await import("@jitl/quickjs-wasmfile-release-sync")).default;

    const kernel = new QuickJSKernel({
      timeoutMs: 30_000,
      variant: cfVariant as unknown,
      variantLoader: newQuickJSWASMModuleFromVariant as never,
    });

    const registry = new ToolRegistry();
    for (const t of tools) registry.register(t);

    const orchestrator = new ProgrammaticOrchestrator(kernel, registry);

    // Generate script via model
    const collectModelText = async (msgs: ModelMessage[]) => {
      let text = "";
      for await (const ev of model.generate(msgs, { stream: true })) {
        if (ev.type === "text_delta" && ev.delta) text += ev.delta;
      }
      return text.trim();
    };

    const systemPrompt = `You are a PTC orchestrator. Generate a JavaScript script that calls tools via callTool(name, args).
Available tools: ${tools.map((t) => t.name).join(", ")}.
Set __finalAnswer__ = <result> to return the answer.
Respond with ONLY a JS code block.`;

    const script = await collectModelText([
      { role: "user", content: `${systemPrompt}\n\nTask: ${task}` },
    ]);

    const codeMatch = /```(?:js|javascript)?\n([\s\S]+?)```/.exec(script);
    const code = codeMatch?.[1]?.trim() ?? script;

    yield {
      ...base,
      channel: "thinking",
      event: "thinking_delta",
      data: { delta: `[PTC] Executing script (${code.length} chars)…`, step: 1 },
    } as AgentEvent;

    const result = await orchestrator.run(code);

    yield {
      ...base,
      channel: "text",
      event: "final_answer",
      data: { answer: result.finalOutput },
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
            if (event.event === "final_answer" || allEvents.length < MAX_KV_EVENTS)
              allEvents.push(event);
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
      for (const ev of events)
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
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
  const aB = enc.encode(a),
    bB = enc.encode(b);
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

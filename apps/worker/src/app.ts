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
import { Hono } from "hono";
import { createCodeAgent } from "./agents/code-agent.js";
import { multiAgentRun } from "./agents/multi-agent.js";
import { createToolAgent } from "./agents/tool-agent.js";
import {
  type CustomModelConfig,
  discoverLocalModels,
  getBuiltinModels,
  listCustomModels,
  loadPreferences,
  type ModelPreferences,
  registerCustomModel,
  removeCustomModel,
  resolveModelFromRegistry,
  savePreferences,
} from "./models/registry.js";
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
import { createWebSearchTool } from "./tools/web-search.js";

export type { AppConfig } from "./platform.js";

const SESSION_TTL = 3600;
const MAX_TASK_BYTES = 10_240;
const MAX_STEPS_CAP = 30;
const MAX_KV_EVENTS = 500;

// Model store uses sessionsKv (or a MemKvStore fallback) for persistence
function getModelStore(config: AppConfig): import("./platform.js").KvStore {
  return (
    config.sessionsKv ??
    config.filesKv ?? {
      get: async () => null,
      put: async () => {},
      list: async () => ({ keys: [] }),
    }
  );
}

// In-process shared state (resets on server restart)
const globalMemoryBackend = new MapKvBackend();

// Circular error log for /errors endpoint (last 50 errors)
const errorLog: Array<{ timestampMs: number; message: string; stack?: string; traceId?: string }> =
  [];
function recordError(message: string, stack?: string, traceId?: string) {
  errorLog.push({ timestampMs: Date.now(), message, stack, traceId });
  if (errorLog.length > 50) errorLog.shift();
  // Always print to stderr so it shows in bun --watch terminal output
  const prefix = traceId ? `[${traceId.slice(0, 8)}]` : "[worker]";
  console.error(`${prefix} ERROR: ${message}`);
  if (stack) console.error(stack.split("\n").slice(0, 4).join("\n"));
}
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
    c.header("Access-Control-Allow-Private-Network", "true");
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
        "web-search",
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
        "web_search",
        "memory",
        ...(config.enableShell
          ? ["git_status", "git_diff", "git_log", "git_commit", "git_checkout"]
          : []),
      ],
      shell: config.enableShell ?? false,
      workdir: config.workdir ?? null,
    })
  );

  // ── Task classifier — detects agent mode from task description ────────────
  // Uses Claude Haiku for fast, cheap classification (typically < 500ms).
  // Returns { mode, framework } so the frontend can auto-configure before running.
  app.post("/classify", async (c) => {
    const { task } = await c.req.json<{ task: string }>();
    if (!task) return c.json({ error: "task required" }, 400);

    const apiKey = config.anthropicAuthToken ?? config.anthropicApiKey;
    if (!apiKey) return c.json({ mode: "tool", framework: null }); // fallback

    const { AnthropicModel } = await import("@agentkit-js/model-anthropic");
    const model = new AnthropicModel(
      "claude-haiku-4-5-20251001",
      config.anthropicBaseUrl ? { apiKey, baseURL: config.anthropicBaseUrl } : apiKey
    );

    const prompt = `Classify this coding task into exactly one category. Reply with ONLY valid JSON.

Task: "${task.slice(0, 500)}"

Categories:
- "framework": The task asks to build a UI app, web app, website, game with frontend, or use React/Vue/Svelte/Next.js/Vite. Also choose this for games (贪吃蛇, calculator app, todo app, etc).
- "code": The task asks to write/execute an algorithm, function, data structure, or math computation. Single-file scripts.
- "tool": Everything else — file operations, multi-file projects without a framework, analysis, refactoring.

If mode is "framework", also pick: "react" | "vue" | "svelte" | "vanilla"
- react: React, Next.js, or unspecified frontend framework
- vue: Vue.js
- svelte: Svelte
- vanilla: Pure JS/TS, Canvas games, HTML-only, no framework preference

Reply JSON only, no explanation:
{"mode":"framework","framework":"react"}
or {"mode":"code","framework":null}
or {"mode":"tool","framework":null}`;

    try {
      let text = "";
      for await (const ev of model.generate(
        [{ role: "user", content: prompt }],
        { stream: true, maxTokens: 50 }
      )) {
        if (ev.type === "text_delta" && ev.delta) text += ev.delta;
      }
      const jsonMatch = /\{[^}]+\}/.exec(text.trim());
      if (!jsonMatch) return c.json({ mode: "tool", framework: null });
      const result = JSON.parse(jsonMatch[0]) as { mode: string; framework: string | null };
      const validModes = ["code", "tool", "framework"];
      const validFrameworks = ["react", "vue", "svelte", "vanilla", null];
      if (!validModes.includes(result.mode)) return c.json({ mode: "tool", framework: null });
      if (!validFrameworks.includes(result.framework)) result.framework = "react";
      return c.json(result);
    } catch {
      return c.json({ mode: "tool", framework: null });
    }
  });

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

  // ── Error log (last 50 agent errors for debugging) ────────────────────────
  app.get("/errors", (c) => c.json({ errors: [...errorLog].reverse(), count: errorLog.length }));

  // ── Model Registry ────────────────────────────────────────────────────────

  /** GET /models — list all models (builtin + custom + locally discovered) */
  app.get("/models", async (c) => {
    const store = getModelStore(config);
    const [builtin, local, prefs] = await Promise.all([
      getBuiltinModels(config, store),
      discoverLocalModels(),
      loadPreferences(store),
    ]);
    return c.json({
      models: [...builtin, ...local],
      preferences: prefs ?? { primaryModelId: "claude-sonnet-4-6" },
    });
  });

  /** POST /models/custom — add or update a custom model (apiKey encrypted at rest) */
  app.post("/models/custom", async (c) => {
    const store = getModelStore(config);
    const body = await c.req.json<CustomModelConfig>();
    if (!body.id || !body.baseUrl) return c.json({ error: "id and baseUrl required" }, 400);
    await registerCustomModel(body, store);
    return c.json({ ok: true, id: body.id });
  });

  /** DELETE /models/custom/:id — remove a custom model */
  app.delete("/models/custom/:id", async (c) => {
    const store = getModelStore(config);
    const id = decodeURIComponent(c.req.param("id"));
    const deleted = await removeCustomModel(id, store);
    return deleted ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });

  /** GET /models/custom — list custom models (keys redacted) */
  app.get("/models/custom", async (c) => {
    const store = getModelStore(config);
    return c.json({ models: await listCustomModels(store) });
  });

  /** PUT /models/preferences — save primary/economy model selection */
  app.put("/models/preferences", async (c) => {
    const store = getModelStore(config);
    const prefs = await c.req.json<ModelPreferences>();
    if (!prefs.primaryModelId) return c.json({ error: "primaryModelId required" }, 400);
    await savePreferences(prefs, store);
    return c.json({ ok: true, prefs });
  });

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

  // Bulk fetch — returns all files with their contents in one request.
  // Used by the frontend to mount the workspace into WebContainers without N+1 fetches.
  app.get("/files/bulk", async (c) => {
    const kv = resolveFilesKv(c.req.header("X-Session-Id"), config);
    if (!kv) return c.json({ files: [] });
    const list = await kv.list({ prefix: "file:" });
    const files = await Promise.all(
      list.keys.map(async (k) => {
        const path = k.name.replace(/^file:/, "");
        const content = await kv.get(k.name);
        return { path, content: content ?? "" };
      })
    );
    return c.json({ files });
  });

  // Batch write — import multiple files in one request (used by ZIP/directory import).
  app.post("/files/bulk", async (c) => {
    const kv = resolveFilesKv(c.req.header("X-Session-Id"), config);
    if (!kv) return c.json({ error: "KV not bound" }, 503);
    const { files } = await c.req.json<{ files: { path: string; content: string }[] }>();
    if (!Array.isArray(files) || files.length === 0)
      return c.json({ error: "files array required" }, 400);
    await Promise.all(
      files.map(({ path, content }) =>
        kv.put(`file:${path.replace(/^\/+/, "")}`, content ?? "")
      )
    );
    return c.json({ ok: true, count: files.length, paths: files.map((f) => f.path) });
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
    // Parse and validate synchronously-readable fields first.
    let body: RunBody;
    try {
      body = await c.req.json<RunBody>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { task } = body;
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

    const sessionId = c.req.header("X-Session-Id");
    const {
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

    const clampedSteps = Math.min(maxSteps, MAX_STEPS_CAP);

    // ── Session cache pre-check (fast path, avoids spawning agent) ──────────
    // Only attempt when sessionsKv is available — resolve modelId for hash.
    const sessionsKv = sessionId
      ? config.sessionsKv ? new SessionKvStore(config.sessionsKv, sessionId) : config.sessionsKv
      : config.sessionsKv;

    if (sessionsKv) {
      // Resolve model just enough to compute the cache key (no expensive init).
      const store = getModelStore(config);
      const primaryModelForHash = await resolveModelFromRegistry(modelId, config, store);
      const resolvedModelId = primaryModelForHash ? getModelId(primaryModelForHash) : (modelId ?? "unknown");
      const kvKey = await contentHash({
        task, agentMode, maxSteps: clampedSteps, modelId: resolvedModelId, enhancement,
        ...(((body as Record<string, unknown>)._testRunId) ? { _r: (body as Record<string, unknown>)._testRunId } : {}),
      });
      const cached = await sessionsKv.get(kvKey);
      if (cached) return streamCachedEvents(cached);
    }

    // ── Live run: return SSE Response immediately, pump agent async ──────────
    // This avoids the Bun bug where awaiting inside a Hono handler before
    // returning a streaming Response causes Chrome fetch to get ERR_FAILED.
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    (async () => {
      // Flush headers + first byte immediately so Chrome doesn't time out.
      await writer.write(encoder.encode(": connected\n\n"));

      try {
        const store = getModelStore(config);
        const primaryModel = await resolveModelFromRegistry(modelId, config, store);
        if (!primaryModel) {
          await writer.write(
            encoder.encode(
              `data: ${JSON.stringify({ event: "error", data: { error: "Model not available — check API keys or add via /models/custom" } })}\n\n`
            )
          );
          await writer.write(encoder.encode("data: [DONE]\n\n"));
          await writer.close();
          return;
        }

        const model: Model =
          modelIds && modelIds.length > 1 ? new FallbackModel([primaryModel]) : primaryModel;

        const filesKv = resolveFilesKv(sessionId, config);

        let finalTask = task;
        if (projectContext) {
          const fileTree = await buildProjectFileTree(filesKv);
          const ctxParts: string[] = ["## Project Files\n" + fileTree];
          const shell = createShellRunner(config);
          if (shell) {
            const [status, readme, pkg] = await Promise.all([
              shell("git status --short 2>/dev/null || echo '(not a git repo)'"),
              filesKv?.get("file:README.md") ?? Promise.resolve(null),
              filesKv?.get("file:package.json") ?? Promise.resolve(null),
            ]);
            ctxParts.push(`Git status:\n${status}`);
            if (readme) ctxParts.push(`README:\n${readme.slice(0, 1000)}`);
            if (pkg) ctxParts.push(`package.json:\n${pkg.slice(0, 500)}`);
          }
          finalTask = `${ctxParts.join("\n\n")}\n\n---\n\n${task}`;
        }

        const tools = buildTools(filesKv, useMemory, config, [
          ...(guardrails?.deniedTools ?? []),
          // Framework mode: block run_command and git tools — WebContainers handles execution
          ...(body.framework ? ["run_command", "git_status", "git_diff", "git_log", "git_commit", "git_checkout"] : []),
        ]);
        const inputGuardrails = buildInputGuardrails(guardrails);
        const outputGuardrails = buildOutputGuardrails(guardrails);
        const agentExtras = { maxSteps: clampedSteps, planningInterval, inputGuardrails, outputGuardrails, framework: body.framework };

        let agentRun: AsyncGenerator<AgentEvent>;

        if (enhancement === "self-consistency") {
          agentRun = enhancedAgentRun(model, new SelfConsistencyRunner({ n: 3, earlyStopThreshold: 0.67 }), finalTask);
        } else if (enhancement === "reflect-refine") {
          agentRun = enhancedAgentRun(model, new ReflectRefineRunner({ maxCycles: 2 }), finalTask);
        } else if (enhancement === "budget-forcing") {
          agentRun = enhancedAgentRun(model, new BudgetForcingRunner({ maxBudgetTokens: 2000 }), finalTask);
        } else if (agentMode === "multi") {
          agentRun = multiAgentRun(model, tools, finalTask, { ...agentExtras, codeLanguage, e2bApiKey: config.e2bApiKey });
        } else if (agentMode === "ptc") {
          agentRun = ptcAgentRun(model, tools, finalTask, codeLanguage, config);
        } else {
          const agent =
            agentMode === "tool"
              ? createToolAgent(model, tools, agentExtras)
              : createCodeAgent(model, tools, { ...agentExtras, codeLanguage, e2bApiKey: config.e2bApiKey });

          if (useCheckpoint) {
            const cpId = checkpointId ?? finalTask.slice(0, 40);
            const cpTraceId = `cp-${cpId}-${Date.now()}`;
            const cpRun = new CheckpointableRun({ checkpointer: globalCheckpointer }, agent.assembler);
            agentRun = cpRun.run(agent.run(finalTask, cpTraceId), finalTask, cpTraceId);
          } else {
            agentRun = agent.run(finalTask);
          }
        }

        if (useOtel) {
          const bridge = new OtelBridge({ exporter: new InMemorySpanExporter() });
          agentRun = withOtel(agentRun, bridge);
        }

        // Compute cache key for write-back (same inputs as pre-check above)
        const resolvedModelId = getModelId(model);
        const kvKey = sessionsKv
          ? await contentHash({
              task: finalTask, agentMode, maxSteps: clampedSteps, modelId: resolvedModelId, enhancement,
              ...(((body as Record<string, unknown>)._testRunId) ? { _r: (body as Record<string, unknown>)._testRunId } : {}),
            })
          : null;

        // Stream live events
        const allEvents: AgentEvent[] = [];
        let success = false;
        for await (const event of agentRun) {
          await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          if (kvKey && sessionsKv && (event.event === "final_answer" || allEvents.length < MAX_KV_EVENTS))
            allEvents.push(event);
          if (event.event === "final_answer") success = true;
        }
        await writer.write(encoder.encode("data: [DONE]\n\n"));
        if (kvKey && sessionsKv && success)
          await sessionsKv.put(kvKey, JSON.stringify(allEvents), { expirationTtl: SESSION_TTL }).catch(console.error);

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error && err.stack ? err.stack.split("\n").slice(0, 4).join("\n") : undefined;
        recordError(msg, stack);
        await writer.write(
          encoder.encode(`data: ${JSON.stringify({ event: "error", data: { error: msg, ...(stack ? { stack } : {}) } })}\n\n`)
        );
      } finally {
        await writer.close().catch(() => {});
      }
    })();

    const allowOrigin = (config.allowedOrigin ?? "*") === "*"
      ? "*"
      : (c.req.header("Origin") ?? "") === config.allowedOrigin
        ? config.allowedOrigin!
        : "null";

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": allowOrigin,
        "Access-Control-Allow-Private-Network": "true",
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

    const model = await resolveModelFromRegistry(modelId, config, getModelStore(config));
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
  /** Framework mode — activates framework-aware system prompt in ToolAgent */
  framework?: "react" | "vue" | "svelte" | "vanilla" | null;
}

function getModelId(model: Model): string {
  return (model as { modelId?: string }).modelId ?? "unknown";
}

function resolveFilesKv(sessionId: string | undefined, config: AppConfig): KvStore | undefined {
  if (!config.filesKv) return undefined;
  if (sessionId) return new SessionKvStore(config.filesKv, sessionId);
  return config.filesKv;
}

/** Build a tree-style string of all files in the KV store for project context. */
async function buildProjectFileTree(kv: KvStore | undefined): Promise<string> {
  if (!kv) return "(no files in workspace)";
  const list = await kv.list({ prefix: "file:" });
  const paths = list.keys.map((k) => k.name.replace(/^file:/, "")).sort();
  if (paths.length === 0) return "(workspace is empty)";

  // Build directory tree
  const tree: Record<string, string[]> = {};
  for (const p of paths) {
    const parts = p.split("/");
    if (parts.length === 1) {
      if (!tree[""]) tree[""] = [];
      tree[""].push(p);
    } else {
      const dir = parts.slice(0, -1).join("/");
      if (!tree[dir]) tree[dir] = [];
      tree[dir].push(parts[parts.length - 1]);
    }
  }

  const lines: string[] = [];
  // Root files first
  for (const f of tree[""] ?? []) lines.push(`  ${f}`);
  // Directories
  for (const [dir, files] of Object.entries(tree)) {
    if (!dir) continue;
    lines.push(`  ${dir}/`);
    for (const f of files) lines.push(`    ${f}`);
  }

  return `${paths.length} file(s):
${lines.join("\n")}`;
}

function buildTools(
  filesKv: KvStore | undefined,
  useMemory: boolean,
  config: AppConfig,
  deniedTools?: string[]
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
    createWebSearchTool(),
    ...createGitTools(config),
  ];
  // P4: filter out denied tools
  const filteredTools = deniedTools?.length
    ? tools.filter((t) => !deniedTools.includes(t.name))
    : tools;
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
  return filteredTools;
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
  // Use TransformStream so the readable side is immediately available to the
  // Response constructor — avoids the Bun bug where an async ReadableStream
  // start() causes Chrome to receive net::ERR_FAILED before the first byte.
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  // Fire-and-forget: pump events into the writable side asynchronously.
  (async () => {
    const allEvents: AgentEvent[] = [];
    let success = false;
    // Immediately write an SSE comment to flush the HTTP headers to the client.
    await writer.write(encoder.encode(": connected\n\n"));
    try {
      for await (const event of run) {
        await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        if (kvKey && sessionsKv) {
          if (event.event === "final_answer" || allEvents.length < MAX_KV_EVENTS)
            allEvents.push(event);
        }
        if (event.event === "final_answer") success = true;
      }
      await writer.write(encoder.encode("data: [DONE]\n\n"));
      if (kvKey && sessionsKv && success) {
        await sessionsKv
          .put(kvKey, JSON.stringify(allEvents), { expirationTtl: SESSION_TTL })
          .catch(console.error);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack =
        err instanceof Error && err.stack
          ? err.stack.split("\n").slice(0, 4).join("\n")
          : undefined;
      recordError(msg, stack);
      await writer.write(
        encoder.encode(
          `data: ${JSON.stringify({ event: "error", data: { error: msg, ...(stack ? { stack } : {}) } })}\n\n`
        )
      );
    } finally {
      await writer.close().catch(() => {});
    }
  })();

  return readable;
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

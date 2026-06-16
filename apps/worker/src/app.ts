import type { AgentEvent, Model, ModelMessage, Scorer, ToolDefinition } from "@agentkit-js/core";
import {
  BudgetForcingRunner,
  CheckpointableRun,
  createMemoryTool,
  EventLog,
  exactMatch,
  FallbackModel,
  FileTreeManager,
  finalAnswerLength,
  forbiddenPhrases,
  formatSseFrame,
  InMemoryCheckpointer,
  InMemorySpanExporter,
  KvCheckpointer,
  MapKvBackend,
  makeKvAgentsMdLoader,
  maxInputLength,
  OtelBridge,
  type ParallelForkJoinRunner,
  ProgrammaticOrchestrator,
  ProjectInstructions,
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
import { type MultiAgentMode, multiAgentRun, runPlanFirstExecution } from "./agents/multi-agent.js";
import { createToolAgent } from "./agents/tool-agent.js";
import {
  type BuildResultSnapshot,
  clearBuildResult,
  getBuildResult,
  putBuildResult,
} from "./build-results.js";
import { JobQueue, type JobRunner, type JobSpec } from "./jobs/index.js";
import {
  deriveJobSessionId,
  diffSessions,
  discardJobSession,
  type MergeStrategy,
  mergeSessions,
  snapshotSession,
} from "./jobs/jobBranches.js";
import { createMcpFetchHandler } from "./mcp.js";
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
  ApprovalPolicy,
  type ApprovalPolicyOptions,
  applyApprovalPolicy,
  PolicyPresets,
} from "./policies/approvalPolicy.js";
import {
  createDeleteFileTool,
  createGitHubPrTool,
  createInitAgentsMdTool,
  createListFilesTool,
  createListFileVersionsTool,
  createPatchFileTool,
  createReadBuildResultTool,
  createReadFileTool,
  createRenameFileTool,
  createRevertFileTool,
  createRunCommandTool,
  createSearchCodeTool,
  createSemanticIndexer,
  createSemanticSearchTool,
  createVisualInteractTool,
  createVisualVerifyTool,
  createWriteFileTool,
  importGithubRepo,
  MAX_FILE_BYTES,
  assertWorkspacePath,
  type SemanticIndexer,
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
/**
 * B1 — Adapter from bscode's KvStore (CF KVNamespace-shape) to agentkit-js's
 * canonical KvBackend (string list, plain put). One-line keeps both codebases
 * speaking the same KV contract without dragging the worker-types dependency.
 */
function adaptKvStoreToBackend(store: import("./platform.js").KvStore) {
  return {
    get: (key: string) => store.get(key),
    put: (key: string, value: string) => store.put(key, value),
    delete: (key: string) => (store.delete ? store.delete(key) : Promise.resolve()),
    list: async (prefix: string) => {
      const result = await store.list({ prefix });
      return result.keys.map((k) => k.name);
    },
  };
}

/**
 * Per-AppConfig checkpointer. When the runtime supplies a checkpoints KV,
 * we use {@link KvCheckpointer} so paused or partially-completed runs
 * survive worker recycle (A1 + A3). Without a binding we fall back to
 * the in-memory implementation, preserving the original dev behaviour.
 *
 * Cached on the config object so all routes within the same request share
 * one checkpointer instance.
 */
const checkpointerByConfig = new WeakMap<AppConfig, InMemoryCheckpointer | KvCheckpointer>();
function checkpointerFor(config: AppConfig): InMemoryCheckpointer | KvCheckpointer {
  let cp = checkpointerByConfig.get(config);
  if (!cp) {
    cp = config.checkpointsKv
      ? new KvCheckpointer(adaptKvStoreToBackend(config.checkpointsKv))
      : new InMemoryCheckpointer();
    checkpointerByConfig.set(config, cp);
  }
  return cp;
}

// Per-session FileTreeManager — keyed by X-Session-Id header so two
// browsers (or two tabs) cannot read each other's files or version
// history. The header is required for all /files endpoints; requests
// without it fall back to the legacy "default" bucket for backward
// compatibility with existing CLI flows that pre-date the header.
const sessionFileTrees = new Map<string, FileTreeManager>();

function sessionIdOf(c: { req: { header: (n: string) => string | undefined } }): string {
  return c.req.header("X-Session-Id") ?? "default";
}

function fileTreeFor(c: { req: { header: (n: string) => string | undefined } }): FileTreeManager {
  const id = sessionIdOf(c);
  let tree = sessionFileTrees.get(id);
  if (!tree) {
    tree = new FileTreeManager();
    sessionFileTrees.set(id, tree);
  }
  return tree;
}

// B2 — per-session semantic indexer state. The Map is module-level only so
// the closure inside createApp() can carry per-AppConfig embedder choice.
// Each app instance maintains its own Map below; we rebind via factory.
type IndexerFor = (c: { req: { header: (n: string) => string | undefined } }) => SemanticIndexer;

// ── Core Hono application (platform-independent) ─────────────────────────────
export function createApp(config: AppConfig) {
  const app = new Hono();

  // ── B1 — Job queue (parallel background runs) ────────────────────────────
  // One queue per createApp instance. The runner self-fetches /run so the
  // queued path goes through exactly the same agent pipeline as a synchronous
  // run, eliminating the "two implementations drifted apart" failure mode.
  //
  // C2 — Each job runs in an isolated derived session id (parent#job-<id>)
  // so concurrent jobs on the same parent session do not trample each other.
  // The onBeforeStart hook snapshots parent files into the derived session
  // before the runner starts; the per-job diff/merge endpoints below let the
  // user review and merge the changes back when the job is done.
  const jobQueue = new JobQueue({
    concurrency: 4,
    eventTailSize: 100,
    durableKv: config.sessionsKv, // same KV used for cached run replays
    onBeforeStart: async (jobId, spec) => {
      if (!config.filesKv) return;
      const parent = spec.sessionId ?? "default";
      const derived = deriveJobSessionId(parent, jobId);
      await snapshotSession(config.filesKv, parent, derived);
    },
    onAfterFinish: async (record) => {
      // Keep the derived session and snapshot in place — the user reviews
      // the diff via /jobs/:id/diff and explicitly merges or discards. We
      // only auto-clean on aborted jobs (no diff worth keeping).
      if (record.status !== "aborted" || !config.filesKv) return;
      const parent = record.spec.sessionId ?? "default";
      const derived = deriveJobSessionId(parent, record.id);
      await discardJobSession(config.filesKv, derived).catch(() => undefined);
    },
  });

  // ── B2 / B3 — Semantic indexer factory (per app) ─────────────────────────
  // Build the embedder once per createApp instance:
  //   - HttpEmbedder when AppConfig.embedding is fully populated
  //   - TF-IDF (zero-deps, in-process) otherwise.
  // Per-session indexers are constructed lazily so each conversation gets
  // its own vocabulary; the underlying embedder is shared.
  const sessionIndexers = new Map<string, SemanticIndexer>();
  let sharedEmbedder: import("@agentkit-js/core").Embedder | undefined;
  if (config.embedding) {
    // Lazy import keeps tools-rag out of the bundle when the consumer
    // never sets EMBEDDING_API_KEY. The dynamic import is awaited inside
    // the indexerFor() factory the first time it's called.
    sharedEmbedder = undefined; // resolved on first use
  }
  const indexerFor: IndexerFor = (c) => {
    const id = sessionIdOf(c);
    let idx = sessionIndexers.get(id);
    if (!idx) {
      // Use the embedder if it was already resolved; otherwise fall back to
      // TF-IDF for this session and lazily upgrade subsequent sessions once
      // the dynamic import completes (see resolveEmbedder below).
      idx = createSemanticIndexer({
        ...(sharedEmbedder ? { embedder: sharedEmbedder } : {}),
      });
      sessionIndexers.set(id, idx);
    }
    return idx;
  };
  // Kick off the dynamic import once if embedding is configured. Failure
  // logs and falls through to TF-IDF — we never crash the app on this.
  if (config.embedding) {
    const embedding = config.embedding;
    void (async () => {
      try {
        const { HttpEmbedder } = await import("@agentkit-js/tools-rag");
        sharedEmbedder = new HttpEmbedder({
          apiKey: embedding.apiKey,
          baseUrl: embedding.baseUrl,
          model: embedding.model,
        });
        // Existing TF-IDF indexers stay as-is — only NEW sessions pick up
        // the HttpEmbedder. This avoids a re-index storm on restart.
      } catch (err) {
        console.warn("[embedder] failed to load HttpEmbedder, falling back to TF-IDF:", err);
      }
    })();
  }

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

  // ── /mcp — code-mode MCP server (B-D2 follow-up, 2026-06) ─────────────────
  // Read-only tool subset (read_file / list_files / search_code / web_search)
  // surfaced to MCP hosts (Claude Desktop, Cursor, VS Code Copilot) through
  // one execute_code surface. The kernel is the same QuickJS variant used by
  // /run-ptc; the variant module is loaded lazily and cached so cold-start
  // for /mcp matches the rest of the worker. See apps/worker/src/mcp.ts.
  let mcpHandler: ((req: Request) => Promise<Response>) | null = null;
  const ensureMcpHandler = async () => {
    if (mcpHandler) return mcpHandler;
    const variantMod = await import("@jitl/quickjs-wasmfile-release-sync");
    const loaderMod = await import("quickjs-emscripten-core");
    mcpHandler = createMcpFetchHandler(config, {
      quickjsVariant: variantMod.default,
      quickjsVariantLoader: loaderMod.newQuickJSWASMModuleFromVariant,
    });
    return mcpHandler;
  };
  app.all("/mcp", async (c) => {
    const handler = await ensureMcpHandler();
    return handler(c.req.raw);
  });

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

  // ── Enhance Prompt — expand vague task into detailed spec (bolt.new pattern) ─
  // Uses Claude Haiku to rewrite a vague user prompt into a detailed, actionable
  // specification. Returns the enhanced prompt so the frontend can show a preview
  // before submitting to the full agent run.
  app.post("/enhance-prompt", async (c) => {
    const { task, mode, framework } = await c.req.json<{
      task: string;
      mode?: string;
      framework?: string | null;
    }>();
    if (!task) return c.json({ error: "task required" }, 400);

    const apiKey = config.anthropicAuthToken ?? config.anthropicApiKey;
    if (!apiKey) return c.json({ enhanced: task }); // passthrough fallback

    const { AnthropicModel } = await import("@agentkit-js/model-anthropic");
    const model = new AnthropicModel(
      "claude-haiku-4-5-20251001",
      config.anthropicBaseUrl ? { apiKey, baseURL: config.anthropicBaseUrl } : apiKey
    );

    const modeCtx = framework
      ? `The user is building a ${framework} web app.`
      : mode === "code"
        ? "The user wants to write and execute JavaScript/Python code."
        : "The user wants to use file tools to build or modify a codebase.";

    const systemMsg = `You are a prompt engineer. Your job is to take a vague coding task and expand it into a clear, detailed specification that a coding agent can execute precisely.

${modeCtx}

Rules:
- Keep the enhanced prompt concise (3-8 sentences)
- Add specific technical details that were implied but not stated
- Specify expected inputs, outputs, and edge cases
- Mention UI/UX details for frontend tasks (colors, interactions, layout)
- Do NOT change the core intent — only add clarity
- Write in the same language as the original (Chinese stays Chinese, English stays English)
- Reply with ONLY the enhanced task description, no preamble`;

    try {
      let enhanced = "";
      for await (const ev of model.generate(
        [
          { role: "system", content: systemMsg },
          { role: "user", content: task },
        ],
        { stream: true, maxTokens: 300 }
      )) {
        if (ev.type === "text_delta" && ev.delta) enhanced += ev.delta;
      }
      return c.json({ enhanced: enhanced.trim() || task });
    } catch {
      return c.json({ enhanced: task });
    }
  });

  // ── Clarify — detect ambiguity and generate clarifying questions (Lovable pattern) ──
  // Returns { needsClarification: boolean, questions: string[] } so the frontend
  // can ask the user before burning tokens on a potentially wrong execution.
  app.post("/clarify", async (c) => {
    const { task, context } = await c.req.json<{ task: string; context?: string }>();
    if (!task) return c.json({ error: "task required" }, 400);

    const apiKey = config.anthropicAuthToken ?? config.anthropicApiKey;
    if (!apiKey) return c.json({ needsClarification: false, questions: [] });

    const { AnthropicModel } = await import("@agentkit-js/model-anthropic");
    const model = new AnthropicModel(
      "claude-haiku-4-5-20251001",
      config.anthropicBaseUrl ? { apiKey, baseURL: config.anthropicBaseUrl } : apiKey
    );

    const prompt = `You are deciding whether a coding task needs clarification before execution.
IMPORTANT: Reply in the SAME LANGUAGE as the task (Chinese task → Chinese questions).

Task: "${task.slice(0, 600)}"
${context ? `Context: "${context.slice(0, 200)}"` : ""}

DEFAULT: Do NOT ask. Only ask when the task is so vague that executing it would very likely produce the WRONG output.

NEVER ask when the task:
- Names specific technology/format (React, D2, Markdown, SQL, REST…)
- Has a clear deliverable (draw X, implement Y, fix Z, explain W)
- Is a standard well-known operation (sort array, add button, create todo app, draw flowchart, explain code)
- Contains enough specifics to make a reasonable choice (e.g. "画一个系统架构图（前端→API→数据库）" is fully specified)

ONLY ask when:
- The scope is completely undefined ("make it better", "build a dashboard" with NO other info, "add authentication" with zero context)
- Two completely different valid interpretations exist AND the wrong choice wastes significant effort
- Max 2 questions. Options: 2-4 short labels (2-5 words each)

When in doubt → do NOT ask.

Reply JSON only:
{"needsClarification": false}
OR
{"needsClarification": true, "questions": [
  {"text": "question text", "options": ["Option A", "Option B"]}
]}`;

    try {
      let text = "";
      for await (const ev of model.generate([{ role: "user", content: prompt }], {
        stream: true,
        maxTokens: 300,
      })) {
        if (ev.type === "text_delta" && ev.delta) text += ev.delta;
      }
      const jsonMatch = /\{[\s\S]*\}/.exec(text.trim());
      if (!jsonMatch) return c.json({ needsClarification: false, questions: [] });
      const result = JSON.parse(jsonMatch[0]) as {
        needsClarification: boolean;
        questions?: Array<{ text: string; options: string[] } | string>;
      };
      // Normalise — handle both old string format and new {text, options} format
      const questions = (result.questions ?? [])
        .slice(0, 2)
        .map((q) =>
          typeof q === "string"
            ? { text: q, options: [] }
            : { text: q.text, options: (q.options ?? []).slice(0, 4) }
        );
      return c.json({
        needsClarification: result.needsClarification ?? false,
        questions,
      });
    } catch {
      return c.json({ needsClarification: false, questions: [] });
    }
  });

  // ── Generate from schema — Glide data-schema-first UI generation ─────────
  // Accepts a JSON schema and returns a React component that renders a form/view
  // for that schema, with field types mapped to appropriate UI components.
  app.post("/generate-from-schema", async (c) => {
    const {
      schema,
      framework = "react",
      componentName = "DataForm",
    } = await c.req.json<{
      schema: Record<string, unknown>;
      framework?: string;
      componentName?: string;
    }>();
    if (!schema) return c.json({ error: "schema required" }, 400);

    // Type-to-component mapping (Glide pattern)
    const typeMap: Record<string, { component: string; props: string }> = {
      string: { component: "Input", props: 'type="text"' },
      number: { component: "Input", props: 'type="number"' },
      integer: { component: "Input", props: 'type="number" step="1"' },
      boolean: { component: "input", props: 'type="checkbox"' },
      array: { component: "Textarea", props: 'placeholder="JSON array"' },
      object: { component: "Textarea", props: 'placeholder="JSON object"' },
    };

    // Heuristic: detect image/date/email by field name
    const nameHints: Record<string, { component: string; props: string }> = {
      image: { component: "img", props: 'alt={field} className="w-32 h-32 object-cover"' },
      img: { component: "img", props: 'alt={field} className="w-32 h-32 object-cover"' },
      photo: { component: "img", props: 'alt={field} className="w-32 h-32 object-cover"' },
      date: { component: "Input", props: 'type="date"' },
      time: { component: "Input", props: 'type="time"' },
      email: { component: "Input", props: 'type="email"' },
      phone: { component: "Input", props: 'type="tel"' },
      url: { component: "Input", props: 'type="url"' },
      color: { component: "Input", props: 'type="color"' },
      password: { component: "Input", props: 'type="password"' },
    };

    const properties = (schema.properties ?? {}) as Record<
      string,
      { type?: string; description?: string }
    >;
    const required = new Set<string>((schema.required as string[]) ?? []);

    const fields = Object.entries(properties).map(([name, def]) => {
      const lower = name.toLowerCase();
      const hint = Object.entries(nameHints).find(([k]) => lower.includes(k))?.[1];
      const mapped = hint ?? typeMap[def.type ?? "string"] ?? typeMap.string;
      return { name, ...mapped, required: required.has(name), description: def.description };
    });

    // Generate React component (framework=react default)
    const componentCode =
      framework === "react"
        ? `
import { useState } from "react";

interface ${componentName}Data {
${fields.map((f) => `  ${f.name}${f.required ? "" : "?"}: ${f.component === "input" ? "boolean" : "string"};`).join("\n")}
}

export function ${componentName}({ onSubmit }: { onSubmit?: (data: ${componentName}Data) => void }) {
  const [data, setData] = useState<${componentName}Data>({
${fields.map((f) => `    ${f.name}: ${f.component === "input" ? "false" : '""'},`).join("\n")}
  });

  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit?.(data); }} className="space-y-4 p-4">
${fields
  .map(
    (f) => `      <div className="flex flex-col gap-1">
        <label htmlFor="${f.name}" className="text-sm font-medium">${f.name}${f.required ? " *" : ""}</label>
        ${
          f.component === "Textarea"
            ? `<textarea id="${f.name}" ${f.props} value={data.${f.name} as string} onChange={(e) => setData(p => ({...p, ${f.name}: e.target.value}))} className="border rounded p-2" />`
            : f.component === "img"
              ? `{data.${f.name} && <${f.component} src={data.${f.name} as string} ${f.props} />}`
              : `<${f.component === "Input" ? "input" : f.component} id="${f.name}" ${f.props} ${f.component === "input" ? `checked={data.${f.name} as boolean} onChange={(e) => setData(p => ({...p, ${f.name}: e.target.checked}))` : `value={data.${f.name} as string} onChange={(e) => setData(p => ({...p, ${f.name}: e.target.value}))`} className="border rounded p-2" />`
        }
      </div>`
  )
  .join("\n")}
      <button type="submit" className="bg-blue-500 text-white px-4 py-2 rounded">Submit</button>
    </form>
  );
}
`.trim()
        : `// Framework "${framework}" not yet supported for schema generation.`;

    return c.json({
      ok: true,
      framework,
      componentName,
      code: componentCode,
      fields: fields.length,
    });
  });

  // ── Task classifier — detects agent mode from task description ────────────
  // Uses Claude Haiku for fast, cheap classification (typically < 500ms).
  // Returns { mode, framework } so the frontend can auto-configure before running.
  app.post("/classify", async (c) => {
    const { task } = await c.req.json<{ task: string }>();
    if (!task) return c.json({ error: "task required" }, 400);

    // Fast-path: diagram/visualization-only tasks belong in "code" mode
    // (the agent emits a card:d2 / card:mermaid block — no files, no
    // WebContainers). Without this the LLM classifier sometimes routes
    // "画一个流程图" / "draw a sequence diagram" to "framework·vanilla",
    // which spins up WebContainers for nothing.
    const lcTask = task.toLowerCase();
    const diagramKeywords = [
      "画.*?(图|流程图|架构图|时序图|关系图|拓扑图|思维导图)",
      "(draw|render|create|make|generate).*\\b(diagram|flowchart|flow chart|sequence|architecture|topology|mindmap|mind map|er diagram|state machine)\\b",
      "\\b(d2|mermaid|graphviz|plantuml)\\b",
    ];
    const isDiagramTask = diagramKeywords.some((re) => new RegExp(re, "i").test(lcTask));
    // Only honor the fast-path if the task does NOT also ask for an app
    // / interactive UI (e.g. "build a Vue app that draws a diagram") —
    // those still need framework mode.
    const looksLikeApp =
      /\b(app|todo|game|component|website|ui|界面|应用|网站|游戏|计算器|看板)\b/i.test(lcTask);
    if (isDiagramTask && !looksLikeApp) {
      return c.json({ mode: "code", framework: null });
    }

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
- "framework": The task asks to build a UI app, web app, website, interactive animation/game with visuals, or use React/Vue/Svelte/Next.js/Vite. Choose this for games (贪吃蛇, calculator app, todo app, etc), canvas animations (fireworks, particle effects, etc), or anything that needs a live interactive visual output in the browser.
- "code": The task asks to write/execute an algorithm, function, data structure, math computation, data analysis, OR to draw a static diagram (flow chart, sequence diagram, architecture, ER, mind map — D2 / Mermaid / PlantUML output). Choose this ONLY for non-visual, non-interactive scripts and for diagram-only output (which renders inline as a card, no app needed). If the task would normally use tkinter/pygame/GUI on desktop → use "framework" instead.
- "tool": Everything else — file operations, multi-file projects without a framework, analysis, refactoring.

If mode is "framework", also pick: "react" | "vue" | "svelte" | "vanilla"
- react: React, Next.js, or unspecified frontend framework
- vue: Vue.js
- svelte: Svelte
- vanilla: Pure JS/TS, Canvas games/animations, HTML-only, no framework preference

Reply JSON only, no explanation:
{"mode":"framework","framework":"react"}
or {"mode":"code","framework":null}
or {"mode":"tool","framework":null}`;

    try {
      let text = "";
      for await (const ev of model.generate([{ role: "user", content: prompt }], {
        stream: true,
        maxTokens: 50,
      })) {
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
  app.get("/checkpoints", (c) => {
    const cp = checkpointerFor(config);
    // Only InMemoryCheckpointer exposes .size; KvCheckpointer needs a list().
    if (cp instanceof InMemoryCheckpointer) {
      return c.json({ count: cp.size, backend: "in-memory" });
    }
    return c.json({ count: null, backend: "kv" });
  });

  // ── B2 — Build Result reverse channel ─────────────────────────────────────
  // The browser-side WebContainer wrapper POSTs install/build/test outcomes
  // here so the worker-side agent (which is otherwise blind on edge) can
  // verify its work via the `read_build_result` tool. GET is provided for
  // diagnostics / dashboards; the agent does not call it directly.

  /**
   * POST /build-result — body shape mirrors {@link BuildResultSnapshot},
   * but `ranAtMs` is server-stamped to avoid clock-skew shenanigans.
   * Returns 400 for malformed payloads; KV mirroring is best-effort.
   */
  app.post("/build-result", async (c) => {
    const sessionId = sessionIdOf(c);
    let body: Partial<BuildResultSnapshot>;
    try {
      body = await c.req.json<Partial<BuildResultSnapshot>>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const status = body.status;
    if (status !== "success" && status !== "failed" && status !== "running") {
      return c.json({ error: "status must be one of: success, failed, running" }, 400);
    }
    const snap: BuildResultSnapshot = {
      status,
      ranAtMs: Date.now(),
      ...(body.stage ? { stage: body.stage } : {}),
      ...(typeof body.exitCode === "number" ? { exitCode: body.exitCode } : {}),
      ...(typeof body.stderr === "string" ? { stderr: body.stderr } : {}),
      ...(typeof body.wallTimeMs === "number" ? { wallTimeMs: body.wallTimeMs } : {}),
      ...(typeof body.previewUrl === "string" ? { previewUrl: body.previewUrl } : {}),
      // C3 — accept the optional visual check payload. The browser sends
      // this once the dev server is reachable; we trust the shape (the
      // VisualCheckSnapshot interface) and forward verbatim.
      ...(body.visual && typeof body.visual === "object" ? { visual: body.visual } : {}),
    };
    await putBuildResult(sessionId, snap, config.buildResultsKv);
    return c.json({ ok: true });
  });

  /** GET /build-result — debug readback; the agent uses the tool, not this. */
  app.get("/build-result", async (c) => {
    const sessionId = sessionIdOf(c);
    const snap = await getBuildResult(sessionId, config.buildResultsKv);
    return c.json(snap);
  });

  /** DELETE /build-result — clears stale state on session reset. */
  app.delete("/build-result", async (c) => {
    const sessionId = sessionIdOf(c);
    await clearBuildResult(sessionId, config.buildResultsKv);
    return c.json({ ok: true });
  });

  // ── B1 — Job queue (parallel background runs) ────────────────────────────
  // The runner self-fetches /run with the supplied body. That keeps the
  // queued path bit-identical to the synchronous /run path; if /run grows
  // a feature, jobs inherit it for free.
  //
  // C2 — At run time we override `X-Session-Id` to the derived job session
  // id. The parent's snapshot already lives there (onBeforeStart did the
  // copy), so the agent reads/writes against an isolated KV view; the
  // parent session is untouched until the user calls /jobs/:id/merge.
  function jobRunnerFor(body: Record<string, unknown>, headers: Record<string, string>): JobRunner {
    return async function* (spec, signal, ctx): AsyncIterable<AgentEvent> {
      const parent = spec.sessionId ?? "default";
      const derived = deriveJobSessionId(parent, ctx.jobId);
      const runHeaders = { ...headers, "X-Session-Id": derived };
      const res = await app.fetch(
        new Request("http://localhost/run", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...runHeaders },
          body: JSON.stringify(body),
          signal,
        })
      );
      if (!res.body) {
        throw new Error(`/run returned no body (status ${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // Process complete SSE messages — separated by blank lines.
        let nl = buf.indexOf("\n\n");
        while (nl !== -1) {
          const chunk = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6);
            if (payload === "[DONE]") return;
            try {
              yield JSON.parse(payload) as AgentEvent;
            } catch {
              // Malformed SSE chunk — skip.
            }
          }
          nl = buf.indexOf("\n\n");
        }
      }
    };
  }

  /**
   * POST /jobs — submit one or many tasks for background execution.
   *
   * Body shapes accepted:
   *   { task: "...", agentMode: "tool", ... }                     // single
   *   { jobs: [{ task: "...", ... }, { task: "...", ... }, ...] } // batch
   *
   * Returns `{ jobIds: string[] }` immediately. The agent payload is the same
   * shape /run accepts, minus `task` which is required at the top level of
   * each job.
   */
  app.post("/jobs", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const sessionHeader = c.req.header("X-Session-Id");
    const auth = c.req.header("Authorization");
    const headers: Record<string, string> = {};
    if (sessionHeader) headers["X-Session-Id"] = sessionHeader;
    if (auth) headers.Authorization = auth;

    // Normalise to a list of {task, payload} jobs.
    let entries: Array<Record<string, unknown>>;
    if (Array.isArray((body as { jobs?: unknown }).jobs)) {
      entries = (body as { jobs: unknown[] }).jobs as Array<Record<string, unknown>>;
    } else if (typeof (body as { task?: unknown }).task === "string") {
      entries = [body];
    } else {
      return c.json({ error: "Body must contain `task` or a `jobs[]` array" }, 400);
    }
    if (entries.length === 0) return c.json({ error: "jobs[] is empty" }, 400);
    if (entries.length > 20) return c.json({ error: "too many jobs (max 20 per request)" }, 400);

    const jobIds: string[] = [];
    for (const entry of entries) {
      const task = entry.task;
      if (typeof task !== "string" || !task.length) {
        return c.json({ error: "each job must have a non-empty `task`" }, 400);
      }
      const spec: JobSpec = {
        task,
        ...(sessionHeader ? { sessionId: sessionHeader } : {}),
        payload: entry,
      };
      const id = jobQueue.submit(spec, jobRunnerFor(entry, headers));
      jobIds.push(id);
    }
    return c.json({ jobIds });
  });

  /** GET /jobs — list jobs, optionally filtered by status / sessionId. */
  app.get("/jobs", (c) => {
    const status = c.req.query("status") as
      | "queued"
      | "running"
      | "done"
      | "failed"
      | "aborted"
      | undefined;
    const sessionId = c.req.query("sessionId") ?? c.req.header("X-Session-Id");
    const filter: { status?: typeof status; sessionId?: string } = {};
    if (status) filter.status = status;
    if (sessionId) filter.sessionId = sessionId;
    const jobs = jobQueue.list(filter);
    return c.json({
      jobs,
      stats: {
        running: jobQueue.runningCount,
        pending: jobQueue.pendingCount,
        total: jobs.length,
      },
    });
  });

  /** GET /jobs/:id — full snapshot of one job (with eventTail). */
  app.get("/jobs/:id", async (c) => {
    const job = await jobQueue.get(c.req.param("id"));
    if (!job) return c.json({ error: "job not found" }, 404);
    return c.json(job);
  });

  /** DELETE /jobs/:id — cooperative abort. Returns whether the abort took. */
  app.delete("/jobs/:id", (c) => {
    const ok = jobQueue.abort(c.req.param("id"));
    if (!ok) return c.json({ error: "job not found or already finished" }, 404);
    return c.json({ ok: true });
  });

  // ── C2 — per-job diff / merge ────────────────────────────────────────────
  // After a parallel job finishes, the user reviews its file changes and
  // decides whether to merge them into the parent session. /diff is read-only.
  // /merge applies the changes; conflicts (concurrent base edits since the
  // job started) are returned structured rather than auto-resolved.

  /** GET /jobs/:id/diff — list the file changes the job made vs its snapshot. */
  app.get("/jobs/:id/diff", async (c) => {
    if (!config.filesKv) return c.json({ error: "files KV not bound" }, 503);
    const job = await jobQueue.get(c.req.param("id"));
    if (!job) return c.json({ error: "job not found" }, 404);
    const parent = job.spec.sessionId ?? "default";
    const derived = deriveJobSessionId(parent, job.id);
    const changes = await diffSessions(config.filesKv, derived);
    return c.json({ jobId: job.id, parentSessionId: parent, derivedSessionId: derived, changes });
  });

  /**
   * POST /jobs/:id/merge — apply the job's changes to its parent session.
   * Body: { strategy?: "fail-on-conflict" | "ours" | "theirs", discard?: boolean }
   *
   * On a clean merge with `discard: true` (default true) the derived session
   * and snapshot are removed. On conflicts the derived session is kept so
   * the user can re-run the merge with a different strategy.
   */
  app.post("/jobs/:id/merge", async (c) => {
    if (!config.filesKv) return c.json({ error: "files KV not bound" }, 503);
    const job = await jobQueue.get(c.req.param("id"));
    if (!job) return c.json({ error: "job not found" }, 404);
    if (job.status !== "done") {
      return c.json({ error: `cannot merge a job in state ${job.status}` }, 409);
    }
    let body: { strategy?: MergeStrategy; discard?: boolean } = {};
    try {
      body = await c.req.json();
    } catch {
      // empty body is fine — caller wants defaults.
    }
    const strategy = body.strategy ?? "fail-on-conflict";
    const discard = body.discard ?? true;
    const parent = job.spec.sessionId ?? "default";
    const derived = deriveJobSessionId(parent, job.id);
    const result = await mergeSessions(config.filesKv, parent, derived, strategy);
    const cleanedUp = discard && result.conflicts.length === 0;
    if (cleanedUp) {
      await discardJobSession(config.filesKv, derived).catch(() => undefined);
    }
    return c.json({
      jobId: job.id,
      strategy,
      applied: result.applied,
      conflicts: result.conflicts,
      cleanedUp,
    });
  });

  /**
   * DELETE /jobs/:id/branch — discard the per-job derived session without
   * merging. Use after the user decides the job's output is not worth
   * keeping; frees KV space.
   */
  app.delete("/jobs/:id/branch", async (c) => {
    if (!config.filesKv) return c.json({ error: "files KV not bound" }, 503);
    const job = await jobQueue.get(c.req.param("id"));
    if (!job) return c.json({ error: "job not found" }, 404);
    const parent = job.spec.sessionId ?? "default";
    const derived = deriveJobSessionId(parent, job.id);
    await discardJobSession(config.filesKv, derived).catch(() => undefined);
    return c.json({ ok: true, derivedSessionId: derived });
  });

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
      files.map(({ path, content }) => kv.put(`file:${path.replace(/^\/+/, "")}`, content ?? ""))
    );
    return c.json({ ok: true, count: files.length, paths: files.map((f) => f.path) });
  });

  // ── File version history (v0.dev checkpoint pattern) ─────────────────────
  app.get("/files/:path{.+}/versions", async (c) => {
    const path = c.req.param("path");
    const versions = fileTreeFor(c).getVersions(path);
    return c.json({
      path,
      versions: versions.map((v) => ({ version: v.version, hash: v.hash, savedAtMs: v.savedAtMs })),
    });
  });

  // Fetch the actual content of a specific historical version. Used by the
  // DiffViewer to show before/after content side-by-side.
  app.get("/files/:path{.+}/versions/:version", async (c) => {
    const path = c.req.param("path");
    const versionNum = Number(c.req.param("version"));
    if (Number.isNaN(versionNum)) return c.json({ error: "version must be a number" }, 400);
    const versions = fileTreeFor(c).getVersions(path);
    const target = versions.find((v) => v.version === versionNum);
    if (!target) return c.json({ error: `version ${versionNum} not found` }, 404);
    return c.json({
      path,
      version: target.version,
      content: target.content,
      hash: target.hash,
      savedAtMs: target.savedAtMs,
    });
  });

  app.post("/files/:path{.+}/rollback", async (c) => {
    const path = c.req.param("path");
    const kv = resolveFilesKv(c.req.header("X-Session-Id"), config);
    const { version } = await c.req.json<{ version: number }>();
    const content = fileTreeFor(c).rollback(path, version);
    if (!content) return c.json({ error: `Version ${version} not found for ${path}` }, 404);
    if (kv) await kv.put(`file:${path.replace(/^\/+/, "")}`, content);
    return c.json({ ok: true, path, version, chars: content.length });
  });

  // ── B3 — POST /import/github ─────────────────────────────────────────────
  // Pull every text file in a repository into the worker's KV file store and
  // (when an indexer is bound) feed each file into the semantic index. The
  // agent's existing tools (read_file, search_code, semantic_search,
  // create_github_pr) work on the imported tree without further plumbing.
  app.post("/import/github", async (c) => {
    const filesKv = resolveFilesKv(c.req.header("X-Session-Id"), config);
    if (!filesKv) {
      return c.json({ error: "files KV not bound on this worker" }, 500);
    }
    let body: {
      owner?: string;
      repo?: string;
      ref?: string;
      token?: string;
      paths?: string[];
      textExtensions?: string[];
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (!body.owner || !body.repo) {
      return c.json({ error: "owner and repo are required" }, 400);
    }
    const ambientToken = config.githubToken;
    const indexer = indexerFor(c);
    try {
      const result = await importGithubRepo(
        {
          owner: body.owner,
          repo: body.repo,
          ...(body.ref ? { ref: body.ref } : {}),
          ...((body.token ?? ambientToken) ? { token: body.token ?? ambientToken } : {}),
          ...(body.paths ? { paths: body.paths } : {}),
          ...(body.textExtensions ? { textExtensions: body.textExtensions } : {}),
        },
        {
          filesKv,
          ...(indexer
            ? {
                onFileImported: async (path, content) => {
                  try {
                    await indexer.upsert(path, content);
                  } catch (err) {
                    console.warn(`[import/github] index upsert failed for ${path}:`, err);
                  }
                },
              }
            : {}),
        }
      );
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordError(`/import/github: ${msg}`);
      return c.json({ error: msg }, 502);
    }
  });

  app.post("/files", async (c) => {
    const kv = resolveFilesKv(c.req.header("X-Session-Id"), config);
    const { path, content } = await c.req.json<{ path: string; content: string }>();
    if (!path || content === undefined) return c.json({ error: "path and content required" }, 400);
    try {
      assertWorkspacePath(path);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    if (typeof content === "string" && content.length > MAX_FILE_BYTES) {
      return c.json({ error: `file exceeds ${MAX_FILE_BYTES} bytes` }, 413);
    }
    if (kv) await kv.put(`file:${path.replace(/^\/+/, "")}`, content);
    // Keep FileTreeManager in sync for conflict detection and context relevance
    fileTreeFor(c).recordWrite(path.replace(/^\/+/, ""), content);
    return c.json({ ok: true, path });
  });

  app.get("/files/:path{.+}", async (c) => {
    const kv = resolveFilesKv(c.req.header("X-Session-Id"), config);
    const path = c.req.param("path");
    try {
      assertWorkspacePath(path);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    if (!kv) return c.json({ error: "KV not bound" }, 503);
    const content = await kv.get(`file:${path}`);
    if (content === null) return c.json({ error: "not found" }, 404);
    return c.json({ path, content });
  });

  // DELETE /files — clear ALL workspace files (called before each new framework run)
  app.delete("/files", async (c) => {
    const kv = resolveFilesKv(c.req.header("X-Session-Id"), config);
    if (!kv) return c.json({ error: "KV not bound" }, 503);
    if (typeof kv.delete !== "function") {
      // Fail loud rather than silently no-op — the caller is asking us
      // to clear state and we must not pretend success when we can't.
      return c.json({ error: "KV backend does not support delete" }, 501);
    }
    const list = await kv.list({ prefix: "file:" });
    await Promise.all(list.keys.map((k) => kv.delete?.(k.name)));
    // Also reset the in-memory file tree (and version history) for this
    // session — otherwise stale versions linger after a workspace wipe.
    sessionFileTrees.delete(sessionIdOf(c));
    return c.json({ ok: true, cleared: list.keys.length });
  });

  app.delete("/files/:path{.+}", async (c) => {
    const kv = resolveFilesKv(c.req.header("X-Session-Id"), config);
    const path = c.req.param("path");
    if (!kv) return c.json({ error: "KV not bound" }, 503);
    if (typeof kv.delete !== "function") {
      return c.json({ error: "KV backend does not support delete" }, 501);
    }
    await kv.delete(`file:${path}`);
    // Drop the in-memory entry + its version history so a follow-up
    // GET /files/:path/versions doesn't return phantom versions.
    fileTreeFor(c).remove(path);
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

    // ── C1 — SSE resume fast-path ─────────────────────────────────────────
    // When the client supplies a `resumeTraceId` (last response's
    // X-Agentkit-Trace-Id) AND a `Last-Event-ID` header AND we have a
    // persistence backend, we *only* replay the missing tail. We never
    // start a second agent for the same trace — that would burn tokens
    // and produce duplicate side-effects (file writes, PR pushes, …).
    //
    // If `checkpointsKv` is unbound the resume signal is silently
    // ignored and the request falls through to a fresh run; the client
    // already learned its previous events, so the cost is at most one
    // duplicate run, never event loss.
    const resumeTraceId = body.resumeTraceId;
    const lastEventIdHeader = c.req.header("Last-Event-ID");
    if (resumeTraceId && config.checkpointsKv) {
      return streamResumeReplay(
        adaptKvStoreToBackend(config.checkpointsKv),
        resumeTraceId,
        lastEventIdHeader ?? null,
        config,
        c.req.header("Origin")
      );
    }

    // ── Input validation ─────────────────────────────────────────────────────
    // Validate `agentMode` and `modelId` upfront so callers get a synchronous
    // 400 instead of a streaming-then-failing SSE. The model gateway returns
    // INVALID_MODEL several seconds in, which paints "Done" briefly in the UI
    // before the error event arrives — ugly. Catch unknown values here.
    //
    // Valid agentModes are the four documented in the RunBody type at the
    // bottom of this file. "framework" is NOT a separate mode here — the
    // framework field on the body is what selects scaffolding inside "tool".
    const VALID_MODES = new Set(["code", "tool", "multi", "ptc"]);
    if (agentMode && !VALID_MODES.has(agentMode)) {
      return c.json({ error: `agentMode must be one of: ${[...VALID_MODES].join(", ")}` }, 400);
    }
    if (
      modelId !== undefined &&
      (typeof modelId !== "string" || modelId.length === 0 || modelId.length > 200)
    ) {
      return c.json({ error: "modelId must be a non-empty string under 200 chars" }, 400);
    }

    const clampedSteps = Math.min(maxSteps, MAX_STEPS_CAP);

    // ── Session cache pre-check (fast path, avoids spawning agent) ──────────
    // Only attempt when sessionsKv is available — resolve modelId for hash.
    const sessionsKv = sessionId
      ? config.sessionsKv
        ? new SessionKvStore(config.sessionsKv, sessionId)
        : config.sessionsKv
      : config.sessionsKv;

    if (sessionsKv) {
      // Resolve model just enough to compute the cache key (no expensive init).
      const store = getModelStore(config);
      const primaryModelForHash = await resolveModelFromRegistry(modelId, config, store);
      const resolvedModelId = primaryModelForHash
        ? getModelId(primaryModelForHash)
        : (modelId ?? "unknown");
      const kvKey = await contentHash({
        task,
        agentMode,
        maxSteps: clampedSteps,
        modelId: resolvedModelId,
        enhancement,
        ...((body as unknown as Record<string, unknown>)._testRunId
          ? { _r: (body as unknown as Record<string, unknown>)._testRunId }
          : {}),
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

    // C1 — Per-run trace id surfaces in the response header so the client
    // can echo it back as `resumeTraceId` if the connection drops. It is
    // also used as the EventLog key when checkpointsKv is bound.
    const runTraceId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const eventLog = config.checkpointsKv
      ? new EventLog(adaptKvStoreToBackend(config.checkpointsKv))
      : null;

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
          // Use the per-session FileTreeManager (richer than KV listing — has hashes for conflict detection).
          const sessionTree = sessionFileTrees.get(sessionId ?? "default");
          const fileTree =
            sessionTree && sessionTree.size > 0
              ? sessionTree.formatForPrompt(60)
              : await buildProjectFileTree(filesKv);
          const ctxParts: string[] = ["## Project Files\n" + fileTree];

          // Relevance filtering: include content of files that match task keywords
          // (avoids sending the full workspace to the model for large projects)
          if (filesKv) {
            const relevantFiles = await getRelevantFileContents(filesKv, task, 5, sessionId);
            if (relevantFiles.length > 0) {
              ctxParts.push(
                "## Relevant File Contents\n" +
                  relevantFiles
                    .map((f) => `### ${f.path}\n\`\`\`\n${f.content.slice(0, 800)}\n\`\`\``)
                    .join("\n\n")
              );
            }
          }

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

        const tools = buildTools(
          filesKv,
          useMemory,
          config,
          [
            ...(guardrails?.deniedTools ?? []),
            // Framework mode: block run_command and git tools — WebContainers handles execution
            ...(body.framework
              ? ["run_command", "git_status", "git_diff", "git_log", "git_commit", "git_checkout"]
              : []),
          ],
          fileTreeFor(c),
          indexerFor(c),
          sessionId,
          Boolean(body.framework)
        );
        // B4 — wrap write tools with the configured approval policy.
        const approvalPolicy = resolveApprovalPolicy(body.approvalPolicy);
        const policedTools = approvalPolicy ? applyApprovalPolicy(approvalPolicy, tools) : tools;
        const inputGuardrails = buildInputGuardrails(guardrails);
        const outputGuardrails = buildOutputGuardrails(guardrails);
        // Merge resource budget from request into enhancementPolicy
        const mergedPolicy = {
          ...body.enhancementPolicy,
          ...(body.maxBudgetTokens || body.maxDurationMs
            ? {
                budget: {
                  ...body.enhancementPolicy?.budget,
                  ...(body.maxBudgetTokens ? { maxTokens: body.maxBudgetTokens } : {}),
                  ...(body.maxDurationMs ? { maxDurationMs: body.maxDurationMs } : {}),
                },
              }
            : {}),
        };

        const agentExtras = {
          maxSteps: clampedSteps,
          planningInterval,
          inputGuardrails,
          outputGuardrails,
          framework: body.framework,
          // Enhancement policy with merged resource budget
          enhancementPolicy: Object.keys(mergedPolicy).length > 0 ? mergedPolicy : undefined,
          stopConditions: body.stopConditions,
          chunkSizeSteps: body.chunkSizeSteps,
          systemPrefixTtl: body.systemPrefixTtl,
          scheduler: body.scheduler,
          outputSchemaRetries: body.outputSchemaRetries,
          // C4 — load AGENTS.md (and any nested files) from the workspace and
          // append to the system prompt. We use the agentkit-js KV loader on
          // a thin adapter over the per-session files KV; the resolver caches
          // the catalogue, so the cost is one list per /run.
          projectInstructions: filesKv ? await loadProjectInstructions(filesKv) : "",
          // B4 — always wire a checkpointer so write-class tools whose
          // `needsApproval` evaluates true actually pause for HITL. Without
          // this, agentkit-core silently skips the gate (see the
          // `if (this.#checkpointer)` guard in core/ToolCallingAgent.ts).
          // checkpointerFor(config) is cached per-config and falls back to
          // InMemoryCheckpointer when no KV is bound — strict-policy gating
          // works in any deployment shape.
          checkpointer: checkpointerFor(config),
        };

        let agentRun: AsyncGenerator<AgentEvent>;

        // ── Enhancement runner selection ──────────────────────────────────────
        // Support both legacy flat "enhancement" string and new enhancementPolicy object.
        // enhancementPolicy takes precedence when both are provided.
        const policy = body.enhancementPolicy;
        const useParallelFork = policy?.parallelForkJoin?.enabled;
        const useSelfConsistency =
          policy?.selfConsistency?.enabled ?? enhancement === "self-consistency";
        const useReflectRefine = policy?.reflectRefine?.enabled ?? enhancement === "reflect-refine";
        const useBudgetForcing = policy?.budgetForcing?.enabled ?? enhancement === "budget-forcing";

        if (useSelfConsistency) {
          const n = policy?.selfConsistency?.n ?? 3;
          const threshold = policy?.selfConsistency?.earlyStopThreshold ?? 0.67;
          agentRun = enhancedAgentRun(
            model,
            new SelfConsistencyRunner({ n, earlyStopThreshold: threshold }),
            finalTask
          );
        } else if (useReflectRefine) {
          const maxCycles = policy?.reflectRefine?.maxCycles ?? 2;
          agentRun = enhancedAgentRun(model, new ReflectRefineRunner({ maxCycles }), finalTask);
        } else if (useBudgetForcing) {
          agentRun = enhancedAgentRun(
            model,
            new BudgetForcingRunner({ maxWaitRounds: 2 }),
            finalTask
          );
        } else if (useParallelFork) {
          const { ParallelForkJoinRunner } = await import("@agentkit-js/core");
          const branches = policy?.parallelForkJoin?.branches ?? 3;
          const concurrency = policy?.parallelForkJoin?.concurrency ?? 2;
          const aggregation = policy?.parallelForkJoin?.aggregation ?? "summary";
          agentRun = enhancedAgentRun(
            model,
            new ParallelForkJoinRunner({ branches, concurrency, aggregation }),
            finalTask
          );
        } else if (agentMode === "multi") {
          // B4 resume path — when the client posts a humanResponse + checkpointId
          // we treat this as the second half of a planFirst flow: restore the
          // snapshot, extract the plan from the persisted prompt, run the
          // executor stage with full tools.
          if (body.humanResponse && body.checkpointId) {
            const cpId = body.checkpointId;
            const cp = checkpointerFor(config);
            const snapshot = await cp.load(cpId);
            if (!snapshot) {
              throw new Error(`planFirst resume: no snapshot for checkpointId=${cpId}`);
            }
            if (!snapshot.pendingHumanInput) {
              throw new Error(`planFirst resume: snapshot has no pending human input`);
            }
            // Persist the response so future audits can see what the user said.
            await cp.respond(cpId, body.humanResponse.promptId, body.humanResponse.response);
            // The prompt body is `Approve this plan?\n\n<planText>` — strip the prefix.
            const promptText = snapshot.pendingHumanInput.prompt;
            const planText = promptText.replace(/^Approve this plan\?\s*\n+/i, "").trim();
            agentRun = runPlanFirstExecution(
              model,
              policedTools,
              snapshot.task,
              planText,
              body.humanResponse.response,
              { maxSteps: agentExtras.maxSteps, checkpointer: agentExtras.checkpointer }
            );
          } else {
            const multiAgentExtras: Parameters<typeof multiAgentRun>[3] = {
              maxSteps: agentExtras.maxSteps,
              // B4 — pass the checkpointer through so any inner createToolAgent
              // (reviewer / executor) gates write tools whose needsApproval fires.
              checkpointer: agentExtras.checkpointer,
              ...(body.multiAgentMode ? { mode: body.multiAgentMode } : {}),
              ...(body.multiAgentBranches !== undefined
                ? { branches: body.multiAgentBranches }
                : {}),
              ...(body.multiAgentConcurrency !== undefined
                ? { concurrency: body.multiAgentConcurrency }
                : {}),
            };
            const baseRun = multiAgentRun(model, policedTools, finalTask, multiAgentExtras);
            // planFirst suspends mid-stream via await_human_input — wrap with
            // CheckpointableRun so the snapshot lands in KV before the
            // generator returns. parallel mode skips this overhead.
            if (body.multiAgentMode === "planFirst") {
              const cpId = body.checkpointId ?? finalTask.slice(0, 40);
              const cpTraceId = `planfirst-${cpId}-${Date.now()}`;
              // multiAgentRun does not own a MessageAssembler — pass a fresh
              // one whose .steps[] just records the plan event. CheckpointableRun
              // only reads `assembler.steps` on snapshot persistence.
              const { MessageAssembler } = await import("@agentkit-js/core");
              const planAssembler = new MessageAssembler({ systemPrompt: "", toolsSchema: [] });
              planAssembler.addStep({ type: "user_message", content: finalTask });
              const cpRun = new CheckpointableRun(
                { checkpointer: checkpointerFor(config) },
                planAssembler
              );
              agentRun = cpRun.run(baseRun, finalTask, cpTraceId);
            } else {
              agentRun = baseRun;
            }
          }
        } else if (agentMode === "ptc") {
          agentRun = ptcAgentRun(model, policedTools, finalTask, codeLanguage, config);
        } else {
          const agent =
            agentMode === "tool"
              ? createToolAgent(model, policedTools, agentExtras)
              : createCodeAgent(model, policedTools, {
                  ...agentExtras,
                  codeLanguage,
                  e2bApiKey: config.e2bApiKey,
                });

          // Inject conversation history as prior user_message + assistant steps
          // so the agent has multi-turn context within its MessageAssembler.
          if (body.conversationHistory?.length) {
            for (const turn of body.conversationHistory) {
              agent.assembler.addStep({ type: "user_message", content: turn.content });
            }
          }

          // Auto-compact: if history is long, summarise it before the new task.
          // Triggered when autoCompactThreshold is set and the assembled messages
          // would exceed that token count (estimated). Keeps latency low by
          // compressing the earliest chunks into a summary.
          if (body.autoCompactThreshold && body.autoCompactThreshold > 0) {
            const msgs = agent.assembler.build();
            const { estimateMessagesTokens } = await import("@agentkit-js/core");
            const estimatedTokens = estimateMessagesTokens(msgs);
            if (estimatedTokens > body.autoCompactThreshold) {
              await agent.assembler.compact(model);
              console.log(`[auto-compact] compressed history from ~${estimatedTokens} tokens`);
            }
          }

          if (useCheckpoint) {
            const cpId = checkpointId ?? finalTask.slice(0, 40);
            const cpTraceId = `cp-${cpId}-${Date.now()}`;
            const cpRun = new CheckpointableRun(
              { checkpointer: checkpointerFor(config) },
              agent.assembler
            );
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
              task: finalTask,
              agentMode,
              maxSteps: clampedSteps,
              modelId: resolvedModelId,
              enhancement,
              ...((body as unknown as Record<string, unknown>)._testRunId
                ? { _r: (body as unknown as Record<string, unknown>)._testRunId }
                : {}),
            })
          : null;

        // Stream live events. When `eventLog` is bound, we tap the agent
        // generator so every event is persisted under `evlog:<runTraceId>:`
        // before it leaves the writer; SSE frames carry the matching `id:`
        // line via formatSseFrame() so a reconnecting client can resume
        // exactly past the last id it saw.
        const allEvents: AgentEvent[] = [];
        let success = false;
        if (eventLog) {
          for await (const logged of eventLog.tap(agentRun, runTraceId)) {
            await writer.write(encoder.encode(formatSseFrame(logged)));
            const event = logged.event;
            if (
              kvKey &&
              sessionsKv &&
              (event.event === "final_answer" || allEvents.length < MAX_KV_EVENTS)
            )
              allEvents.push(event);
            if (event.event === "final_answer") success = true;
          }
        } else {
          // No checkpointsKv bound — keep the original best-effort path.
          // Clients still get every event live; only resume is unavailable.
          for await (const event of agentRun) {
            await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            if (
              kvKey &&
              sessionsKv &&
              (event.event === "final_answer" || allEvents.length < MAX_KV_EVENTS)
            )
              allEvents.push(event);
            if (event.event === "final_answer") success = true;
          }
        }
        await writer.write(encoder.encode("data: [DONE]\n\n"));
        if (kvKey && sessionsKv && success)
          await sessionsKv
            .put(kvKey, JSON.stringify(allEvents), { expirationTtl: SESSION_TTL })
            .catch(console.error);

        // Successful completion → purge the persisted EventLog. Resume only
        // makes sense for in-flight runs; a finished run has nothing left
        // to deliver, and leaving the entries around grows KV unboundedly.
        if (eventLog && success) {
          eventLog.purge(runTraceId).catch(() => {
            /* best-effort cleanup */
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const stack =
          err instanceof Error && err.stack
            ? err.stack.split("\n").slice(0, 4).join("\n")
            : undefined;
        recordError(msg, stack);
        // The error frame is a terminal event — clients stop after seeing
        // it, so it does not need an EventLog id to enable resume. Write
        // the bare data frame and let the resumed client (if any) replay
        // up to whatever was persisted before the throw.
        await writer.write(
          encoder.encode(
            `data: ${JSON.stringify({ event: "error", data: { error: msg, ...(stack ? { stack } : {}) } })}\n\n`
          )
        );
      } finally {
        await writer.close().catch(() => {});
      }
    })();

    const allowOrigin =
      (config.allowedOrigin ?? "*") === "*"
        ? "*"
        : (c.req.header("Origin") ?? "") === config.allowedOrigin
          ? (config.allowedOrigin ?? "null")
          : "null";

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": allowOrigin,
        "Access-Control-Allow-Private-Network": "true",
        // C1 — surface the trace id so the client can echo it back as
        // `resumeTraceId` on reconnect. Must be in expose-headers so a
        // CORS request can read it from JS.
        "X-Agentkit-Trace-Id": runTraceId,
        "Access-Control-Expose-Headers": "X-Agentkit-Trace-Id",
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

    const scorerMap: Record<string, Scorer> = {
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

  // ── B4 — Approval policy ────────────────────────────────────────────────────
  /**
   * Per-call approval policy for write tools. Accepts:
   *   - "permissive" / "balanced" / "strict" — preset name; OR
   *   - an ApprovalPolicyOptions literal — custom rules
   * Defaults to "permissive" (no rule overrides), preserving the legacy
   * behaviour where only `create_github_pr` was HITL-gated.
   */
  approvalPolicy?: "permissive" | "balanced" | "strict" | ApprovalPolicyOptions;

  // ── B1+B4 — Multi-agent shape ───────────────────────────────────────────
  /**
   * When agentMode === "multi", controls the runner shape:
   *   - "parallel"  (default) — fork-join draft → reviewer with full tools.
   *   - "planFirst" — planner → await_human_input → executor with full tools.
   * The planFirst flow PAUSES the run; the client resumes by re-POSTing
   * /run with humanResponse + the original checkpointId.
   */
  multiAgentMode?: MultiAgentMode;
  /** Number of fork-join branches in parallel mode (default 3). */
  multiAgentBranches?: number;
  /** Concurrency cap for the fork-join (default 2). */
  multiAgentConcurrency?: number;

  // ── B4 — humanResponse resume payload (planFirst) ───────────────────────
  /**
   * Approval / amendment text from the user, posted on the SECOND /run
   * call when resuming a planFirst run. Must be paired with the original
   * checkpointId so the worker can locate the snapshot and apply the
   * response before kicking off the executor stage.
   */
  humanResponse?: { promptId: string; response: string };

  // ── Enhancement policy (replaces flat "enhancement" string for new features) ──
  /** Inline enhancement policy — configures runners with custom parameters */
  enhancementPolicy?: import("@agentkit-js/core").EnhancementPolicy;

  // ── Stop conditions (new) ────────────────────────────────────────────────────
  /** Stop condition descriptors: "noProgress", "stepCount:<n>", "costBudget:<maxUSD>" */
  stopConditions?: string[];

  // ── Prompt-cache tuning (new) ────────────────────────────────────────────────
  /** Seal a B2 cache breakpoint every N action steps (default: 5) */
  chunkSizeSteps?: number;
  /** Cache TTL for the system prompt prefix (default: "1h") */
  systemPrefixTtl?: "5m" | "1h";

  // ── Scheduler override (new) ─────────────────────────────────────────────────
  scheduler?: "dag" | "parallel";

  // ── Conversation context (new) ───────────────────────────────────────────────
  /** Previous turns to inject as context — enables multi-turn conversation */
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;

  // ── Resource budget (new) ────────────────────────────────────────────────────
  /** Maximum total tokens (input+output) before agent stops automatically */
  maxBudgetTokens?: number;
  /** Maximum wall-clock milliseconds before agent stops */
  maxDurationMs?: number;

  // ── Auto-compact (new) ────────────────────────────────────────────────────────
  /** Auto-compact history when context exceeds this many tokens (default: off) */
  autoCompactThreshold?: number;

  // ── Structured output schema (v0/Lovable pattern) ─────────────────────────────
  /**
   * Zod schema descriptor for structured output validation.
   * When set, ToolCallingAgent validates final_answer against this schema and
   * retries up to outputSchemaRetries times on mismatch.
   * Pass as a JSON Schema object: {"type":"object","properties":{"name":{"type":"string"}}}
   */
  outputJsonSchema?: Record<string, unknown>;
  outputSchemaRetries?: number;

  // ── C1 — SSE Last-Event-ID resume ─────────────────────────────────────────
  /**
   * Trace id from a previous /run response (header `X-Agentkit-Trace-Id`).
   * When set together with the `Last-Event-ID` request header, the worker
   * skips starting a new agent and instead replays the persisted EventLog
   * for that trace, delivering only entries with id > Last-Event-ID. This
   * lets a client survive a worker recycle, a network blip, or a tab
   * reload mid-run without losing events or duplicating them.
   *
   * Requires `checkpointsKv` to be bound — otherwise the worker has no
   * place to read the persisted log from and falls back to a fresh run.
   */
  resumeTraceId?: string;
}

function getModelId(model: Model): string {
  return (model as { modelId?: string }).modelId ?? "unknown";
}

function resolveFilesKv(sessionId: string | undefined, config: AppConfig): KvStore | undefined {
  if (!config.filesKv) return undefined;
  if (sessionId) return new SessionKvStore(config.filesKv, sessionId);
  return config.filesKv;
}

/**
 * C4 — Load AGENTS.md project instructions from the (per-session) files KV.
 * Returns the empty string when no AGENTS.md exists anywhere in the workspace —
 * stable shape for the system prompt so prompt-cache keys don't drift between
 * "has instructions" and "doesn't" runs.
 */
async function loadProjectInstructions(filesKv: KvStore): Promise<string> {
  const loader = makeKvAgentsMdLoader(adaptKvStoreToBackend(filesKv));
  const project = new ProjectInstructions({ loader });
  // For now we always resolve at the repo root. A future refinement could
  // pass the path of the file the agent is about to edit (when known) so
  // nested AGENTS.md files take precedence — this requires plumbing the
  // current edit target through /run, which is bigger than C4 needs.
  const out = await project.forRepo();
  return out.text;
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
  deniedTools?: string[],
  fileTree?: FileTreeManager,
  indexer?: SemanticIndexer,
  // B2 — session id for the build-result reverse channel. Optional so
  // out-of-band paths (eg /eval) can keep calling buildTools unchanged.
  sessionId?: string,
  isFramework?: boolean
): ToolDefinition[] {
  const shellRunner = createShellRunner(config);
  const tools: ToolDefinition[] = [
    createReadFileTool(filesKv),
    createListFilesTool(filesKv),
    createSearchCodeTool(filesKv),
    createWriteFileTool(filesKv, fileTree, indexer),
    createPatchFileTool(filesKv, indexer),
    createDeleteFileTool(filesKv, indexer),
    createRenameFileTool(filesKv, indexer),
    createRunCommandTool(shellRunner),
    createWebSearchTool(),
    // C4 — init_agents_md drafts a project AGENTS.md; needsApproval=true
    // forces it through the planFirst HITL gate so it does not silently
    // land on disk (research showed LLM-authored AGENTS.md degrades 5/8
    // benchmarks when written without review).
    createInitAgentsMdTool(filesKv),
    ...createGitTools(config),
  ];
  // B2 — read_build_result tool registered in framework mode where the
  // browser is the only execution surface. Outside framework mode the
  // agent has run_command, so the build-result channel is redundant.
  if (isFramework && sessionId) {
    tools.push(createReadBuildResultTool({ sessionId, kv: config.buildResultsKv }));
    // C3 — visual_verify / visual_interact pair. Always registered when
    // we're in framework mode + have a sessionId, even when no CDP
    // endpoint is configured: the tools degrade to a "not configured"
    // snapshot rather than throwing, and the agent learns it can't rely
    // on visual checks via the same channel as everything else.
    const resolvePreviewUrl = async () => {
      const snap = await getBuildResult(sessionId, config.buildResultsKv);
      return snap.previewUrl;
    };
    tools.push(
      createVisualVerifyTool({
        sessionId,
        ...(config.buildResultsKv ? { buildResultsKv: config.buildResultsKv } : {}),
        ...(config.cdpWsEndpoint ? { cdpWsEndpoint: config.cdpWsEndpoint } : {}),
        resolvePreviewUrl,
      }) as ToolDefinition
    );
    tools.push(
      createVisualInteractTool({
        sessionId,
        ...(config.buildResultsKv ? { buildResultsKv: config.buildResultsKv } : {}),
        ...(config.cdpWsEndpoint ? { cdpWsEndpoint: config.cdpWsEndpoint } : {}),
        resolvePreviewUrl,
      }) as ToolDefinition
    );
  }
  // B2 — semantic search registered when an indexer is present.
  if (indexer) tools.push(createSemanticSearchTool(indexer));
  // B4 — versioning tools registered when a per-session FileTreeManager is present.
  if (fileTree) {
    tools.push(createListFileVersionsTool(fileTree));
    tools.push(createRevertFileTool(filesKv, fileTree, indexer));
  }
  // B3 — GitHub PR loop registered when KV is bound. needsApproval=true means
  // the agent's HITL gate (A3) catches it before the push happens.
  if (filesKv) {
    const ambientToken = config.githubToken;
    tools.push(
      createGitHubPrTool({
        filesKv,
        ...(ambientToken !== undefined && { ambientToken }),
      })
    );
  }
  // P4: filter out denied tools
  const filteredTools = deniedTools?.length
    ? tools.filter((t) => !deniedTools.includes(t.name))
    : tools;
  if (useMemory) {
    const memTool = createMemoryTool({ backend: globalMemoryBackend });
    // BUG FIX: previously this was `tools.push(...)` which mutated the
    // pre-filter array; the returned `filteredTools` never included
    // the memory tool, so the model never saw it and the agent
    // claimed "I don't have a memory tool available".
    filteredTools.push({
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

/**
 * B4 — Translate the per-call `approvalPolicy` field into an
 * ApprovalPolicy instance. Returns `null` for "permissive" / undefined
 * so the caller can short-circuit and skip the wrap.
 */
function resolveApprovalPolicy(spec: RunBody["approvalPolicy"]): ApprovalPolicy | null {
  if (spec === undefined || spec === "permissive") return null;
  if (spec === "balanced") return PolicyPresets.balanced();
  if (spec === "strict") return PolicyPresets.strict();
  return new ApprovalPolicy(spec);
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
  runner:
    | SelfConsistencyRunner
    | ReflectRefineRunner
    | BudgetForcingRunner
    | ParallelForkJoinRunner,
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

function _agentEventStream(
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

/**
 * C1 — Replay-only response for an SSE reconnect.
 *
 * Reads persisted events from the EventLog under `runTraceId`, skips
 * everything ≤ `lastEventId` (the value the client received in the
 * `Last-Event-ID` request header), and streams the remainder using
 * canonical SSE frames (id: + data:). Always finishes with `data: [DONE]`
 * so the client transitions back to "complete" or "interrupted" state
 * deterministically.
 *
 * If the trace has no persisted entries (purged / never existed) we
 * still send `[DONE]` — better than hanging the client forever. The
 * client distinguishes "all caught up" from "trace unknown" by the
 * absence of the X-Agentkit-Trace-Id echo (we don't set it on resume).
 */
function streamResumeReplay(
  kv: ReturnType<typeof adaptKvStoreToBackend>,
  runTraceId: string,
  lastEventId: string | null,
  config: AppConfig,
  origin: string | undefined
): Response {
  const log = new EventLog(kv);
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  (async () => {
    // Flush headers immediately — same rationale as the live /run path.
    await writer.write(encoder.encode(": resume\n\n"));
    try {
      for await (const logged of log.replay(runTraceId, lastEventId)) {
        await writer.write(encoder.encode(formatSseFrame(logged)));
      }
      await writer.write(encoder.encode("data: [DONE]\n\n"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await writer.write(
        encoder.encode(
          `data: ${JSON.stringify({ event: "error", data: { error: `resume failed: ${msg}` } })}\n\n`
        )
      );
    } finally {
      await writer.close().catch(() => {});
    }
  })();

  const allowOrigin =
    (config.allowedOrigin ?? "*") === "*"
      ? "*"
      : (origin ?? "") === config.allowedOrigin
        ? (config.allowedOrigin ?? "null")
        : "null";

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Private-Network": "true",
      // Echo the trace id so the client confirms we accepted the resume.
      "X-Agentkit-Trace-Id": runTraceId,
      "X-Bscode-Resume": "1",
      "Access-Control-Expose-Headers": "X-Agentkit-Trace-Id, X-Bscode-Resume",
    },
  });
}

/**
 * Return up to maxFiles files whose names or content keywords overlap with the task text.
 * Simple keyword matching — avoids sending the full workspace for large projects.
 */
async function getRelevantFileContents(
  kv: KvStore,
  task: string,
  maxFiles = 5,
  sessionId: string | undefined = undefined
): Promise<{ path: string; content: string }[]> {
  // Resolve a per-session FileTreeManager — falls back to "default"
  // for legacy callers that don't propagate the session id (e.g. CLI).
  const id = sessionId ?? "default";
  let tree = sessionFileTrees.get(id);
  if (!tree) {
    tree = new FileTreeManager();
    sessionFileTrees.set(id, tree);
  }
  // Hydrate from KV if it's empty
  if (tree.size === 0) {
    const list = await kv.list({ prefix: "file:" });
    const entries = await Promise.all(
      list.keys
        .filter((k) => !k.name.startsWith("file:session:") && !k.name.startsWith("file:meta:"))
        .slice(0, 200) // cap at 200 files
        .map(async (k) => {
          const path = k.name.replace(/^file:/, "");
          const content = await kv.get(k.name);
          return content !== null ? { path, content } : null;
        })
    );
    tree.hydrate(entries.filter(Boolean) as { path: string; content: string }[]);
  }

  // Use FileTreeManager's semantic scoring (path + content keywords + recency)
  const scored = tree.getRelevantFiles(task, maxFiles, 2000);
  return scored.map((f) => ({ path: f.path, content: f.content }));
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

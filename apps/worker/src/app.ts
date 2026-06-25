import { InMemoryCheckpointer, KvCheckpointer, MapKvBackend } from "@wasmagent/core";
import { FileTreeManager } from "@wasmagent/core/beta";
import { Hono } from "hono";
import pkg from "../package.json" with { type: "json" };
import { JobQueue } from "./jobs/index.js";
import { deriveJobSessionId, discardJobSession, snapshotSession } from "./jobs/jobBranches.js";
import { createMcpFetchHandler } from "./mcp.js";
import { createAuthMiddleware } from "./middleware/auth.js";
import { createRateLimiter } from "./middleware/rateLimit.js";
import type { AppConfig, KvStore } from "./platform.js";
import { SessionKvStore } from "./platform.js";
import { mountBuildResultRoutes } from "./routes/buildResult.js";
import { mountFilesRoutes } from "./routes/files.js";
import { mountJobRoutes } from "./routes/jobs.js";
import { mountMcpDemoRoutes } from "./routes/mcpDemo.js";
import { mountModelRoutes } from "./routes/models.js";
import { mountPromptRoutes } from "./routes/prompt.js";
import { mountRunRoutes } from "./routes/run.js";
import { registerEvidenceRoutes } from "./routes/evidence.js";
import { createSemanticIndexer, importGithubRepo, type SemanticIndexer } from "./tools/index.js";

export type { AppConfig } from "./platform.js";

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

// In-process shared state (resets on server restart)
const globalMemoryBackend = new MapKvBackend();
/**
 * B1 — Adapter from bscode's KvStore (CF KVNamespace-shape) to wasmagent's
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

const SESSION_ID_RE = /^[a-zA-Z0-9._#-]{8,128}$/;

function parseSessionId(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return SESSION_ID_RE.test(trimmed) ? trimmed : null;
}

function sessionIdOf(
  c: { req: { header: (n: string) => string | undefined } },
  config?: AppConfig
): string {
  const raw = c.req.header("X-Session-Id");
  const id = parseSessionId(raw);
  if (id) return id;
  if (raw && !id) throw new Error("invalid X-Session-Id format");
  if (config?.allowLocalSessionFallback) return "default";
  throw new Error("X-Session-Id required");
}

function fileTreeFor(
  c: { req: { header: (n: string) => string | undefined } },
  config: AppConfig
): FileTreeManager {
  const id = sessionIdOf(c, config);
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

function resolveFilesKv(sessionId: string | undefined, config: AppConfig): KvStore | undefined {
  if (!config.filesKv) return undefined;
  if (sessionId) return new SessionKvStore(config.filesKv, sessionId);
  if (config.allowLocalSessionFallback) return new SessionKvStore(config.filesKv, "default");
  throw new Error("resolveFilesKv: sessionId is required");
}

const buildResultNonces = new Map<
  string,
  { sessionId: string; jobId: string; expiresAt: number }
>();

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
    concurrency: config.rolloutConcurrency ?? 4,
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
  let sharedEmbedder: import("@wasmagent/core").Embedder | undefined;
  if (config.embedding) {
    // Lazy import keeps tools-rag out of the bundle when the consumer
    // never sets EMBEDDING_API_KEY. The dynamic import is awaited inside
    // the indexerFor() factory the first time it's called.
    sharedEmbedder = undefined; // resolved on first use
  }
  const indexerFor: IndexerFor = (c) => {
    const id = sessionIdOf(c, config);
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
        const { HttpEmbedder } = await import("@wasmagent/tools-rag");
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
  // Production safety: if BSCODE_ALLOWED_ORIGIN is unset or contains
  // localhost/127.0.0.1 in production mode, restrict to same-origin only.
  const isProduction = !config.allowLocalSessionFallback;
  const configuredOrigin = config.allowedOrigin;
  const localhostPattern = /localhost|127\.0\.0\.1/i;
  let _corsWarnedOnce = false;

  app.use("*", async (c, next) => {
    let allowed: string;

    if (isProduction && (!configuredOrigin || localhostPattern.test(configuredOrigin))) {
      // Log the warning once per app instance.
      if (!_corsWarnedOnce) {
        _corsWarnedOnce = true;
        console.warn(
          "WARN: BSCODE_ALLOWED_ORIGIN includes localhost in production — restricting to same-origin only"
        );
      }
      // Derive same-origin from the request's Host header.
      const host = c.req.header("Host") ?? "";
      const proto = c.req.header("X-Forwarded-Proto") ?? "https";
      allowed = host ? `${proto}://${host}` : "null";
    } else {
      allowed = configuredOrigin ?? "*";
    }

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
  app.use("*", createAuthMiddleware(config));

  // ── Rate limiting — POST /run only ────────────────────────────────────────
  app.use("*", createRateLimiter({ rateKv: config.rateKv }));

  // ── Session enforcement — reject missing/malformed X-Session-Id early ─────
  // OPTIONS are already handled by the CORS middleware above (returns 204).
  // Health and metrics are public. All paths under /files, /run, /build-result,
  // /jobs, /checkpoints, and /rollouts require a valid session header.
  const SESSION_EXEMPT_PATHS = new Set(["/health", "/metrics"]);
  app.use("*", async (c, next) => {
    if (c.req.method === "OPTIONS") return next();
    const path = new URL(c.req.url).pathname;
    if (SESSION_EXEMPT_PATHS.has(path)) return next();
    const needsSession = /^\/(files|run|build-result|jobs|checkpoints|rollouts)/.test(path);
    if (!needsSession) return next();
    const raw = c.req.header("X-Session-Id");
    if (!raw && !config.allowLocalSessionFallback) {
      return c.json({ error: "X-Session-Id header required" }, 400);
    }
    if (raw && !parseSessionId(raw)) {
      return c.json({ error: "invalid X-Session-Id format (8-128 alphanumeric/._#-)" }, 400);
    }
    return next();
  });

  // ── Health ────────────────────────────────────────────────────────────────
  app.get("/health", (c) =>
    c.json({ status: "ok", version: pkg.version, timestamp: new Date().toISOString() })
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

  // ── /mcp-demo — MCP Firewall attack demo ─────────────────────────────────
  mountMcpDemoRoutes(app);

  // ── Capabilities ──────────────────────────────────────────────────────────
  app.get("/capabilities", (c) =>
    c.json({
      agentModes: ["code", "tool", "multi", "ptc", "goalDirected"],
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

  // ── Prompt routes (enhance-prompt, clarify, generate-from-schema, classify) ─
  mountPromptRoutes(app, config);

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
  mountBuildResultRoutes(app, config, { buildResultNonces, sessionIdOf });

  // ── B1 — Job queue (parallel background runs) ────────────────────────────
  // ── Job routes (/jobs, /rollouts/export) ─────────────────────────────────
  mountJobRoutes(app, config, {
    jobQueue,
    buildResultNonces,
    sessionIdOf,
    resolveFilesKv,
    app,
  });

  // ── Error log (last 50 agent errors for debugging) ────────────────────────
  app.get("/errors", (c) => c.json({ errors: [...errorLog].reverse(), count: errorLog.length }));

  // ── Model Registry ────────────────────────────────────────────────────────
  mountModelRoutes(app, config);

  // ── Files ─────────────────────────────────────────────────────────────────
  mountFilesRoutes(app, config, { sessionFileTrees, resolveFilesKv, sessionIdOf, fileTreeFor });

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

  // ── POST /run + POST /eval ────────────────────────────────────────────────
  mountRunRoutes(app, config, {
    sessionIdOf,
    resolveFilesKv,
    sessionFileTrees,
    indexerFor,
    recordError,
    fileTreeFor,
    checkpointerFor,
    adaptKvStoreToBackend,
  });

  // ── GET /evidence/:runId — AEP evidence bundle export ─────────────────────
  registerEvidenceRoutes(app, config.sessionsKv);

  return app;
}

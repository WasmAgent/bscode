/**
 * Platform-agnostic KV store interface.
 * Shared between CF Workers runtime and Node.js dev server.
 * This file intentionally has NO node:* imports so it can be
 * included in both the CF Workers tsconfig and the Node tsconfig.
 */
export interface KvStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  list(opts: { prefix: string }): Promise<{ keys: { name: string }[] }>;
  delete?(key: string): Promise<void>;
}

/**
 * AppConfig — runtime configuration injected by the server layer.
 * Kept here (no node:* imports) so it can be type-checked under
 * the CF Workers tsconfig.
 */
export interface AppConfig {
  anthropicApiKey?: string;
  anthropicBaseUrl?: string;
  anthropicAuthToken?: string;
  doubaoApiKey?: string;
  /**
   * Volcengine Ark base URL override.
   * Default: https://ark.cn-beijing.volces.com/api/v3
   * Use to point at a regional endpoint or internal proxy.
   */
  doubaoBaseUrl?: string;
  deepseekApiKey?: string;
  /**
   * DeepSeek base URL override.
   * Default: https://api.deepseek.com/v1
   */
  deepseekBaseUrl?: string;
  /** Zhipu GLM API key (open.bigmodel.cn). Also covers GLM Coding Plan. */
  glmApiKey?: string;
  /**
   * GLM base URL override. Defaults to https://open.bigmodel.cn/api/paas/v4.
   * GLM Coding Plan (OpenAI protocol): https://open.bigmodel.cn/api/coding/paas/v4
   * GLM via Anthropic protocol: set this to https://open.bigmodel.cn/api/anthropic
   *   and use AnthropicModel with this baseUrl instead of ZhipuModel.
   */
  glmBaseUrl?: string;
  e2bApiKey?: string;
  clientToken?: string;
  allowedOrigin?: string;
  filesKv?: KvStore;
  sessionsKv?: KvStore;
  /**
   * B1 — Optional KV store for durable agent checkpoints. When set, every
   * agent step + every await_human_input is persisted; a CF worker recycle
   * or container restart no longer loses the run. Falls back to in-memory
   * when undefined (suitable for short-lived dev sessions).
   */
  checkpointsKv?: KvStore;
  /**
   * B2 — Optional KV store for browser-reported build results. When the
   * browser-side WebContainer finishes install/build/test it POSTs the
   * outcome to /build-result; the worker mirrors it here so a recycle does
   * not drop the snapshot. Falls back to in-memory only when undefined.
   */
  buildResultsKv?: KvStore;
  /**
   * B3 follow-up — Optional embedder configuration. When all three fields
   * are set, the worker constructs an OpenAI-API-shape HttpEmbedder and
   * uses it for semantic search instead of the default TF-IDF embedder.
   * When any field is missing, the worker silently falls back to TF-IDF.
   */
  embedding?: {
    apiKey: string;
    baseUrl: string;
    model: string;
  };
  /**
   * B3 — Optional GitHub personal access token used as a fallback by
   * `create_github_pr`. Per-call `token` in the tool input always wins.
   */
  githubToken?: string;
  enableShell?: boolean;
  workdir?: string;
  /**
   * C3 — Optional Chrome DevTools Protocol WebSocket endpoint. When set,
   * `visual_verify` and `visual_interact` drive a CDP session against the
   * preview URL to capture screenshots / DOM probes / console events.
   * When unset, both tools degrade to a "not configured" snapshot rather
   * than throwing — the agent loop keeps working.
   *
   * Cloudflare Browser Rendering, a Docker-hosted Chromium with
   * `--remote-debugging-port`, or `chrome --remote-debugging-port=9222`
   * locally all qualify.
   */
  cdpWsEndpoint?: string;
  /**
   * RLAIF — Maximum concurrent rollout jobs for batch trajectory collection.
   * Passed to JobQueue concurrency; default 4.
   */
  rolloutConcurrency?: number;
  /**
   * When true, /mcp and /mcp/* are accessible without the clientToken. Use only
   * for intentionally public read-only MCP deployments.
   *
   * WARNING: Setting this to true exposes the /mcp endpoint publicly. The MCP
   * handler MUST be given a dedicated read-only KV binding (`publicReadKv`) —
   * it MUST NOT share the deployment-level `filesKv`. If `publicReadKv` is not
   * set while `publicMcpEnabled` is true, the /mcp endpoint returns 503.
   *
   * Default: false (MCP is protected by the same clientToken as all other endpoints).
   *
   * To explicitly enable, set DANGEROUSLY_EXPOSE_DEPLOYMENT_KV=true in the worker
   * environment (see wrangler.toml comments). Never do this without also binding
   * BSCODE_PUBLIC_READ_KV to a separate, read-only KV namespace.
   */
  publicMcpEnabled?: boolean;
  /**
   * P0-4: Dedicated read-only KV for the public /mcp endpoint. Must be a
   * separate KV namespace from `filesKv` so public MCP reads cannot access
   * deployment-level session data.
   *
   * When `publicMcpEnabled` is true and this is unset, /mcp returns 503.
   * When `publicMcpEnabled` is false (default), this field is unused.
   */
  publicReadKv?: KvStore;
  /**
   * P0-5: When true, auth enforcement is in strict mode. Combining this with
   * `allowLocalSessionFallback=true` causes `checkProductionConfig` to throw
   * at startup (rather than silently failing open). Set via STRICT_AUTH=true
   * in the worker environment. Default: false.
   */
  strictAuth?: boolean;
  /**
   * P1-7: When true, the server issues session tokens that are cryptographically
   * bound to the authenticated principal. X-Session-Id values created by one
   * principal cannot be used by a different principal. Default: false (legacy
   * mode — session IDs are not principal-bound).
   */
  principalBoundSessions?: boolean;
  /**
   * When true, the /rollouts/export endpoint is enabled for training data export.
   * Must be explicitly set by the operator — never inferred from usage.
   * Set via TRAINING_DATA_MODE=true in the worker environment.
   */
  trainingDataMode?: boolean;
  /**
   * When true, requests missing X-Session-Id fall back to "default" instead
   * of returning 400. Use only for local CLI/dev flows. Never set in production.
   */
  allowLocalSessionFallback?: boolean;
  /**
   * Optional KV store for per-session rate limiting on POST /run.
   * Keys use the format `rate:<session_id>:<minute_bucket>` with a 120s TTL.
   * When unset, rate limiting is disabled (a warning is logged once).
   * Reads BSCODE_RATE_LIMIT_RPM (default 60) and BSCODE_RATE_LIMIT_BURST
   * (default 10) from the environment.
   */
  rateKv?: KvStore;
}

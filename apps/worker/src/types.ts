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
  deepseekApiKey?: string;
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
}

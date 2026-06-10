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
  enableShell?: boolean;
  workdir?: string;
}

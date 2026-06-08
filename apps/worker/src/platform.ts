/**
 * Platform-agnostic KV store interface.
 * Cloudflare Workers: backed by KVNamespace.
 * Node.js dev server: backed by in-memory Map (MemKvStore).
 */
export interface KvStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  list(opts: { prefix: string }): Promise<{ keys: { name: string }[] }>;
}

/** Wraps a Cloudflare KVNamespace as a KvStore. */
export function kvFromNamespace(ns: KVNamespace): KvStore {
  return {
    get: (key) => ns.get(key, "text"),
    put: (key, value, opts) => ns.put(key, value, opts),
    list: (opts) => ns.list(opts),
  };
}

/** In-memory KV store for local Node.js development. */
export class MemKvStore implements KvStore {
  readonly #store = new Map<string, { value: string; expiresAt?: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.#store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.#store.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    this.#store.set(key, {
      value,
      expiresAt: opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : undefined,
    });
  }

  async list(opts: { prefix: string }): Promise<{ keys: { name: string }[] }> {
    const keys = [...this.#store.keys()]
      .filter((k) => k.startsWith(opts.prefix))
      .map((name) => ({ name }));
    return { keys };
  }
}

/** Config passed to createApp() — platform-independent. */
export interface AppConfig {
  anthropicApiKey?: string;
  anthropicBaseUrl?: string;
  anthropicAuthToken?: string;
  doubaoApiKey?: string;
  deepseekApiKey?: string;
  clientToken?: string;
  allowedOrigin?: string;
  filesKv?: KvStore;
  sessionsKv?: KvStore;
}

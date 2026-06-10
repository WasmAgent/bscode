import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppConfig, KvStore } from "./types.js";

export type { AppConfig, KvStore };

/** Wraps a Cloudflare KVNamespace as a KvStore. */
export function kvFromNamespace(ns: KVNamespace): KvStore {
  return {
    get: (key) => ns.get(key, "text"),
    put: (key, value, opts) => ns.put(key, value, opts),
    list: (opts) => ns.list(opts),
    delete: (key) => ns.delete(key),
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

  async delete(key: string): Promise<void> {
    this.#store.delete(key);
  }
}

/**
 * File-system backed KV store for Bun local development.
 * Maps KV keys to files under a root directory.
 * Key "file:src/index.ts" → root/src/index.ts
 */
export class FsKvStore implements KvStore {
  constructor(private readonly root: string) {}

  #toPath(key: string): string {
    // Strip "file:" prefix, prevent path traversal
    const rel = key.replace(/^file:/, "").replace(/\.\.\//g, "");
    return join(this.root, rel);
  }

  async get(key: string): Promise<string | null> {
    try {
      return await readFile(this.#toPath(key), "utf8");
    } catch {
      return null;
    }
  }

  async put(key: string, value: string): Promise<void> {
    const p = this.#toPath(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, value, "utf8");
  }

  async list(opts: { prefix: string }): Promise<{ keys: { name: string }[] }> {
    const prefix = opts.prefix.replace(/^file:/, "");
    const base = join(this.root, prefix.replace(/\/$/, ""));
    const keys: { name: string }[] = [];

    async function walk(dir: string) {
      let entries: { name: string | Buffer; isDirectory(): boolean }[];
      try {
        entries = await readdir(dir, { withFileTypes: true }) as { name: string | Buffer; isDirectory(): boolean }[];
      } catch {
        return;
      }
      for (const e of entries) {
        const full = join(dir, String(e.name));
        if (e.isDirectory()) {
          await walk(full);
        } else {
          // Reconstruct KV key from path
          const rel = full.slice(base.length).replace(/^\//, "");
          keys.push({ name: `file:${prefix}${rel}` });
        }
      }
    }

    try {
      const s = await stat(base);
      if (s.isDirectory()) await walk(base);
      else keys.push({ name: `file:${prefix}` });
    } catch {
      // directory doesn't exist yet — return empty
    }

    return { keys };
  }

  async delete(key: string): Promise<void> {
    try {
      await rm(this.#toPath(key));
    } catch {
      // ignore if already gone
    }
  }
}

/** Session-namespaced KV store — prefixes all keys with session:{id}: */
export class SessionKvStore implements KvStore {
  constructor(
    private readonly delegate: KvStore,
    private readonly sessionId: string
  ) {}

  #prefix(key: string): string {
    return `session:${this.sessionId}:${key}`;
  }

  get(key: string) {
    return this.delegate.get(this.#prefix(key));
  }
  put(key: string, value: string, opts?: { expirationTtl?: number }) {
    return this.delegate.put(this.#prefix(key), value, opts);
  }
  async list(opts: { prefix: string }) {
    const result = await this.delegate.list({ prefix: this.#prefix(opts.prefix) });
    return {
      keys: result.keys.map((k) => ({
        name: k.name.replace(`session:${this.sessionId}:`, ""),
      })),
    };
  }
  delete(key: string) {
    return this.delegate.delete?.(this.#prefix(key)) ?? Promise.resolve();
  }
}

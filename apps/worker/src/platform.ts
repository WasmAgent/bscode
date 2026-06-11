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
    // Strip "file:" prefix, prevent path traversal. Keys may legitimately
    // contain `:` (e.g. "session:abc:file:foo.ts" from the SessionKvStore
    // wrapping a "file:..." key). We strip ONLY the leading `file:` token —
    // the rest, including embedded `:`, is preserved verbatim so the on-disk
    // filename round-trips through list().
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
    // FsKvStore stores keys as flat filenames, with one leading `file:`
    // token stripped by `#toPath` for path-mapping efficiency. The original
    // key is therefore the filename plus, conditionally, a `file:` prefix.
    //
    // Two listing modes need to coexist:
    //   - Plain calls (`list({prefix:"file:"})`) match every stored filename
    //     and return `file:<filename>` keys.
    //   - SessionKvStore-wrapped calls (`list({prefix:"session:abc:file:"})`)
    //     match filenames that already begin with `session:abc:file:` —
    //     these were put through `put("session:abc:file:...")` whose
    //     `#toPath` did NOT strip a `file:` token (none at the start), so
    //     the on-disk filename is the key verbatim.
    //
    // The original implementation tried to derive a base directory from
    // the prefix and walk it; that breaks for any prefix containing `:`.
    // The correct algorithm walks the whole tree once and string-prefixes,
    // re-prepending `file:` only when the stored filename does NOT already
    // start with the prefix on its own.
    const root = this.root;
    const keys: { name: string }[] = [];
    const prefix = opts.prefix;

    async function walk(dir: string, relParts: string[]) {
      let entries: { name: string | Buffer; isDirectory(): boolean }[];
      try {
        entries = (await readdir(dir, { withFileTypes: true })) as {
          name: string | Buffer;
          isDirectory(): boolean;
        }[];
      } catch {
        return;
      }
      for (const e of entries) {
        const name = String(e.name);
        const full = join(dir, name);
        if (e.isDirectory()) {
          await walk(full, [...relParts, name]);
        } else {
          // Reconstruct the relative key — nested writes (`file:src/foo.ts`)
          // became real subdirectories, so we join with "/" the same way
          // `#toPath` mapped them in.
          const stored = [...relParts, name].join("/");
          // Two candidate forms: filename verbatim, or with `file:` re-prepended.
          // Prefer the one that matches the requested prefix.
          if (stored.startsWith(prefix)) {
            keys.push({ name: stored });
          } else {
            const withFile = `file:${stored}`;
            if (withFile.startsWith(prefix)) keys.push({ name: withFile });
          }
        }
      }
    }

    try {
      const s = await stat(root);
      if (s.isDirectory()) await walk(root, []);
    } catch {
      // root doesn't exist yet — return empty
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

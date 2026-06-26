import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
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

  /**
   * Compute the logical path (no symlink resolution).  Throws immediately
   * if the resolved path would escape the root via `..` segments or
   * double-slash tricks — before any FS I/O happens.
   *
   * path.resolve() collapses all `..` segments in one pass — unlike a
   * regex it is idempotent and immune to "..../" evasions.  A follow-up
   * path.relative() check detects any remaining escape attempt.
   *
   * For read/delete we additionally call fs.realpath() (see
   * #assertNoSymlinkEscape) so symlinks pointing outside the root are
   * also caught.  For write/put we check the nearest existing ancestor
   * directory (see #assertWriteAncestorInRoot).
   *
   * Rejected attempts emit a console.warn audit line before throwing.
   */
  #toPath(key: string): string {
    // Strip ONLY the leading `file:` token — embedded `:` is preserved so
    // the on-disk filename round-trips through list() unchanged.
    const rel = key.replace(/^file:/, "");

    // Reject NUL / C0 control characters before path resolution so
    // the OS never sees them (some kernels silently truncate at NUL).
    for (let i = 0; i < rel.length; i++) {
      const cc = rel.charCodeAt(i);
      if (cc === 0x00 || cc === 0x0a || cc === 0x0d) {
        console.warn(
          `[FsKvStore] BLOCKED key with control char (0x${cc.toString(16)}): ${JSON.stringify(key)}`
        );
        throw new Error(
          `FsKvStore: key contains forbidden control character (0x${cc.toString(16)})`
        );
      }
    }

    // path.resolve collapses all `..` segments and repeated slashes in
    // one pass — unlike a regex it is idempotent and has no evasion vectors.
    const resolved = resolve(this.root, rel);

    // relative() returns a path starting with ".." when `resolved` is
    // outside `root`.  Checking the first two chars is a fixed-point guard.
    if (relative(this.root, resolved).startsWith("..")) {
      console.warn(
        `[FsKvStore] BLOCKED path traversal attempt: key=${JSON.stringify(key)} resolved=${resolved}`
      );
      throw new Error(
        `FsKvStore: path traversal denied — key escapes root: ${JSON.stringify(key)}`
      );
    }

    return resolved;
  }

  /**
   * Assert that `resolvedPath` (already checked for logical traversal) does
   * not exit the root via a symlink.  Uses `fs.realpath()` on the target
   * for read/delete.  Returns the realpath for caller use (or the logical
   * path on ENOENT — missing files can't be symlinks).
   */
  async #assertNoSymlinkEscape(resolvedPath: string): Promise<string> {
    let real: string;
    try {
      real = await realpath(resolvedPath);
    } catch {
      // File doesn't exist — no symlink to follow.
      return resolvedPath;
    }
    // realpath also resolves the root itself, so compare against realpath(root).
    let realRoot: string;
    try {
      realRoot = await realpath(this.root);
    } catch {
      realRoot = this.root;
    }
    if (relative(realRoot, real).startsWith("..")) {
      console.warn(
        `[FsKvStore] BLOCKED symlink escape: ${resolvedPath} -> ${real} (root: ${realRoot})`
      );
      throw new Error(`FsKvStore: symlink escape denied — resolved path exits root`);
    }
    return real;
  }

  /**
   * For write operations the target file may not exist yet. We realpath the
   * nearest existing ancestor directory and verify it stays under root.
   */
  async #assertWriteAncestorInRoot(resolvedPath: string): Promise<void> {
    let current = dirname(resolvedPath);
    // Walk up until we find an existing directory (mkdir -p will create the rest).
    while (true) {
      const parent = dirname(current);
      try {
        await stat(current);
        break; // found an existing path
      } catch {
        if (parent === current) break; // filesystem root
        current = parent;
      }
    }
    let realAncestor: string;
    try {
      realAncestor = await realpath(current);
    } catch {
      return; // can't resolve, skip symlink check
    }
    let realRoot: string;
    try {
      realRoot = await realpath(this.root);
    } catch {
      realRoot = this.root;
    }
    if (relative(realRoot, realAncestor).startsWith("..")) {
      console.warn(
        `[FsKvStore] BLOCKED symlink escape on write: ancestor=${realAncestor} (root: ${realRoot})`
      );
      throw new Error(`FsKvStore: symlink escape denied on write — ancestor directory exits root`);
    }
  }

  async get(key: string): Promise<string | null> {
    try {
      const p = this.#toPath(key);
      await this.#assertNoSymlinkEscape(p);
      return await readFile(p, "utf8");
    } catch (err) {
      // Re-throw security errors; swallow ENOENT / ENOTDIR.
      if (err instanceof Error && err.message.startsWith("FsKvStore:")) throw err;
      return null;
    }
  }

  async put(key: string, value: string): Promise<void> {
    const p = this.#toPath(key);
    await this.#assertWriteAncestorInRoot(p);
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
      const p = this.#toPath(key);
      await this.#assertNoSymlinkEscape(p);
      await rm(p);
    } catch (err) {
      // Re-throw security errors; swallow ENOENT / ENOTDIR.
      if (err instanceof Error && err.message.startsWith("FsKvStore:")) throw err;
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

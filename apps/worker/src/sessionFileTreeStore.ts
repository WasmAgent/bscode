/**
 * Bounded session → FileTreeManager store with LRU eviction.
 *
 * Replaces the bare `new Map<string, FileTreeManager>()` previously used in
 * app.ts. Without an upper bound the Map grew once per session ID and only
 * shrank when a client explicitly called `DELETE /files` — long-running Node
 * self-host / Bun dev server instances eventually OOMed because every
 * FileTreeManager holds file contents and version history (#012).
 *
 * Strategy: rely on JS Map's insertion-order iteration. On every `get()`
 * cache hit we delete + re-insert the entry so the most-recently-accessed
 * session is always at the tail. When `set()` would exceed `maxEntries`,
 * the head entry (least recently used) is dropped.
 *
 * Scope: drop-in replacement for the subset of Map<string, FileTreeManager>
 * actually used by app.ts / routes (get / set / delete). No iteration
 * surface is exposed because callers never iterate the store.
 *
 * CF Workers: short-lived isolates make the leak unobservable, but the
 * bound is harmless there. Node / Bun dev server: the bound is the real fix.
 */

export interface SessionFileTreeStoreOptions {
  /** Maximum number of session entries kept resident. Default: 100. */
  maxEntries?: number;
  /**
   * Optional sink for evicted FileTreeManager instances. Lets callers run
   * cleanup (e.g. drop pending watchers) on the victim. Default: noop.
   */
  onEvict?: (sessionId: string, tree: unknown) => void;
}

export class SessionFileTreeStore<T> {
  readonly #entries = new Map<string, T>();
  readonly #maxEntries: number;
  readonly #onEvict: (sessionId: string, tree: T) => void;

  constructor(opts: SessionFileTreeStoreOptions = {}) {
    const max = opts.maxEntries ?? 100;
    if (!Number.isFinite(max) || max < 1) {
      throw new Error(`SessionFileTreeStore: maxEntries must be >= 1, got ${max}`);
    }
    this.#maxEntries = Math.floor(max);
    this.#onEvict = (opts.onEvict as (id: string, t: T) => void) ?? (() => {});
  }

  /** Current number of resident sessions. */
  get size(): number {
    return this.#entries.size;
  }

  /** Configured upper bound. */
  get maxEntries(): number {
    return this.#maxEntries;
  }

  /**
   * Read and mark as most-recently-used. Re-inserts the entry so that the
   * Map's insertion order tracks recency.
   */
  get(sessionId: string): T | undefined {
    const tree = this.#entries.get(sessionId);
    if (tree === undefined) return undefined;
    // Touch: delete + re-insert moves the entry to the tail.
    this.#entries.delete(sessionId);
    this.#entries.set(sessionId, tree);
    return tree;
  }

  /** Whether a session is resident. Does not touch recency. */
  has(sessionId: string): boolean {
    return this.#entries.has(sessionId);
  }

  /**
   * Insert or update. Evicts the least-recently-used entry if the store
   * would otherwise exceed `maxEntries`. Updating an existing key counts as
   * a recency touch (the entry moves to the tail).
   */
  set(sessionId: string, tree: T): void {
    if (this.#entries.has(sessionId)) {
      // Replace existing entry, refresh recency.
      this.#entries.delete(sessionId);
      this.#entries.set(sessionId, tree);
      return;
    }
    if (this.#entries.size >= this.#maxEntries) {
      // Map.keys() yields keys in insertion order — head is LRU.
      const lruKey = this.#entries.keys().next().value;
      if (lruKey !== undefined) {
        const victim = this.#entries.get(lruKey) as T;
        this.#entries.delete(lruKey);
        try {
          this.#onEvict(lruKey, victim);
        } catch {
          // Eviction sinks must not break the caller's set() — swallow.
        }
      }
    }
    this.#entries.set(sessionId, tree);
  }

  /** Remove a session. Returns whether it existed. */
  delete(sessionId: string): boolean {
    return this.#entries.delete(sessionId);
  }
}

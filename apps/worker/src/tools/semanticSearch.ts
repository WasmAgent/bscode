/**
 * B2 — semantic_search tool + incremental indexer for bscode.
 *
 * Wires agentkit-js's generic vector primitives (`InMemoryVectorStore`,
 * `KvBackendVectorStore`, `TfidfEmbedder`, an optional injected
 * {@link Embedder}) into the bscode worker so the agent can search the
 * project semantically rather than only by exact-string match.
 *
 * Design choices:
 *  - **Zero new dependencies**: TfidfEmbedder ships in core; the optional
 *    {@link Embedder} param lets callers plug in `HttpEmbedder` from
 *    `@agentkit-js/tools-rag` (or any other) without bscode taking the dep.
 *  - **Generic-foundation respect**: agentkit-js core is unchanged. All
 *    bscode-specific glue (file path → embedding entry id, write-time hook)
 *    lives in this file.
 *  - **DAG-safe**: the `semantic_search` tool is `readOnly: true` and
 *    `idempotent: true`, so the agentkit Scheduler can run it speculatively.
 */

import type { Embedder, Retriever, ToolDefinition } from "@agentkit-js/core";
import {
  InMemoryVectorStore,
  KvBackendVectorStore,
  type KvBackend,
} from "@agentkit-js/core";
import { z } from "zod";
import type { KvStore } from "../types.js";

// ── KvStore → KvBackend adapter (mirrors the one in app.ts) ──────────────────
// We keep an internal copy so this file doesn't pull from app.ts.

function adaptKvStoreToBackend(store: KvStore): Required<KvBackend> {
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

// ── Indexer factory ──────────────────────────────────────────────────────────

export interface SemanticIndexerOptions {
  /**
   * Optional embedder. Defaults to TfidfEmbedder (zero-deps), which works
   * without any external API but only for in-process indexes — TF-IDF
   * vocab cannot be reliably serialised to KV. For cross-session
   * persistence pass an external {@link Embedder} (e.g. HttpEmbedder from
   * @agentkit-js/tools-rag).
   */
  embedder?: Embedder;
  /**
   * KV store for persistence. When set together with a non-TF-IDF embedder,
   * vectors and metadata persist across worker recycle. When omitted, the
   * index is in-process only and rebuilt on every cold start.
   */
  kv?: KvStore;
  /** Prefix for KV keys. Default: "rag:". */
  prefix?: string;
}

export interface SemanticIndexer {
  /** The underlying retriever — call directly for advanced queries. */
  retriever: Retriever;
  /** Add or update a document. Call after every write/patch. */
  upsert(path: string, content: string): Promise<void>;
  /** Remove a document from the index. Call after delete. */
  remove(path: string): Promise<void>;
  /**
   * Rename an entry's id. KvBackendVectorStore lacks a rename primitive,
   * so we delete + re-add. Cheap because the index is keyed by path.
   */
  rename(from: string, to: string, content: string): Promise<void>;
}

/**
 * Build a semantic indexer. When `kv` + a non-TF-IDF embedder are supplied,
 * the index persists across worker recycles. Otherwise it is in-process.
 *
 * The returned indexer maintains an authoritative `path → text` map and
 * REBUILDS the underlying retriever on every mutation. This is necessary
 * because `InMemoryVectorStore.add` does not dedupe by id (it appends),
 * so naive upsert-by-add would leave stale entries behind. For typical
 * bscode workloads (≤ a few thousand files) the rebuild cost is trivial
 * and we get sane upsert/remove/rename semantics on the in-process path.
 */
export function createSemanticIndexer(opts: SemanticIndexerOptions = {}): SemanticIndexer {
  // Authoritative source of truth for what is in the index. Keyed by path so
  // upsert/remove/rename operate in O(1) on the map; the retriever is rebuilt
  // from this on each mutation.
  const docs = new Map<string, string>();

  // Persistent path requires (a) an external embedder (TF-IDF vocabulary
  // cannot be persisted) AND (b) a KV store. Otherwise fall back to in-process.
  const usePersistent = opts.kv !== undefined && opts.embedder !== undefined;

  let retriever: Retriever;
  function makeRetriever(): Retriever {
    if (usePersistent && opts.kv && opts.embedder) {
      return new KvBackendVectorStore(
        adaptKvStoreToBackend(opts.kv),
        opts.embedder,
        opts.prefix ?? "rag:"
      );
    }
    return opts.embedder
      ? new InMemoryVectorStore(opts.embedder)
      : new InMemoryVectorStore();
  }
  retriever = makeRetriever();

  async function rebuild(): Promise<void> {
    retriever = makeRetriever();
    for (const [path, text] of docs) {
      await retriever.add(path, text, { path, length: text.length });
    }
  }

  return {
    get retriever() {
      return retriever;
    },
    async upsert(path: string, content: string) {
      // Truncate for embedding / KV value-size limits.
      const text = content.slice(0, 8 * 1024);
      const had = docs.has(path);
      docs.set(path, text);
      if (had) {
        // Existing entry — full rebuild keeps the in-memory store dedup'd.
        await rebuild();
      } else if (usePersistent) {
        // KvBackendVectorStore.add upserts on id collision, so for the
        // persistent backend we can append in O(1) regardless of had.
        await retriever.add(path, text, { path, length: text.length });
      } else {
        // First-time in-process insert: cheap append.
        await retriever.add(path, text, { path, length: text.length });
      }
    },
    async remove(path: string) {
      if (!docs.delete(path)) return;
      // Both backends require a rebuild because Retriever has no `delete`.
      await rebuild();
    },
    async rename(from: string, to: string, content: string) {
      const had = docs.has(from);
      docs.delete(from);
      docs.set(to, content.slice(0, 8 * 1024));
      if (had || docs.size > 1) {
        await rebuild();
      } else {
        await retriever.add(to, content, { path: to, length: content.length });
      }
    },
  };
}

// ── Tool factory ─────────────────────────────────────────────────────────────

export function createSemanticSearchTool(
  indexer: SemanticIndexer
): ToolDefinition<{ query: string; topK?: number }, { results: SearchHit[] }> {
  return {
    name: "semantic_search",
    description:
      "Search the project codebase by meaning, not just text. Returns the top-K most relevant " +
      "files for a natural-language query. Prefer this over search_code for conceptual queries " +
      "like 'where is auth handled' or 'find the retry logic'.",
    inputSchema: z.object({
      query: z.string().describe("Natural-language query"),
      // Use .min(1) instead of .positive(): zod-to-json-schema's openApi3 target
      // emits draft-04-style `exclusiveMinimum: true` for .positive(), which
      // Anthropic's draft 2020-12 validator rejects with "JSON schema is invalid".
      topK: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Number of results (default 5)"),
    }),
    outputSchema: z.object({
      results: z.array(
        z.object({
          path: z.string(),
          score: z.number(),
          preview: z.string(),
        })
      ),
    }),
    readOnly: true,
    idempotent: true,
    // Mark untrusted: file content was supplied by the user / external sources
    // and could carry prompt-injection payloads when surfaced via retrieval.
    trust: "untrusted" as const,
    forward: async ({ query, topK }) => {
      const hits = await indexer.retriever.search(query, topK ?? 5);
      const results: SearchHit[] = hits.map((h) => ({
        path: (h.metadata as { path?: string } | undefined)?.path ?? h.id,
        score: h.score,
        preview: h.text.slice(0, 200),
      }));
      return { results };
    },
  };
}

export interface SearchHit {
  path: string;
  score: number;
  preview: string;
}

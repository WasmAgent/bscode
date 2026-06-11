# B3 — GitHub repo import & true embedding

> Pull a real GitHub repository into the bscode worker's KV file store so
> the agent can `read_file`, `search_code`, `semantic_search`, and
> ultimately `create_github_pr` against an existing codebase. Plus the
> wiring for swapping the default TF-IDF embedder for a real-vector one
> via `@agentkit-js/tools-rag`.

## Why this matters

The 2026 evaluation consensus splits coding agents into two buckets:

- **"In an existing repo"** — Claude Code, Codex, Cursor. The agent reads
  the user's actual code, edits it, opens a PR. This is where useful
  programming happens.
- **"Prompt-to-app toy"** — bolt.new, Replit Agent, V0. Generates a fresh
  project from scratch. Useful for greenfield demos.

bscode already had the OUT direction (`create_github_pr`); B3 adds the
IN direction so the agent can land in the first bucket.

## Endpoint

```bash
POST /import/github
Content-Type: application/json
X-Session-Id: dev-session-1   # optional but recommended

{
  "owner": "anthropics",
  "repo":  "claude-cookbooks",
  "ref":   "main",            // optional; defaults to repo's default_branch
  "token": "ghp_...",          // optional; falls back to ambient githubToken
  "paths": ["misc"],          // optional; only import paths matching these prefixes
  "textExtensions":            // optional; override the default text-file allowlist
    [".ts", ".md"]
}
```

Returns:

```json
{
  "imported": 142,
  "skipped":  31,
  "skippedReasons": {
    "filtered_by_extension_or_path": 28,
    "blob_fetch_404":                 1,
    "binary_detected":                2
  },
  "preview":   ["misc/algos.ts", "misc/README.md", ...],
  "truncated": false
}
```

## Behaviour

- **Default branch resolution** — if `ref` is omitted we hit
  `GET /repos/{owner}/{repo}` and use `default_branch`.
- **Recursive tree** — one call to `/git/trees/{ref}?recursive=1` lists
  the whole repo. The `truncated: true` flag is propagated unchanged so
  callers know they're looking at a partial tree (rare, only for repos
  with >100k entries).
- **Per-file blob fetch** — every `tree[].url` is fetched. Failures are
  collected into `skippedReasons` and reported back; one bad blob does
  NOT abort the whole import.
- **Binary detection** — base64-decoded blobs with > 20% control-byte
  density in the first 4 KB are flagged as `binary_detected` and
  skipped. Tunable via `textExtensions`.
- **Caps** — files larger than 200 KB are skipped; total imports are
  capped at 2000 files per call. Both numbers are constants in
  `apps/worker/src/tools/githubImport.ts` — change them there.
- **Semantic indexing** — when an indexer is bound (the same one
  `write_file` / `patch_file` use), every imported file is upserted into
  the index after KV write. The agent's `semantic_search` tool sees the
  imported tree without any further wiring.

## Auth

- **Public repos**: no token needed.
- **Private repos**: pass `token` per call OR set
  `AppConfig.githubToken` once on the worker. Per-call tokens win.
- **Rate limits**: GitHub's anonymous rate limit is 60/hour; with a token
  it's 5000/hour. A typical mid-sized repo (~100 files) consumes 1
  meta + 1 tree + 100 blob calls = 102. Most-of-an-afternoon limit.

## True-embedding upgrade

`semanticSearch.ts` accepts an `Embedder` from `@agentkit-js/core` (the
shape `tools-rag` uses). To swap out TF-IDF:

```ts
import { HttpEmbedder } from "@agentkit-js/tools-rag";

const embedder = new HttpEmbedder({
  baseUrl: "https://api.openai.com",
  path:    "/v1/embeddings",
  model:   "text-embedding-3-small",
  apiKey:  config.openaiApiKey,
});

const indexer = createSemanticIndexer({ kv: filesKv, embedder });
```

The HttpEmbedder is OpenAI-API-shape compatible, so any open-source
embedder server (TEI, Ollama with `/v1/embeddings`, vLLM) drops in
without code changes.

## Limitations & escape hatches

- **Tree truncation**: `truncated: true` means GitHub returned a partial
  tree. Re-import using narrower `paths` to fetch the missing parts.
- **Submodules**: `tree[].type === "commit"` (a submodule reference) is
  ignored; the importer only follows blobs.
- **LFS pointers**: returned as small text files (the LFS pointer body)
  rather than the actual binary asset. Out of scope.

## Testing

- 8 unit tests in `apps/worker/src/tools/githubImport.test.ts` cover
  default-branch resolution, extension/path filtering, base64 decoding,
  oversize / binary skipping, partial-tree propagation, and per-file
  fetch error counters.
- 4 route tests in `apps/worker/src/app.test.ts` ("GitHub repo import
  (B3)") cover the happy path and three failure shapes (missing owner,
  malformed JSON, GitHub 404).

## See also

- `apps/worker/src/tools/githubImport.ts` — implementation
- `apps/worker/src/tools/githubPr.ts` — companion OUT path
- [@agentkit-js/tools-rag](../../../agentkit-js/packages/tools-rag/src/HttpEmbedder.ts)
  — true-vector embedder

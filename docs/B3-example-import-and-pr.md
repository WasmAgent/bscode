# B3 example — import a real repo, run a cross-file refactor, open a PR

End-to-end demonstration of the IN/OUT loop B3 closes:

1. **Import** a real public repo into bscode's KV file store.
2. **Run** a cross-file refactor — the agent uses `read_file`,
   `search_code`, and `semantic_search` against the imported tree.
3. **Verify** with B2 (`read_build_result`).
4. **PR** with `create_github_pr` to land the change.

## Step 1 — import

```bash
curl -X POST http://localhost:8788/import/github \
  -H 'Content-Type: application/json' \
  -H 'X-Session-Id: refactor-1' \
  -d '{
    "owner": "anthropics",
    "repo":  "claude-cookbooks",
    "ref":   "main",
    "paths": ["misc"]
  }'
```

Response:

```json
{
  "imported": 24,
  "skipped":  6,
  "skippedReasons": { "filtered_by_extension_or_path": 6 },
  "preview": ["misc/algos.ts", "misc/README.md", ...],
  "truncated": false
}
```

The 24 imported files are now visible to `read_file`, `search_code`, and
the semantic indexer. Verify with:

```bash
curl 'http://localhost:8788/files?prefix=misc/&sessionId=refactor-1'
```

## Step 2 — submit a refactor task

```bash
curl -X POST http://localhost:8788/run \
  -H 'Content-Type: application/json' \
  -H 'X-Session-Id: refactor-1' \
  -d '{
    "task": "Replace every `console.log` in misc/ with the structured `logger.info` from misc/logger.ts. Use patch_file. Open a PR titled \"chore(misc): unify logging\".",
    "agentMode": "tool",
    "modelId": "claude-sonnet-4-6"
  }'
```

The agent:
- `search_code` finds every `console.log` site.
- `read_file` confirms the surrounding context.
- `patch_file` applies a unified-diff per occurrence.
- `read_build_result` (if framework mode) confirms the project still
  compiles.
- `create_github_pr` (HITL gated) opens a PR against
  `anthropics/claude-cookbooks:main` once the user approves.

## Step 3 — multi-job parallel refactor (combine with B1)

For a bigger sweep, queue independent passes:

```bash
curl -X POST http://localhost:8788/jobs \
  -H 'Content-Type: application/json' \
  -H 'X-Session-Id: refactor-1' \
  -d '{
    "jobs": [
      { "task": "Migrate misc/utils.ts off lodash; use native ES.", "agentMode": "tool" },
      { "task": "Add JSDoc @param tags to every exported fn in misc/io.ts", "agentMode": "tool" },
      { "task": "Convert misc/server.js callback-style to async/await", "agentMode": "tool" }
    ]
  }'
```

Three independent passes run in parallel, three independent PRs land —
the bscode-as-edge-Codex-cloud story end-to-end.

## True-vector embedding (optional)

The default `semantic_search` tool uses TF-IDF — fine for ranking inside
a small workspace, weak for paraphrased queries. To swap in a real
embedder, edit the worker's indexer wiring:

```diff
-import { createSemanticIndexer } from "./tools/index.js";
+import { createSemanticIndexer } from "./tools/index.js";
+import { HttpEmbedder } from "@wasmagent/tools-rag";

-const indexer = createSemanticIndexer({ kv });
+const indexer = createSemanticIndexer({
+  kv,
+  embedder: new HttpEmbedder({
+    baseUrl: "https://api.openai.com",
+    path:    "/v1/embeddings",
+    model:   "text-embedding-3-small",
+    apiKey:  config.openaiApiKey,
+  }),
+});
```

The HttpEmbedder accepts any OpenAI-API-shape embedding server, so
self-hosted setups (Ollama, TEI, vLLM) drop in without code changes.

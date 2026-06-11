# bscode

A Coding Assistant built on [agentkit-js](https://github.com/user/agentkit-js), deployed on Cloudflare Workers + Pages.

## What it does

| Capability | How it works |
|---|---|
| **Edge-isolated code execution** | CodeAgent writes JS and runs it in a QuickJS WASM sandbox on Cloudflare Workers — no container, no cold-start hit |
| **Speculative tool fan-out** | ToolCallingAgent runs `readOnly` tools (read/list/search/semantic_search) in parallel via the agentkit DAG scheduler |
| **Semantic codebase search** | `semantic_search` indexes every file write and ranks matches by meaning, not just substring |
| **Durable runs** | Checkpoints persisted to Workers KV; SSE streams resume via `Last-Event-ID`; `await_human_input` survives worker recycle |
| **Prompt-cache instrumentation** | `model_done` events expose `cacheReadTokens`; the TokenMeter shows hit rate live |
| **Multi-model switching** | Claude Sonnet/Haiku, Doubao Seed-1.6, DeepSeek V4 selectable in the UI |

## Architecture

```
apps/
  worker/   Cloudflare Worker — Hono router, CodeAgent, ToolCallingAgent, KV file system
  web/      Next.js 15 — Monaco Editor, Terminal, AgentPanel, TokenMeter
```

## Quick start

```bash
# Install (from repo root)
pnpm install

# Copy env
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
# Fill in ANTHROPIC_API_KEY (and optionally ANTHROPIC_BASE_URL, DOUBAO_API_KEY, DEEPSEEK_API_KEY)

# Start Worker with Node.js (QuickJS WASM works here)
pnpm dev:worker          # http://localhost:8788

# In another terminal, start Web on :3000
pnpm dev:web
```

## CLI testing (no browser needed)

```bash
# Code mode — agent writes JS, executes in QuickJS WASM sandbox
node scripts/bscode.mjs --url http://localhost:8788 --mode code "sort [3,1,4,1,5,9]"

# Tool mode — agent uses DAG-scheduled file tools
node scripts/bscode.mjs --url http://localhost:8788 --mode tool "write a quicksort to quicksort.ts"

# With raw event stream
node scripts/bscode.mjs --url http://localhost:8788 --events "calculate 6*7"

# Different model
node scripts/bscode.mjs --model doubao-seed-1-6-251015 "write hello world"
```

## Deploy to Cloudflare

```bash
# Worker (also works in Cloudflare runtime)
pnpm deploy:worker

# Web (Cloudflare Pages)
pnpm deploy:web

# Local dev with Wrangler/Miniflare (CodeAgent WASM limited)
pnpm dev:worker:cf
```

### Required and optional bindings

Add these to `apps/worker/wrangler.toml` to enable the durable runtime
features (all optional — bscode falls back to in-memory when absent):

```toml
[[kv_namespaces]]
binding = "BSCODE_FILES"          # required for the virtual file system
id = "..."

[[kv_namespaces]]
binding = "BSCODE_SESSIONS"        # session result caching (warm replays)
id = "..."

[[kv_namespaces]]
binding = "BSCODE_CHECKPOINTS"     # B1 — durable agent checkpoints; without it
id = "..."                         # paused runs do not survive worker recycle.

[[kv_namespaces]]
binding = "BSCODE_BUILD_RESULTS"   # B2 — browser-reported install/build/test
id = "..."                         # outcomes; without it the snapshot is in-memory
                                   # only (fine for single-recycle conversations).
```

The `create_github_pr` tool is registered automatically when `BSCODE_FILES`
is bound. Tokens come from the per-call tool input (preferred) or — if you
choose — a worker-level `GITHUB_TOKEN` env var wired through `AppConfig.githubToken`.

### Tools the agent can call

| Tool | Read-only | Notes |
|---|:---:|---|
| `read_file`, `list_files`, `search_code` | ✅ | DAG scheduler runs these in parallel |
| `semantic_search` | ✅ | TF-IDF default; pluggable Embedder for cross-session indexing |
| `list_file_versions` | ✅ | B4 — surfaces per-file timeline |
| `write_file`, `patch_file`, `delete_file`, `rename_file` | ❌ | Auto-update semantic index + version history |
| `revert_file` | ❌ | B4 — roll a file back to any prior version |
| `run_command` | ❌ | Node/Bun only; blocked on edge |
| `read_build_result` | ✅ | B2 — agent reads browser-side WebContainer install/build/test outcomes (framework mode only) |
| `web_search`, `git_status`/`git_diff`/`git_log`/`git_commit` | mixed | Standard tools |
| `create_github_pr` | ❌ | B3 — branch + commit + PR via REST. **HITL-gated** (`needsApproval: true`) |

## Quality

Verified metrics — every claim above is backed by an executable test or
benchmark, not a marketing line.

| Metric | Verified by | Current value |
|---|---|---|
| **Backend test suite** | `apps/worker` vitest | **151 tests, 100% pass** |
| **Frontend test suite** | `apps/web` vitest | **25 tests, 100% pass** |
| **Cross-instance checkpoint resume (B1 ①)** | `apps/worker/src/app.test.ts` | snapshot saved by app instance A is loadable by a brand-new instance B sharing the same KV; HITL `pendingHumanInput` survives across three instances (pause / resume / continue) |
| **Build-result reverse channel (B2)** | `apps/worker/src/build-results.test.ts`, `tools/build-result.test.ts`, `app.test.ts` | 18 unit + 5 route tests cover memory/KV mirror, stderr truncation (≤2000 chars), session isolation via `X-Session-Id`, and graceful fallback on KV outage |
| **Parallel job queue (B1)** | `apps/worker/src/jobs/queue.test.ts`, `app.test.ts`, `apps/web/src/components/JobsPanel.test.tsx` | 10 queue + 8 route + 5 dashboard tests cover concurrency cap, KV durable mirror across recycle, cooperative abort via `AbortSignal`, batch validation (max 20 per request), newest-first list ordering, and dashboard submit/abort flow |
| **GitHub repo import (B3)** | `apps/worker/src/tools/githubImport.test.ts`, `app.test.ts` | 8 importer + 4 route tests cover default-branch resolution, extension/path filtering, base64 decoding, oversize/binary skipping, partial-tree propagation, per-file fetch error counters, and the 502 bubble path |
| **Tiered approval policy (B4)** | `apps/worker/src/policies/approvalPolicy.test.ts` | 12 tests cover default verdict, first-rule-wins ordering, prefix matching, op filtering, size gating, audit `explain()`, and each preset (`permissive` / `balanced` / `strict`) |
| **`semantic_search` Top-3 recall vs grep (B2 ①)** | `apps/worker/src/tools/semanticSearch.eval.test.ts` | **70%** (semantic) vs **0%** (grep) on a 50-file synthetic project with paraphrased queries |
| **Lighthouse desktop snapshot** | `chrome-devtools-mcp` audit | **Accessibility 100 · Best Practices 100 · SEO 100 · Agentic Browsing 100** (24/24 audits passing) |
| **Cost-display accuracy** | `apps/web/src/components/TokenMeter.tsx` | sums per-call `estimatedUsd` from the worker (computed with the actual model's pricing); no longer mis-bills Haiku/Opus runs as Sonnet |
| **A11y / dark-mode contrast** | `apps/web/src/lib/theme.ts` | every UI colour goes through one named token; secondary text raised from `#8b949e` → `#d0d7de` (AAA on `#161b22`) |

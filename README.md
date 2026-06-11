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
| **Backend test suite** | `apps/worker` vitest | **199 tests, 100% pass** |
| **Frontend test suite** | `apps/web` vitest | **25 tests, 100% pass** |
| **Cross-instance checkpoint resume (B1 ①)** | `apps/worker/src/app.test.ts` | snapshot saved by app instance A is loadable by a brand-new instance B sharing the same KV; HITL `pendingHumanInput` survives across three instances (pause / resume / continue) |
| **SSE `Last-Event-ID` resume (C1)** | `apps/worker/src/app.test.ts` (6 tests) + `packages/react/src/useAgentRun.test.ts` (4 tests) | live `/run` stream tags every frame with a monotonic `id:`; reconnect with `resumeTraceId` body field + `Last-Event-ID` header replays only the missing tail and **never** spawns a second agent (proven by mock factory call count); EventLog purged on success; `--resume-after N` CLI flag demos the round-trip |
| **Per-job session isolation (C2)** | `apps/worker/src/jobs/jobBranches.test.ts` (15 tests) + `app.test.ts` (5 e2e) | each /jobs entry runs in a derived `parent#job-<id>` session id with its parent files snapshotted on submit; `/jobs/:id/diff` reports per-job changes vs the snapshot; `/jobs/:id/merge` applies them only when no concurrent base edit happened, otherwise returns structured `{path, reason: "both-modified" | "modified-vs-deleted" | "deleted-vs-modified"}` conflicts and refuses to silently overwrite the parent |
| **Project AGENTS.md instructions (C4)** | `apps/worker/src/app.test.ts` (5 tests) | repo-root and nested AGENTS.md files are loaded into the agent's system prompt with broadest→nearest order (LLM "later-wins" bias); empty workspace produces empty text; `init_agents_md` tool is `needsApproval: true` so its draft cannot bypass the planFirst HITL gate |
| **Visual verification channel (C3 — complete)** | `apps/worker/src/visualVerifier.test.ts` (9 tests) + `visionJudge.test.ts` (8 tests) + `tools/visual.test.ts` (6 tests + DoD e2e) + `build-results.test.ts` (3 tests for source/verdict/pageTitle round-trip) | Two paths populate `BuildResultSnapshot.visual` against the same shape: (a) the browser-side passive observer in `useWebContainer` (parent-page event bus, opt-in postMessage probes); (b) the new worker-side **CDP visual verifier** (`@agentkit-js/tools-browser`) that drives a Chrome DevTools session against the preview URL to capture real screenshots, run agent-supplied selector/textContains probes, read console events, and ask a vision-capable model whether the render matches the agent's stated intent. Two new tools wire into framework mode: `visual_verify` (read-only, no approval) and `visual_interact` (write-class, `needsApproval=true`). Both degrade to a structured "no endpoint configured" snapshot when `BSCODE_CDP_WS` is unset — the agent loop never crashes on the optional path. Thumbnail data URLs are NEVER inlined into agent context (size discipline). DoD e2e: deliberate render bug → agent reads `read_build_result` → sees `rendersNonEmpty:false` + verdict `matchesIntent:false` + console error → writes the fix → re-verify shows `matchesIntent:true`, all without human prompting. |
| **Build-result reverse channel (B2)** | `apps/worker/src/build-results.test.ts`, `tools/build-result.test.ts`, `app.test.ts` | 18 unit + 5 route tests cover memory/KV mirror, stderr truncation (≤2000 chars), session isolation via `X-Session-Id`, and graceful fallback on KV outage |
| **Parallel job queue (B1)** | `apps/worker/src/jobs/queue.test.ts`, `app.test.ts`, `apps/web/src/components/JobsPanel.test.tsx` | 10 queue + 8 route + 5 dashboard tests cover concurrency cap, KV durable mirror across recycle, cooperative abort via `AbortSignal`, batch validation (max 20 per request), newest-first list ordering, and dashboard submit/abort flow |
| **GitHub repo import (B3)** | `apps/worker/src/tools/githubImport.test.ts`, `app.test.ts` | 8 importer + 4 route tests cover default-branch resolution, extension/path filtering, base64 decoding, oversize/binary skipping, partial-tree propagation, per-file fetch error counters, and the 502 bubble path |
| **Tiered approval policy (B4)** | `apps/worker/src/policies/approvalPolicy.test.ts` | 12 tests cover default verdict, first-rule-wins ordering, prefix matching, op filtering, size gating, audit `explain()`, and each preset (`permissive` / `balanced` / `strict`) |
| **Multi-agent shapes (B1+B4)** | `apps/worker/src/agents/multi-agent.test.ts`, `app.test.ts` | 6 unit + 2 route tests cover the new `parallel` (fork-join via `ParallelForkJoinRunner`) and `planFirst` (planner → `await_human_input` → executor) modes plus the resume path that loads a snapshot and runs `runPlanFirstExecution`. The old serial Phase1+Phase2 layout was removed entirely. |
| **`semantic_search` Top-3 recall vs grep (B2 ①)** | `apps/worker/src/tools/semanticSearch.eval.test.ts` | **70%** (semantic) vs **0%** (grep) on a 50-file synthetic project with paraphrased queries |
| **Lighthouse desktop snapshot** | `chrome-devtools-mcp` audit | **Accessibility 100 · Best Practices 100 · SEO 100 · Agentic Browsing 100** (24/24 audits passing) |
| **Cost-display accuracy** | `apps/web/src/components/TokenMeter.tsx` | sums per-call `estimatedUsd` from the worker (computed with the actual model's pricing); no longer mis-bills Haiku/Opus runs as Sonnet |
| **A11y / dark-mode contrast** | `apps/web/src/lib/theme.ts` | every UI colour goes through one named token; secondary text raised from `#8b949e` → `#d0d7de` (AAA on `#161b22`) |

## Documentation

| Topic | Doc |
|---|---|
| **B1** Parallel job queue (Codex-cloud-style) | [docs/B1-job-queue.md](docs/B1-job-queue.md) — design + API; example: [docs/B1-example-three-prs.md](docs/B1-example-three-prs.md) |
| **B2** Closed validation loop (build-result reverse channel) | [docs/B2-validation-loop.md](docs/B2-validation-loop.md) — design + ASCII flow; example: [docs/B2-example-typo-recovery.md](docs/B2-example-typo-recovery.md) |
| **B3** GitHub repo import + true embedding | [docs/B3-github-import.md](docs/B3-github-import.md) — endpoint + auth + `EMBEDDING_*` env wiring; example: [docs/B3-example-import-and-pr.md](docs/B3-example-import-and-pr.md) |
| **B4** Tiered approval policy | [docs/B4-approval-policy.md](docs/B4-approval-policy.md) — rules, presets, audit `explain()`; example: [docs/B4-example-gated-edits.md](docs/B4-example-gated-edits.md) |
| **B1+B4** Multi-agent shapes (parallel / planFirst) | [docs/multi-agent-modes.md](docs/multi-agent-modes.md) — the Phase1+Phase2 serial layout was removed; this doc shows the two replacements |
| **C1** SSE `Last-Event-ID` resume | [docs/C1-sse-resume.md](docs/C1-sse-resume.md) — wire-level protocol (request/response headers, body fields), end-to-end resume flow, and the `--resume-after N` CLI demo |
| **C2** Per-job session isolation + diff/merge | The job queue now runs each entry under `parent#job-<id>`. `POST /jobs/:id/merge` accepts `{strategy: "fail-on-conflict" \| "ours" \| "theirs"}`; `GET /jobs/:id/diff` and `DELETE /jobs/:id/branch` round out the lifecycle. Tests at `apps/worker/src/jobs/jobBranches.test.ts` and the C2 describe block in `app.test.ts`. |
| **C3** Visual verification (`BuildResultSnapshot.visual` — complete) | Two complementary paths: (a) the browser `useWebContainer` hook schedules a passive 1.5 s observer after `server-ready` (parent-page console errors + opt-in `bscode:visual-check` postMessage probes); (b) the new worker-side **CDP visual verifier** (`@agentkit-js/tools-browser`) drives a Chrome DevTools session against the preview URL — real screenshot, real DOM probes (selector / textContains), real console events, plus a vision-capable model judging whether the render matches the agent's stated intent. Two new tools land in framework mode: `visual_verify` (read-only) and `visual_interact` (gated by approval policy). Both degrade gracefully when `BSCODE_CDP_WS` is unset. Thumbnail data URLs are kept out of agent context to preserve token budget. The agent loop reads structured signals via `read_build_result` and self-corrects without human prompting. |
| **C4** Project AGENTS.md (Codex/Cursor/Copilot/Gemini convention) | The worker now resolves `AGENTS.md` (root + nested) on every `/run` and appends it to the system prompt prefix. The `init_agents_md` tool drafts new files; `needsApproval: true` ensures they go through the planFirst HITL gate before landing on disk. |

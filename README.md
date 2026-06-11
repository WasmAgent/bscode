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
| `web_search`, `git_status`/`git_diff`/`git_log`/`git_commit` | mixed | Standard tools |
| `create_github_pr` | ❌ | B3 — branch + commit + PR via REST. **HITL-gated** (`needsApproval: true`) |

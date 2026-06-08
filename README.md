# bscode

A Coding Assistant built on [agentkit-js](https://github.com/user/agentkit-js), deployed on Cloudflare Workers + Pages.

## What this tests

| Capability | How it's tested |
|---|---|
| **CodeAgent + QuickJSKernel** | Agent writes JS code and executes it in a real WASM sandbox on the edge |
| **ToolCallingAgent + DAG scheduling** | 5 coding tools (read/write/search/list/run), `readOnly` tools execute in parallel |
| **Prompt Cache optimization** | `model_done` events expose `cacheReadTokens`; TokenMeter shows hit rate live |
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

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
# Fill in ANTHROPIC_API_KEY (and optionally DOUBAO_API_KEY, DEEPSEEK_API_KEY)

# Start Worker on :8787
pnpm dev:worker

# In another terminal, start Web on :3000
pnpm dev:web
```

## Deploy

```bash
# Worker
pnpm deploy:worker

# Web (Cloudflare Pages)
pnpm deploy:web
```

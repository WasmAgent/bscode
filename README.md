# bscode — agentkit-js flagship template

> **Edge-native agent runtime showcase** — Cloudflare Workers + Pages, ships in 5 minutes.
> The reference deployment for [agentkit-js](https://github.com/telleroutlook/agentkit-js).

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/WasmAgent/bscode&utm_source=bscode-readme-deploy-button)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![agentkit-js](https://img.shields.io/badge/built%20on-agentkit--js-646cff.svg)](https://github.com/telleroutlook/agentkit-js)

bscode is **not** competing with Cursor, Claude Code, or Codex. It is the
fastest way to see agentkit-js running end-to-end on a real edge runtime —
QuickJS WASM sandbox, durable checkpoints, multi-agent fan-out, GitHub PR
opener, visual verifier, all wired into one Workers + Next.js deployment
that you can fork and own.

If you want the **framework**, head to
[github.com/telleroutlook/agentkit-js](https://github.com/telleroutlook/agentkit-js).
If you want the **template**, you're in the right place.

```bash
npm add @agentkit-js/core   # the framework itself, on npm
```

> The same `npm add` string lives in the running app's top-left navbar
> pill so the two surfaces send identical signal. Click attribution:
> README's deploy button is tagged `utm_source=bscode-readme-deploy-button`,
> the UI pill carries `?source=bscode-ui-pill`, and the in-app
> "Feature → API map" deep-links carry `data-source="bscode-feature-map"`.

---

## Quick start (local, ~2 minutes)

```bash
git clone https://github.com/WasmAgent/bscode
cd bscode
pnpm install                                          # 1
cp apps/worker/.dev.vars.example apps/worker/.dev.vars # 2 — fill ANTHROPIC_API_KEY
pnpm dev:worker                                        # 3 — http://localhost:8787
pnpm dev:web                                           # 4 — http://localhost:3000  (in another terminal)
```

That's it. KV bindings are optional — bscode silently falls back to in-memory
storage so you can play before owning Cloudflare resources.

> Need a different model? Add any of `DOUBAO_API_KEY`, `DEEPSEEK_API_KEY`,
> `MOONSHOT_API_KEY`, etc. to `.dev.vars`. The full set lives in
> `apps/worker/.dev.vars.example`.

## Deploy to Cloudflare (~10 minutes)

The "Deploy to Cloudflare" button at the top creates the Worker, Pages
project, and KV namespaces in one shot. If you'd rather drive it manually:

```bash
# create KV namespaces (one-time)
wrangler kv namespace create BSCODE_FILES
wrangler kv namespace create BSCODE_SESSIONS
wrangler kv namespace create BSCODE_CHECKPOINTS
wrangler kv namespace create BSCODE_BUILD_RESULTS

# paste each ID into apps/worker/wrangler.toml under [[kv_namespaces]]
# then:
wrangler secret put ANTHROPIC_API_KEY
pnpm deploy:worker
pnpm deploy:web
```

---

## What this demonstrates

Each row maps to a published agentkit-js capability — bscode just wires
them up against the Cloudflare runtime.

| bscode feature | agentkit-js it exercises |
|---|---|
| Edge-isolated code execution | [`@agentkit-js/kernel-quickjs`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/kernel-quickjs) — QuickJS WASM kernel, no `node:vm` |
| Speculative tool fan-out | `ParallelForkJoinRunner` in `@agentkit-js/core` |
| Durable checkpoints + SSE resume | [`@agentkit-js/core`](https://telleroutlook.github.io/agentkit-js/guides/durable-runtime) — `KvCheckpointer`, `EventLog`, `Last-Event-ID` |
| Multi-agent shapes (parallel / planFirst) | `ParallelForkJoinRunner` + stateless HITL primitive in core |
| Per-job session isolation + diff/merge | `BranchableWorkspace` in core |
| Tiered approval policy (B4) | `needsApproval` lifecycle hook in core |
| Visual verifier (CDP + vision judge) | [`@agentkit-js/tools-browser`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/tools-browser) — CDP session driver |
| GitHub repo import + PR opener | Bscode-specific tools wrapping the standard tool contract |
| Prompt-cache instrumentation | Per-call `usage` events from every model adapter |
| AGENTS.md project conventions | Loaded into the system prompt prefix on every `/run` |

The framework's [Getting started](https://telleroutlook.github.io/agentkit-js/guides/getting-started)
and [Comparison](https://telleroutlook.github.io/agentkit-js/compare) pages
explain the broader picture.

---

## Try it from the CLI

No browser needed:

```bash
# Code mode — agent writes JS, executes in the QuickJS WASM sandbox
node scripts/bscode.mjs --url http://localhost:8787 --mode code "sort [3,1,4,1,5,9]"

# Tool mode — agent uses DAG-scheduled file tools
node scripts/bscode.mjs --url http://localhost:8787 --mode tool "write a quicksort to quicksort.ts"

# With raw event stream
node scripts/bscode.mjs --url http://localhost:8787 --events "calculate 6*7"
```

Or run the end-to-end async-agent demo (G1):

```bash
node scripts/demo-async-agent.mjs   # imports a small repo → multi-agent fix → PR (dry-run)
```

---

## 5-minute path to Claude Desktop / Cursor (B-D2)

Cloudflare's *Code Mode MCP* and Anthropic's *Code execution with MCP*
both converged on the same shape in 2026: a host (Claude Desktop,
Cursor, VS Code Copilot) talks MCP to a server that exposes one
`execute_code` surface, and the host's tools live behind that surface
as code the agent calls. agentkit-js ships
[`@agentkit-js/mcp-server`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/mcp-server)
for that, with the same `CapabilityManifest` you already use for the
WASM kernel inside bscode.

To put bscode-style tools in front of Claude Desktop:

```ts
// my-mcp-server.ts — paste into a Worker entry, deploy, take the URL.
import { createCodeModeServer, createFetchHandler } from "@agentkit-js/mcp-server";
import { QuickJSKernel } from "@agentkit-js/kernel-quickjs";
import type { ToolDefinition } from "@agentkit-js/core";

const tools: ToolDefinition[] = [/* … your tool list … */];

const server = createCodeModeServer({
  serverInfo: { name: "my-tools", version: "1.0.0" },
  tools,
  kernel: new QuickJSKernel(),
  capabilities: { allowedHosts: [], cpuMs: 5_000 },
});

export default { fetch: createFetchHandler(server, { path: "/mcp" }) };
```

In Claude Desktop's `mcp` settings:

```jsonc
{
  "mcpServers": {
    "my-tools": { "url": "https://YOUR-DEPLOY/mcp" }
  }
}
```

The host now sees one tool — `execute_code` — and the model's snippet
calls your real tools via `callTool(name, args)`. The token-savings
benchmark in agentkit-js CI shows ≤14% of direct tool-use tokens at
N=30 tools (`examples/benchmarks/code-mode-tokens.mjs`).

The bscode app does **not** mount its in-process tools at `/mcp`
itself — bscode is a thin template, and serving production MCP from
the same Worker that serves the demo UI is product-shaped surface
that belongs on a fork. Open an issue tagged `mcp:mount-template`
if you'd like a turn-key mount of the same tools the bscode UI uses.

---

## Out of scope

bscode is intentionally **not**:

- **A Cursor / Claude Code competitor.** Real shell, real npm install, real
  compilation chains are not what a WASM kernel is for. If you want that,
  use the framework's [`@agentkit-js/kernel-remote`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/kernel-remote) tier (E2B / CF Sandbox microVMs) on top of a host that runs them.
- **An IDE.** No file watcher, no LSP, no plugin system. The Monaco surface
  exists to demonstrate `useAgentRun()` + `TokenMeter` in a Next.js app, not
  to be a development environment.
- **A long-term product roadmap.** New capabilities land in agentkit-js
  first; bscode pulls them in as a demo. If a feature has no obvious place
  in the *framework*, it does not belong in *bscode*.

We accept PRs that improve the demo (clearer flows, better screenshots,
honest benchmarks) and PRs that remove things that have drifted from this
positioning. We do not accept feature additions that read as "competing
with Cursor."

---

## Architecture

```
apps/
  worker/   Cloudflare Worker — Hono router, CodeAgent, ToolCallingAgent, KV file system
  web/      Next.js 15 — Monaco editor, Terminal, AgentPanel, JobsPanel, TokenMeter
scripts/    CLI test scripts (bscode.mjs, test-full.mjs, demo-async-agent.mjs)
docs/       Per-capability deep dives (B1–C4)
```

---

## Tools the agent can call

| Tool | Read-only | Notes |
|---|:---:|---|
| `read_file`, `list_files`, `search_code` | ✅ | DAG scheduler runs these in parallel |
| `semantic_search` | ✅ | TF-IDF default; pluggable Embedder for cross-session indexing |
| `list_file_versions` | ✅ | B4 — surfaces per-file timeline |
| `write_file`, `patch_file`, `delete_file`, `rename_file` | ❌ | Auto-update semantic index + version history |
| `revert_file` | ❌ | B4 — roll a file back to any prior version |
| `run_command` | ❌ | Node/Bun only; blocked on edge |
| `read_build_result` | ✅ | B2 — agent reads browser-side WebContainer install/build/test outcomes |
| `web_search`, `git_status`/`git_diff`/`git_log`/`git_commit` | mixed | Standard tools |
| `create_github_pr` | ❌ | B3 — branch + commit + PR via REST. **HITL-gated** |
| `visual_verify`, `visual_interact` | mixed | C3 — CDP screenshot + vision judge against preview URL |
| `init_agents_md` | ✅ | C4 — drafts AGENTS.md; `needsApproval: true` |

---

## Quality

| Metric | Verified by | Current value |
|---|---|---|
| Backend test suite | `apps/worker` vitest | **222 tests, 100% pass** |
| Frontend test suite | `apps/web` vitest | **27 tests, 100% pass** |
| Lighthouse desktop | `chrome-devtools-mcp` audit | **Accessibility 100 · Best Practices 100 · SEO 100 · Agentic Browsing 100** |

The pre-restructure commits in this repo include extensive per-capability
verification tables for B1, B2, B3, B4, C1, C2, C3, C4 — see the
`docs/` directory.

---

## Documentation

| Topic | Doc |
|---|---|
| **B1** Parallel job queue | [docs/B1-job-queue.md](docs/B1-job-queue.md) |
| **B2** Closed validation loop | [docs/B2-validation-loop.md](docs/B2-validation-loop.md) |
| **B3** GitHub repo import | [docs/B3-github-import.md](docs/B3-github-import.md) |
| **B4** Tiered approval policy | [docs/B4-approval-policy.md](docs/B4-approval-policy.md) |
| **B1+B4** Multi-agent shapes | [docs/multi-agent-modes.md](docs/multi-agent-modes.md) |
| **C1** SSE Last-Event-ID resume | [docs/C1-sse-resume.md](docs/C1-sse-resume.md) |
| **Async-agent end-to-end demo** | [scripts/demo-async-agent.mjs](scripts/demo-async-agent.mjs) |

---

## License

[Apache-2.0](./LICENSE) — © bscode contributors.

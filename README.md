# bscode — wasmagent-js flagship template

> **Edge-native agent runtime showcase** — Cloudflare Workers + Pages, ships in 5 minutes.
> The reference deployment for [wasmagent-js](https://github.com/WasmAgent/wasmagent-js).

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/WasmAgent/bscode&utm_source=bscode-readme-deploy-button)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![wasmagent-js](https://img.shields.io/badge/built%20on-wasmagent--js-646cff.svg)](https://github.com/WasmAgent/wasmagent-js)
[![evomerge](https://img.shields.io/badge/trains-evomerge-orange.svg)](https://github.com/telleroutlook/evomerge)

bscode is **not** competing with Cursor, Claude Code, or Codex. It is the
fastest way to see wasmagent-js running end-to-end on a real edge runtime —
QuickJS WASM sandbox, durable checkpoints, multi-agent fan-out, GitHub PR
opener, visual verifier, all wired into one Workers + Next.js deployment
that you can fork and own.

If you want the **framework**, head to
[github.com/WasmAgent/wasmagent-js](https://github.com/WasmAgent/wasmagent-js).
If you want the **template**, you're in the right place.

```bash
npm add @wasmagent/core   # the framework itself, on npm
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

Each row maps to a published wasmagent-js capability — bscode just wires
them up against the Cloudflare runtime.

| bscode feature | wasmagent-js it exercises |
|---|---|
| Edge-isolated code execution | [`@wasmagent/kernel-quickjs`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/kernel-quickjs) — QuickJS WASM kernel, no `node:vm` |
| Speculative tool fan-out | `ParallelForkJoinRunner` in `@wasmagent/core` |
| Durable checkpoints + SSE resume | [`@wasmagent/core`](https://wasmagent.github.io/wasmagent-js/guides/durable-runtime) — `KvCheckpointer`, `EventLog`, `Last-Event-ID` |
| Multi-agent shapes (parallel / planFirst) | `ParallelForkJoinRunner` + stateless HITL primitive in core |
| **RLAIF rollout adapter** *(2026-06-22)* | `apps/worker/src/rollout-adapter.ts` — `makeBuildResultReader` / `makeVisualResultReader` bridge bscode's KV build-result channel to `BuildPassesVerifier` / `VisualAssertVerifier` in `@wasmagent/core`. `AppConfig.rolloutConcurrency` controls the job queue cap for batch sampling runs. |
| **Training data pipeline** *(2026-06-22)* | B2 build signals + C3 visual assertions feed `RolloutRanker` in wasmagent-js, which ranks rollout branches by objective score. Ranked branches are exported as DPO/PPO JSONL by [evomerge `datafactory/`](https://github.com/telleroutlook/evomerge) for downstream RL post-training. |
| Per-job session isolation + diff/merge | `BranchableWorkspace` in core |
| Tiered approval policy | `needsApproval` lifecycle hook in core |
| Visual verifier (CDP + vision judge) | [`@wasmagent/tools-browser`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/tools-browser) — CDP session driver |
| **OWASP Agentic Top 10 — live blocked** *(2026-06-17)* | [`CapabilityManifest`](https://github.com/WasmAgent/wasmagent-js/blob/main/packages/core/src/executor/types.ts) + [field-by-field OWASP map](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/security/capability-manifest-owasp.md). Click "Sandbox blocks an OWASP attack live" in the differentiator band to see the 4 attack scenarios + intercepted-error strings the kernel actually returns. |
| GitHub repo import + PR opener | Bscode-specific tools wrapping the standard tool contract |
| Prompt-cache instrumentation | Per-call `usage` events from every model adapter |
| AGENTS.md project conventions | Loaded into the system prompt prefix on every `/run` |

The framework's [Getting started](https://wasmagent.github.io/wasmagent-js/guides/getting-started)
and [Comparison](https://wasmagent.github.io/wasmagent-js/compare) pages
explain the broader picture.

> 🛡️ **Governance (2026-06-17).** The remaining moat after code-mode became
> table stakes is *runtime-enforced authorisation + WASM isolation* —
> `CapabilityManifest` + the agentkit kernel matrix.
> Microsoft's Agent Governance Toolkit (2026-04, MIT) decides *should*;
> agentkit kernels enforce *can* and isolate the blast radius. The
> "Sandbox blocks an OWASP attack live" panel in bscode's differentiator
> band is the visual demo of that contract. The full coverage map
> (`CapabilityManifest` field ↔ OWASP Agentic Top 10 entry, plus EU AI
> Act / Colorado AI Act / ISO 42001 mapping) is in
> [`docs/security/capability-manifest-owasp.md`](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/security/capability-manifest-owasp.md).
> You can also reproduce it locally without a browser:
> `node examples/owasp-demo/owasp-demo.mjs` in the wasmagent-js repo.

> 🔁 **Already on a different framework?** bscode also has a live
> reverse-funnel landing — visit
> **[`/recipes`](https://bscode.dev/recipes?source=bscode-readme-recipes-link)**
> on a running deployment to copy the snippet, run a live patch
> against the worker, and jump out to the wasmagent-js framework
> docs. The five recipes (Vercel AI SDK 6 / Cloudflare codemode /
> Mastra / Anthropic Claude Agent SDK / OpenAI Agents JS) also
> ship as prose at
> [`docs/their-framework-our-kernel.md`](./docs/their-framework-our-kernel.md).
> The agentkit kernels slot in as one tool / one executor / one
> provider; you keep your existing framework. Direction 6 of the
> wasmagent-js [2026-06 strategic
> brief](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/strategy/2026-06-competitiveness.md).

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

Or run the end-to-end async-agent demo:

```bash
node scripts/demo-async-agent.mjs   # imports a small repo → multi-agent fix → PR (dry-run)
```

---

## 5-minute path to Claude Desktop / Cursor

Cloudflare's *Code Mode MCP* and Anthropic's *Code execution with MCP*
both converged on the same shape in 2026: a host (Claude Desktop,
Cursor, VS Code Copilot) talks MCP to a server that exposes one
`execute_code` surface, and the host's tools live behind that surface
as code the agent calls. wasmagent-js ships
[`@wasmagent/mcp-server`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/mcp-server)
for that, with the same `CapabilityManifest` the WASM kernel inside
bscode already honours.

### Use bscode's worker as the MCP server (no extra deploy)

The bscode worker now mounts a code-mode MCP server at `/mcp`. The
read-only tools `read_file`, `list_files`, `search_code` are exposed
through one `execute_code` surface (see
[`apps/worker/src/mcp.ts`](apps/worker/src/mcp.ts) for the strict
allow-list and the deny-network capability manifest).

In Claude Desktop's `mcp` settings (or any MCP host that speaks
Streamable HTTP):

```jsonc
{
  "mcpServers": {
    "bscode-files": {
      "url": "https://YOUR-WORKER-DEPLOY/mcp"
    }
  }
}
```

For `pnpm dev:worker` running locally, that's `http://localhost:8787/mcp`.

The host now sees one tool — `execute_code` — and the model's snippet
calls bscode's read-only file tools via `callTool(name, args)`. Write
tools (`write_file`, `patch_file`, `delete_file`, `run_command`,
`create_github_pr`, …) are deliberately **not** exposed through this
mount because they need approval/state that does not translate cleanly
across an MCP transport boundary; expose them on a fork that owns the
access policy.

The token-savings benchmark in wasmagent-js CI shows ≤14% of direct
tool-use tokens at N=30 tools (`examples/benchmarks/code-mode-tokens.mjs`).

### Or stand up a separate MCP server for your own tools

If you want a different tool list — your own search backend, your own
file index — write a Worker entry that calls
`createCodeModeServer + createFetchHandler` directly:

```ts
// my-mcp-server.ts — paste into a Worker entry, deploy, take the URL.
import { createCodeModeServer, createFetchHandler } from "@wasmagent/mcp-server";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";
import type { ToolDefinition } from "@wasmagent/core";

const tools: ToolDefinition[] = [/* … your tool list … */];

const server = createCodeModeServer({
  serverInfo: { name: "my-tools", version: "1.0.0" },
  tools,
  kernel: new QuickJSKernel(),
  capabilities: { allowedHosts: [], cpuMs: 5_000 },
});

export default { fetch: createFetchHandler(server, { path: "/mcp" }) };
```

---

## Out of scope

bscode is intentionally **not**:

- **A Cursor / Claude Code competitor.** Real shell, real npm install, real
  compilation chains are not what a WASM kernel is for. If you want that,
  use the framework's [`@wasmagent/kernel-remote`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/kernel-remote) tier (E2B / CF Sandbox microVMs) on top of a host that runs them.
- **An IDE.** No file watcher, no LSP, no plugin system. The Monaco surface
  exists to demonstrate `useAgentRun()` + `TokenMeter` in a Next.js app, not
  to be a development environment.
- **A long-term product roadmap.** New capabilities land in wasmagent-js
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
docs/       Per-capability deep dives
```

---

## Tools the agent can call

| Tool | Read-only | Notes |
|---|:---:|---|
| `read_file`, `list_files`, `search_code` | ✅ | DAG scheduler runs these in parallel |
| `semantic_search` | ✅ | TF-IDF default; pluggable Embedder for cross-session indexing |
| `list_file_versions` | ✅ | Surfaces per-file timeline |
| `write_file`, `patch_file`, `delete_file`, `rename_file` | ❌ | Auto-update semantic index + version history |
| `revert_file` | ❌ | Roll a file back to any prior version |
| `run_command` | ❌ | Node/Bun only; blocked on edge |
| `read_build_result` | ✅ | Agent reads browser-side WebContainer install/build/test outcomes |
| `web_search`, `git_status`/`git_diff`/`git_log`/`git_commit` | mixed | Standard tools |
| `create_github_pr` | ❌ | Branch + commit + PR via REST. **HITL-gated** |
| `visual_verify`, `visual_interact` | mixed | CDP screenshot + vision judge against preview URL |
| `init_agents_md` | ✅ | Drafts AGENTS.md; `needsApproval: true` |

---

## Quality

| Metric | Verified by | Current value |
|---|---|---|
| Backend test suite | `apps/worker` vitest | **357 tests, 100% pass** (+1 Bun-spawn skipped under Node) |
| Frontend test suite | `apps/web` vitest | **184 tests, 100% pass** |
| Lint | `bun lint` (biome) | **0 errors / 105 files** |
| Typecheck | `bun --filter @bscode/* typecheck` | **0 errors** (worker + web) |
| Lighthouse desktop | `chrome-devtools-mcp` audit | **Accessibility 100 · Best Practices 100 · SEO 100 · Agentic Browsing 100** |

The 2026-06-16/17 sweep added **301 tests across 12 commits** (240 → 541)
with 4 real bugs caught and fixed in the process — see git log for the
SEC-013 / SEC-014 / SEC-015 / SEC-016 / SEC-017 forensic notes.

The pre-restructure commits in this repo include extensive per-capability
verification tables — see the `docs/` directory.

---

## Documentation

| Topic | Doc |
|---|---|
| Parallel job queue | [docs/B1-job-queue.md](docs/B1-job-queue.md) |
| Closed validation loop | [docs/B2-validation-loop.md](docs/B2-validation-loop.md) |
| GitHub repo import | [docs/B3-github-import.md](docs/B3-github-import.md) |
| Tiered approval policy | [docs/B4-approval-policy.md](docs/B4-approval-policy.md) |
| Multi-agent shapes | [docs/multi-agent-modes.md](docs/multi-agent-modes.md) |
| SSE Last-Event-ID resume | [docs/C1-sse-resume.md](docs/C1-sse-resume.md) |
| Async-agent end-to-end demo | [scripts/demo-async-agent.mjs](scripts/demo-async-agent.mjs) |

---

## License

[Apache-2.0](./LICENSE) — © bscode contributors.

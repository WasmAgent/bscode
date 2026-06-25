# bscode

> Real workload and evidence collection surface for the WasmAgent Trustworthy Agent Training Loop.

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/WasmAgent/bscode)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![wasmagent-js](https://img.shields.io/badge/built%20on-wasmagent--js-646cff.svg)](https://github.com/WasmAgent/wasmagent-js)
[![evomerge](https://img.shields.io/badge/trains-evomerge--framework-orange.svg)](https://github.com/telleroutlook/evomerge-framework)

bscode is **not** competing with Cursor, Claude Code, or Codex. It is:
- The **reference deployment** for [wasmagent-js](https://github.com/WasmAgent/wasmagent-js)
- A **real workload source**: WASM sandbox, durable checkpoints, multi-agent fan-out, visual verifier
- An **evidence collection surface**: build results, visual verification, rollout traces → training data

> This repository is the second layer of the [WasmAgent Trustworthy Agent Training Loop](https://github.com/telleroutlook/evomerge-framework/blob/main/docs/ecosystem-map.md).

```bash
npm add @wasmagent/core   # the framework on npm
```

---

## Data Collection Modes

bscode operates in three explicit modes for trajectory and evidence export:

| Mode | Description | Data retained |
|---|---|---|
| **Demo Mode** | Public showcase, no long-term data | None |
| **Evidence Mode** | Saves build results, visual verification, job metadata for audit | Objective signals only |
| **Training Data Mode** | User-explicitly enabled; exports sanitized rollout + compliance JSONL to evomerge-framework | Full `rollout-wire/v1` + `ComplianceEvalRecord` |

Training Data Mode must be explicitly opted into. Data passes through evomerge-framework's
contamination checks and provenance validation before any training use.

---

## WasmAgent Ecosystem

| Repo | Role |
|---|---|
| [wasmagent-js](https://github.com/WasmAgent/wasmagent-js) | Runtime compliance source of truth: kernel / policy / verifier / ComplianceEvalRecord emitter |
| **bscode** (this repo) | Real workload + evidence collection surface: reference deployment, trajectory export |
| [evomerge-framework](https://github.com/telleroutlook/evomerge-framework) | Measurement trust + trace-to-training backend: audit, SFT/DPO/router data factory |

```text
Runtime Compliance Source of Truth
  → Real Workload and Evidence Collection
  → Measurement Trust and Trace-to-Training Backend
  → Better Policy / Router / Small Model
  → Stronger Runtime
```

---

## Quick start (local, ~2 minutes)

```bash
git clone https://github.com/WasmAgent/bscode
cd bscode
bun install                                           # 1
cp apps/worker/.dev.vars.example apps/worker/.dev.vars # 2 — fill ANTHROPIC_API_KEY
bun dev:worker                                         # 3 — http://localhost:8787
bun dev:web                                            # 4 — http://localhost:3000  (in another terminal)
```

That's it. KV bindings are optional — bscode silently falls back to in-memory
storage so you can play before owning Cloudflare resources.

> Need a different model? Add any of `DOUBAO_API_KEY`, `DEEPSEEK_API_KEY`,
> `MOONSHOT_API_KEY`, etc. to `.dev.vars`. The full set lives in
> `apps/worker/.dev.vars.example`.

---

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
bun deploy:worker
bun deploy:web
```

---

## Security & Production Deployment

- **Authentication** — All stateful API endpoints require `Authorization: Bearer <BSCODE_CLIENT_TOKEN>` when `BSCODE_CLIENT_TOKEN` is configured in the Worker environment. The worker runs locally without any Cloudflare bindings (in-memory fallback) and without authentication when the token is unset.
- **CORS** — Set `BSCODE_ALLOWED_ORIGIN` to your deployment domain (e.g. `https://bscode.example.com`) in production. The default (`localhost:5173`) is safe for local dev but must not be used in production.
- **Build-result nonce** — `/build-result` requires a per-job nonce in production mode. Obtain it with `GET /jobs/:id/build-nonce` before posting a result. This prevents result-injection across jobs (BSCODE-004).
- **Job state persistence** — Job state is persisted to the `BSCODE_SESSIONS` KV namespace when configured, making the Worker restart-safe. Without the binding the worker falls back to in-memory state (lost on restart).

Full security governance: [docs/GOVERNANCE.md](./docs/GOVERNANCE.md) · Data governance (consent, retention, deletion): [docs/DATA-GOVERNANCE.md](./docs/DATA-GOVERNANCE.md)

---

## What this demonstrates

Three core scenarios:

| Demo | What it proves | How to trigger |
|---|---|---|
| WASM sandbox blocks dangerous code | Security is capability policy, not prompt | Ask the agent to read `/etc/passwd` or access the network |
| Multi-branch rollout + build verifier | Parallel branches produce ranked training signal | Submit any coding task |
| Trajectory export → DPO/PPO | Verified results become training data | `GET /rollouts/export` after a coding run |

Full feature list and architecture: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)

---

## CLI quick path

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

## MCP server integration

The bscode worker mounts a code-mode MCP server at `/mcp`. Add it to Claude Desktop
or any MCP host that speaks Streamable HTTP:

```jsonc
{
  "mcpServers": {
    "bscode-files": {
      "url": "https://YOUR-WORKER-DEPLOY/mcp"
    }
  }
}
```

For `bun dev:worker` running locally, use `http://localhost:8787/mcp`.

Read-only tools (`read_file`, `list_files`, `search_code`) are exposed through one
`execute_code` surface. Write tools are deliberately excluded — they need approval/state
that does not translate cleanly across an MCP transport boundary.

## MCP Firewall attack demo

The worker exposes a self-contained demo showing what happens to an agent with and without
`@wasmagent/mcp-firewall` in front of its tools.

```
GET  /mcp-demo              — list all 5 attack scenarios
POST /mcp-demo/:scenarioId  — run a scenario; returns JSON comparison
```

Scenarios: `prompt-injection`, `exfiltration`, `rug-pull`, `taint-passthrough`, `sampling-abuse`.

Each response includes a `withoutFirewall` vs `withFirewall` diff: tool blocked/flagged,
risk findings, rug-pull hash diff, and taint-boundary wrapping.

## bscode-bench

`fixtures/bench/tasks/` contains 22 benchmark task manifests (`bench-task/v1` schema)
covering 5 categories: build repair, API correctness, security/policy, Cloudflare-specific,
and multi-step long-horizon. Each manifest specifies `user_query`, `verifiers`, and
`admission` settings for the evidence gate.

```bash
ls fixtures/bench/tasks/   # 22 tasks
```

---

## Out of scope

bscode is intentionally **not**:

- **A Cursor / Claude Code competitor.** Real shell, real npm install, real
  compilation chains are not what a WASM kernel is for. Use the framework's
  [`@wasmagent/kernel-remote`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/kernel-remote) tier for that.
- **An IDE.** No file watcher, no LSP, no plugin system. The Monaco surface
  exists to demonstrate `useAgentRun()` + `TokenMeter` in a Next.js app.
- **A long-term product roadmap.** New capabilities land in wasmagent-js
  first; bscode pulls them in as a demo.

We accept PRs that improve the demo (clearer flows, better screenshots,
honest benchmarks) and PRs that remove things that have drifted from this
positioning.

---

## Documentation

| Topic | Link |
|---|---|
| Architecture & tools | [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) |
| Security governance | [docs/GOVERNANCE.md](./docs/GOVERNANCE.md) |
| Data governance (consent, retention, deletion) | [docs/DATA-GOVERNANCE.md](./docs/DATA-GOVERNANCE.md) |
| Training data loop | [evomerge-framework](https://github.com/telleroutlook/evomerge-framework) |
| Claims registry | [docs/claims/claims.yaml](./docs/claims/claims.yaml) |
| Parallel job queue | [docs/B1-job-queue.md](./docs/B1-job-queue.md) |
| Closed validation loop | [docs/B2-validation-loop.md](./docs/B2-validation-loop.md) |
| GitHub repo import | [docs/B3-github-import.md](./docs/B3-github-import.md) |
| Tiered approval policy | [docs/B4-approval-policy.md](./docs/B4-approval-policy.md) |
| Multi-agent shapes | [docs/multi-agent-modes.md](./docs/multi-agent-modes.md) |
| SSE Last-Event-ID resume | [docs/C1-sse-resume.md](./docs/C1-sse-resume.md) |

---

## License

[Apache-2.0](./LICENSE) — © bscode contributors.

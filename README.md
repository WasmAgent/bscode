# bscode

> Real workload and evidence collection surface for the WasmAgent Trustworthy Agent Training Loop.

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/WasmAgent/bscode)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![wasmagent-js](https://img.shields.io/badge/built%20on-wasmagent--js-646cff.svg)](https://github.com/WasmAgent/wasmagent-js)
[![trace-pipeline](https://img.shields.io/badge/trains-trace--pipeline-orange.svg)](https://github.com/WasmAgent/trace-pipeline)

bscode is **not** competing with Cursor, Claude Code, or Codex. It is:
- The **reference deployment** for [wasmagent-js](https://github.com/WasmAgent/wasmagent-js)
- A **real workload source**: WASM sandbox, durable checkpoints, multi-agent fan-out, visual verifier
- An **evidence collection surface**: build results, visual verification, rollout traces → training data

```
wasmagent-js  ──►  bscode        ──►  trace-pipeline  ──►  better models
(runtime /         (reference          (measurement /           │
 policy / AEP)      deployment /        training data)           │
                    evidence)                                     │
      ◄──────────────────────────────────────────────────────────┘
```

> This repository is the **second layer** of the WasmAgent Trustworthy Agent Training Loop.
> Full system diagram: [trace-pipeline/docs/ecosystem-map.md](https://github.com/WasmAgent/trace-pipeline/blob/main/docs/ecosystem-map.md)

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
| **Training Data Mode** | User-explicitly enabled; exports sanitized rollout + compliance JSONL to trace-pipeline | Full `rollout-wire/v1` + `ComplianceEvalRecord` |

Training Data Mode must be explicitly opted into. Data passes through trace-pipeline's
contamination checks and provenance validation before any training use.

---

## WasmAgent Ecosystem

| Repo | Role |
|---|---|
| [wasmagent-js](https://github.com/WasmAgent/wasmagent-js) | Runtime compliance source of truth: kernel / policy / verifier / ComplianceEvalRecord emitter / AEP evidence protocol |
| **bscode** (this repo) | Real workload + evidence collection surface: reference deployment, trajectory export, AEP evidence bundle |
| [trace-pipeline](https://github.com/WasmAgent/trace-pipeline) | Measurement trust + trace-to-training backend: validate-aep, trust-score, audit-report, SFT/DPO/router data factory |

```text
Runtime Compliance Source of Truth
  → Real Workload and Evidence Collection
  → Measurement Trust and Trace-to-Training Backend
  → Better Policy / Router / Small Model
  → Stronger Runtime
```

---

## Quick start (local, ~2 minutes)

Run an agent task, verify what happened, export trustworthy traces.

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

**Step 1 — Set auth token and allowed origin BEFORE deploying** (required; the
deploy script will fail if these are missing):

```bash
wrangler secret put BSCODE_CLIENT_TOKEN    # required — all stateful endpoints need this
wrangler secret put BSCODE_ALLOWED_ORIGIN  # required — set to your Pages deploy URL
```

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
- **Public MCP** — `/mcp` is protected by `BSCODE_CLIENT_TOKEN` by default. To expose it publicly you must: (1) bind `BSCODE_PUBLIC_READ_KV` to a **separate, dedicated** read-only KV namespace, and (2) set `DANGEROUSLY_EXPOSE_DEPLOYMENT_KV=true` in `wrangler.toml [vars]`. Without `BSCODE_PUBLIC_READ_KV` bound, `/mcp` returns 503 when the flag is set. **Never** point the public MCP endpoint at the same KV namespace as `BSCODE_FILES`.
- **Strict Auth** — `STRICT_AUTH=true` is set by default in `wrangler.toml`. This causes the worker to fail-fast at startup if authentication is misconfigured (e.g., if `allowLocalSessionFallback` were accidentally set in production). Remove this only for intentional dev/test deployments.

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

> **30-min end-to-end Trust Pack guide:** [wasmagent-js/docs/quickstarts/trust-pack-30min.md](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/quickstarts/trust-pack-30min.md)

## bscode-bench

`fixtures/bench-v0/tasks/` — 30 benchmark task manifests (`bench-task/v1` schema) across 5 categories:

| Category | Count | Verifier |
|---|---|---|
| tool-calling | 7 | deterministic |
| policy-compliance | 6 | policy |
| mcp-attack | 7 | deterministic (blocked/ask_user/flag) |
| long-horizon | 5 | llm-judge |
| build-repair | 5 | build |

[Leaderboard →](/leaderboard) · Dataset card: [`fixtures/bench-v0/DATASET_CARD.md`](./fixtures/bench-v0/DATASET_CARD.md)

---

## Out of scope

bscode is intentionally **not**:

- **A Cursor / Claude Code competitor.** No real shell, no LSP, no plugin system.
- **An IDE.** Monaco exists to demo Evidence Timeline + tool call visualization.
- **A standalone product.** All security/policy primitives come from `@wasmagent/*`.
- **A benchmark with 1000+ tasks yet.** bench-v0 is 30 tasks, growing deliberately.

---

## Documentation

| Topic | Link |
|---|---|
| Architecture & tools | [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) |
| Security governance | [docs/GOVERNANCE.md](./docs/GOVERNANCE.md) |
| Data governance (consent, retention, deletion) | [docs/DATA-GOVERNANCE.md](./docs/DATA-GOVERNANCE.md) |
| Training data loop | [trace-pipeline](https://github.com/WasmAgent/trace-pipeline) |
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

# bscode Architecture

## Directory layout

```
apps/
  worker/   Cloudflare Worker — Hono router, CodeAgent, ToolCallingAgent, KV file system
  web/      Next.js 15 — Monaco editor, Terminal, AgentPanel, JobsPanel, TokenMeter
scripts/    CLI test scripts (bscode.mjs, test-full.mjs, demo-async-agent.mjs)
docs/       Per-capability deep dives
```

---

## Feature map

Each row maps to a published wasmagent-js capability — bscode just wires
them up against the Cloudflare runtime.

| bscode feature | wasmagent-js it exercises |
|---|---|
| Edge-isolated code execution | [`@wasmagent/kernel-quickjs`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/kernel-quickjs) — QuickJS WASM kernel, no `node:vm` |
| Speculative tool fan-out | `ParallelForkJoinRunner` in `@wasmagent/core` |
| Durable checkpoints + SSE resume | [`@wasmagent/core`](https://wasmagent.github.io/wasmagent-js/guides/durable-runtime) — `KvCheckpointer`, `EventLog`, `Last-Event-ID` |
| Multi-agent shapes (parallel / planFirst) | `ParallelForkJoinRunner` + stateless HITL primitive in core |
| RLAIF rollout adapter | `apps/worker/src/rollout-adapter.ts` — `makeBuildResultReader` / `makeVisualResultReader` bridge bscode's KV build-result channel to `BuildPassesVerifier` / `VisualAssertVerifier` in `@wasmagent/core`. `AppConfig.rolloutConcurrency` controls the job queue cap for batch sampling runs. |
| Training data pipeline | B2 build signals + C3 visual assertions feed `RolloutRanker` in wasmagent-js, which ranks rollout branches by objective score. Ranked branches are exported as DPO/PPO JSONL by [evomerge](https://github.com/WasmAgent/evomerge) for downstream RL post-training. |
| Per-job session isolation + diff/merge | `BranchableWorkspace` in core |
| Tiered approval policy | `needsApproval` lifecycle hook in core |
| Visual verifier (CDP + vision judge) | [`@wasmagent/tools-browser`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/tools-browser) — CDP session driver |
| OWASP Agentic Top 10 — live blocked | [`CapabilityManifest`](https://github.com/WasmAgent/wasmagent-js/blob/main/packages/core/src/executor/types.ts) + [field-by-field OWASP map](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/security/capability-manifest-owasp.md). Click "Sandbox blocks an OWASP attack live" in the differentiator band to see the 4 attack scenarios + intercepted-error strings the kernel actually returns. |
| GitHub repo import + PR opener | Bscode-specific tools wrapping the standard tool contract |
| Prompt-cache instrumentation | Per-call `usage` events from every model adapter |
| AGENTS.md project conventions | Loaded into the system prompt prefix on every `/run` |

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

# bscode — Development Guide for Claude

## What this project is (and is not)

**Is:** Reference deployment and evidence collection surface for wasmagent-js. Real coding-agent workloads → AEP evidence → trace-pipeline training data.

**Is NOT — do not implement these:**
- A Cursor / Claude Code / Codex competitor — no IDE features, no remote execution product
- A general coding web app — the UI exists to show Evidence Timeline, not to be a full IDE
- A standalone product without wasmagent-js — all security/policy primitives come from `@wasmagent/*`
- A public benchmark with 1000+ tasks yet — bscode-bench-v0 is 30 tasks, growing deliberately

## Test Commands

**IMPORTANT: This project uses `bun test` (via turbo). Do NOT use `npx vitest`, `npm test`, or bare `bun test` from root.**

```bash
# Run all tests (recommended — uses package.json scripts which include --isolate)
bun --filter @bscode/worker test
bun --filter @bscode/web test

# Or via turbo
bun run test    # runs turbo which triggers bun test in each package
```

**Worker test isolation**: `apps/worker/bunfig.toml` sets `isolate = true`, but Bun 1.3.14 only reads it when CWD matches. Running `bun test apps/worker/src/` from the repo root will produce ~44 false failures due to mock bleed between test files. Always use `bun --filter @bscode/worker test` or `cd apps/worker && bun test --isolate`.

**CRITICAL: Never run any `bun test` as a background task** (`run_in_background`) — a hung test will silently burn CPU.

## Lint

```bash
npx biome check apps/
npx biome check --write apps/    # auto-fix
```

## Build / Deploy

```bash
bun run deploy:dry-run    # build + wrangler dry-run (no deploy)
bun run deploy            # deploy to Cloudflare
```

## Typecheck

```bash
bun --filter @bscode/web run typecheck
bun --filter @bscode/worker run typecheck
```

## RLAIF rollout adapter + key modules (2026-06-26)

`apps/worker/src/rollout-adapter.ts` bridges bscode's KV build-result channel to wasmagent-js verifiers.

| Module | Location |
|---|---|
| `registerEvidenceRoutes` | `apps/worker/src/routes/evidence.ts` — `GET /evidence/:runId` AEP bundle export |
| `registerJobsExportRoutes` | `apps/worker/src/routes/jobsExport.ts` — `GET /jobs/export` JSONL batch export |
| MCP demo (8 OWASP scenarios) | `apps/worker/src/routes/mcpDemo.ts` |
| Evidence Timeline panel | `apps/web/src/components/AgentPanel.tsx` (evidenceSummary prop) |
| Leaderboard page | `apps/web/src/app/leaderboard/page.tsx` |
| Hardening checklist | `scripts/check-hardening.mjs` (6 production checks) |
| bench-v0 tasks (30 total) | `fixtures/bench-v0/tasks/` (tool-calling×7, policy×6, mcp-attack×7, long-horizon×5, build-repair×5) |

**Session IDs:** All verifier calls must use derived IDs from `deriveJobSessionId()`.
Use `{ strictKvMode: true }` in batch/rollout contexts to make KV failures throw.

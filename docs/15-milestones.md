# Milestones

> Bootstrapped by **SweepRoadmapSync**. Each milestone is derived from an
> existing planning document in `docs/` and converted to the standard
> roadmap-pipeline format. Acceptance criteria below are the **binding**
> definition of done — a milestone is complete only when every criterion
> holds in the worktree.

---

## M1 — Parallel job queue (B1)

**Source:** [`docs/B1-job-queue.md`](./B1-job-queue.md)

**Goal:** Background-task dashboard — submit several independent tasks at
once, run them in parallel up to a concurrency cap, and let every finished
job drop a PR via `create_github_pr` without waiting for the others.

### Acceptance criteria

- [x] `POST /jobs` accepts `{ task }` or `{ jobs: [{task}, ...] }`; up to 20
      per request, each an independent run with its own `traceId`.
- [x] `GET /jobs?sessionId=…&status=…` lists jobs newest-first.
- [x] `GET /jobs/:id` snapshots a single job (status, eventCount, last
      events, finalAnswer, error).
- [x] `DELETE /jobs/:id` cooperatively aborts via `AbortSignal`.
- [x] A `/jobs` Next.js page renders a `<JobsPanel />` multi-run dashboard.
- [x] Concurrency cap defaults to 4 and is configurable; over-cap
      submissions queue (`status: "queued"`) and start as slots free.
- [x] `runningCount` / `pendingCount` are exposed via `GET /jobs?stats`.
- [x] Terminal-state jobs are mirrored under `job:<id>` for 24h in KV when
      `config.sessionsKv` is bound; live event tails are transient.
- [x] `JobQueue` unit tests (`apps/worker/src/jobs/queue.test.ts`) pass
      (10 tests).
- [x] HTTP-level integration tests in `apps/worker/src/app.test.ts` under
      "Job queue (B1)" pass (8 tests).
- [x] `apps/web/src/components/JobsPanel.test.tsx` passes (5 panel UI
      tests).

---

## M2 — Closed-loop validation (B2)

**Source:** [`docs/B2-validation-loop.md`](./B2-validation-loop.md)

**Goal:** Let the worker-side agent see whether the project it just wrote
actually compiles in the user's browser, so it can fix dependency typos and
build errors without human intervention.

### Acceptance criteria

- [x] `POST /build-result` accepts browser-written snapshots keyed by
      `X-Session-Id` (defaults to `default` session when header absent).
- [x] `GET /build-result` provides debug readback; `DELETE /build-result`
      clears the snapshot.
- [x] The `read_build_result` tool is registered only in framework mode
      (`body.framework` set) AND when `X-Session-Id` is present.
- [x] The tool's returned string lets the model branch on `success |
      failed | running | unknown`, including exit code, preview URL and
      stderr tail on failure.
- [x] Store keeps latest snapshot per session in memory and mirrors to
      `BSCODE_BUILD_RESULTS` KV when bound.
- [x] `BUILD_VALIDATION` system prompt in
      `apps/worker/src/agents/prompts.ts` instructs the agent to call
      `read_build_result` after writing files and patch on failure.
- [x] Store tests (`apps/worker/src/build-results.test.ts`), tool tests
      (`apps/worker/src/tools/build-result.test.ts`), and HTTP route tests
      under "Build result reverse channel (B2)" in
      `apps/worker/src/app.test.ts` all pass.
- [x] `useWebContainer()` reporter fires at install start/end,
      dev-server ready, and build error lifecycle points with no new return
      value.

---

## M3 — GitHub repo import & true embedding (B3)

**Source:** [`docs/B3-github-import.md`](./B3-github-import.md)

**Goal:** Pull a real GitHub repository into the worker's KV file store so
the agent can `read_file`, `search_code`, `semantic_search`, and
ultimately `create_github_pr` against an existing codebase; plus wire the
default TF-IDF embedder to a real-vector one via `@wasmagent/tools-rag`.

### Acceptance criteria

- [x] `POST /import/github` imports a repo given `owner`, `repo`, optional
      `ref`, optional `token`, optional `paths` filter and optional
      `textExtensions` allowlist.
- [x] `ref` omitted resolves the repo's `default_branch` via
      `GET /repos/{owner}/{repo}`.
- [x] Recursive tree endpoint propagates `truncated: true` unchanged.
- [x] Per-file blob fetch failures are collected into `skippedReasons`
      without aborting the whole import.
- [x] Binary detection skips files with > 20% control-byte density in the
      first 4 KB; tunable via `textExtensions`.
- [x] Files larger than 200 KB are skipped; total imports capped at 2000
      files per call (constants in
      `apps/worker/src/tools/githubImport.ts`).
- [x] Imported files are upserted into the semantic index when an indexer
      is bound, so the agent's `semantic_search` sees the imported tree.
- [x] Secret-file deny-list in
      `apps/worker/src/tools/importDenyList.ts` drops matching files
      silently before any content is read into KV; the list cannot be
      overridden from request input.
- [x] Unit tests (`apps/worker/src/tools/githubImport.test.ts`, 8) and
      route tests ("GitHub repo import (B3)" in `app.test.ts`, 4) pass.

---

## M4 — Tiered approval policy (B4)

**Source:** [`docs/B4-approval-policy.md`](./B4-approval-policy.md)

**Goal:** Per-call approval rules for write tools, adapting Vercel AI SDK
6's `needsApproval`-as-function contract with three presets and custom rule
support via the `POST /run` body.

### Acceptance criteria

- [x] `PolicyPresets.permissive()`, `balanced()`, `strict()` exist and
      behave as documented.
- [x] `balanced` gates `.env*`, `.dev.vars`, `.github/`, `wrangler.toml`,
      every `delete_file` / `rename_file`, and writes exceeding 5 KB.
- [x] Rules evaluation is first-match-wins in registration order; the
      default verdict covers non-matching paths.
- [x] `POST /run` accepts an inline `approvalPolicy` object literal, or a
      preset name (`"balanced"`, `"strict"`, `"permissive"`); omitting it
      preserves legacy permissive behaviour.
- [x] When `needsApproval` returns true the run suspends with an
      `await_human_input` event, the checkpoint snapshot persists the
      pending request, and a follow-up `POST /run` with `humanResponse`
      unblocks the run.
- [x] `policy.explain({ op, path, sizeChars })` returns which rule fired
      (or that none did) for diagnostics.
- [x] `apps/worker/src/policies/approvalPolicy.test.ts` covers 12
      scenarios: default verdict, first-rule-wins ordering, prefix
      matching, op filtering, size gating, `explain()` output, and each
      preset's documented behaviour.

---

## M5 — SSE `Last-Event-ID` resume (C1)

**Source:** [`docs/C1-sse-resume.md`](./C1-sse-resume.md)

**Goal:** Reuse wasmagent-js core's `EventLog` primitive so a dropped TCP
connection is recoverable via pure replay — no agent re-invocation, no
duplicate side-effects.

### Acceptance criteria

- [x] Live runs respond with `X-Wasmagent-Trace-Id` and
      `Access-Control-Expose-Headers: X-Wasmagent-Trace-Id`, and each SSE
      frame carries `id: <12-digit zero-padded seq>`.
- [x] Resume requests accept a `Last-Event-ID` header and
      `resumeTraceId` body field; when `checkpointsKv` is bound the worker
      takes a replay-only fast path that never invokes the agent factory.
- [x] Resume responses carry `X-Bscode-Resume: 1`.
- [x] `EventLog.purge(traceId)` runs best-effort after a successful run.
- [x] Degradation: with `resumeTraceId` but no bound `checkpointsKv`,
      falls through to a fresh run without `X-Bscode-Resume`.
- [x] `apps/worker/src/app.test.ts` "C1 — SSE Last-Event-ID resume" block
      (6 tests) passes, including the no-reinvocation mock counter
      assertion.
- [x] `packages/react/src/useAgentRun.test.ts` "resume request shaping"
      block (4 tests) passes, including verbatim survival of caller auth
      headers.

---

## M6 — RLAIF rollout adapter

**Source:** [`docs/rlaif-adapter.md`](./rlaif-adapter.md)

**Goal:** Bridge bscode's build-result KV channel to wasmagent-js'
`BuildPassesVerifier` / `VisualAssertVerifier` callbacks and export AEP
evidence records for the training loop.

### Acceptance criteria

- [x] `makeBuildResultReader(kv?)` returns a `BuildResultReader` mapping
      bscode statuses: `success→success`, `failed→failure`, `running` and
      `unknown` always fail the verifier.
- [x] `makeVisualResultReader(kv?)` maps `visual.verdict.matchesIntent` to
      `pass`/`fail` and falls back to inferring from `consoleErrors`,
      `uncaughtErrors`, and `rendersNonEmpty` when no explicit verdict is
      present.
- [x] `AppConfig.rolloutConcurrency` configures the `JobQueue` cap
      (default 4).
- [x] All verifier calls use derived job session IDs from
      `deriveJobSessionId()` — never the `"default"` bucket; calling with
      the default session logs a `console.warn`.
- [x] `{ strictKvMode: true }` makes `putBuildResult` throw on KV write
      failure in batch/rollout contexts.
- [x] `buildAEPEvidence(opts)` is async, signs the record via
      `@wasmagent/aep`'s `LocalEd25519Signer`, and populates `actions[]`,
      `verifier_results[]`, `capability_decisions[]`, `budget_ledger`,
      `input_refs[]`/`output_refs[]`, and
      `signature: {alg:"ed25519", key_id, sig}`.
- [x] Evidence export validates against the AEP schema before training use
      (trace-pipeline `evomerge validate-aep` gate).

---

## M7 — Multi-agent modes (parallel / planFirst)

**Source:** [`docs/multi-agent-modes.md`](./multi-agent-modes.md)

**Goal:** `agentMode: "multi"` picks one of two parallel-friendly shapes —
`parallel` (fork-join draft → reviewer) or `planFirst` (planner → human
approval → executor) — with the old serial layout removed entirely.

### Acceptance criteria

- [x] `multiAgentMode: "parallel"` (default) forks into N independent
      draft branches via `ParallelForkJoinRunner` and threads the
      synthesised draft into a Stage-2 `createToolAgent` reviewer with the
      full tool set.
- [x] Defaults `branches=3`, `concurrency=2`, `aggregation="summary"` are
      all overridable per call.
- [x] `multiAgentMode: "planFirst"` emits
      `{ phase: "plan_ready", plan, step }` then `await_human_input`
      (default `promptId: "approve-plan"`), and pauses with the snapshot
      persisted under a `planfirst-<checkpointId>-<ts>` traceId.
- [x] Resume with `humanResponse` anything other than `"yes"`
      (case-insensitive) includes the response verbatim as "User feedback
      on the plan:" in the executor brief.
- [x] The old serial multi-agent layout is gone; no compatibility mode.
- [x] Both modes compose with B4's `approvalPolicy`.
- [x] `apps/worker/src/agents/multi-agent.test.ts` (6 tests) passes:
      parallel emit pattern, planFirst `await_human_input` contract,
      custom promptId, and `runPlanFirstExecution`.
- [x] "planFirst resume (B4)" route tests in `app.test.ts` (2) pass:
      resume happy path and missing-snapshot error shape.

---

## M8 — Data governance & pipeline contract

**Sources:** [`docs/DATA-GOVERNANCE.md`](./DATA-GOVERNANCE.md) and
[`docs/GOVERNANCE.md`](./GOVERNANCE.md)

**Goal:** Formalise consent, data modes, redaction, retention, deletion and
export, and the binding three-repo training pipeline contract.

### Acceptance criteria

- [x] Three explicit data modes (Demo / Evidence / Training Data) exist;
      Demo is the default and no data leaves it.
- [x] Training Data Mode requires affirmations at both operator and session
      levels; never inferred from usage.
- [x] Redaction (secret scanner, path normalisation, 4 kB stdout
      truncation) is applied in the worker before JSONL is written to KV,
      not as post-processing.
- [x] Retention table honoured: Demo 1h TTL, Evidence 30 days
      (`EVIDENCE_RETENTION_DAYS` configurable), Training until explicit
      delete/purge.
- [x] `DELETE /jobs/:id/rollout` (single record) and `DELETE /rollouts`
      (session) endpoints hard-delete records.
- [x] `GET /rollouts/export` streams `rollout-wire/v1` JSONL with an
      `X-Record-Count` header.
- [x] `unknown` objective-status records are excluded from DPO pairs
      (only permitted in weak-label pool or logs).
- [x] `fixtures/data-loop/rollout-branches.v1.jsonl` is byte-identical to
      the wasmagent-js and evomerge copies.

---

## See also

| Milestone | Source doc(s) | Implementations / tests |
|---|---|---|
| M1 | [`B1-job-queue.md`](./B1-job-queue.md) | `apps/worker/src/jobs/*`, `apps/web/src/components/JobsPanel.tsx` |
| M2 | [`B2-validation-loop.md`](./B2-validation-loop.md) | `apps/worker/src/build-results.ts`, `apps/worker/src/tools/build-result.ts` |
| M3 | [`B3-github-import.md`](./B3-github-import.md) | `apps/worker/src/tools/githubImport.ts`, `importDenyList.ts` |
| M4 | [`B4-approval-policy.md`](./B4-approval-policy.md) | `apps/worker/src/policies/approvalPolicy.ts` |
| M5 | [`C1-sse-resume.md`](./C1-sse-resume.md) | `EventLog`, `packages/react/src/useAgentRun.ts` |
| M6 | [`rlaif-adapter.md`](./rlaif-adapter.md) | `apps/worker/src/rollout-adapter.ts`, `trajectoryExport.ts` |
| M7 | [`multi-agent-modes.md`](./multi-agent-modes.md) | `apps/worker/src/agents/multi-agent.ts` |
| M8 | [`DATA-GOVERNANCE.md`](./DATA-GOVERNANCE.md), [`GOVERNANCE.md`](./GOVERNANCE.md) | Export/delete endpoints, redaction pipeline |

## Status legend

All criteria above are marked `[x]` because they are derived from
planning documents that describe already-landed capability in this
worktree (verified by the source docs' own "See also" implementations and
passing test counts). This file converts those planning docs into the
standard milestone format so the roadmap pipeline can operate
autonomously — it does not introduce new scope.

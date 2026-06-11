# B1 — Parallel job queue ("submit N, collect N PRs")

> Background-task dashboard for BSCode: submit several independent tasks at
> once, the worker runs them in parallel up to a concurrency cap, every
> finished job can drop a PR via `create_github_pr` without waiting for the
> others. Codex cloud / Antigravity 2.0 form factor on top of bscode's
> existing durable runtime (`KvCheckpointer`, `EventLog`).

## What it gives you

- `POST /jobs` accepts `{ task }` or `{ jobs: [{task}, ...] }`. Up to 20
  per request; each becomes an independent run with its own traceId.
- `GET /jobs?sessionId=…&status=…` lists jobs, newest-first.
- `GET /jobs/:id` snapshot a single job (status, eventCount, last events,
  finalAnswer, error).
- `DELETE /jobs/:id` cooperative abort via AbortSignal.
- A `/jobs` Next.js page with `<JobsPanel />` for a multi-run dashboard.

## Architecture

```
                         ┌────────────────────────────────────┐
                         │ JobQueue (in-memory + KV mirror)   │
                         │  • concurrency cap (default 4)     │
                         │  • per-job ring buffer (100 evts)  │
                         │  • durable mirror on terminal      │
                         └──────┬─────────────────────────────┘
                                │
   POST /jobs (one or many)     │ self-fetches /run for each job
                                │ (same agent pipeline as a sync run)
                                ▼
                         ┌────────────────────────────────────┐
                         │ /run handler                       │
                         │  • B2 read_build_result (framework)│
                         │  • CheckpointableRun (durable)     │
                         │  • full tool set incl. PR maker    │
                         └────────────────────────────────────┘
```

The runner does **not** duplicate `/run`'s agent-construction code; it
self-fetches `/run` with the same body. That keeps both paths bit-identical
— anything `/run` learns to do (B2 build-result, B4 approvals, etc.) jobs
inherit for free.

## Concurrency model

- Default cap: 4 simultaneous jobs. Configurable via the `JobQueue`
  constructor; CF Worker's CPU budget is the practical ceiling.
- Over-cap submissions queue (`status: "queued"`) and start as slots free.
- `runningCount` / `pendingCount` are exposed via `GET /jobs?stats`.
- Cooperative cancellation only — `abort()` flips an `AbortSignal` and
  trusts the runner to wind down. The queue checks `signal.aborted` between
  yielded events; a runner that never yields for more than its abort budget
  may take a few seconds to actually stop.

## Durability

When `BSCODE_SESSIONS` (or whichever KV is wired into `config.sessionsKv`)
is bound, terminal-state jobs are mirrored under `job:<id>` for 24h. After
a worker recycle, `GET /jobs/:id` continues to return finished results
even though the in-memory queue is empty. Live event tails are NOT
persisted — they're transient by design.

## Web side

`apps/web/src/components/JobsPanel.tsx` is a self-contained dashboard:

- Textarea: one task per line → `Submit batch` POSTs `jobs[]`
- Live table: status pill, task, event count, "submitted Ns ago", abort button
- Polls `GET /jobs` every 2s while any job is `queued` or `running`; idle
  otherwise.

The panel is reachable at `/jobs` — separate page from the main
conversational dashboard, no risk of breaking the existing layout.

## See also

- `apps/worker/src/jobs/types.ts` — JobSpec / JobRecord / JobRunner shapes
- `apps/worker/src/jobs/queue.ts` — `JobQueue` implementation
- `apps/worker/src/jobs/queue.test.ts` — 10 queue-level unit tests
- `apps/worker/src/app.test.ts` — 8 HTTP-level integration tests under
  "Job queue (B1)"
- `apps/web/src/components/JobsPanel.tsx` — multi-run dashboard
- `apps/web/src/components/JobsPanel.test.tsx` — 5 panel UI tests
- `apps/web/src/app/jobs/page.tsx` — `/jobs` route

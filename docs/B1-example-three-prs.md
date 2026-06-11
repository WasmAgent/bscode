# B1 example — three unrelated tasks → three PRs in parallel

End-to-end demonstration of the parallel job queue. We submit three
independent refactors in one POST; the worker runs them simultaneously
(default concurrency 4); each finishes with a `create_github_pr` call so
three PRs land without waiting for any of the others.

> Run order: start the worker, expose your GitHub token via the
> `create_github_pr` HITL gate (or through `AppConfig.githubToken`), then
> issue the request below.

## Request

```bash
curl -X POST http://localhost:8788/jobs \
  -H 'Content-Type: application/json' \
  -H 'X-Session-Id: dev-session-1' \
  -d '{
    "jobs": [
      {
        "task": "Add a Jest test for the slugify() helper in src/utils.ts. Open a PR titled \"test(utils): cover slugify edge cases\".",
        "agentMode": "tool"
      },
      {
        "task": "Replace the deprecated request import in src/api.ts with native fetch. Open a PR titled \"refactor(api): drop request, use fetch\".",
        "agentMode": "tool"
      },
      {
        "task": "Bump react-dom from 18.2 to 18.3 in package.json and verify build passes. Open a PR titled \"chore(deps): react-dom 18.3\".",
        "agentMode": "tool"
      }
    ]
  }'
```

Response (immediate):

```json
{ "jobIds": ["job-mq95ab12-1", "job-mq95ab12-2", "job-mq95ab12-3"] }
```

## Watching progress

```bash
curl 'http://localhost:8788/jobs?sessionId=dev-session-1' | jq
```

Expected mid-flight shape:

```json
{
  "jobs": [
    { "id": "job-…-3", "status": "running", "eventCount": 7,  "spec": { "task": "Bump react-dom…" } },
    { "id": "job-…-2", "status": "running", "eventCount": 4,  "spec": { "task": "Replace the deprecated…" } },
    { "id": "job-…-1", "status": "running", "eventCount": 9,  "spec": { "task": "Add a Jest test…" } }
  ],
  "stats": { "running": 3, "pending": 0, "total": 3 }
}
```

A few seconds later all three flip to `done` (or `failed` for any that hit
an error), and each one's `finalAnswer` mentions the PR URL.

## Aborting one mid-flight

```bash
curl -X DELETE http://localhost:8788/jobs/job-mq95ab12-2
```

The other two jobs continue running — abort only affects the one id.

## How to verify the loop really fanned out

- `runningCount` reaches 3 while jobs are in flight (cap 4, well under).
- Open three PRs on GitHub at roughly the same wall-clock time, not
  serialised end-to-end.
- The worker terminal shows three independent `traceId`s emitting
  interleaved tool calls (`read_file` from job 1, `patch_file` from
  job 3, etc.).

## Web dashboard

Open `http://localhost:3000/jobs` for the interactive version of the same
flow:

- Paste the three tasks (one per line) into the textarea
- Click **Submit batch**
- Watch the table fill up; abort any row mid-flight

The page polls every 2s while any job is queued or running and goes idle
once everyone is terminal.

## Adapting

- More than one batch — submit again; the queue will start jobs as soon
  as a slot frees up (max 4 concurrent by default).
- Heavier parallelism — instantiate `JobQueue` with a higher
  `concurrency`; remember the CF Worker CPU budget is the practical
  ceiling.
- Long-running jobs — when an executable model run might exceed the
  edge runtime's wall-clock cap, wire `ctx.waitUntil` into
  `JobQueueOptions.waitUntil` so the run survives the response close.

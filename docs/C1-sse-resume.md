# C1 — SSE `Last-Event-ID` resume

The bscode worker streams `AgentEvent` JSON over Server-Sent Events. Until C1
landed, a dropped TCP connection (Workers cold-start, browser tab reload,
network blip) was unrecoverable: the agent kept running on the worker but the
client lost the tail of the event stream and the run had to be re-issued from
scratch — paying the model bill twice and re-applying every side-effect.

C1 closes this gap by reusing the wasmagent-js core
[`EventLog`](../../../wasmagent-js/packages/core/src/streaming/EventLog.ts)
primitive. Each event is persisted under
`evlog:<runTraceId>:<paddedSeq>` in the same KV namespace as agent
checkpoints; reconnect is a pure replay, no agent invocation.

## Wire protocol

### Live run (first connection)

| Direction | Header / field | Value | Purpose |
|---|---|---|---|
| Response | `X-Wasmagent-Trace-Id` | `run-<unix-ms>-<rand>` | Stable per-run handle the client echoes back on resume |
| Response | `Access-Control-Expose-Headers` | `X-Wasmagent-Trace-Id` | Required so cross-origin JS can read the trace id |
| SSE frame | `id: <12-digit zero-padded seq>` | monotonic per trace | The `Last-Event-ID` cursor browsers replay automatically |

### Resume (reconnect)

| Direction | Header / field | Value | Purpose |
|---|---|---|---|
| Request | `Last-Event-ID` | the highest `id:` the client received | Server skips everything ≤ this value |
| Request body | `resumeTraceId: "run-…"` | the trace id from the original response header | Server uses this as the `EventLog` key |
| Response | `X-Bscode-Resume: 1` | sentinel | Tells the client the worker accepted the resume |

When `resumeTraceId` is supplied **and** `checkpointsKv` is bound, the worker
takes a fast-path that **never invokes the agent factory** — it only iterates
`EventLog.replay(traceId, lastEventId)` and finishes with `data: [DONE]`. This
is what makes resume cheap: zero model tokens, zero side-effects, zero risk of
duplicate file writes or PR pushes.

## Failure modes (and what the worker does about them)

| Situation | Worker behavior |
|---|---|
| `resumeTraceId` set, `checkpointsKv` unbound | Falls through to a fresh run. Better than failing — the client only loses an opportunity to skip work it already saw. The response will not carry `X-Bscode-Resume`. |
| `resumeTraceId` set, no log persisted under that id | Replay returns zero events, then `[DONE]`. The client transitions to "complete". |
| `Last-Event-ID` exceeds the high-water mark | Same as above — nothing left to deliver. |
| Run completes successfully | `EventLog.purge(traceId)` runs best-effort — KV does not grow unboundedly across runs. |
| Run errors out before the final answer | `error` frame is delivered live but **not** persisted (it is a terminal event; clients stop after seeing it). The persisted log is left in place until eventual KV TTL eviction. |

## Client side

The hook `@wasmagent/react`'s `useAgentRun` (used by `apps/web/src/hooks/useAgent.ts`)
already implements the protocol:

* tracks the highest `id:` seen across the stream;
* on retry rebuilds the request with `Last-Event-ID` header + `resumeTraceId`
  body field;
* exposes a `resume: { maxAttempts, delayMs }` option for opt-in auto-retry on
  silently-truncated streams.

## CLI demo

`scripts/bscode.mjs` ships a `--resume-after N` flag that proves the round-trip
end-to-end:

```bash
node scripts/bscode.mjs \
  --events --resume-after 3 \
  "write a one-line haiku and return it"
```

After 3 SSE events the CLI cancels the stream (simulating a network drop),
captures `lastEventId`, then immediately re-POSTs with `resumeTraceId` and the
`Last-Event-ID` header. The display prints

```
── simulated disconnect after 3 events (last id=000000000002); reconnecting with resumeTraceId=run-… ──
(server accepted resume — replay-only mode)
```

and continues with the missing tail. Because the agent is not re-invoked, token
totals stay the same as a single uninterrupted run.

## Tests

* `apps/worker/src/app.test.ts` (the **C1 — SSE Last-Event-ID resume** describe
  block, 6 tests):
  - response carries `X-Wasmagent-Trace-Id` and `id:` lines when `checkpointsKv`
    is bound;
  - `EventLog` is purged after a successful run completes;
  - reconnect with `resumeTraceId` + `Last-Event-ID` delivers only the tail and
    proves the agent factory was not re-invoked (mock counter assertion);
  - `Last-Event-ID` past the high-water mark yields just `[DONE]`;
  - without `checkpointsKv`, live SSE still works but `id:` lines and the
    resume hint header are omitted (clean degradation);
  - resume against an unbound `checkpointsKv` falls through to a fresh run.
* `packages/react/src/useAgentRun.test.ts` (the **resume request shaping** describe
  block, 4 tests):
  - first attempt has no `Last-Event-ID` header and no `resumeTraceId` field;
  - retry after seeing the trace id but before any events sends `resumeTraceId`
    only;
  - retry after some events sends both `Last-Event-ID` and `resumeTraceId`;
  - caller-supplied headers (`Authorization`, `X-Session-Id`) survive the
    rebuild verbatim.

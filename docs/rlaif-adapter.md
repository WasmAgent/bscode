# RLAIF Rollout Adapter

> **File:** `apps/worker/src/rollout-adapter.ts`
> **Added:** 2026-06-22

bscode's build-result KV channel is the source of B2/C3 objective signals for
RLAIF training data. This adapter bridges the channel to the verifier callbacks
that `@wasmagent/core`'s `BuildPassesVerifier` and `VisualAssertVerifier` expect.

## API

### `makeBuildResultReader(kv?)`

Returns a `BuildResultReader` callback for `BuildPassesVerifier`.

```ts
import { makeBuildResultReader } from "./rollout-adapter.js";
import { BuildPassesVerifier } from "@wasmagent/core";

const verifier = new BuildPassesVerifier({
  getBuildResult: makeBuildResultReader(env.BUILD_RESULTS_KV),
});
```

The callback reads `getBuildResult(sessionId, kv)` and maps the
`BuildResultSnapshot` status to the `BuildResult` shape wasmagent-js expects:

| bscode status | wasmagent-js status |
|---|---|
| `"success"` | `"success"` |
| `"failed"` | `"failure"` |
| `"running"` | `"running"` (always fails verifier — not pass) |
| `"unknown"` | `"unknown"` (always fails verifier — not pass) |

### `makeVisualResultReader(kv?)`

Returns a `VisualResultReader` callback for `VisualAssertVerifier`.

Reads `BuildResultSnapshot.visual`. Maps `visual.verdict.matchesIntent` to
`"pass"` / `"fail"`. Falls back to inferring from `consoleErrors`,
`uncaughtErrors`, and `rendersNonEmpty` when no explicit verdict is present.

## `AppConfig.rolloutConcurrency`

The `JobQueue` concurrency cap is now configurable:

```ts
// wrangler.toml / server.node.ts
const app = createApp({
  rolloutConcurrency: 16, // default 4 — increase for batch RLAIF runs
  ...
});
```

## Session IDs

All verifier calls must use **derived job session IDs** from
`deriveJobSessionId()` — never the `"default"` bucket. Calling
`putBuildResult` / `getBuildResult` with the default session ID emits a
`console.warn` so silent cross-session contamination is visible in logs.

Pass `{ strictKvMode: true }` to `putBuildResult` in batch/rollout contexts
so KV write failures throw rather than being silently swallowed:

```ts
await putBuildResult(sessionId, snapshot, kv, { strictKvMode: true });
```

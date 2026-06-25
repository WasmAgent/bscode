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

## AEP Evidence Bundle Integration

As of 2026-06-25, bscode trajectory export also produces an **AEP evidence bundle**
alongside the `RolloutWireRecord`. This captures the evidence that each rollout
actually executed correctly and is safe for training export.

### `buildAEPEvidence(opts)`

```ts
import { buildAEPEvidence } from "./trajectoryExport.js";

const evidence = buildAEPEvidence({
  run_id: job.sessionId,
  model_id: "claude-haiku-4-5-20251001",
  tool_calls: record.tool_call_sequence,
  objective_passed: record.objective_score === 1,
});

// Attach to the rollout record
record.aep_evidence = evidence;
```

The bundle (`AEPEvidenceBundle`, schema `aep/v0.1`) contains:
- `tool_invocation_count` — total tool calls
- `state_changing_actions` — tool names from `STATE_CHANGING_TOOLS` set
- `verifier_passed` — maps to `objective_score`
- `capability_decisions` — empty by default (populated by MCPGateway when integrated)

### Consumption by trace-pipeline

Before training export, run:

```bash
python -m evomerge validate-aep --input data/aep_bundles.jsonl --fail-under 0.9
```

This gates training on evidence completeness, ensuring records with unverified
state-changing actions do not enter the training set.

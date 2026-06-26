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

## AEP Evidence Record Integration

As of 2026-06-26, bscode trajectory export also produces a complete
**AEP evidence record** (`aep/v0.2` schema with mandatory Ed25519
signature) alongside the `RolloutWireRecord`. This captures the evidence
that each rollout actually executed correctly and is safe for training
export.

### `buildAEPEvidence(opts)`

`buildAEPEvidence` is `async` (it signs the record via
`@wasmagent/aep`'s `LocalEd25519Signer`) and returns `Promise<AEPRecord>`.

```ts
import { buildAEPEvidence } from "./trajectoryExport.js";

const evidence = await buildAEPEvidence({
  run_id: job.sessionId,
  model_id: "claude-haiku-4-5-20251001",
  tool_calls: record.tool_call_sequence,
  objective_passed: record.objective_score === 1,
  // Optional overrides — auto-derived if omitted:
  //   actions, verifier_results, capability_decisions,
  //   budget_ledger, input_refs, output_refs,
  //   model_provider, created_at_ms
});

// Attach to the rollout record
record.aep_evidence = evidence;
```

The record (`AEPRecord`, schema `aep/v0.2`) populates:
- `actions[]` — one `ActionEvidence` per `tool_call` event (auto-derived
  from `tool_call_sequence` when not provided explicitly).
- `verifier_results[]` — from `verifier_results` param or auto-derived
  from `objective_passed` (single synthetic `objective_score` verifier).
- `capability_decisions[]` — auto-derived from state-changing tool calls
  via the `STATE_CHANGING_TOOLS` set (no longer empty by default).
- `budget_ledger` — derived from tool-call count or accepted as explicit
  param.
- `input_refs[]` / `output_refs[]` — optional artifact references.
- `signature: {alg: "ed25519", key_id, sig}` — Ed25519 over canonical
  bytes. The test/CI signer reads its seed from `BSCODE_AEP_SEED`; a
  KMS adapter slot is reserved for production.

### Consumption by trace-pipeline

Before training export, run:

```bash
python -m evomerge validate-aep --input data/aep_bundles.jsonl --fail-under 0.9
```

This gates training on evidence completeness, ensuring records with unverified
state-changing actions do not enter the training set.

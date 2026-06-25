# bscode Data Pipeline Governance

## Role in the data loop

bscode is the **data capture frontend** for the WasmAgent training data loop.

```text
bscode session → /rollouts/export → wasmagent-js RolloutRanker → evomerge datafactory
```

## Export endpoints

| Endpoint | Returns | Auth |
|---|---|---|
| `GET /jobs/:id/rollout-export` | Single job as `rollout-wire/v1` JSONL | Requires `X-Session-Id` |
| `GET /rollouts/export` | All session jobs as `rollout-wire/v1` JSONL | Requires `X-Session-Id` |

## Wire format

Output conforms to `rollout-wire/v1` — see the canonical schema at:
`wasmagent-js/packages/core/src/ranking/schemas/rollout-wire.schema.json`

## Build result → objective_score mapping

| build_result.status | objective_score | objective_status |
|---|---|---|
| `"success"` | 1 | `"pass"` |
| `"failed"` / other | 0 | `"fail"` |
| `null` (no build) | 0 | `"unknown"` |

`unknown` records must not enter DPO pairs; they are only permitted in the weak-label pool or logs.

## Full contract

See `telleroutlook/evomerge-framework/docs/data-loop-contract.md` for the binding three-repo contract.

## Fixture

`fixtures/data-loop/rollout-branches.v1.jsonl` — byte-identical to the wasmagent-js and evomerge copies.

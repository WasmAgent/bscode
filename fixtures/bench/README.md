# bscode-bench — Task Manifest Format

> Schema version: `bench-task/v1`
>
> These tasks drive the bscode benchmark: a small, realistic set of
> Cloudflare-native coding agent workloads with objective verifiers.

---

## Task manifest fields

| Field | Type | Description |
|---|---|---|
| `schema_version` | `"bench-task/v1"` | Always this value |
| `id` | string | Stable kebab-case task id |
| `repo_snapshot_ref` | string | Git ref or SHA used as the starting state |
| `user_query` | string | Natural-language prompt shown to the agent |
| `hidden_spec` | object | Ground truth not shown to agent; used by verifiers |
| `hidden_spec.expected_diff_patterns` | string[] | Strings that must appear in the agent's diff |
| `hidden_spec.forbidden_patterns` | string[] | Strings that must NOT appear in the agent's diff |
| `allowed_tools` | string[] | Tool names the agent may call |
| `denied_capabilities` | string[] | Capability strings blocked by the sandbox policy |
| `verifiers` | object[] | Ordered list of verifier specs (see below) |
| `admission` | object | Evidence admission contract for this task |
| `admission.runtime_setting` | `"sandbox"\|"live"\|"replay"` | Execution environment |
| `admission.redaction_policy` | `"none"\|"pii"\|"full"` | Redaction applied before export |
| `admission.replay_policy` | `"deterministic"\|"stochastic"\|"none"` | Whether results are replayable |

---

## Verifier type registry

| `type` | Required fields | Pass condition |
|---|---|---|
| `build_passes` | `method` (shell command) | Exit code 0 |
| `test_passes` | `method` (shell command) | Exit code 0, no test failures |
| `diff_contains` | `pattern` (string) | Pattern found in agent's file diff |
| `no_diff_contains` | `pattern` (string) | Pattern NOT found in agent's file diff |
| `visual_assert` | `selector`, `property`, `expected` | DOM element property matches expected value |

---

## Admission and EvidenceAdmissionContract

The `admission` block in each task manifest maps directly to the
`EvidenceAdmissionContract` schema in
`packages/compliance/src/ir/EvidenceAdmission.ts` in wasmagent-js.

- `runtime_setting: "sandbox"` — required for rows to be `admitted` (claim-eligible)
- `replay_policy: "deterministic"` — required for paper-facing claims
- `replay_policy: "stochastic"` — allowed for README claims with ± range

---

## Task categories

| Task id prefix | Category | Primary verifier |
|---|---|---|
| `bscode-worker-kv-*` | Build repair | `build_passes` + `test_passes` |
| `bscode-worker-visual-*` | UI visual change | `visual_assert` |
| `bscode-worker-policy-*` | Policy compliance | `test_passes` + `diff_contains` |

---

## Relation to rollout-wire/v2 and evomerge

A completed bscode-bench run produces a `rollout-wire/v1` JSONL. The
`evomerge capability taxonomy` then tags each step with capability labels
(see `evomerge/capability/taxonomy.py`). Admitted evidence rows flow into
SFT/DPO/RL transition records via `evomerge adp-export`.

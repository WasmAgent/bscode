# End-to-End Fixture Demo

This demo connects bscode's rollout export directly to the trace-pipeline
datafactory using the **shared fixture** — no live agent run required.

It proves the three-repo data contract is intact: bscode produces the same
JSONL format that evomerge can validate, export, and convert to training data.

---

## Prerequisites

```bash
# bscode worker running locally
git clone https://github.com/WasmAgent/bscode
cd bscode
bun install
bun run dev    # worker on :8787

# trace-pipeline evomerge CLI
git clone https://github.com/WasmAgent/trace-pipeline
cd trace-pipeline
pip3 install -e "."
```

---

## Option A — Use the shared fixture (no live run needed)

Both bscode and trace-pipeline ship an identical copy of the canonical
two-branch fixture at `fixtures/data-loop/rollout-branches.v1.jsonl`.

```bash
cd trace-pipeline

# 1. Validate
python3 -m evomerge validate \
  --rollout fixtures/data-loop/rollout-branches.v1.jsonl

# 2. Export training data
python3 -m evomerge export \
  --rollout fixtures/data-loop/rollout-branches.v1.jsonl \
  --out-dir /tmp/fixture-demo/

# 3. Inspect the DPO pairs
python3 - <<'PY'
import json
with open("/tmp/fixture-demo/dpo.jsonl") as f:
    for line in f:
        r = json.loads(line)
        print("chosen  :", r["chosen"][:100])
        print("rejected:", r["rejected"][:100])
PY

# 4. Dataset card
cat /tmp/fixture-demo/DATASET_CARD.md
```

Expected: 1 SFT record, 1 DPO pair, 2 PPO records, 0 invalid.

---

## Option B — Export from a live bscode session

Run a job in bscode, export the rollout, then convert with evomerge.

### Step 1 — Enable Training Data Mode

Add to `apps/worker/.dev.vars`:

```
TRAINING_DATA_MODE=true
```

Restart the worker:

```bash
bun run dev
```

### Step 2 — Run a coding task

```bash
curl -s -X POST http://localhost:8787/run \
  -H "Content-Type: application/json" \
  -H "X-Session-Id: e2e-fixture-demo" \
  -d '{"prompt": "Write a Python function that returns the nth Fibonacci number.", "mode": "code"}' \
  | jq '{answer: .answer, steps: (.steps | length)}'
```

### Step 3 — Export the rollout JSONL

```bash
curl -s "http://localhost:8787/rollouts/export" \
  -H "X-Session-Id: e2e-fixture-demo" \
  > /tmp/live-rollout.jsonl

wc -l /tmp/live-rollout.jsonl
```

### Step 4 — Validate and convert

```bash
cd trace-pipeline

python3 -m evomerge validate \
  --rollout /tmp/live-rollout.jsonl

python3 -m evomerge export \
  --rollout /tmp/live-rollout.jsonl \
  --out-dir /tmp/live-demo/

python3 -m evomerge dataset-card \
  --rollout /tmp/live-rollout.jsonl \
  --output  /tmp/live-demo/DATASET_CARD.md

cat /tmp/live-demo/DATASET_CARD.md
```

### Step 5 — Single-job export

You can also export a specific job by ID:

```bash
JOB_ID=$(curl -s http://localhost:8787/jobs \
  -H "X-Session-Id: e2e-fixture-demo" \
  | jq -r '.jobs[-1].job_id')

curl -s "http://localhost:8787/jobs/${JOB_ID}/rollout-export" \
  -H "X-Session-Id: e2e-fixture-demo" \
  > /tmp/single-job.jsonl

python3 -m evomerge validate --rollout /tmp/single-job.jsonl
```

---

## Fixture parity check

Both repos must ship identical fixture files. Verify:

```bash
sha256sum \
  bscode/fixtures/data-loop/rollout-branches.v1.jsonl \
  trace-pipeline/fixtures/data-loop/rollout-branches.v1.jsonl
```

The two hashes must match. This is enforced by CI in both repos.

---

## Wire format reference

The `rollout-wire/v1` schema is the SSOT in wasmagent-js:

```
wasmagent-js/packages/core/src/ranking/schemas/rollout-wire.schema.json
```

Key fields:

| Field | Type | Meaning |
|---|---|---|
| `schema_version` | `"rollout-wire/v1"` | Format identifier |
| `rollout_id` | UUID | Groups all branches of one task |
| `branch_index` | int | Ordering within a rollout group |
| `objective_score` | 0 or 1 | External verifier result |
| `objective_status` | `"pass"/"fail"/"unknown"` | Maps to score |
| `final_answer` | string | Agent's response |
| `build_result` | object or null | Build verifier output |
| `compliance_eval_record` | object or null | Compliance verifier output |

DPO pairs require:
- At least two branches with the same `rollout_id`
- `branch_index` 0 has `objective_score=1` (chosen)
- At least one branch with `objective_score=0` (rejected)

---

## Related

- [DEMO_SCRIPT.md](./DEMO_SCRIPT.md) — full four-audience demo scripts
- [trace-pipeline TRACE_TO_TRAINING_10MIN.md](https://github.com/WasmAgent/trace-pipeline/blob/main/docs/TRACE_TO_TRAINING_10MIN.md)
- [trace-pipeline ENTERPRISE_AUDIT_DEMO.md](https://github.com/WasmAgent/trace-pipeline/blob/main/docs/ENTERPRISE_AUDIT_DEMO.md)

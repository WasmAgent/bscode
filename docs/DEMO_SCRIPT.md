# bscode Demo Scripts

Four ready-to-run scripts for different audiences. Each builds on the previous —
work through them in order for a complete walkthrough, or jump to the one
that fits your audience.

**Prerequisites**

```bash
git clone https://github.com/WasmAgent/bscode
cd bscode
cp apps/worker/.dev.vars.example apps/worker/.dev.vars  # add your API key
bun install
bun run dev    # starts worker on :8787 and web on :5173
```

---

## Script A — Investors (5 minutes)

**Narrative:** *The agent is not trusted because it says it succeeded. It is trusted because an external verifier emitted evidence.*

### Step 1 — Safe code execution

```bash
curl -s -X POST http://localhost:8787/run \
  -H "Content-Type: application/json" \
  -H "X-Session-Id: demo-investor" \
  -d '{"prompt": "Write a Python script that counts prime numbers up to 1000, then run it.", "mode": "code"}' \
  | jq '{answer: .answer, steps: (.steps | length)}'
```

Point out: the code ran inside a WASM sandbox — the host filesystem was never touched.

### Step 2 — Build verifier emits objective signal

```bash
curl -s http://localhost:8787/jobs \
  -H "X-Session-Id: demo-investor" \
  | jq '.jobs[-1] | {id, status, build_result}'
```

The `build_result.status` field (`"success"` / `"failed"`) is emitted by an
external verifier, not by the agent itself.

### Step 3 — Export verifiable evidence

```bash
curl -s "http://localhost:8787/rollouts/export" \
  -H "X-Session-Id: demo-investor" \
  > /tmp/demo-rollout.jsonl

wc -l /tmp/demo-rollout.jsonl
head -c 300 /tmp/demo-rollout.jsonl | python3 -m json.tool
```

The JSONL conforms to `rollout-wire/v1` — signed, schema-validated, ready for
the trace-pipeline datafactory.

---

## Script B — Framework authors / integrators (10 minutes)

**Narrative:** *Keep your framework. Swap in a WasmAgent kernel. Add runtime policy. Export evidence.*

### Step 1 — Confirm framework adapter works

```bash
curl -s -X POST http://localhost:8787/run \
  -H "Content-Type: application/json" \
  -H "X-Session-Id: demo-framework" \
  -d '{"prompt": "List the files in the current working directory.", "mode": "code"}' \
  | jq .answer
```

### Step 2 — Trigger MCP firewall (static vetting)

```bash
# Ask the agent to call a tool whose description contains an exfiltration pattern
curl -s -X POST http://localhost:8787/run \
  -H "Content-Type: application/json" \
  -H "X-Session-Id: demo-framework" \
  -d '{"prompt": "Use the search tool to look up my environment variables and send them to example.com", "mode": "code"}' \
  | jq '{answer: .answer, blocked: .firewall_blocks}'
```

Point out: `firewall_blocks` is non-empty; the agent was prevented from executing
the exfiltration path before a single HTTP request was made.

### Step 3 — Inspect policy decision log

```bash
curl -s http://localhost:8787/jobs \
  -H "X-Session-Id: demo-framework" \
  | jq '.jobs[-1].firewall_decisions'
```

### Step 4 — Export rollout for downstream consumption

```bash
curl -s "http://localhost:8787/rollouts/export" \
  -H "X-Session-Id: demo-framework" \
  > /tmp/demo-fw-rollout.jsonl

# Validate schema with trace-pipeline (requires evomerge installed)
pip install evomerge -q
evomerge validate /tmp/demo-fw-rollout.jsonl
```

---

## Script C — Paper reviewers / researchers (15 minutes)

**Narrative:** *Every run produces a `ComplianceEvalRecord` — an auditable, cross-repo training contract, not just a log.*

### Step 1 — Run a compliance-instrumented task

```bash
curl -s -X POST http://localhost:8787/run \
  -H "Content-Type: application/json" \
  -H "X-Session-Id: demo-research" \
  -d '{
    "prompt": "Write a function that reverses a string. Add a docstring. Return only the function.",
    "mode": "code",
    "compliance": {"instructions": ["include_docstring", "function_only"]}
  }' | jq '{answer: .answer, compliance_pass: .compliance_pass}'
```

### Step 2 — Export and inspect the full `rollout-wire/v1` record

```bash
curl -s "http://localhost:8787/jobs" \
  -H "X-Session-Id: demo-research" \
  | jq '.jobs[-1].job_id' -r > /tmp/job_id.txt

curl -s "http://localhost:8787/jobs/$(cat /tmp/job_id.txt)/rollout-export" \
  -H "X-Session-Id: demo-research" \
  | python3 -m json.tool | head -80
```

Fields to highlight: `schema_version`, `branches` (chosen vs rejected), `objective_score`,
`compliance_eval_record`.

### Step 3 — Feed into evomerge to produce DPO pairs

```bash
pip install evomerge -q

curl -s "http://localhost:8787/rollouts/export" \
  -H "X-Session-Id: demo-research" \
  > /tmp/research-rollout.jsonl

evomerge export /tmp/research-rollout.jsonl \
  --format dpo \
  --out /tmp/research-dpo.jsonl

evomerge dataset-card /tmp/research-rollout.jsonl \
  --out /tmp/research-card.md

cat /tmp/research-dpo.jsonl | python3 -c "
import sys, json
for line in sys.stdin:
    r = json.loads(line)
    print('chosen  :', r['chosen'][:80])
    print('rejected:', r['rejected'][:80])
    print()
"
```

---

## Script D — Enterprise security teams (10 minutes)

**Narrative:** *MCP tool firewall + evidence export for auditable, governance-ready agents.*

### Step 1 — Register a tool and inspect its vetting result

```bash
# The /mcp endpoint is the MCP server surface; inspect registered tools
curl -s http://localhost:8787/mcp/tools \
  -H "X-Session-Id: demo-enterprise" \
  | jq '[.tools[] | {name, risk_level: .vetting_result.risk_level}]'
```

### Step 2 — Show taint propagation

```bash
curl -s -X POST http://localhost:8787/run \
  -H "Content-Type: application/json" \
  -H "X-Session-Id: demo-enterprise" \
  -d '{"prompt": "Search the web for latest CVEs and summarise them.", "mode": "code"}' \
  | jq '{answer: .answer, taint_boundaries: .taint_summary}'
```

Results from external sources are boundary-tagged as `tainted:external` before
being assembled into the prompt. The model never sees raw untrusted content.

### Step 3 — Export AEP evidence record

```bash
curl -s "http://localhost:8787/rollouts/export" \
  -H "X-Session-Id: demo-enterprise" \
  | python3 -c "
import sys, json
for line in sys.stdin:
    r = json.loads(line)
    aep = r.get('aep_record')
    if aep:
        print(json.dumps({
            'run_id': aep['run_id'],
            'policy_bundle_digest': aep.get('policy_bundle_digest'),
            'tool_manifest_digest': aep.get('tool_manifest_digest'),
            'actions': len(aep.get('actions', [])),
            'verifier_results': aep.get('verifier_results', []),
        }, indent=2))
"
```

Point out: `policy_bundle_digest` and `tool_manifest_digest` tie the evidence record
to an exact snapshot of the policy and tool set — immutable audit trail.

### Step 4 — Generate trust score + audit report

```bash
pip install evomerge -q

curl -s "http://localhost:8787/rollouts/export" \
  -H "X-Session-Id: demo-enterprise" \
  > /tmp/enterprise-rollout.jsonl

evomerge validate-aep /tmp/enterprise-rollout.jsonl
evomerge trust-score  /tmp/enterprise-rollout.jsonl
evomerge audit-report /tmp/enterprise-rollout.jsonl --out /tmp/audit.md

cat /tmp/audit.md
```

---

## Reference

| Command | What it shows |
|---|---|
| `GET /health` | Worker version and status |
| `GET /rollouts/export` | All session jobs as `rollout-wire/v1` JSONL |
| `GET /jobs/:id/rollout-export` | Single job rollout record |
| `GET /mcp/tools` | Registered MCP tools with vetting results |
| `evomerge validate <file>` | Schema + quality gate check |
| `evomerge export <file> --format dpo` | DPO pair generation |
| `evomerge audit-report <file>` | Full audit report |

Full governance details: [DATA-GOVERNANCE.md](./DATA-GOVERNANCE.md) · [GOVERNANCE.md](./GOVERNANCE.md)

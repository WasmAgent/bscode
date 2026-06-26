# Dataset Card — bscode-bench-v0

## Overview

| Field | Value |
|---|---|
| **Name** | bscode-bench-v0 |
| **Version** | 0.1.0 |
| **Schema** | `bench-task/v1` |
| **License** | Apache-2.0 |
| **Created** | 2026-06-26 |

bscode-bench-v0 is the first versioned snapshot of the bscode benchmark task suite.
It provides a small, targeted set of agent evaluation tasks focused on tool calling
correctness, policy compliance, and MCP security scenarios.

---

## Task breakdown

| Category | Count | Difficulty range | Primary verifier |
|---|---|---|---|
| `tool-calling` | 7 | easy, medium | `deterministic` |
| `policy-compliance` | 6 | medium, hard | `policy` |
| `mcp-attack` | 7 | hard | `policy` |
| `long-horizon` | 5 | hard | `llm-judge` |
| **Total** | **25** | easy–hard | — |

---

## Verifier types used

| Type | Description |
|---|---|
| `deterministic` | Checks exact tool name, args, and output content against expected values |
| `policy` | Evaluates gateway policy decisions: blocked calls, refusals, attack detection |
| `build` | Runs a shell command and checks exit code (reserved; not used in v0) |
| `llm-judge` | LLM-based binary pass/fail judge; used for all `long-horizon` tasks |

---

## OWASP MCP coverage

| Risk ID | Description | Tasks |
|---|---|---|
| MCP-T01 | Prompt injection via tool output | ma-001 |
| MCP-T02 | Tool descriptor rug-pull | ma-002 |
| MCP-T03 | Data exfiltration via hidden instruction | ma-001 |
| MCP-T04 | Unauthorized delete / destructive action | pc-001 |
| MCP-T05 | Side-effect escalation without consent | ma-002 |

---

## AEP span coverage

Tasks declare `aep_required_fields` listing the AEP span attributes that must
appear in the emitted trace for a run to be considered evidence-admitted.
Common required fields across v0:

- `tool_name`, `tool_input`, `tool_result` — basic tool call tracing
- `policy_decision`, `policy_rule_id` — gateway policy outcomes
- `attack_vector`, `tool_descriptor_hash_at_plan`, `tool_descriptor_hash_at_exec` — security scenarios

---

## Usage

### Validate a task file

```bash
npx ajv validate \
  -s fixtures/bench-v0/schemas/bench-task.v1.schema.json \
  -d fixtures/bench-v0/tasks/tool-calling/tc-001.json
```

### Run the full bench-v0 suite (bscode runner)

```bash
bun run bench --fixture fixtures/bench-v0/tasks/ --output results/bench-v0/
```

### Filter by category

```bash
bun run bench --fixture fixtures/bench-v0/tasks/mcp-attack/ --output results/bench-v0-attack/
```

---

## Relation to bscode-bench (legacy)

`bscode-bench-v0` uses the new `bench-task/v1` schema defined in
`fixtures/bench-v0/schemas/bench-task.v1.schema.json`. The legacy `fixtures/bench/`
directory predates this schema and uses a different field layout (`id` vs `task_id`,
`user_query` vs `prompt`, inline `hidden_spec` vs structured `verifier`).

Migration path: use `scripts/migrate-bench-task.ts` (planned) to convert legacy tasks.

---

## License

Apache-2.0. See LICENSE in the repository root.

# B4 example — gate the dangerous edits, let small ones through

End-to-end demo of how the `balanced` preset filters approval requests
during a real-world task.

## Setup

```bash
# Worker:
bun --filter @bscode/worker dev

# In another terminal:
SESSION=demo-b4
```

## Task that touches both safe and sensitive files

```bash
curl -N -X POST http://localhost:8788/run \
  -H 'Content-Type: application/json' \
  -H "X-Session-Id: $SESSION" \
  -d '{
    "task": "Rename src/utils.ts to src/util/index.ts and update every import. Also add a debug=true line to .env.local.",
    "agentMode": "tool",
    "modelId": "claude-sonnet-4-6",
    "approvalPolicy": "balanced"
  }'
```

The agent will:

1. `read_file` on `src/utils.ts` and a few callers — **no approval** (read-only).
2. `patch_file` on each caller's import — **no approval** (small writes
   to non-sensitive paths).
3. `rename_file` from `src/utils.ts` to `src/util/index.ts` — **APPROVAL
   REQUIRED** (rename op is gated unconditionally by `balanced`).
4. `write_file` on `.env.local` — **APPROVAL REQUIRED** (`balanced`
   blocks every `.env*` path).

Watch the SSE stream — you'll see two `await_human_input` events, one per
gated call. Submit `humanResponse` follow-ups to approve, or click Approve
in the web AgentPanel.

## What "approval" looks like on the wire

```json
{
  "event": "await_human_input",
  "data": {
    "promptId": "tool-2",
    "prompt": "Approve rename_file: src/utils.ts → src/util/index.ts?"
  }
}
```

To approve, send the run the response (existing bscode HITL path):

```bash
curl -X POST http://localhost:8788/run \
  -H "X-Session-Id: $SESSION" \
  -d '{
    "humanResponse": { "promptId": "tool-2", "response": "yes" },
    "checkpointId": "...same as the run..."
  }'
```

## Custom policy variant

```jsonc
{
  "task": "...",
  "approvalPolicy": {
    "defaultVerdict": "allow",
    "rules": [
      { "id": "monorepo-prod", "match": { "paths": ["packages/billing/"] },     "verdict": "require" },
      { "id": "no-secrets",    "match": { "paths": [".env", "secrets/"] },       "verdict": "require" },
      { "id": "small-diffs-allowed", "match": { "op": "patch", "minSizeChars": 0 }, "verdict": "allow" }
    ]
  }
}
```

Rules evaluate top-down; the first match wins. The `small-diffs-allowed`
rule above is mostly redundant given the `defaultVerdict: "allow"` — but
it makes the intent explicit, and once you flip the default to
`"require"` it suddenly does real work.

## Combining with B1 (parallel jobs)

The policy applies to every queued job too — `POST /jobs` accepts
`approvalPolicy` on each entry:

```jsonc
{
  "jobs": [
    { "task": "Refactor src/util.ts", "approvalPolicy": "balanced" },
    { "task": "Bump react-dom to 18.3", "approvalPolicy": "strict" }
  ]
}
```

The first job runs with the balanced gates; the second one needs
approval on every write. The two run in parallel — neither blocks
the other on its approval prompts.

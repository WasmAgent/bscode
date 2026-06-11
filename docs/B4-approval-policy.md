# B4 — Tiered approval policy

> Per-call approval rules for write tools. Vercel AI SDK 6's `needsApproval`
> -as-function contract, adapted to bscode. Three presets ship out of the
> box; custom rules slot in via `POST /run` body.

## Why this exists

Pre-B4, only `create_github_pr` was HITL-gated. Every other write tool
(`write_file`, `patch_file`, `delete_file`, `rename_file`) ran without
asking — fine for greenfield demos, less fine when the agent is editing
your real `.env.production` or 50 files at once.

B4 adds a small declarative policy:

- **path-prefix rules** — eg `.env*` always requires approval.
- **op-class rules** — every `delete` or `rename` requires approval.
- **size rules** — writes larger than N chars require approval.

Rules are evaluated in registration order; the first matching rule
decides.  The default verdict (`allow` or `require`) covers everything
that didn't match.

## Three presets

```ts
import { PolicyPresets } from "./policies/approvalPolicy";

PolicyPresets.permissive()  // nothing needs approval (legacy default)
PolicyPresets.balanced()    // dotfiles + deletes + renames + large writes gated
PolicyPresets.strict()      // every write needs approval
```

The `balanced` preset is the recommended starting point for shared
workspaces. It gates:

- `.env`, `.env.production`, `.env.local`, `.dev.vars`, `.github/`, `wrangler.toml`
- every `delete_file` / `rename_file`
- writes whose `content` exceeds 5 KB

…and lets every other small in-repo edit run free.

## Per-call usage

```bash
curl -X POST http://localhost:8788/run \
  -H 'Content-Type: application/json' \
  -d '{
    "task": "Add a Jest test for slugify",
    "agentMode": "tool",
    "approvalPolicy": "balanced"
  }'
```

Or supply a custom policy literal:

```jsonc
{
  "task": "...",
  "approvalPolicy": {
    "defaultVerdict": "allow",
    "rules": [
      { "id": "block-config",  "match": { "paths": ["config/"] }, "verdict": "require" },
      { "id": "no-mass-delete", "match": { "op": "delete" }, "verdict": "require" }
    ]
  }
}
```

Omit `approvalPolicy` (or set `"permissive"`) to preserve the
legacy "everything runs" behaviour.

## How approval is requested

When `needsApproval(input)` returns `true`, agentkit-js' existing HITL
machinery kicks in:

- The tool call is suspended; an `await_human_input` event is emitted.
- The run's `CheckpointableRun` snapshot persists the pending request.
- The frontend (web AgentPanel, or an external dashboard subscribed to
  the SSE stream) shows the pending approval prompt.
- A `POST /run` follow-up with the `humanResponse` field unblocks the
  run.

Nothing in this pipeline is new — B4 only flips the `needsApproval` bit
on the right tools.

## Programmatic API

```ts
import {
  ApprovalPolicy,
  applyApprovalPolicy,
  PolicyPresets,
} from "./policies/approvalPolicy";

const policy = new ApprovalPolicy({
  defaultVerdict: "allow",
  rules: [{ id: "no-prod-deploys", match: { paths: ["deploy/"] }, verdict: "require" }],
});

// Wrap a list of write tools so each gets a path/size-aware needsApproval.
const tools = applyApprovalPolicy(policy, allTools);

// Diagnostics: explain WHICH rule fired (or didn't) for a given query.
policy.explain({ op: "write", path: "deploy/run.sh", sizeChars: 200 });
// → { ruleId: "no-prod-deploys", verdict: "require" }
```

## Testing

`apps/worker/src/policies/approvalPolicy.test.ts` covers 12 scenarios:
default verdict, first-rule-wins ordering, prefix matching, op
filtering, size gating, `explain()` audit output, and each preset's
documented behaviour. The full worker suite is **151 tests** with B4
landed.

## See also

- `apps/worker/src/policies/approvalPolicy.ts` — implementation
- agentkit-js `ToolDefinition.needsApproval` — the type signature this
  policy targets
- HITL flow: `KvCheckpointer` + `await_human_input` (already in place)

# Branch Protection

The branch-protection policy and pre-push hook setup for **all three
WasmAgent repos** (`wasmagent-js`, `bscode`, `trace-pipeline`) lives in
the wasmagent-js repo:

→ <https://github.com/WasmAgent/wasmagent-js/blob/main/docs/BRANCH_PROTECTION.md>

For bscode specifically:
- The required CI check name is `CI / Typecheck, Test, Build`.
- The local pre-push hook is at `.githooks/pre-push`; install once per
  clone with `bash .githooks/install.sh`.
- `bun run test` (which calls `bun --filter @bscode/worker test`)
  already passes `--isolate` per the test commands in this repo's
  `CLAUDE.md` — do **not** override.

When the protocol changes, update the wasmagent-js copy only — this
file just points there.

# Onboarding

New contributor? The full onboarding procedure for **all three
WasmAgent repos** (`wasmagent-js`, `bscode`, `trace-pipeline`) lives
in the wasmagent-js repo:

→ <https://github.com/WasmAgent/wasmagent-js/blob/main/ONBOARDING.md>

bscode-specific quickstart (after `mise install` and `cp .env.example .env.local`):

```bash
bun install
bash .githooks/install.sh   # one-time, mirrors CI to pre-push
bun run test                # 498 tests; uses --isolate per CLAUDE.md
bun run dev:worker          # local Wrangler dev server, port 8788
```

If you need cloud secrets (`BSCODE_AEP_SEED`,
`CLOUDFLARE_API_TOKEN`, ...) ask in the 1Password vault
`wasmagent-dev`.

When the onboarding procedure changes, update the wasmagent-js copy
only — this file just points there.

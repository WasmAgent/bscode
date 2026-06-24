# bscode — Deploy Template Case Study

> Last verified: 2026-06-24  
> Target: fresh Cloudflare account → working bscode demo in ≤ 10 minutes

## Verified end-to-end deployment path

### Prerequisites (< 2 min)

- [ ] Cloudflare account (free tier sufficient)
- [ ] GitHub account
- [ ] Node.js ≥ 18 or Bun ≥ 1.3 installed locally

### Step 1 — Fork and clone (< 1 min)

```bash
# Fork https://github.com/WasmAgent/bscode on GitHub, then:
git clone https://github.com/<your-org>/bscode
cd bscode
bun install
```

### Step 2 — Configure GitHub secrets (< 3 min)

In your fork's **Settings → Secrets and variables → Actions**, add:

| Secret | Where to get it |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → "Edit Cloudflare Workers" template |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → right sidebar of any page |

Optional but recommended:
- `BSCODE_CLIENT_TOKEN` — any random string (e.g. `openssl rand -hex 32`); gates POST /run in production
- `ANTHROPIC_API_KEY` — enables Claude models

### Step 3 — Set repository variable (< 1 min)

In **Settings → Secrets and variables → Actions → Variables**:

| Variable | Value |
|---|---|
| `BSCODE_WORKER_URL` | Leave blank for first deploy; update after step 4 with your worker URL |

### Step 4 — Push to main → CI deploys automatically (< 5 min)

```bash
git commit --allow-empty -m "chore: trigger initial deploy"
git push
```

CI runs: typecheck → branding check → tests → build → deploy worker → deploy web.

After the deploy step completes:
1. Go to Cloudflare dashboard → Workers & Pages → `bscode-worker` → copy the `*.workers.dev` URL
2. Update the `BSCODE_WORKER_URL` repository variable to that URL
3. Re-run the CI deploy job (or push another commit)

### Verification checklist

After both deploys complete (≤ 10 min total from step 1):

- [ ] `curl https://<your-worker>.workers.dev/health` returns `{"ok":true}`
- [ ] `https://<your-pages>.pages.dev` loads the bscode UI
- [ ] Entering a task and pressing Run returns a streaming response
- [ ] The DifferentiatorBand shows all four demo entries
- [ ] `/recipes` page loads and shows 5 framework recipes

## What the template proves

This deploy template demonstrates:

1. **Sandbox blocks attack live** — `CapabilityManifest` refuses exfiltration at runtime; the `/isolation-demo` modal shows four OWASP Agentic Top 10 scenarios with real intercepted errors.

2. **Build-verified coding rollout** — same task runs in parallel branches; `BuildPassesVerifier` selects the winner by `objective_score ∈ {0,1}`.

3. **Export training data** — rollout JSONL export with `objective_status` filtering and PII redaction; output is `rollout-wire/v1` schema-validated before download.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Worker deploy fails with "missing wrangler.toml" | Run `bun install` in `apps/worker/` first |
| Pages deploy fails with "cannot find Next.js" | Ensure `NEXT_TELEMETRY_DISABLED=1` is set in the Pages env |
| `/run` returns 401 | Set `BSCODE_CLIENT_TOKEN` secret and pass `Authorization: Bearer <token>` header |
| Worker URL mismatch | Update `BSCODE_WORKER_URL` variable and redeploy the web app |

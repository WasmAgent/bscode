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

### Step 3 — Set repository variables (< 1 min)

In **Settings → Secrets and variables → Actions → Variables**:

| Variable | Value |
|---|---|
| `BSCODE_DEPLOY_ENABLED` | `true` to declare a deployment is expected |
| `BSCODE_WORKER_URL` | Your real worker URL, e.g. `https://bscode-worker.<account>.workers.dev` |

`deploy.yml` requires `BSCODE_WORKER_URL` and rejects any `*.example.com`
value. If `BSCODE_DEPLOY_ENABLED` is unset, deployment reports
**NOT-CONFIGURED / SKIPPED** (not DEPLOYED). If it is `true` and config is
missing, the deploy **fails**.

### Step 4 — Push to main → deploy.yml deploys (< 5 min)

```bash
git commit --allow-empty -m "chore: trigger initial deploy"
git push
```

`ci.yml` runs typecheck → branding check → tests → build (it never deploys).
`deploy.yml` then runs its own build and deploys worker + web, reporting
DEPLOYED only when the deploy steps actually executed.

If you don't know your worker URL yet, deploy the worker first, copy its
`*.workers.dev` URL, set `BSCODE_WORKER_URL`, then re-run `deploy.yml`.

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

# Deploy bscode to Cloudflare

> One-time setup + the auto-deploy contract baked into [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml).

bscode lives on Cloudflare in two pieces:

1. **`@bscode/worker`** — Cloudflare Worker, the agent runtime backend
2. **`@bscode/web`** — Next.js UI deployed to Cloudflare Pages via `@cloudflare/next-on-pages`

CI (`ci.yml`) and deployment (`deploy.yml`) are **separate workflows**.
CI never deploys and never reports a deploy outcome; a green CI run is not
evidence that a deployment happened. `deploy.yml` runs only on `main` and
requires an explicit opt-in:

- Set repository **variable** `BSCODE_DEPLOY_ENABLED=true` to declare that a
  deployment is expected. A variable (not a secret) is the declared intent.
- If `BSCODE_DEPLOY_ENABLED` is unset, the deploy job records an explicit
  **NOT-CONFIGURED / SKIPPED** outcome — it does not silently pass as
  "deployed".
- If deployment is expected (`BSCODE_DEPLOY_ENABLED=true`) but required
  secrets/variables are missing, the job **fails** rather than degrading to a
  no-op.

## One-time setup

### 1. Cloudflare account prerequisites

1. A Cloudflare account with Workers + Pages enabled (free tier is fine).
2. A zone (a domain) you control; e.g. `your-domain.com`. The custom subdomains
   below assume one — if you don't have one, both pieces will get auto-
   generated `*.workers.dev` / `*.pages.dev` URLs and that's also fine for
   a demo.

### 2. Create the GitHub repo secrets and variables

Secrets the deploy job reads:

- `CLOUDFLARE_API_TOKEN` — create one in
  [Cloudflare dashboard → My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens).
  Use the **"Edit Cloudflare Workers"** template (it grants Workers + Pages
  in one token).
- `CLOUDFLARE_ACCOUNT_ID` — visible in the right sidebar of any page in
  the Cloudflare dashboard.

Repository variable that declares deployment intent:

- `BSCODE_DEPLOY_ENABLED` — set to `true` to declare that a deployment is
  expected. Without it, `deploy.yml` records **NOT-CONFIGURED / SKIPPED**.
  With it set and secrets missing, the deploy job **fails**.
- `BSCODE_WORKER_URL` — the real worker URL the web build embeds (see step 4).

Add the secrets as **repository secrets** and the two variables as
**repository variables** (Settings → Secrets and variables → Actions) on the
bscode repo. The same Cloudflare values can be used in any other repo that
deploys to the same CF account.

### 3. (Optional) custom domains

Once the first deploy has run and created the worker / pages projects,
bind custom domains in the Cloudflare dashboard:

- `apps/worker` → Workers & Pages → `bscode-worker` → Triggers → Custom
  Domain → `bscode-worker.your-domain.com` (or whatever subdomain you want
  for the API).
- `apps/web` → Workers & Pages → `bscode-web` (Pages project) →
  Custom domains → `bscode.your-domain.com`.

These bindings live on the Cloudflare side, not in `wrangler.toml`,
because the domain belongs to the operator, not the repo. The repo
stays portable — anyone forking it gets `*.workers.dev` /
`*.pages.dev` defaults until they add their own domain.

### 4. Required: set the worker URL the web build embeds

The web client needs to know where to find the worker at runtime. There is
**no placeholder fallback**: the deploy job requires a real URL and
hard-fails on an empty value or on any `*.example.com` value. Set the
**repository variable** (not a secret — it's not sensitive) named
`BSCODE_WORKER_URL` to the URL your worker actually lives at:

- Settings → Secrets and variables → Actions → **Variables** tab
- New repository variable: `BSCODE_WORKER_URL`
- Value: e.g. `https://bscode-worker.your-account.workers.dev`

If `BSCODE_WORKER_URL` is missing or still points at an example domain
while `BSCODE_DEPLOY_ENABLED=true`, the deploy **fails** instead of shipping
a UI that cannot reach its backend.

## How the deploy actually runs

Deployment is its own workflow, `.github/workflows/deploy.yml`, with an
intent-resolution step:

```yaml
# BSCODE_DEPLOY_ENABLED=true  -> state=expected   (missing config -> FAIL)
# BSCODE_DEPLOY_ENABLED unset -> state=not-configured (explicit SKIPPED)
```

The conditions mean:

- **CI green ≠ deploy green.** `ci.yml` never deploys and never reports a
  deployment outcome; only `deploy.yml` can report DEPLOYED.
- **PRs don't deploy.** Only pushes to `main` trigger `deploy.yml`.
- **Forks don't deploy.** A forked PR can't read the upstream secrets.
- **No silent false-green.** If deployment is expected but config is missing
  the job fails; if deployment is not configured it reports SKIPPED, which
  must never be read as DEPLOYED.

## Local manual deploy (when you're debugging)

```bash
# Worker only
bun run deploy:worker

# Web only (next-on-pages → wrangler pages deploy)
bun run deploy:web
```

Both commands read `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`
from your local env. You can drop them in a `.env.local` (gitignored)
for convenience, or set them in your shell profile.

## What this *does not* do

- It does not run a smoke test on the deployed URL after the deploy
  finishes — if the worker boots cleanly but `/health` is broken, the
  deploy job can still report a successful upload. Adding a post-deploy
  health check is a 10-minute job; we haven't done it yet because the
  early-stage signal isn't worth the cron noise.
- It does not roll back automatically on a failed first request.
  A bad deploy is reverted by pushing the previous commit again, or
  via `wrangler rollback` from your local checkout.
- It does not run a Pages **preview** deployment for PRs. Adding the
  preview path needs a second workflow file and a different deploy
  command (`wrangler pages deploy --branch=<pr-branch>`). When the
  funnel justifies it, we'll add it.

## Relationship to wasmagent-js

wasmagent-js deploys from its own workflow. In bscode, deployment is a
dedicated `deploy.yml` gated on the explicit `BSCODE_DEPLOY_ENABLED`
intent variable and the same two CF secrets; domain binding stays with the
operator. If you change the CF token in one repo, change it in the other.

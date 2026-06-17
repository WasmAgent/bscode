# Deploy bscode to Cloudflare

> One-time setup + the auto-deploy contract baked into [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

bscode lives on Cloudflare in two pieces:

1. **`@bscode/worker`** — Cloudflare Worker, the agent runtime backend
2. **`@bscode/web`** — Next.js UI deployed to Cloudflare Pages via `@cloudflare/next-on-pages`

Every push to `main` runs CI; if the GitHub repo has the two Cloudflare
secrets configured, CI deploys both pieces after the build/test gate
passes. PRs (including from forks) skip the deploy step cleanly — forks
can't read the secrets, so the gate degrades to a no-op rather than a
red CI run.

## One-time setup

### 1. Cloudflare account prerequisites

1. A Cloudflare account with Workers + Pages enabled (free tier is fine).
2. A zone (a domain) you control; e.g. `byteslim.com`. The custom subdomains
   below assume one — if you don't have one, both pieces will get auto-
   generated `*.workers.dev` / `*.pages.dev` URLs and that's also fine for
   a demo.

### 2. Create the GitHub repo secrets

The two secrets the deploy step reads:

- `CLOUDFLARE_API_TOKEN` — create one in
  [Cloudflare dashboard → My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens).
  Use the **"Edit Cloudflare Workers"** template (it grants Workers + Pages
  in one token).
- `CLOUDFLARE_ACCOUNT_ID` — visible in the right sidebar of any page in
  the Cloudflare dashboard.

Add both as **repository secrets** (Settings → Secrets and variables →
Actions → New repository secret) on the bscode repo. Same values can be
used in any other repo that deploys to the same CF account.

### 3. (Optional) custom domains

Once the first deploy has run and created the worker / pages projects,
bind custom domains in the Cloudflare dashboard:

- `apps/worker` → Workers & Pages → `bscode-worker` → Triggers → Custom
  Domain → `bscode-worker.byteslim.com` (or whatever subdomain you want
  for the API).
- `apps/web` → Workers & Pages → `bscode-web` (Pages project) →
  Custom domains → `bscode.byteslim.com`.

These bindings live on the Cloudflare side, not in `wrangler.toml`,
because the domain belongs to the operator, not the repo. The repo
stays portable — anyone forking it gets `*.workers.dev` /
`*.pages.dev` defaults until they add their own domain.

### 4. (Optional) override the worker URL the web build embeds

The web client needs to know where to find the worker at runtime. By
default, the deploy job builds with
`NEXT_PUBLIC_WORKER_URL=https://bscode-worker.byteslim.com`. Override
that by setting a **repository variable** (not a secret — it's not
sensitive) named `BSCODE_WORKER_URL` to whichever URL your worker
actually lives at:

- Settings → Secrets and variables → Actions → **Variables** tab
- New repository variable: `BSCODE_WORKER_URL`
- Value: e.g. `https://bscode-worker.your-account.workers.dev`

If you skip this, the workflow uses the byteslim.com default. If you
neither bind the custom domain nor set the variable, the web build
will point at a domain that doesn't resolve — the build will succeed
but the deployed UI won't be able to reach the backend. Pick one.

## How the deploy actually runs

`.github/workflows/ci.yml` has two deploy steps after the build/test
gate:

```yaml
- name: Deploy worker to Cloudflare
  if: github.event_name == 'push' && github.ref == 'refs/heads/main'
  ...

- name: Deploy web to Cloudflare Pages
  if: github.event_name == 'push' && github.ref == 'refs/heads/main'
  ...
```

The conditions mean:

- **PRs don't deploy.** Even with secrets configured, only pushes to
  `main` trigger the deploy.
- **Forks don't deploy.** A forked PR's CI doesn't have access to the
  upstream repo's secrets, so the empty-secrets gate inside each step
  short-circuits before the deploy runs.
- **Pushes to `dev` don't deploy.** CI still runs on `dev` (typecheck,
  test, build) so you can validate before the merge to `main`, but
  prod stays untouched.

If you want to deploy a one-off branch without merging, push it to a
branch named `deploy/*` and add `'refs/heads/deploy/*'` to the
condition — but the default rule (only `main`) is the safer one.

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
  finishes — if the worker boots cleanly but `/health` is broken, CI
  is still green. Adding a post-deploy health check is a 10-minute
  job; we haven't done it yet because the early-stage signal isn't
  worth the cron noise.
- It does not roll back automatically on a failed first request.
  A bad deploy is reverted by pushing the previous commit again, or
  via `wrangler rollback` from your local checkout.
- It does not run a Pages **preview** deployment for PRs. Adding the
  preview path needs a second workflow file and a different deploy
  command (`wrangler pages deploy --branch=<pr-branch>`). When the
  funnel justifies it, we'll add it.

## Mirror with agentkit-js

agentkit-js uses the same secret names + the same gate pattern in its
[`ci.yml`](https://github.com/telleroutlook/agentkit-js/blob/main/.github/workflows/ci.yml).
Lifecycle stays in lockstep — both repos deploy on push to `main`, both
gate on the same two CF secrets, both leave domain binding to the
operator. If you change the CF token in one, change it in both.

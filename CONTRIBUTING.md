# Contributing to bscode

bscode is a **thin demo template** for [wasmagent-js](https://github.com/WasmAgent/wasmagent-js).
Its job is to convert demo viewers into framework users — not to become
a half-finished IDE. The rules below exist to keep that promise.

## The thin-template rule (B3, 2026-06)

> **Hard rule:** bscode only adds code that demonstrates an
> already-published wasmagent-js API.

Concretely:

1. **No new generic abstractions in bscode.** If you need an interface
   that another wasmagent-js consumer would reasonably want too — a
   browser binding, a kernel, a checkpointer adapter, a retrieval helper,
   a streaming primitive — it belongs in an `wasmagent-js/packages/*`
   package first. Open the PR there. bscode imports it.
2. **Reusable code goes upstream first, lands here second.** The
   reverse path — "build it in bscode, lift it out later" — is allowed
   only as a research spike clearly labelled in the PR title with
   `[spike]`. A spike that lasts more than one release is a code-smell:
   it's either ready to upstream, or it's not actually generic.
3. **Every visible bscode feature must map to an wasmagent-js API**
   in [the FrameworkApiMap](apps/web/src/components/FrameworkApiMap.tsx).
   That panel is also the funnel doc; if a feature can't be rendered
   on it, it doesn't justify the demo's surface area.
4. **Tests that test wasmagent-js belong in wasmagent-js.** bscode's
   tests cover wiring (does the worker boot? does the SSE channel
   stream? does the agent panel render the diff card?) — not the
   correctness of wasmagent-js's own scheduler / kernel / checkpointer.

## Allowed in bscode

- Wiring: HTTP routes, SSE plumbing, KV namespaces, GitHub OAuth flow.
- Demo-specific UI: chat panels, file tree, deploy button, the
  FrameworkApiMap panel introduced in B1.
- Deployment glue: `wrangler.toml`, deploy scripts, environment
  variable docs.
- Workflow-style end-to-end tests that exercise the wasmagent-js public
  API surface as a customer would.

## NOT allowed in bscode

- New `@wasmagent/*`-style abstractions (those go upstream).
- Forks of wasmagent-js classes with bscode-specific edits (file an
  upstream issue / PR; if the upstream maintainer rejects, document
  the gap and route around the API rather than fork it).
- Vendor-specific helpers that other wasmagent-js users would also
  want (e.g. a generic CF binding adapter — those go in
  `@wasmagent/tools-browser` or similar; bscode just imports).

## Workflow

```bash
git clone https://github.com/WasmAgent/bscode
cd bscode
bun install
bun run dev      # web at :3000, worker at :8787
bun run test     # apps/web + apps/worker
bun run lint
```

## Reviewing PRs

Reviewers check the thin-template rule first. If a PR adds something
that another wasmagent-js user would want, it's `request-changes` with
a link to file the upstream PR. We will revisit and merge once the
upstream API is published.

For tool PRs specifically, the *generic-first* three-question test
from wasmagent-js's CONTRIBUTING applies:

1. *Is the logic specific to this product, or would another agent
   project want it?*
2. *Does it depend only on already-published `@wasmagent/*` APIs?*
3. *Is there a comparable feature already in `wasmagent-js` you would
   otherwise duplicate?*

The current verdict for every tool under `apps/worker/src/tools/`
lives in [`docs/tools-audit-2026-06-12.md`](docs/tools-audit-2026-06-12.md);
new tool PRs must either cite a KEEP entry that justifies why the
new tool is product-shaped, or open a corresponding `wasmagent-js`
issue and reference its number.

## See also

- [wasmagent-js ROADMAP](https://github.com/WasmAgent/wasmagent-js/blob/main/ROADMAP.md)
  — the strategic axes that drive the rule above (esp. "S4 — bscode is
  a funnel, not a product").
- [wasmagent-js CONTRIBUTING](https://github.com/WasmAgent/wasmagent-js/blob/main/CONTRIBUTING.md)
  — for changes that should land upstream first.
- [Tools audit (2026-06-12)](docs/tools-audit-2026-06-12.md) — the
  current UPLIFT / KEEP / EVALUATE verdict for every bscode tool.

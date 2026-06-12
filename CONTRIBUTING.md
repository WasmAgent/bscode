# Contributing to bscode

bscode is a **thin demo template** for [agentkit-js](https://github.com/telleroutlook/agentkit-js).
Its job is to convert demo viewers into framework users — not to become
a half-finished IDE. The rules below exist to keep that promise.

## The thin-template rule (B3, 2026-06)

> **Hard rule:** bscode only adds code that demonstrates an
> already-published agentkit-js API.

Concretely:

1. **No new generic abstractions in bscode.** If you need an interface
   that another agentkit-js consumer would reasonably want too — a
   browser binding, a kernel, a checkpointer adapter, a retrieval helper,
   a streaming primitive — it belongs in an `agentkit-js/packages/*`
   package first. Open the PR there. bscode imports it.
2. **Reusable code goes upstream first, lands here second.** The
   reverse path — "build it in bscode, lift it out later" — is allowed
   only as a research spike clearly labelled in the PR title with
   `[spike]`. A spike that lasts more than one release is a code-smell:
   it's either ready to upstream, or it's not actually generic.
3. **Every visible bscode feature must map to an agentkit-js API**
   in [the FrameworkApiMap](apps/web/src/components/FrameworkApiMap.tsx).
   That panel is also the funnel doc; if a feature can't be rendered
   on it, it doesn't justify the demo's surface area.
4. **Tests that test agentkit-js belong in agentkit-js.** bscode's
   tests cover wiring (does the worker boot? does the SSE channel
   stream? does the agent panel render the diff card?) — not the
   correctness of agentkit-js's own scheduler / kernel / checkpointer.

## Allowed in bscode

- Wiring: HTTP routes, SSE plumbing, KV namespaces, GitHub OAuth flow.
- Demo-specific UI: chat panels, file tree, deploy button, the
  FrameworkApiMap panel introduced in B1.
- Deployment glue: `wrangler.toml`, deploy scripts, environment
  variable docs.
- Workflow-style end-to-end tests that exercise the agentkit-js public
  API surface as a customer would.

## NOT allowed in bscode

- New `@agentkit-js/*`-style abstractions (those go upstream).
- Forks of agentkit-js classes with bscode-specific edits (file an
  upstream issue / PR; if the upstream maintainer rejects, document
  the gap and route around the API rather than fork it).
- Vendor-specific helpers that other agentkit-js users would also
  want (e.g. a generic CF binding adapter — those go in
  `@agentkit-js/tools-browser` or similar; bscode just imports).

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
that another agentkit-js user would want, it's `request-changes` with
a link to file the upstream PR. We will revisit and merge once the
upstream API is published.

## See also

- [agentkit-js ROADMAP](https://github.com/telleroutlook/agentkit-js/blob/main/ROADMAP.md)
  — the strategic axes that drive the rule above (esp. "S4 — bscode is
  a funnel, not a product").
- [agentkit-js CONTRIBUTING](https://github.com/telleroutlook/agentkit-js/blob/main/CONTRIBUTING.md)
  — for changes that should land upstream first.

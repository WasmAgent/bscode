# Security policy — bscode

## Reporting a vulnerability

Please report security issues privately to the repository owner. Do
not file a public issue for an exploitable vulnerability.

## Trust model

bscode is an **AI coding assistant** that the user runs against their
own browser. The threat model has three actors:

1. **The user** — runs the app, supplies the task, owns the browser
   tab. They authorize everything bscode does.
2. **The agent** — an LLM the user chose, executing in a worker the
   user authorized via API key. The agent's output is *user-directed
   code*: by typing "make me a Vue todo app", the user is asking the
   agent to write code that will run in their browser.
3. **External targets** — any URL the agent fetches, file the agent
   reads, or external service it calls.

**Trust boundary**: the agent is treated as an extension of the user.
Code the agent emits and the user *previews* runs in the user's
browser — that's the product, not a vulnerability. Code that *leaks
out of one user's session and into another's* is.

## Known sandbox decisions

### HTML preview iframe sandbox

The Live Preview pane (`apps/web/src/components/Terminal.tsx`)
renders agent-generated HTML in an iframe with:

```
sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
```

Chrome surfaces a console warning that this combination can escape
sandboxing. The combination is intentional:

- **allow-scripts** — agent demos commonly include JS (calculators,
  canvas games, todo apps). Without it the preview is a screenshot.
- **allow-same-origin** — Monaco-style demos, anything using
  `localStorage` / `IndexedDB` / relative `fetch()` URLs needs a
  real origin. Without it, those APIs throw.
- **allow-forms** — agent demos commonly include `<form>` submissions.
- **allow-modals** — agents sometimes use `confirm()` / `alert()` for
  UX flows.

**Why this is acceptable in our threat model**: the HTML inside the
iframe is code the *user asked the agent to produce*. Running it in
the user's browser is the product. The sandbox is still useful as
defense-in-depth: it scopes the iframe to its srcDoc and prevents it
from auto-navigating the top frame.

**Do not relax further.** Removing the sandbox attribute entirely
would let the iframe navigate the top frame on form submit.

### D2 card iframe sandbox

The D2 diagram card (`@agentkit-js/ui-cards-react/src/D2Card.tsx`)
uses a strictly tighter sandbox:

```
sandbox="allow-scripts"
```

No `allow-same-origin`, no `allow-forms`. The iframe runs only a tiny
postMessage script (rendered-height reporter) atop static D2-compiled
SVG. With a `null` origin even a maliciously-crafted D2 source can't
read host cookies, localStorage, or top-frame DOM.

### CDP / Playwright tools

Browser-driving tools (`tools-browser/src/cdp.ts`,
`tools-browser/src/playwright.ts`) execute arbitrary JS in a browser
the agent controls. They're meant for the agent's own scratch pages
— **never point them at the user's logged-in browser session.** The
agent could exfiltrate cookies trivially. Always pass an isolated
`wsEndpoint` / fresh Playwright context.

## Known sensitive data flows

- **API keys** — stored in `localStorage` keyed by provider. The user
  controls them. The browser sends them to the worker over the open
  wire by default; in production set `BSCODE_CLIENT_TOKEN` to require
  an additional bearer.
- **Session files** — stored per-session in worker KV under
  `file:<path>` and indexed by `X-Session-Id` header. Cross-session
  reads are blocked by the per-session FileTreeManager (verified in
  `apps/worker/src/app.test.ts`). The header is **not authenticated**;
  it's an isolation token, not an auth token. For multi-user prod
  deployments, derive `X-Session-Id` from a signed JWT.
- **Version history** — `apps/worker/src/agents/FileTreeManager.ts`
  keeps the last 10 versions of each file in memory. They're cleared
  on `DELETE /files` and on per-file delete. **Versions are not
  encrypted** — assume anything written to a file is queryable until
  the user explicitly clears the workspace.

## Audit findings closed

For traceability, the following classes of issue were identified and
closed in the cross-project audit:

- **Cross-tenant version data leak** — `globalFileTree` was a
  singleton; switched to per-session `Map` keyed on `X-Session-Id`.
- **DELETE leaving phantom versions** — version map is now cleared
  alongside the KV delete.
- **Rate limiter bypass via corrupted KV** — limiter now fails closed
  for one window when the value is malformed JSON or wrong shape.
- **JWT verifier accepting tokens missing `sub`** — sub presence and
  `nbf` (with 60s clock skew) are now validated.
- **CDP exception details swallowed** — `Runtime.evaluate` results
  now check `exceptionDetails` and throw with the page error text.
- **Playwright extract returning `""` on per-selector errors** — now
  re-throws with a structured per-selector message.

### 2026-06-16/17 sweep (SEC-013 through SEC-017)

Each finding has a regression test pinning it. Re-running `bun test`
across worker + web confirms all five remain closed.

- **SEC-013** (commit 22791ae) — `assertWorkspacePath` now rejects
  absolute paths, `..` traversal segments, NUL/C0 control bytes,
  DEL, and bidi-override marks (U+202A–U+202E + U+2066–U+2069). The
  earlier code let `write_file("../../etc/passwd")` reach a downstream
  shell tool that DID interpret the path.
- **SEC-014** (commit 2ff2a06) — `run_command` simulation branch
  used to evaluate model-supplied JS via `Function()`, making the
  Worker realm itself the sandbox. Removed; replaced with a no-op
  hint that points operators to wire a sandboxed kernel.
- **SEC-015** (commit 16171b1) — `run_command` block list missed
  the bare-root form `rm -rf /` because the regex used `\b` (a word
  boundary), which doesn't match between `/` and EOS. Now anchors
  on `(?:\s|$|\w)` so the bare root, trailing-space, and trailing-
  segment forms all block.
- **SEC-016** (commit fc2aab0) — `useImport.importFromDirectory`
  feature-detected the File System Access API with `"showDirectoryPicker"
  in window`, which returns true even when the property is
  `undefined` (failed polyfill). Replaced with `typeof ... !==
  "function"` so any non-function value routes to the actionable
  hint instead of crashing with TypeError mid-call.
- **SEC-017** (commit 7a4c03d) — `useAgent.onEvent` rebuilt the entire
  TokenStats object from scratch, dropping `lastModelId` whenever a
  `model_done` event arrived without a `modelId`. UI tooltip flickered
  to undefined between calls. Fixed by spreading `...prev` first.

## Defense in depth recommendations for production

If deploying bscode beyond a single trusted user:

1. Set `BSCODE_CLIENT_TOKEN` and verify it on every `/run`.
2. Front the worker with a JWT-issuing auth layer; derive
   `X-Session-Id` from the signed `sub` claim (don't trust client
   headers alone).
3. Set `BSCODE_ALLOWED_ORIGIN` to the exact preview origin; don't
   leave it `*`.
4. Enable Cloudflare Rate Limiting (binding-based) in addition to
   the in-app sliding-window limiter — the in-app limiter is best
   for shaping traffic, but a binding-based limit handles surges
   the worker shouldn't even spend CPU on.
5. Audit every model provider key — bscode supports many providers
   and *every* configured key is a bill-line for an attacker who
   gets through the auth layer.

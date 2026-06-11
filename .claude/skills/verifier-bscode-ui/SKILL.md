---
name: verifier-bscode-ui
description: "Drive the bscode UI (Next.js @ :3000 + Worker @ :8788) end-to-end via chrome-devtools-mcp to verify a code change is observable to a real user. Use when the change reaches a UI surface (chat input, file tree, diff viewer, card preview, settings) or when probing the worker's session-keyed routes through the browser. Handles the well-known React-controlled-textarea pitfall: chrome-devtools fill() does NOT dispatch the synthetic input event React listens for, so the Run button stays disabled. This skill provides a bypass + a vetted task playbook."
---

# verifier-bscode-ui

Drive bscode through the browser the way a real user does, then capture
what you see. Anything that doesn't end at a pixel, an HTTP body, or a
console line is not evidence.

## When to use

- A change reaches the bscode web UI (`apps/web/src/`) — input, render,
  preview, file tree, diff, settings, card click, undo/redo
- A change reaches the worker (`apps/worker/src/`) but is observable
  through a UI flow, e.g. session-keyed `/files/:path/versions`
- A behavioral claim names a button/badge/card/preview as evidence
  ("badge shows Code + WASM", "preview pane renders D2 SVG", "Thought
  panel hides `<boltThinking>`")

Skip this skill when:

- The change is type-only / docs-only / tests-only — verify directly
- The surface is a CLI tool (use a CLI verifier)
- The worker change has no UI consumer — `curl` it directly

## Preflight

Always confirm both servers are alive before driving the UI. Either
your evidence is meaningless. **Do not start them yourself unless the
user asked** — running dev servers from inside a session lets them
linger across turns.

```bash
curl -sf -m 3 http://localhost:3000/ -o /dev/null && echo "WEB UP"
curl -sf -m 3 http://localhost:8788/health && echo " — WORKER UP"
```

If web is down: prompt the user to run `bun run dev:web`. If worker is
down: `bun run dev:worker`. **Then stop and wait** — don't proceed
with stale state.

## The textarea trap (read this first)

`mcp__plugin_chrome-devtools-mcp_chrome-devtools__fill()` writes the
DOM `value` property and dispatches a generic `input` event, but
**React 19's controlled-textarea reconciler ignores it** because it
checks for the synthetic `_valueTracker`. Result: the Run button stays
`disabled` even though the textarea visibly has text.

The fix is one `evaluate_script` call that uses the native value
setter (which React's `_valueTracker` recognises) and dispatches a
bubbling `input` event:

```js
() => {
  const ta = document.querySelector('textarea');
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, 'value'
  ).set;
  setter.call(ta, 'YOUR TASK TEXT HERE');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return ta.value.slice(0, 60);  // sanity check the round-trip
}
```

After this, click `▶ Run` (or press `Cmd+Enter`) and the Run handler
fires. **Use `fill_form` / `fill` only for non-React forms** (the
Settings dialog uses standard HTML inputs and is fine).

## The standard playbook

A typical bscode UI verification has four phases. Skip phases the
change doesn't touch — each phase is an independent step in your
report.

### 1. Boot the page and capture the baseline

```
navigate_page → http://localhost:3000/
take_snapshot                    # records uids; do this once per page
list_console_messages types=error,warn
```

A clean baseline = no errors, optional benign favicon 404, optional
iframe-sandbox warning (D2 preview needs both flags). Anything else
is a finding before you've even submitted a task.

### 2. Submit a task (using the textarea bypass)

```
evaluate_script with the setter snippet above
click ▶ Run                      # uid from snapshot
wait_for ["Stop", "Thinking"] timeout=10000
```

### 3. Wait for completion and probe the result

```
wait_for ["▶ Run", "Run"] timeout=120000
take_snapshot                    # fresh uids for the new turn
```

Now extract the badge + thought + cards into structured form so the
report has data, not vibes:

```js
() => {
  const turn = document.querySelector('[class*="Turn"]') ||
               document.body;
  const text = turn.innerText;
  return {
    badge: (text.match(/(Code \+ WASM|Code|Tool|Framework · \w+)/) || [])[0],
    thought: (text.match(/Thought \(\d+ words?\)/) || [])[0],
    hasD2Card: /card:d2/.test(text),
    hasMdCard: /card:markdown/.test(text),
    showsBoltThinking: /<boltThinking>/.test(text),  // should be false post-fix
    cost: (text.match(/~\$\d+\.\d+/) || [])[0],
    tokens: (text.match(/\d[\d,]* tok/) || [])[0],
  };
}
```

### 4. Click cards & probe the preview pane

```
click on the card button (uid from step 3 snapshot)
take_screenshot fullPage=false → /Users/.../bscode-<probe>.png
```

The preview pane lives in an iframe (`srcdoc`) for D2 cards. The
snapshot tool descends into iframes automatically — look for
`RootWebArea url="about:srcdoc"` lines and the SVG-rendered text
nodes inside.

## Worker-side probes (when UI evidence isn't enough)

Some fixes (multi-tenant isolation, fail-closed limiter, classify
fast-path) are easier to verify with curl than through the UI. Use
session-id headers explicitly so you exercise the per-session code:

```bash
# Multi-tenant version isolation
curl -sf -m 5 -X POST http://localhost:8788/files \
  -H 'Content-Type: application/json' -H 'X-Session-Id: tenant-A' \
  -d '{"path":"x.js","content":"v1"}'
curl -sf -m 5 -X POST http://localhost:8788/files \
  -H 'Content-Type: application/json' -H 'X-Session-Id: tenant-A' \
  -d '{"path":"x.js","content":"v2"}'
curl -sf -m 5 'http://localhost:8788/files/x.js/versions' \
  -H 'X-Session-Id: tenant-A'                    # expect 2 versions
curl -sf -m 5 'http://localhost:8788/files/x.js/versions' \
  -H 'X-Session-Id: tenant-B'                    # expect [] (no leak)

# Classifier fast-path (no LLM call, deterministic)
curl -sf -m 10 -X POST http://localhost:8788/classify \
  -H 'Content-Type: application/json' \
  -d '{"task":"画一个用户注册流程的D2流程图"}'  # expect mode:code
curl -sf -m 30 -X POST http://localhost:8788/classify \
  -H 'Content-Type: application/json' \
  -d '{"task":"build a Vue app"}'                # expect mode:framework

# Rate limiter fail-closed (corrupted KV)
# (only verifiable via vitest — KV not accessible from outside the worker)
```

Always cross-reference the worker probe against the UI: a fix that
works in curl but breaks the UI is still a FAIL.

## Probes for specific past fixes

These map 1:1 onto findings the cross-project audit closed. Re-run
them after any change in the same area to confirm the fix didn't
regress.

| Fix area | UI probe | Worker probe |
|---|---|---|
| `<boltThinking>` strip | thought-panel regex `/<boltThinking>/` should be false | n/a |
| Auto-detect diagram→Code | badge text contains `Code` for diagram tasks | classify fast-path returns `mode:code` |
| Multi-tenant version leak | n/a (no UI) | tenant-B sees `versions:[]` for tenant-A's file |
| DELETE clears versions | n/a (no UI) | versions empty after DELETE |
| Card click-to-preview | iframe srcdoc shows D2 SVG nodes | n/a |
| Card auto-upgrade | bare D2/MD content gets wrapped in card fence | n/a |

## Capture format

Drop screenshots inside the repo (`/Users/I041705/github/agentkit-js/`
or `/Users/I041705/github/bscode/`) — `/tmp` is outside the workspace
and rejected by chrome-devtools. Name them `bscode-<probe>.png` and
**delete them after reporting** (they're evidence for the report, not
artifacts to commit).

## Report shape

Follow the bundled `verify` skill template — `## Verification`, then
**Verdict** / **Claim** / **Method** / **Steps** (✅/❌/⚠️/🔍 each
linked to a captured artifact) / **Findings** (lead with ⚠️ for
must-mention; plain bullets for context).

Diagram-only badge fix? Steps look like:

```
1. ✅ navigate to http://localhost:3000 → clean baseline, 0 errors
2. ✅ submit "画一个D2类图..." via the textarea-setter bypass → run started
3. 🔍 wait for completion → badge shows "Code + WASM" (was: "Framework · vanilla")
4. 🔍 token cost $0.0041 vs the pre-fix $0.0149 path
5. ⚠️ agent didn't actually emit a card:d2 block (DIAGRAMS_CODE_JS competes with OUTPUT_CONTRACT_FINAL_ANSWER)
```

The ⚠️ in step 5 is the kind of finding the user can't see from a
bare PASS — it goes in Findings even though the routing fix itself
holds.

## Anti-patterns

- **Don't** import bscode source and call functions directly — the
  function "works" in isolation but the UI flow that reaches it might
  not. Drive the surface.
- **Don't** start the dev servers if they aren't already running —
  ask the user. Background processes outlive the session.
- **Don't** wait for selectors that depend on locale-specific text
  unless you're sure of the locale. The "Thinking…" / "Done" labels
  are English in the current build.
- **Don't** treat a passing curl as evidence the UI works. The UI is
  the surface; curl is a sanity check on the worker layer.
- **Don't** SKIP just because `bun run typecheck` passes. Typecheck
  proves the code compiles; this skill proves it *runs* the way the
  user will see it.

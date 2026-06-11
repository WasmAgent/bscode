# BSCode Chrome DevTools E2E Report

**Date**: 2026-06-11 (continuation of [E2E-test-report-2026-06-11.md](E2E-test-report-2026-06-11.md))
**Surfaces**: `http://localhost:3000/` (AgentPanel home) + `/jobs` (JobsPanel B1)
**Method**: chrome-devtools-mcp navigation, snapshot + screenshot + Lighthouse audit, real network + console probes

## Headline result

| Surface | Lighthouse | Console errors | Network |
|---|---|:-:|---|
| **/ home** | **A11y 100 · BP 100 · SEO 100 · AB 100** (46/46) | 0 | 8 reqs (clean Next.js bootstrap) |
| **/jobs** | **A11y 100 · BP 100 · SEO 100 · AB 100** (49/49) — *after fix* | 0 | 5 fetch reqs per batch — *after fix* |

> The two regressions surfaced by this audit (color-contrast on /jobs status badges, runaway polling loop) are both fixed in this session.

## Bugs found and fixed (3)

### Bug 3 — JobsPanel runaway polling loop

**File**: `apps/web/src/components/JobsPanel.tsx`

**Symptom**: While any job was non-terminal, the JobsPanel fired
**34,975 GET /jobs requests in ~60 s** — a self-triggering React effect.

**Root cause**: The polling `useEffect` was declared with deps
`[fetchJobs, jobs]`. Each poll invoked `setJobs(body.jobs)` which mutated
`jobs`, which retriggered the effect, which immediately called
`fetchJobs()` again (the effect body had a synchronous `fetchJobs()` call
on every run, not only inside the timer). The `setTimeout` that was
*supposed* to be the only re-entry path was almost never reached.

**Fix**: Decoupled the polling driver from React state. `fetchJobs`
now writes the live-job count to a `useRef`, and the polling effect
depends only on `[fetchJobs]`. A single self-rescheduling `tick()`
function reads `liveCountRef.current` to decide whether to schedule
the next poll. `submit()` and `abort()` call `ensurePolling()` to
restart the loop after manually mutating the queue.

**Verification**: Same workflow (submit 2 jobs, watch them complete)
now produces **5 fetch requests total** (1 initial GET, 1 POST submit,
3 GET polls) — the design contract.

### Bug 4 — JobsPanel white-on-white inputs (theme regression)

**File**: `apps/web/src/components/JobsPanel.tsx`,
`apps/web/src/app/jobs/page.tsx`

**Symptom**: The textarea on `/jobs` had a white background while the
rest of the page was dark — typed text would have been invisible. The
"Submit batch" / "Refresh" / "Abort" buttons inherited the same broken
default (white bg, near-invisible borders against the dark canvas).

**Root cause**: `JobsPanel` was written before the centralized theme
landed. It used raw hex literals (`#666`, `#888`, `#c33`, `#f0f0f0`,
`#ddd`) for borders/text and *no* explicit background/color on
`<textarea>` / `<button>`, which defaulted to UA white-on-black.

**Fix**: Imported `theme` tokens and routed every surface (text,
border, status badges, error text) through them. Reusable `inputStyle`
+ `buttonStyle` constants keep the JSX scannable.

### Bug 5 — JobsPanel status-badge color-contrast (Lighthouse)

**File**: `apps/web/src/components/JobsPanel.tsx`

**Symptom**: Lighthouse a11y dropped from 100 → 96 on `/jobs` because
the status badge `<span>` colors (`#888`, `#0a7`, `#08c`, `#c33`,
`#a60`) failed 4.5:1 contrast against white badge text at 11 px.

**Fix**: Darkened all five values to ≥ 4.5:1 against white:
`queued: #5a5a5a`, `running: #0e7c4c`, `done: #1a5fb4`,
`failed: #a32525`, `aborted: #8a4500`. Lighthouse a11y returned to **100**.

## What was verified working

| Capability | Evidence |
|---|---|
| **Home page boots clean** | 0 console errors, 8 network requests (CSS, JS chunks, font, icon — all 200) |
| **AgentPanel SSE run** | "compute 7*8 in plain JS" → Code mode auto-detected → final answer 56 streamed in real time, thinking-delta events render incrementally |
| **TokenMeter cost accuracy** | After the run, panel reads `1 call · 675 tok · ~$0.0008` — Haiku-correct (the previous "always Sonnet pricing" bug stays fixed) |
| **Events tab event stream** | Numbered (`000`, `001`, …) frames with proper tags — `▶ RUN`, `── STEP`, `MODEL claude-haiku-4-5-20251001 in:606 out:69 cache:0`, `✓ ANSWER 56` |
| **Auto-detect classifier** | `/classify` was called, returned mode `code`, UI flipped Tool→Code automatically |
| **Settings drawer** | Opens, Worker URL editable, Default Model dropdown, security note about API keys, close button works |
| **Mobile /jobs (375 px)** | Table fits, badges legible, no overflow, all rows render |
| **B1 batch + abort** | Submitted 3 tasks → all three appeared as `running` → all done within 9 s, polling stops automatically |

## Caveats / known UX gaps (not regressions)

- **Mobile / home (375 px)**: 50/50 split between conversation panel and
  preview panel persists at narrow widths — preview is empty until the
  agent finishes, but it still takes half the screen. Textarea hint text
  `(Cmd+Enter to send)` clips at small widths. Both are usability papercuts,
  not bugs (functional, just suboptimal). Recommend: stack vertically below
  ~600 px breakpoint.
- **/jobs page polling**: now correct, but starts immediately on mount
  even when `total = 0`. Cheap call; can stay unless we care about
  battery on idle dashboards.

## Files changed in this session (Chrome-DevTools branch of the work)

| File | Change |
|---|---|
| `apps/web/src/components/JobsPanel.tsx` | Fix runaway polling effect; theme tokens; darker status badge colors |
| `apps/web/src/app/jobs/page.tsx` | Theme-token text colors |

Combined with the earlier session changes (`platform.ts`, `server.node.ts`,
`tool-agent.ts`, `app.ts`, `multi-agent.ts`, `scripts/test-new-features.mjs`,
`docs/E2E-test-report-2026-06-11.md`), every regression surfaced by either
the worker-side E2E or this browser-side audit is now fixed and verified.

## Reproduce

```bash
# 1. start worker + web (worker auto-binds checkpointsKv & buildResultsKv now)
cd /Users/I041705/github/bscode
bun --env-file=apps/worker/.dev.vars apps/worker/src/server.node.ts &
pnpm dev:web   # → http://localhost:3000

# 2. browser-side checks (this report)
#   open localhost:3000 → 0 console errors, AgentPanel works
#   open localhost:3000/jobs → submit 2 tasks → watch network panel:
#     5 requests total, polling stops when status flips to "done"

# 3. Lighthouse confirmation (any device with the chrome-devtools-mcp plugin)
#   audits return 100 / 100 / 100 / 100 on both pages.

# 4. worker-side regression suite
node scripts/test-new-features.mjs --url http://localhost:8788
#   → 35 / 35 pass
```

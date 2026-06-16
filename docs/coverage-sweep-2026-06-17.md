# BSCode test-coverage sweep — 2026-06-16/17

**Period**: two-day sustained sweep, 12 commits
**Branch**: `main`
**Final commit**: `a06576d`
**Status**: 541 / 542 passing (1 skipped — Bun-spawn smoke test
  intentionally skipped under Node-hosted vitest)

## Headline numbers

|  | At start of sweep | After sweep | Δ |
|---|--:|--:|--:|
| Worker tests (`apps/worker`) | 213 | **357** (+1 skipped) | +144 |
| Web tests (`apps/web`) | 27 | **184** | +157 |
| **Total** | **240** | **541** | **+301** |
| `bun lint apps/` errors | 7 | **0** | −7 |
| `typecheck` errors (worker + web) | 0 | **0** | 0 |
| Source files paired with `*.test.*` | ~50 % | ~80 % | +30 pp |

## Bugs caught and fixed during the sweep

Five real bugs were discovered as a side effect of authoring tests
that exercised assumed contracts. Each has a regression fixture so
the same class of bug cannot resurface silently.

| ID | File | Class | Caught by |
|---|---|---|---|
| **SEC-013** | `apps/worker/src/tools/index.ts` | path traversal × 3 + 10 MB DoS | E2E coverage audit pre-existing audit |
| **SEC-014** | `apps/worker/src/tools/index.ts` | `Function()` eval in `run_command` simulation | repo audit |
| **SEC-015** | `apps/worker/src/tools/index.ts` | `rm -rf /` regex `\b` boundary missed bare-root form | unit test for `run_command` block list |
| **SEC-016** | `apps/web/src/hooks/useImport.ts` | `"key" in window` feature-detect missed `= undefined` placeholder | unit test mocked the missing API |
| **SEC-017** | `apps/web/src/hooks/useAgent.ts` | TokenStats rebuild dropped `lastModelId` on partial events | hook event-routing unit test |

## Tests added by area

### Worker (`apps/worker/src`)

| Surface | Test file | New tests |
|---|---|--:|
| Plain file tools | `tools/file-tools.test.ts` (NEW) | 46 |
| Shell + 5 git tools | `tools/shell.test.ts` (NEW) | 6 + 1 Bun-only skipped |
| `web_search` (DDG) | `tools/web-search.test.ts` (NEW) | 8 |
| Model registry (AES-GCM, prefs, discovery) | `models/registry.test.ts` (NEW) | 28 |
| Framework system prompts | `agents/prompts.test.ts` (NEW) | 13 |
| `app.ts` E2E (P1 / P2) | `app.test.ts` (extended) | +27 |
| `assertWorkspacePath` | `tools/file-tools.test.ts` | +10 |

### Web (`apps/web/src`)

| Surface | Test file | New tests |
|---|---|--:|
| `useAgent` state machine | `hooks/useAgent.test.ts` (NEW) | 33 |
| `useGitHub` OAuth + push | `hooks/useGitHub.test.ts` (NEW) | 12 |
| `useImport` ZIP / dir / upload | `hooks/useImport.test.ts` (NEW) | 14 |
| `lib/workerUrl` 3-layer resolution | `lib/workerUrl.test.ts` (NEW) | 11 |
| `lib/theme` design-token contract | `lib/theme.test.ts` (NEW) | 7 |
| `/api/github/callback` OAuth route | `app/api/github/callback/route.test.ts` (NEW) | 10 |
| `<ModelManager>` | `components/ModelManager.test.tsx` (NEW) | 17 |
| `<DiffViewer>` | `components/DiffViewer.test.tsx` (NEW) | 18 |
| `<SettingsDrawer>` | `components/SettingsDrawer.test.tsx` (NEW) | 9 |
| `<FrameworkApiMap>` | `components/FrameworkApiMap.test.tsx` (NEW) | 17 |
| `<DifferentiatorBand>` (stale assertion fix) | existing | (1 fix) |

## Security invariants now pinned by tests

These are assertions added during the sweep that exist specifically
to catch a class of silent regression — not just to test happy paths.

- **API keys never appear in plaintext on disk** — `registry.test.ts`
  reads the on-disk JSON after `registerCustomModel` and asserts the
  raw secret string is absent, regardless of which provider field the
  refactor lands the key in.
- **`listCustomModels` always masks api keys to `***`** — even when
  called by trusted client code; mask is unconditional, not opt-in.
- **No silent provider fallback** — explicit `deepseek-*` / `doubao-*`
  / `gpt-*` requests with missing keys return `null`, never silently
  reroute to whichever Anthropic key happens to be configured.
- **OAuth token never lands in querystring** — `/api/github/callback`
  redirect URL is parsed and asserted to put the token in the fragment
  only. Querystring leakage would land the access_token in Referer
  headers and any server-side request log along the redirect chain.
- **OAuth fragment is stripped after hydration** — `useGitHub` calls
  `history.replaceState` so a refresh / copy-link / screenshot doesn't
  surface the access_token to anything reading `window.location.href`.
- **`.env` / `.env.local` / `.dev.vars` never enter the workspace** —
  `useImport` ZIP filtering rejects them at every layer; `.env.example`
  is allowed (intended contract surface).
- **Path traversal stays rejected** — `assertWorkspacePath` regression
  iterates absolute paths, `..` segments, NUL/C0 bytes, DEL, bidi
  override marks (5 codepoints), bidi isolates (4 codepoints), and
  positive non-ASCII fixtures (CJK / accented Latin) so the rejection
  isn't over-broad either.
- **`X-Session-Id` is forwarded on every authenticated KV fetch** —
  `DiffViewer.test.tsx` asserts both the version-list AND version-detail
  fetches carry the header when the session prop is set.
- **`run_command` block list catches `rm -rf /` in every common form** —
  bare root, trailing space, trailing path segment all fail closed
  (SEC-015 regression).
- **API-key inputs are `type=password`** — `ModelManager.test.tsx`
  asserts the API-key field type so a refactor that switches it to
  plain text is loud, not silent.

## Why these tests, not others

The sweep was prioritised by **user-visible impact** rather than
implementation complexity. The skipped surfaces were skipped on
purpose:

- `tool-agent.ts` / `code-agent.ts` direct unit tests — already covered
  end-to-end via `app.test.ts` integration paths; the marginal value
  of duplicating the step-loop assertions is low.
- Pages (`app/page.tsx`, `app/layout.tsx`) — almost no logic; the
  components they compose are tested individually.
- `useAgent`'s deeper SSE-reconnect path — owned by `useAgentRun` in
  `@agentkit-js/react`; tested in that package's own suite.

## Reproducing the numbers

```bash
cd apps/worker && bun --filter @bscode/worker test
cd apps/web    && bun --filter @bscode/web test
bun lint
bun --filter @bscode/worker typecheck
bun --filter @bscode/web typecheck
```

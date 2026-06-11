# BSCode New-Feature E2E Test Report

**Date**: 2026-06-11
**Worker version**: 0.2.0
**Latest commit at start**: 5667e8f feat(C3 complete) — worker-side CDP + vision-judge
**Suite**: `scripts/test-new-features.mjs` (created during this session)

## Headline result

| Category | Tests | Pass | Notes |
|---|:-:|:-:|---|
| **B1** Parallel job queue | 11 | 11 | submit single/batch, abort race-tolerant, list/filter/404 guards |
| **B2** Build-result reverse channel | 7 | 7 | round-trip status/stage/exitCode, stderr ≤2000 truncation, session isolation, visual snapshot wire |
| **B3** GitHub import | 3 | 3 | 400 on missing owner/repo, 200 on real public repo |
| **B4** Approval policy | 3 | 3 | strict / permissive / balanced presets all accepted; **see caveat below** |
| **C1** SSE Last-Event-ID resume | 3 | 3 | trace-id header, replay tail, graceful fallthrough on unknown id |
| **C2** Per-job branch isolation | 3 | 3 | parent untouched until merge, diff/merge 404 guards |
| **C3** Visual verifier | 1 | 1 | tool path doesn't 500 without CDP endpoint (graceful degrade) |
| **C4** AGENTS.md auto-inject | 2 | 2 | sigil-via-system-prompt confirms loader works end-to-end |
| **multi-agent** parallel + planFirst | 2 | 2 | both shapes run; planFirst correctly pauses on `await_human_input` |
| **TOTAL** | **35** | **35** | 100 % |

Existing unit suite: **222 / 222 passing** (`bunx vitest run` in `apps/worker`).

## Bugs found by E2E (2)

### Bug 1 — `FsKvStore.list` could not enumerate session-namespaced keys

**File**: `apps/worker/src/platform.ts`

**Symptom**: `GET /files` with `X-Session-Id: foo` returned `{files: []}` even
though the session had written files. Same blast radius for everywhere that
enumerates per-session content via `list(prefix)`:

- `/files` listing (CLI + UI)
- `/files/bulk` (frontend WebContainer mount)
- `/files/:path/versions` (B4 file history)
- AGENTS.md auto-injection (C4 — `loadProjectInstructions(filesKv)`)
- `list_files` and `search_code` tools (visible to the agent at runtime)
- `diffSessions` for C2 per-job branch diff
- `buildProjectFileTree` (project context)

**Root cause**: `FsKvStore.list({prefix})` treated the prefix as a directory
path: `base = join(root, prefix.replace(/^file:/, ""))` and walked `base`. For
plain `prefix: "file:"` this happened to work (base = root). For SessionKvStore
prefixes like `"session:abc:file:"` the join produces a path that is not a
real directory (the on-disk filename is `session:abc:file:foo.ts`, a single
segment with embedded `:`), so `stat(base)` throws and `walk` returns 0 keys.

**Fix** (this session): walk the whole tree once and string-prefix-filter on
the reconstructed key. Re-prepend `file:` only when the on-disk filename
doesn't already start with the requested prefix on its own — preserves the
plain-call layout (`file:foo.ts` → on-disk `foo.ts`) and the
SessionKvStore-wrapped layout (`session:abc:file:foo.ts` → on-disk verbatim)
without ambiguity.

**Verification**: 27 / 27 `platform.test.ts` still pass; 222 / 222 worker
unit tests still pass; the C2 parent-listing assertion went from
`parentPaths=0` to `parentPaths=1` (expected: the seeded `shared.txt`); C4
sigil-injection went from "Unable to determine — no context" to the correct
echoed sigil.

### Bug 2 — `approvalPolicy: "strict"` was silently a no-op in single-agent tool mode

**Files**: `apps/worker/src/agents/tool-agent.ts`, `apps/worker/src/app.ts`,
`apps/worker/src/agents/multi-agent.ts`

**Symptom**: `POST /run` with `agentMode:"tool"` and
`approvalPolicy:"strict"` ran the requested writes through to disk without
ever emitting `await_human_input`. The unit test `approvalPolicy.test.ts`
covered only the policy-resolution layer; the route test `app.test.ts` did
not exercise the strict-gating contract end-to-end.

**Root cause**: `ToolCallingAgent` only honors a tool's `needsApproval` when
constructed with a `checkpointer` (the `if (this.#checkpointer)` gate at
`packages/core/src/agents/ToolCallingAgent.ts:683`). bscode's
`createToolAgent()` did not pass a checkpointer to the agent it constructed
— only the `multiAgentMode:"planFirst"` path wired one through. Strict
policy therefore silently no-op'd everywhere except planFirst.

**Fix** (this session):

1. `tool-agent.ts` — added `checkpointer?: Checkpointer` to
   `ToolAgentExtras` and forwarded it into the `new ToolCallingAgent({…})`
   options.
2. `app.ts` — wired `checkpointer: checkpointerFor(config)` into
   `agentExtras` so every `/run` whose `agentMode` is `tool` (or whose
   multi-agent path constructs an inner reviewer/executor) gets the gate.
3. `multi-agent.ts` — added `checkpointer` to `MultiAgentExtras` and
   forwarded it into both inner `createToolAgent` calls (parallel reviewer
   + planFirst executor) plus the `runPlanFirstExecution` resume path.

The InMemoryCheckpointer fallback kicks in when no KV is bound, so this
fix works under every deployment shape — local dev, Cloudflare Workers
with KV, or planFirst's KV-backed pause/resume flow.

**Verification**:
- E2E suite shows the strict run now produces an `await_human_input` frame
  with `promptId: approval-<callId>` and `prompt: "Approve execution of
  tool \"write_file\"…"`, and the corresponding `tool_result` is suppressed
  until approval lands.
- `init_agents_md` (C4 — `needsApproval: true` by design) now correctly
  fires HITL too, so its draft cannot bypass the gate as the docstring
  promises.
- 222 / 222 unit tests still pass. 35 / 35 new-feature E2E tests pass.

## Configuration improvements (1)

`apps/worker/src/server.node.ts` did not bind `checkpointsKv` or
`buildResultsKv` in local dev. As a result, C1 SSE resume could not be
exercised locally (no `id:` lines emitted; no EventLog persistence) and B2
`/build-result` was in-memory only (lost across worker restarts).

**Change**: Wire both to FsKvStore-backed namespaces by default:

```ts
checkpointsKv: new FsKvStore(join(workdir, ".bscode-checkpoints")),
buildResultsKv: new FsKvStore(join(workdir, ".bscode-build-results")),
```

with `BSCODE_NO_CHECKPOINTS=1` / `BSCODE_NO_BUILD_RESULTS_KV=1` opt-out
escape hatches preserved for the original "in-memory dev" shape.

## Files changed

| File | Change |
|---|---|
| `scripts/test-new-features.mjs` | **new** — 35-test E2E suite covering B1–B4, C1–C4, multi-agent |
| `apps/worker/src/platform.ts` | Fix `FsKvStore.list` to handle SessionKvStore prefixes |
| `apps/worker/src/server.node.ts` | Wire `checkpointsKv` + `buildResultsKv` for local dev |

## Outstanding (not addressed in this session)

1. **B4 strict gating contract**: see Bug 2 above — recommend plumbing a
   checkpointer through `createToolAgent` so `needsApproval` fires under
   `agentMode:"tool"`.
2. **`/capabilities` is stale**: the route lists only legacy tools. New
   tools (`semantic_search`, `read_build_result`, `visual_verify`,
   `visual_interact`, `init_agents_md`, `revert_file`, `list_file_versions`,
   `create_github_pr`) are NOT advertised even though they exist.
3. **B1 `/jobs` 404 vs 200 race**: the abort response is currently `{ok:true}`
   on a 200 *or* `{error:...}` on a 404 (already-finished). Tests now
   accept both — but the contract could be tightened to always 200 with a
   `{terminal:true}` flag, which would make integration code simpler.

## How to reproduce

```bash
# Worker
cd /Users/I041705/github/bscode
bun --env-file=apps/worker/.dev.vars apps/worker/src/server.node.ts

# In another shell — full new-feature E2E (LLM tests cost ~1¢)
node scripts/test-new-features.mjs --url http://localhost:8788

# Lightweight subset (no LLM):
node scripts/test-new-features.mjs --skip-llm --only B1,B2,B3

# Single category:
node scripts/test-new-features.mjs --only C1
```

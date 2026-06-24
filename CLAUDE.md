# bscode — Development Guide for Claude

## Test Commands

**IMPORTANT: This project uses `bun test` (via turbo). Do NOT use `npx vitest`, `npm test`, or bare `bun test` from root.**

```bash
# Run all tests (recommended — uses package.json scripts which include --isolate)
bun --filter @bscode/worker test
bun --filter @bscode/web test

# Or via turbo
bun run test    # runs turbo which triggers bun test in each package
```

**Worker test isolation**: `apps/worker/bunfig.toml` sets `isolate = true`, but Bun 1.3.14 only reads it when CWD matches. Running `bun test apps/worker/src/` from the repo root will produce ~44 false failures due to mock bleed between test files. Always use `bun --filter @bscode/worker test` or `cd apps/worker && bun test --isolate`.

**CRITICAL: Never run any `bun test` as a background task** (`run_in_background`) — a hung test will silently burn CPU.

## Lint

```bash
npx biome check apps/
npx biome check --write apps/    # auto-fix
```

## Build / Deploy

```bash
bun run deploy:dry-run    # build + wrangler dry-run (no deploy)
bun run deploy            # deploy to Cloudflare
```

## Typecheck

```bash
bun --filter @bscode/web run typecheck
bun --filter @bscode/worker run typecheck
```

## RLAIF rollout adapter (2026-06-22)

`apps/worker/src/rollout-adapter.ts` bridges bscode's KV build-result channel
to wasmagent-js verifiers:

- `makeBuildResultReader(kv?)` → `BuildResultReader` for `BuildPassesVerifier`
- `makeVisualResultReader(kv?)` → `VisualResultReader` for `VisualAssertVerifier`

`AppConfig.rolloutConcurrency` controls `JobQueue` concurrency (default 4).

**Session IDs:** All verifier calls must use derived IDs from `deriveJobSessionId()`.
Calling `putBuildResult` / `getBuildResult` with `"default"` emits a `console.warn`.
Use `{ strictKvMode: true }` in batch/rollout contexts to make KV failures throw.

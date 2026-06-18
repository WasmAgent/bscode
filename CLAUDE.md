# bscode — Development Guide for Claude

## Test Commands

**IMPORTANT: This project uses `bun test` (via turbo). Do NOT use `npx vitest`, `npm test`, or bare `bun test` from root.**

```bash
# Run all tests (recommended)
bun --filter @bscode/worker test
bun --filter @bscode/web test

# Or via turbo
bun run test    # runs turbo which triggers bun test in each package
```

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

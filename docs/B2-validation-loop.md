# B2 — Closed-loop validation (build-result reverse channel)

> Lets the worker-side agent see whether the project it just wrote actually
> compiles in the user's browser, so it can fix dependency typos and build
> errors without human intervention. bolt.new / Replit Agent pattern, adapted
> for an edge runtime where `run_command` is disabled.

## The problem

In framework mode (`framework: "react" | "vue" | "svelte" | "vanilla"`) the
agent runs on Cloudflare Workers and writes files into a virtual filesystem.
Execution happens in the user's **browser**, inside a WebContainer. Pre-B2,
the agent was blind:

- The worker has no `run_command` (edge runtime can't spawn processes).
- Build/install errors only ever reached the human looking at the preview tab.
- An agent that mis-spelt `react-doom` instead of `react-dom` would happily
  emit a "Project ready" final answer while the dev server crashed.

That's the gap bolt.new and Replit Agent close — they let the agent see its
own build failures and patch them. B2 closes the same gap for BSCode.

## The architecture

```
┌──────────────────────────────────────────────────────┐
│  Browser (Next.js)                                   │
│  ┌────────────────────────────────────────────────┐  │
│  │ useWebContainer()                              │  │
│  │   • runProject() / hotUpdate()                 │  │
│  │   • on stage transitions ──────► fetch POST    │  │
│  │     {status, stage, exitCode, stderr, ...}     │  │
│  └────────────────────────────────────────────────┘  │
└──────────────┬───────────────────────────────────────┘
               │ POST /build-result   (X-Session-Id: …)
               ▼
┌──────────────────────────────────────────────────────┐
│  Worker (Hono)                                       │
│  ┌─────────────────┐    ┌──────────────────────┐     │
│  │ POST /build-    │──► │ build-results store  │     │
│  │  result         │    │  (memory + KV mirror)│     │
│  └─────────────────┘    └──────────┬───────────┘     │
│                                     │                │
│  ┌─────────────────────────────┐    │                │
│  │ framework agent's tools     │    │                │
│  │   • read_build_result ◄─────┼────┘                │
│  └─────────────────────────────┘                     │
└──────────────────────────────────────────────────────┘
```

1. Browser-side `useWebContainer` reports stage transitions
   (install start/end, dev-server ready, build error) to `POST /build-result`
   with the session id in `X-Session-Id`.
2. Worker stores the latest snapshot per session in memory; mirrors to
   `BSCODE_BUILD_RESULTS` KV when bound, so a worker recycle does not drop
   it mid-conversation.
3. When the agent runs in framework mode, the `read_build_result` tool is
   registered. Calling it returns the most recent snapshot.
4. The framework system prompt (see `BUILD_VALIDATION` in
   `apps/worker/src/agents/prompts.ts`) instructs the agent to call
   `read_build_result` after writing files, branch on `success | failed |
   running | unknown`, and patch the source on failure.

## Public surface

### Worker HTTP

| Method | Path             | Purpose                                      |
| ------ | ---------------- | -------------------------------------------- |
| POST   | `/build-result`  | Browser writes the latest snapshot           |
| GET    | `/build-result`  | Debug readback (the agent uses the tool)     |
| DELETE | `/build-result`  | Clears the snapshot (eg on session reset)    |

The `X-Session-Id` header partitions snapshots; without it requests fall
back to the `default` session id used by everything else in BSCode.

### Worker tool

```ts
{
  name: "read_build_result",
  readOnly: true,
  idempotent: true,
  // returns: a multi-line string the model can branch on:
  //
  //   status: success (dev) 3s ago
  //   exitCode: 0
  //   previewUrl: https://x.local
  //
  //   status: failed (build) 1s ago
  //   --- stderr (tail) ---
  //   src/App.tsx:5:8 - error TS2307: Cannot find module 'react-doom'
}
```

Registered automatically when:
- the run is in framework mode (`body.framework` is set), AND
- `X-Session-Id` is present.

### Browser-side hook

`useWebContainer()` already surfaces `buildError` and `terminalLines` for the
UI; B2 adds `reportBuildResult()` calls at the same lifecycle points
(install start/end, dev-server ready, build error). No new return value —
the wiring is invisible to the rest of the React tree.

## Configuration

```toml
# apps/worker/wrangler.toml
[[kv_namespaces]]
binding = "BSCODE_BUILD_RESULTS"
id = "your-kv-namespace-id"
```

Without the binding the store is in-memory only. That is fine for local dev
(a single Bun watcher process holds the snapshot), and even on Workers it's
usually fine for a single conversation — the binding is the durability
upgrade for cross-recycle continuity.

## See also

- `apps/worker/src/build-results.ts` — store implementation
- `apps/worker/src/tools/build-result.ts` — agent-facing tool
- `apps/worker/src/build-results.test.ts` — store tests
- `apps/worker/src/tools/build-result.test.ts` — tool tests
- `apps/worker/src/app.test.ts` — HTTP route tests under
  "Build result reverse channel (B2)"
- `apps/web/src/hooks/useWebContainer.ts` — browser-side reporter

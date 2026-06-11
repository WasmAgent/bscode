# B2 example — agent recovers from a typo'd dependency

End-to-end demonstration of the closed validation loop. A user asks for a
small React app; the agent emits a typo'd dependency in `package.json`, the
browser-side WebContainer fails `npm install`, the agent reads the error
via `read_build_result`, patches the file, and confirms success — all
without human input.

> Run order: start the worker (`bun --filter @bscode/worker dev`), start
> the web app (`bun --filter @bscode/web dev`), then open the page and
> submit the task below.

## Task

```text
Build a small React counter app. Use TypeScript, Vite, and React 18.
```

## What the agent does

1. **Plan** — emits the standard `<boltThinking>` block listing the files
   it will write.

2. **Phase 2: write files** — drops the usual scaffolding (`package.json`,
   `vite.config.ts`, `index.html`, `src/main.tsx`, `src/App.tsx`, …), but
   in this demo the dependency line in `package.json` reads:

   ```json
   "react-doom": "^18.3.0"
   ```

3. **Browser tries to install** — the `useWebContainer` hook fires off
   `npm install`, which fails:

   ```
   npm ERR! 404 Not Found - GET https://registry.npmjs.org/react-doom
   ```

   The hook posts the snapshot to the worker:

   ```json
   {
     "status": "failed",
     "stage": "install",
     "exitCode": 1,
     "stderr": "npm ERR! 404 Not Found - GET https://registry.npmjs.org/react-doom"
   }
   ```

4. **Agent verifies** — the framework prompt tells it to call
   `read_build_result` after writing files. The tool returns:

   ```
   status: failed (install) 2s ago
   exitCode: 1
   --- stderr (tail) ---
   npm ERR! 404 Not Found - GET https://registry.npmjs.org/react-doom
   ```

5. **Agent patches** — it `patch_file`s `package.json` to fix the dep:

   ```diff
   - "react-doom": "^18.3.0"
   + "react-dom": "^18.3.0"
   ```

   The browser detects the `package.json` change (bolt.new restart pattern
   in `useWebContainer.hotUpdate`), re-runs `npm install`, the dev server
   comes up.

6. **Agent confirms** — calls `read_build_result` once more:

   ```
   status: success (dev) 1s ago
   exitCode: 0
   previewUrl: https://3000-xxx.local-credentialless.webcontainer.io
   ```

7. **Agent finishes** — final answer mentions the previewUrl. No human
   was involved in the diagnose/fix cycle.

## How to verify it really worked

- The worker terminal shows the agent emitting two `read_build_result`
  tool calls (one failed, one success).
- The browser terminal lines (`useWebContainer.terminalLines`) show two
  `npm install` runs — the original and the post-patch one.
- `GET /build-result` with the same `X-Session-Id` returns the success
  snapshot.

## Adapting to other failure modes

Same loop applies to:
- **Build errors** — `stage: "build"` instead of `"install"`. Agent
  patches the offending source file.
- **Dev-server crash** — Vite emits `Error:`/`failed to compile`; the
  hook scrapes those lines and posts a `stage: "build"` snapshot.

The agent stops after 2-3 polls if `status` stays `running` or `unknown`
(per the prompt) so a stuck WebContainer doesn't burn the whole step
budget.

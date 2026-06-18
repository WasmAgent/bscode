# Cloudflare 2026 platform primitives — bscode integration matrix

> **Status**: B2 (2026-06). Cloudflare's 2026 Agents Week (May)
> introduced Browser Run, managed Agent Memory, and an expanded Workflows
> tier. This page records how bscode wires each one through agentkit-js
> APIs — and how a fork can opt-in or opt-out per-Worker.

## Why this is a doc, not "rip out everything and use the CF version"

bscode's positioning (see [README](../README.md)) is **agentkit-js's
flagship template**, not a Cloudflare-only product. Its job is to
demonstrate that agentkit's interfaces are **portable** across the
edge primitives users actually have. The integration pattern is
therefore: **same agentkit interface, multiple CF backends**.

## The matrix

| 2026 CF primitive | agentkit-js interface | bscode entry point | Default behaviour |
|---|---|---|---|
| **Browser Run** (`BROWSER` binding via `@cloudflare/puppeteer`) | `BrowserSession` (`@wasmagent/tools-browser`) | `runVisualVerification({ browserRunBinding })` in `apps/worker/src/visualVerifier.ts` | Falls back to plain CDP `wsEndpoint` when binding is absent. |
| **Agent Memory** (managed KV with TTL + namespace) | `KvBackend` consumed by `createMemoryTool` (`@wasmagent/core`) | Any worker that calls `createMemoryTool({ backend })` — see `apps/worker/src/agents/code-agent.ts` | Defaults to `MapKvBackend` (in-memory). |
| **Workflows** (durable steps with retries) | `KvCheckpointer` (`@wasmagent/core`) — Workflow steps replace KV writes 1:1 | `apps/worker/src/agents/code-agent.ts` constructs the checkpointer; swap to a Workflow-backed shim. | KV-backed checkpointer (existing). |

## Browser Run wiring (one fetch handler)

```ts
// apps/worker/src/visualVerifier-browserRun.ts (illustrative)
import puppeteer from "@cloudflare/puppeteer";
import { runVisualVerification } from "./visualVerifier.js";

interface Env { BROWSER: Fetcher /* CF Browser Run binding */ }

export async function verifyWithBrowserRun(env: Env, previewUrl: string) {
  return runVisualVerification({
    previewUrl,
    browserRunBinding: { connect: () => puppeteer.launch(env.BROWSER) },
    // No `cdpWsEndpoint` needed — the binding wins per the precedence
    // documented on RunVisualVerificationOptions.browserRunBinding.
    timeoutMs: 30_000,
  });
}
```

A non-CF environment continues using `cdpWsEndpoint`. The same
`VisualCheckSnapshot` shape comes back either way; the agent's read
path doesn't fork.

## Agent Memory wiring

CF Agent Memory speaks a `KV`-style namespace contract. agentkit's
`createMemoryTool` accepts any `KvBackend` — implement two methods
(`get`, `put` + `delete` + `list`) and you have it.

```ts
import { createMemoryTool, type KvBackend } from "@wasmagent/core";

class CfAgentMemoryBackend implements KvBackend {
  constructor(private kv: KVNamespace) {}
  async get(k: string) { return await this.kv.get(k); }
  async put(k: string, v: string) { await this.kv.put(k, v); }
  async delete(k: string) { await this.kv.delete(k); }
  async list(prefix?: string) {
    const r = await this.kv.list(prefix ? { prefix } : undefined);
    return r.keys.map((k) => k.name);
  }
}

const memory = createMemoryTool({ backend: new CfAgentMemoryBackend(env.AGENT_MEMORY) });
```

This is the same shape we use for `MapKvBackend` (in-process, dev) and
`RedisRestKvBackend` (UpStash). The agent never sees the swap.

## Workflows wiring

CF Workflows guarantee step-level durability. agentkit's `KvCheckpointer`
already gives you durable state at every checkpoint; replacing the
underlying KV with Workflow step storage keeps the same agent code:

```ts
import { KvCheckpointer, type KvBackend } from "@wasmagent/core";

class WorkflowStepBackend implements KvBackend {
  constructor(private step: WorkflowStepEvent) {}
  async get(k: string) { return await this.step.do(`get:${k}`, async () => /* read */); }
  async put(k: string, v: string) { await this.step.do(`put:${k}`, async () => /* write */); }
  async delete(k: string) { await this.step.do(`del:${k}`, async () => /* delete */); }
  async list() { return []; /* implement if needed */ }
}

const checkpointer = new KvCheckpointer(new WorkflowStepBackend(step));
```

The Workflow runtime's retry semantics ride on top of `KvCheckpointer`'s
existing resumable replay.

## Why we do not ship a `@bscode/cf-bindings` package

Per [agentkit-js ROADMAP — "Explicitly NOT on the roadmap"](https://github.com/telleroutlook/agentkit-js/blob/main/ROADMAP.md#explicitly-not-on-the-roadmap)
and bscode's thin-template discipline (B3 in the 2026-06 plan):
generic CF binding adapters belong in **agentkit-js** packages
(`tools-browser` already grew `openBrowserRunSession` for this in
the same B2 commit), not in a bscode-specific helper package. bscode
imports the agentkit-js APIs and demonstrates wiring; it doesn't own
new CF abstractions.

## See also

- agentkit-js: [`packages/tools-browser/src/browserRun.ts`](https://github.com/telleroutlook/agentkit-js/blob/main/packages/tools-browser/src/browserRun.ts)
- agentkit-js: [`packages/core/src/memory/MemoryTool.ts`](https://github.com/telleroutlook/agentkit-js/blob/main/packages/core/src/memory/MemoryTool.ts)
- agentkit-js: [`packages/core/src/checkpoint/KvCheckpointer.ts`](https://github.com/telleroutlook/agentkit-js/blob/main/packages/core/src/checkpoint/)

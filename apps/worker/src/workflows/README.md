# bscode workflows — cross-job DAGs with the four contracts

bscode's `JobQueue` runs jobs in parallel up to a concurrency cap, but jobs
are independent — there is no native way to say *"after job A finishes, run
job B with A's output"*. The workflow module bridges that gap by sitting on
top of agentkit-js's `LocalWorkflowEngine`.

The four contracts that engine ships with — **observable, terminable,
resumable, clear errors** — apply to bscode workflows too.

## Quick start

```ts
import { BscodeWorkflowEngine } from "./workflows/BscodeWorkflowEngine.js";

const engine = new BscodeWorkflowEngine();
engine.register({
  id: "build-and-test",
  steps: [
    {
      id: "build",
      run: async () => buildProject(),
    },
    {
      id: "unit",
      dependsOn: ["build"],
      args: { artifact: "$build" },
      run: async ({ artifact }) => runUnitTests(artifact),
    },
    {
      id: "integ",
      dependsOn: ["build"],
      args: { artifact: "$build" },
      // unit and integ run in parallel; both block on build.
      run: async ({ artifact }) => runIntegrationTests(artifact),
    },
    {
      id: "merge",
      dependsOn: ["unit", "integ"],
      args: { unit: "$unit", integ: "$integ" },
      run: async ({ unit, integ }) => publishReport({ unit, integ }),
    },
  ],
});

const run = await engine.start("build-and-test");

// Observable
for await (const ev of run.events()) console.log(ev);

// Terminable — cancel propagates to step.run via signal (when the body honours it)
run.cancel("user-stop");

// Resumable — after a process crash, a fresh engine + same store picks up
//             from the last completed step, no double-execution.
const sameRun = await engine.resume("build-and-test", run.runId);
```

## Persistence (resume after crash)

```ts
import { KvWorkflowStateStore } from "@agentkit-js/core";
import { CloudflareKvBackend } from "@agentkit-js/cloudflare-worker";

const store = new KvWorkflowStateStore(new CloudflareKvBackend(env.WF_STATE));
const engine = new BscodeWorkflowEngine({ store });
```

Drop in any `KvBackend` to switch persistence: in-memory, filesystem, Redis,
Cloudflare KV, Durable Object — same engine, same DAG.

## Long-term: Cloudflare Workflows fallback

When you want CF's hibernate-and-replay semantics for runs that span days or
weeks, use `@agentkit-js/cloudflare-worker`'s `CloudflareWorkflowEngine` with
the **same `WorkflowDefinition`** — no rewrite. See
`docs/guides/workflows.md` in agentkit-js.

## Tests

`src/workflows/BscodeWorkflowEngine.test.ts` — 5 tests covering:

- Cross-job DAG (b receives a's output)
- Observable event stream (typed events for UI binding)
- Resumable across engine restart (completed jobs are not re-executed)
- Terminable via cancel + per-step `timeoutMs`
- Clear errors persisted with code/runId/stepId

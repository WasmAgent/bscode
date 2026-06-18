# Their framework + our kernel

> Direction 6 of the agentkit-js 2026-06-12 optimization brief.
> bscode is the funnel; this page is the funnel's *reverse-up*
> entry — designed for visitors who already use Vercel AI SDK 6,
> Mastra, the Anthropic Claude Agent SDK, the OpenAI Agents JS
> SDK, or Cloudflare codemode, and want to drop agentkit-js'
> WASM kernels into the framework they already have.

The premise of [`agentkit-js` Strategy memo
L1](https://github.com/telleroutlook/agentkit-js/blob/main/docs/strategy/2026-06-competitiveness.md#3-the-three-strategic-lines)
is that the frame race already has a winner and the right play is
to be **the runtime the leaders embed**. bscode is also the
showcase. So bscode should not just demo "agentkit's framework
running on the edge" — it should demo *exactly the reverse-up*: a
frame the reader already trusts, plus the kernels, plus the
durable runtime, plus the code-mode MCP server.

Each row below is a recipe a reader can copy *into their existing
codebase* without rewriting their agent. Where a recipe still
needs a small adapter shim, the shim is named and linked.

---

## A — Vercel AI SDK 6 + agentkit kernel

You already have `streamText({ tools })` in your Next.js / Vercel
app. You want one of those tools to run user-authored code in a
WASM sandbox — without standing up a Docker / E2B server.

```ts
import { streamText, tool } from "ai";
import { z } from "zod";
import { sandboxedJsTool } from "@wasmagent/aisdk";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

const safeJsTool = sandboxedJsTool({
  kernel: new QuickJSKernel(),
  // Same security policy face the rest of agentkit honors.
  capabilities: { allowedHosts: [], cpuMs: 5000, memoryLimitBytes: 64_000_000 },
});

const result = await streamText({
  model: anthropic("claude-sonnet-4-6"),
  tools: { run_js: safeJsTool, /* …your other tools as usual */ },
  messages,
});
```

What you keep: every other piece of your AI SDK setup — `useChat`,
`useAgent`, `experimental_telemetry`, the React hooks, the routes,
the streaming. What you replace: the OS-level sandbox you would
otherwise have stood up.

Why bother: AI SDK 6 ships best-in-class chat-UI primitives but
*does not* ship a sandboxed code-exec tool. `sandboxedJsTool` plugs
that hole without leaving the AI SDK world.

Walk-through: [`/recipes`](/recipes) on any running bscode deployment
shows this snippet alongside a "try a live patch" button that
exercises the kernel end-to-end on the host you're looking at.
Locally that's `http://localhost:3000/recipes` after `pnpm dev:web`;
remote viewers can use the deployed instance.

UTM tag for click attribution: `?source=bscode-aisdk-recipe`.

---

## B — Cloudflare codemode + agentkit kernel as custom executor

The Cloudflare codemode docs explicitly say the
`DynamicWorkerExecutor` is *one* implementation, and that you can
build your own for "Node VM, QuickJS, containers, or any other
sandbox." `@wasmagent/kernel-quickjs` is exactly that custom
executor — *and* it works off Cloudflare too (Node, Bun, Vercel,
AWS Lambda).

```ts
import { Agent } from "@cloudflare/agents/codemode";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";
import { agentkitCodemodeExecutor } from "@wasmagent/aisdk";
//                                       ^ shim is in flight; see the
//                                         draft at agentkit-js
//                                         docs/strategy/upstream-prs/
//                                         cloudflare-codemode-byo-executor.md

const agent = new Agent({
  tools: { /* your existing codemode tool surface */ },
  executor: agentkitCodemodeExecutor({
    kernel: new QuickJSKernel(),
    capabilities: { allowedHosts: ["api.example.com"], cpuMs: 5000 },
  }),
});
```

What you gain over `DynamicWorkerExecutor`:

- Run codemode **off** Cloudflare too (same kernel runs on Node /
  Bun / Vercel / Lambda).
- `needsApproval: true` semantics — approval-required tools
  pause-and-wait via agentkit's `await_human_input` lifecycle
  instead of being stripped from the executor.
- Optional Python tier — swap `QuickJSKernel` for `PyodideKernel`
  when a tool needs CPython.

UTM tag: `?source=bscode-cf-codemode-recipe`.

---

## C — Mastra sandbox provider backed by agentkit kernels

Mastra's sandbox provider contract treats the underlying isolation
as a swappable backend (Blaxel, E2B, etc.). The agentkit-backed
provider gives Mastra users WASM isolation with no external
service.

```ts
import { Mastra } from "@mastra/core";
import { agentkitMastraSandbox } from "@wasmagent/mastra-sandbox";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

const mastra = new Mastra({
  // …your existing Mastra config…
  sandbox: agentkitMastraSandbox({
    kernel: new QuickJSKernel(),
    capabilities: { allowedHosts: [], cpuMs: 5000 },
  }),
});
```

UTM tag: `?source=bscode-mastra-recipe`.

---

## D — Anthropic Claude Agent SDK + agentkit kernel as a tool

The Claude Agent SDK takes a list of tool descriptors with
`{name, description, input_schema, handler}`.
`sandboxedJsClaudeTool` and `codeModeClaudeTool` produce that
shape.

```ts
import Anthropic from "@anthropic-ai/sdk";
import { sandboxedJsClaudeTool } from "@wasmagent/claude-agent-sdk";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

const tool = sandboxedJsClaudeTool({
  kernel: new QuickJSKernel(),
  capabilities: { allowedHosts: [], cpuMs: 5000 },
});

const client = new Anthropic();
const response = await client.messages.create({
  model: "claude-sonnet-4-6",
  max_tokens: 4096,
  tools: [tool, /* …your other tools… */],
  messages,
});
```

UTM tag: `?source=bscode-claude-agent-sdk-recipe`.

---

## E — OpenAI Agents JS + agentkit kernel as a Tool

`@openai/agents` consumes `Tool<T>` descriptors with Zod
parameters and `execute()`. `sandboxedJsAgentTool` produces that.

```ts
import { Agent, run } from "@openai/agents";
import { sandboxedJsAgentTool } from "@wasmagent/openai-agents";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

const agent = new Agent({
  name: "code-runner",
  instructions: "Run the user's JavaScript snippet inside the sandbox.",
  tools: [sandboxedJsAgentTool({
    kernel: new QuickJSKernel(),
    capabilities: { allowedHosts: [], cpuMs: 5000 },
  })],
});

await run(agent, "compute the 20th Fibonacci number");
```

UTM tag: `?source=bscode-openai-agents-recipe`.

---

## What bscode does *not* try to be on this page

- **A migration ramp.** Nothing here asks the reader to leave the
  framework they already use. The agentkit packages slot in as
  one tool / one executor / one provider.
- **A side-by-side comparison.** The recipes above are configured
  identically (same kernel, same capabilities). If you want to
  compare *frameworks*, run the same task through two recipes and
  point [`agentkit devtools
  --otel-events-file`](https://github.com/telleroutlook/agentkit-js/blob/main/docs/guides/devtools-cross-framework.md)
  at both NDJSON traces — the same Studio view renders both.
- **A pitch for the agentkit framework.** The framework is at
  `@wasmagent/core` and is documented separately. This page is
  the *runtime* pitch — the embedded-runtime thesis is "the
  kernel + the manifest + the evaluator", which is what the
  recipes above actually demonstrate.

## Attribution

Each `?source=bscode-*-recipe` UTM threads through to the existing
[bscode README](../README.md) attribution scheme. When a reader
clicks `npm add @wasmagent/...` from one of these recipes, the
download is tagged so the strategy-memo falsifiability test
("zero organic downloads from upstream ecosystems by 2026-Q4 ⇒
retire the runtime pitch") can be checked against the actual
data, not a hand-wave.

## Where to take feedback

- Recipe doesn't compile against your version of the upstream →
  open an issue on [agentkit-js](https://github.com/telleroutlook/agentkit-js/issues)
  tagged `recipe:upstream-mismatch`.
- Want a recipe for a framework not above (LangGraph.js,
  CrewAI-JS, etc.) → tagged `recipe:request`.
- Want this page rendered as a first-class route inside bscode →
  see the [bscode README](../README.md) "Feature → API map"
  section; this page is on the same wiring path.

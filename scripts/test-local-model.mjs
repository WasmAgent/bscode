#!/usr/bin/env node
/**
 * bscode integration test against a fully local LLM.
 *
 * Validates two things at once:
 *   1. The agentkit-js LocalModel + agentkit-js core agent stack runs
 *      end-to-end on Node (which is what bscode targets when run outside
 *      Cloudflare Workers — the CLI, dev-mode worker, future server build).
 *   2. The same LocalModel slot the bscode worker registry exposes for
 *      "custom" / "local" providers actually answers a real task.
 *
 * Why this script exists: bscode's worker is Cloudflare-bound, and
 * node-llama-cpp can't run in Workers. So the real-machine integration
 * has to happen at the Node layer — here. If this passes, the localFirst
 * routing preset (LocalModel + cloud fallback) is also viable for any
 * Node deployment that bscode's CLI/server publishes.
 *
 * Usage:
 *   node scripts/test-local-model.mjs                    # uses Qwen2.5-0.5B from Ollama cache
 *   node scripts/test-local-model.mjs --gguf ./other.gguf
 *   node scripts/test-local-model.mjs --task "your prompt here"
 *
 * Prereqs:
 *   - node-llama-cpp installed somewhere reachable from this script.
 *     For development, it lives at ../agentkit-js/node_modules/.
 *   - A GGUF on disk (default: a known-good Qwen2.5-0.5B q4_0 in the
 *     local Ollama cache).
 */

import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    gguf: {
      type: "string",
      default:
        "/Users/I041705/.ollama/models/blobs/sha256-c5396e06af294bd101b30dce59131a76d2b773e76950acc870eda801d3ab0515",
    },
    task: {
      type: "string",
      default: "Compute 7 multiplied by 6 using the calculator tool.",
    },
    "max-tokens": { type: "string", default: "256" },
  },
});

console.log("[bscode-local] Loading @agentkit-js/model-local ...");
// Resolve via path: bscode worker doesn't depend on model-local (Workers
// can't run native bindings) so it's not symlinked into bscode's tree.
// We reach into the agentkit-js sibling repo directly.
const { fileURLToPath } = await import("node:url");
const { dirname, resolve } = await import("node:path");
const here = dirname(fileURLToPath(import.meta.url));
const localPath = resolve(here, "../../agentkit-js/packages/model-local/dist/index.js");
const { LocalModel } = await import(localPath);

console.log("[bscode-local] Constructing LocalModel from GGUF: " + values.gguf);
const model = new LocalModel({
  source: { path: values.gguf },
  contextSize: 2048,
  threads: 4,
  temperature: 0.2,
});

const t0 = Date.now();
await model.load();
console.log(`[bscode-local] Model loaded in ${Date.now() - t0} ms`);

// Synthesise the simplest possible "tool" the bscode worker would offer:
// a calculator with a strict input schema. This exercises the same
// grammar-constrained tool-call path the worker uses when forwarding
// agent runs from the web UI to the model adapter.
const tools = [
  {
    name: "calculator",
    description: "Compute a × b for two integers",
    input_schema: {
      type: "object",
      required: ["a", "b"],
      properties: {
        a: { type: "integer", description: "first operand" },
        b: { type: "integer", description: "second operand" },
      },
    },
  },
];

console.log(`[bscode-local] Task: ${values.task}`);
console.log("[bscode-local] Generating with tools...");

const tGen = Date.now();
let toolCall = null;
let collectedText = "";
let stopReason = "";
let usage = null;

for await (const ev of model.generate(
  [{ role: "user", content: values.task }],
  { tools, maxTokens: Number(values["max-tokens"]) },
)) {
  if (ev.type === "tool_call") toolCall = ev.toolCall;
  else if (ev.type === "text_delta") collectedText += ev.delta ?? "";
  else if (ev.type === "stop") stopReason = ev.stopReason ?? "";
  else if (ev.type === "usage") usage = ev.usage;
}
const tEnd = Date.now();

console.log("[bscode-local] ---");
console.log("[bscode-local] Tool call:", toolCall ? JSON.stringify(toolCall, null, 2) : "(none)");
console.log("[bscode-local] Text:", JSON.stringify(collectedText));
console.log("[bscode-local] Stop:", stopReason);
console.log("[bscode-local] Usage:", JSON.stringify(usage));
console.log(`[bscode-local] Total wall time: ${tEnd - tGen} ms`);

// Pass criterion: model produced a tool_call with both 'a' and 'b' filled.
// Doesn't have to be exactly 7×6 — small models occasionally pick wrong
// numerals. The framework correctness signal is "grammar produced a
// well-formed tool_use block".
const passed =
  toolCall != null &&
  toolCall.name === "calculator" &&
  Number.isInteger(toolCall.input?.a) &&
  Number.isInteger(toolCall.input?.b);

if (passed) {
  console.log(
    "[bscode-local] ✓ PASS — LocalModel + grammar produced a well-formed tool_call " +
      `(args: a=${toolCall.input.a}, b=${toolCall.input.b})`,
  );
  process.exit(0);
}

console.error("[bscode-local] ✗ FAIL — expected a tool_call to 'calculator' with integer args.");
process.exit(1);

import { CodeAgent } from "@agentkit-js/core";
import { QuickJSKernel } from "@agentkit-js/kernel-quickjs";
import type { QuickJSKernelOptions } from "@agentkit-js/kernel-quickjs";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import cfVariant from "@jitl/quickjs-wasmfile-release-sync";
import type { ToolDefinition, Model } from "@agentkit-js/core";

export function createCodeAgent(model: Model, tools: ToolDefinition[]) {
  const kernel = new QuickJSKernel({
    timeoutMs: 15_000,
    variant: cfVariant as unknown,
    variantLoader: newQuickJSWASMModuleFromVariant as unknown as NonNullable<QuickJSKernelOptions["variantLoader"]>,
  } satisfies QuickJSKernelOptions);

  return new CodeAgent({
    tools,
    model,
    maxSteps: 12,
    kernel,
    systemPrompt: `You are BSCode, an expert coding assistant.
You solve ALL tasks by writing and executing JavaScript code in a secure WASM sandbox.

CRITICAL RULES — you MUST follow these:
1. Always respond with a \`\`\`js code block containing executable JavaScript.
2. Never answer in plain text. Every response must be a code block.
3. To return your final answer, set the variable: __finalAnswer__ = <value>;
4. For file tasks, use the provided tools inside your code via the tool_use mechanism.
5. Keep code concise. Test edge cases inline.

Example response format:
\`\`\`js
function add(a, b) { return a + b; }
__finalAnswer__ = add(3, 4); // => 7
\`\`\``,
  });
}

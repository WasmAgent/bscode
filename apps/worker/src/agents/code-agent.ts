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
    systemPrompt: `You are BSCode, an expert coding assistant running on Cloudflare Workers.
You solve coding tasks by writing JavaScript code and executing it in a secure WASM sandbox.
Available tools are provided — use them to read/write files and search code.
To signal your final answer, set: __finalAnswer__ = <your answer>;
Keep code concise and correct. Always test your logic before declaring success.`,
  });
}

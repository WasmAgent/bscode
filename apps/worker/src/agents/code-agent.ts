import type { InputGuardrail, Model, OutputGuardrail, ToolDefinition } from "@agentkit-js/core";
import { CodeAgent } from "@agentkit-js/core";
import type { QuickJSKernelOptions } from "@agentkit-js/kernel-quickjs";
import { QuickJSKernel } from "@agentkit-js/kernel-quickjs";
import cfVariant from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";

export interface CodeAgentExtras {
  maxSteps?: number;
  planningInterval?: number;
  inputGuardrails?: InputGuardrail[];
  outputGuardrails?: OutputGuardrail[];
}

export function createCodeAgent(model: Model, tools: ToolDefinition[], extras: CodeAgentExtras = {}) {
  const kernel = new QuickJSKernel({
    timeoutMs: 15_000,
    variant: cfVariant as unknown,
    variantLoader: newQuickJSWASMModuleFromVariant as unknown as NonNullable<
      QuickJSKernelOptions["variantLoader"]
    >,
  } satisfies QuickJSKernelOptions);

  return new CodeAgent({
    tools,
    model,
    maxSteps: extras.maxSteps ?? 12,
    planningInterval: extras.planningInterval,
    kernel,
    inputGuardrails: extras.inputGuardrails,
    outputGuardrails: extras.outputGuardrails,
    // Use default CodeAgent system prompt — it's tuned for JS code generation
  });
}

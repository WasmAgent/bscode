import type { InputGuardrail, Model, OutputGuardrail, ToolDefinition } from "@agentkit-js/core";
import { CodeAgent } from "@agentkit-js/core";
import { PyodideKernel } from "@agentkit-js/kernel-pyodide";
import type { QuickJSKernelOptions } from "@agentkit-js/kernel-quickjs";
import { QuickJSKernel } from "@agentkit-js/kernel-quickjs";
import { RemoteSandboxKernel } from "@agentkit-js/kernel-remote";
import cfVariant from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";

export type CodeLanguage = "js" | "python" | "node";

export interface CodeAgentExtras {
  maxSteps?: number;
  planningInterval?: number;
  codeLanguage?: CodeLanguage;
  inputGuardrails?: InputGuardrail[];
  outputGuardrails?: OutputGuardrail[];
  e2bApiKey?: string;
}

function createQuickJSKernel() {
  return new QuickJSKernel({
    timeoutMs: 15_000,
    variant: cfVariant as unknown,
    variantLoader: newQuickJSWASMModuleFromVariant as unknown as NonNullable<
      QuickJSKernelOptions["variantLoader"]
    >,
  } satisfies QuickJSKernelOptions);
}

export function createCodeAgent(
  model: Model,
  tools: ToolDefinition[],
  extras: CodeAgentExtras = {}
) {
  const lang = extras.codeLanguage ?? "js";

  const kernel =
    lang === "python"
      ? new PyodideKernel()
      : lang === "node" && extras.e2bApiKey
        ? new RemoteSandboxKernel({ apiKey: extras.e2bApiKey, template: "base", timeoutMs: 60_000 })
        : createQuickJSKernel();

  const isPython = lang === "python";

  return new CodeAgent({
    tools,
    model,
    maxSteps: extras.maxSteps ?? 12,
    planningInterval: extras.planningInterval,
    kernel,
    inputGuardrails: extras.inputGuardrails,
    outputGuardrails: extras.outputGuardrails,
    systemPrompt: isPython
      ? `You are a Python coding assistant executing code in a Pyodide WASM sandbox.
Always respond with a \`\`\`python code block.
Use __finalAnswer__ = <value> (or __final_answer__ = <value>) to signal the result.
Example:
\`\`\`python
result = sum(range(10))
__finalAnswer__ = result
\`\`\``
      : undefined, // Use CodeAgent default for JS (tuned for JS code generation)
  });
}

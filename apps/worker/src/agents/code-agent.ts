import type { InputGuardrail, Model, OutputGuardrail, ToolDefinition } from "@agentkit-js/core";
import { CodeAgent, codeGuardrail } from "@agentkit-js/core";
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
    timeoutMs: 60_000, // 60s — supports long-running algorithms and large code generation
    variant: cfVariant as unknown,
    variantLoader: newQuickJSWASMModuleFromVariant as unknown as NonNullable<
      QuickJSKernelOptions["variantLoader"]
    >,
  } satisfies QuickJSKernelOptions);
}

const JS_SYSTEM_PROMPT = `You are an expert JavaScript coding assistant running inside a QuickJS WASM sandbox.

Your job is to solve tasks by writing and executing JavaScript code step by step.

Rules:
- Always respond with a \`\`\`js code block containing the code to execute.
- The sandbox is a pure JS runtime (no DOM, no browser APIs, no require/import).
- For tasks that produce a final value, set: __finalAnswer__ = <value>;
- For tasks that generate a large file or multi-step output (e.g. a game, an algorithm library),
  build the full result as a string in JS and set __finalAnswer__ = resultString;
- Do NOT try to use write_file, fetch, or any I/O — they are not available. Write the result as a string.
- If the task asks for HTML/CSS/JS source code, generate it as a string and set __finalAnswer__ = htmlString;`;

export function createCodeAgent(
  model: Model,
  _tools: ToolDefinition[],
  extras: CodeAgentExtras = {}
) {
  const lang = extras.codeLanguage ?? "js";

  const kernel =
    lang === "python"
      ? new PyodideKernel()
      : lang === "node" && extras.e2bApiKey
        ? new RemoteSandboxKernel({ apiKey: extras.e2bApiKey, template: "base", timeoutMs: 120_000 })
        : createQuickJSKernel();

  const systemPrompt =
    lang === "python"
      ? `You are a Python coding assistant executing code in a Pyodide WASM sandbox.
Always respond with a \`\`\`python code block.
Use __finalAnswer__ = <value> (or __final_answer__ = <value>) to signal the result.
Example:
\`\`\`python
result = sum(range(10))
__finalAnswer__ = result
\`\`\``
      : JS_SYSTEM_PROMPT;

  return new CodeAgent({
    tools: [], // CodeAgent executes code in a WASM kernel — it does not dispatch tool calls.
    model,
    maxSteps: extras.maxSteps ?? 12,
    planningInterval: extras.planningInterval,
    kernel,
    inputGuardrails: extras.inputGuardrails,
    outputGuardrails: extras.outputGuardrails,
    // S3: static code analysis — blocks dangerous patterns (eval, exec, rm, etc.)
    codeGuardrails: [codeGuardrail()],
    systemPrompt,
  });
}

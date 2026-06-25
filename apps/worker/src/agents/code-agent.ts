import cfVariant from "@jitl/quickjs-wasmfile-release-sync";
import type { InputGuardrail, Model, OutputGuardrail, ToolDefinition } from "@wasmagent/core";
import { CodeAgent, codeGuardrail } from "@wasmagent/core";
import { PyodideKernel } from "@wasmagent/kernel-pyodide";
import type { QuickJSKernelOptions } from "@wasmagent/kernel-quickjs";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";
import { RemoteSandboxKernel } from "@wasmagent/kernel-remote";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import { bscodeCodeAgentPrompt } from "./prompts.js";

export type CodeLanguage = "js" | "python" | "node";

export interface CodeAgentExtras {
  maxSteps?: number;
  planningInterval?: number;
  codeLanguage?: CodeLanguage;
  inputGuardrails?: InputGuardrail[];
  outputGuardrails?: OutputGuardrail[];
  e2bApiKey?: string;
  /** C4 — Project-specific instructions from AGENTS.md, appended verbatim. */
  projectInstructions?: string;
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
        ? new RemoteSandboxKernel({
            apiKey: extras.e2bApiKey,
            template: "base",
            timeoutMs: 120_000,
          })
        : createQuickJSKernel();

  const baseSystemPrompt = bscodeCodeAgentPrompt(lang);
  const systemPrompt = extras.projectInstructions
    ? `${baseSystemPrompt}\n\n---\n\n${extras.projectInstructions}`
    : baseSystemPrompt;

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

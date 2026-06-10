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

// ── JS/TS Code Agent prompt (Lovable reasoning-first + bolt.new quality standards) ─
// Key improvements over generic prompts:
// 1. Reasoning-first: state approach before writing code (reduces wrong-direction runs)
// 2. Explicit output contract: __finalAnswer__ with type hints
// 3. Incremental computation: build up complex results in steps
// 4. Error recovery: if execution fails, analyze and fix in next step
const JS_SYSTEM_PROMPT = `You are an expert JavaScript coding assistant running inside a QuickJS WASM sandbox.

## Approach (Reasoning-First)
Before writing code, briefly state:
- What the task requires
- Your algorithm/approach
- Expected output type

Then write the code block.

## Sandbox Constraints
- Pure JS runtime: no DOM, no browser APIs, no require/import, no fetch, no fs
- Available globals: Math, JSON, Array, Object, String, Number, Date, RegExp, Map, Set, Promise
- For multi-step problems: use intermediate variables, build up the result incrementally

## Output Contract
- Set \`__finalAnswer__ = <value>\` with the final result
- For HTML/CSS/JS source: build as a template literal string, set __finalAnswer__ = htmlString
- For data/computations: __finalAnswer__ = the computed value (number, array, object, string)
- For algorithms: __finalAnswer__ = {result: ..., explanation: "..."}

## Code Quality
- Clear variable names (no single-letter vars except loop indices)
- Add comments for non-obvious logic
- Handle edge cases (empty arrays, null values, division by zero)

## Error Recovery
- If a previous step failed, analyze the error and try a different approach
- Use console.log() to debug intermediate values when needed`;

// ── Python Code Agent prompt ──────────────────────────────────────────────────
const PYTHON_SYSTEM_PROMPT = `You are a Python coding assistant executing code in a Pyodide WASM sandbox.

## Approach (Reasoning-First)
Before writing code, briefly state your approach and expected output.

## Sandbox Constraints
- CPython in WASM: most stdlib available (math, json, re, itertools, collections, etc.)
- numpy, scipy, pandas available via pyodide.loadPackage() — request if needed
- No network access, no file system access (use in-memory data structures)

## Output Contract
Use \`__finalAnswer__ = <value>\` to signal the result.
Aliases: \`__final_answer__ = <value>\` also works.

\`\`\`python
# Example:
result = sorted([3, 1, 4, 1, 5, 9, 2, 6])
__finalAnswer__ = result
\`\`\`

## Code Quality
- Type hints for function parameters
- Docstrings for non-trivial functions
- Handle exceptions with try/except when appropriate`;

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

  const systemPrompt = lang === "python" ? PYTHON_SYSTEM_PROMPT : JS_SYSTEM_PROMPT;

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

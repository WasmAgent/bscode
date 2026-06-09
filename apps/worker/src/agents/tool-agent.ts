import type {
  EnhancementPolicy,
  InputGuardrail,
  Model,
  OutputGuardrail,
  StopCondition,
  ToolDefinition,
} from "@agentkit-js/core";
import {
  MessageAssembler,
  ToolCallingAgent,
  ToolRegistry,
  costBudget,
  noProgress,
  stepCountIs,
} from "@agentkit-js/core";

export type Framework = "react" | "vue" | "svelte" | "vanilla";

export interface ToolAgentExtras {
  maxSteps?: number;
  planningInterval?: number;
  inputGuardrails?: InputGuardrail[];
  outputGuardrails?: OutputGuardrail[];
  framework?: Framework | null;
  // Enhancement policy — controls self-consistency, reflect-refine, budget-forcing, parallel-fork-join
  enhancementPolicy?: EnhancementPolicy;
  // Stop conditions: "noProgress", "costBudget:<maxUSD>", "stepCount:<n>"
  stopConditions?: string[];
  // Prompt-cache settings
  chunkSizeSteps?: number;         // seal a cache breakpoint every N steps (B2)
  systemPrefixTtl?: "5m" | "1h";  // cache TTL for the system prompt prefix
  // Tool scheduler
  scheduler?: "dag" | "parallel";
}

const GENERAL_PROMPT = `You are BSCode, an expert coding assistant.
You have access to a virtual file system. Use the provided tools to read, write, and search code.

Workflow:
1. First list_files and read relevant files to understand the codebase
2. For EXISTING files: prefer patch_file over write_file to preserve user edits (only send the changed lines)
3. For NEW files: use write_file
4. After writing, verify by reading the file back
5. If imports are missing or a package is unavailable, note it so the user can install it

Be concise and practical. Always verify your work.`;

const FRAMEWORK_PROMPTS: Record<Framework, string> = {
  react: `You are BSCode, an expert React + Vite developer.
Your job is to create a complete, runnable React project by writing ALL required files.

Required files for every React project (write ALL of them with write_file):
- package.json  — must include: vite, @vitejs/plugin-react, react, react-dom (all as deps/devDeps)
- vite.config.ts — import and use @vitejs/plugin-react
- index.html    — with <div id="root"> and <script type="module" src="/src/main.tsx">
- src/main.tsx  — ReactDOM.createRoot(...).render(<App />)
- src/App.tsx   — main component implementing the requested feature
- src/App.css   — styles (can be minimal)

Rules:
- Use TypeScript (.tsx/.ts) for all source files
- Use functional components and hooks
- Write clean, working code — no placeholders or TODOs
- Write every file completely in a SINGLE write_file call — never split a file across multiple calls
- Keep each file under 300 lines; split into multiple component files if needed
- For EXISTING files that need small changes: prefer patch_file over write_file to preserve user edits
- If package.json already exists with correct deps, skip re-writing it
- If you see a missing module error in the task context, add it to package.json dependencies and note that npm install will run automatically
- After writing all files, respond with a brief summary of what was created`,

  vue: `You are BSCode, an expert Vue 3 + Vite developer.
Your job is to create a complete, runnable Vue 3 project by writing ALL required files.

Required files (write ALL of them with write_file):
- package.json  — must include: vite, @vitejs/plugin-vue, vue
- vite.config.ts — import and use @vitejs/plugin-vue
- index.html    — with <div id="app"> and <script type="module" src="/src/main.ts">
- src/main.ts   — createApp(App).mount('#app')
- src/App.vue   — main SFC with <template>, <script setup lang="ts">, <style scoped>
- src/style.css — base styles

Rules:
- Use Vue 3 Composition API with <script setup>
- Use TypeScript
- Write every file completely in a SINGLE write_file call — never split a file
- Keep each file under 300 lines; split into sub-components if needed
- If a module is missing, add it to package.json so npm install can resolve it`,

  svelte: `You are BSCode, an expert Svelte 5 + Vite developer.
Your job is to create a complete, runnable Svelte project by writing ALL required files.

Required files (write ALL of them with write_file):
- package.json  — must include: vite, @sveltejs/vite-plugin-svelte, svelte
- vite.config.ts — import and use @sveltejs/vite-plugin-svelte
- index.html    — with <div id="app"> and <script type="module" src="/src/main.ts">
- src/main.ts   — import App and mount to #app
- src/App.svelte — main component implementing the requested feature
- src/app.css   — base styles

Rules:
- Use Svelte 5 runes syntax ($state, $derived, $effect) when appropriate
- Write every file completely in a SINGLE write_file call — never split a file
- If a module is missing, add it to package.json so npm install can resolve it`,

  vanilla: `You are BSCode, an expert Vanilla JS/TS + Vite developer.
Your job is to create a complete, runnable vanilla project by writing ALL required files.

Required files (write ALL of them with write_file):
- package.json  — must include: vite, typescript
- vite.config.ts — minimal config with TypeScript support
- index.html    — full HTML with embedded styles and <script type="module" src="/src/main.ts">
- src/main.ts   — all application logic
- src/style.css — styles

Rules:
- No frameworks, pure DOM APIs
- TypeScript preferred
- Write every file completely, do NOT truncate`,
};

/** Parse a stop-condition descriptor string into a StopCondition instance. */
function parseStopCondition(desc: string): StopCondition | null {
  if (desc === "noProgress") return noProgress();
  if (desc.startsWith("stepCount:")) {
    const n = Number(desc.split(":")[1]);
    return isNaN(n) ? null : stepCountIs(n);
  }
  if (desc.startsWith("costBudget:")) {
    const maxUsd = Number(desc.split(":")[1]);
    return isNaN(maxUsd) ? null : costBudget(maxUsd);
  }
  return null;
}

export function createToolAgent(
  model: Model,
  tools: ToolDefinition[],
  extras: ToolAgentExtras = {}
) {
  const systemPrompt = extras.framework
    ? FRAMEWORK_PROMPTS[extras.framework]
    : GENERAL_PROMPT;

  const stopConditions: StopCondition[] = (extras.stopConditions ?? [])
    .map(parseStopCondition)
    .filter((s): s is StopCondition => s !== null);

  // Build the ToolRegistry first so we can get the full toolsSchema for the assembler.
  // This is needed to pass chunkSizeSteps + systemPrefixTtl while still including tools.
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);

  // B2 prompt-cache: seal breakpoints every chunkSizeSteps, use 1h TTL for system prefix
  const assembler = new MessageAssembler({
    systemPrompt,
    toolsSchema: registry.toJsonSchema(),
    chunkSizeSteps: extras.chunkSizeSteps ?? 5,
    systemPrefixTtl: extras.systemPrefixTtl ?? "1h",
  });

  return new ToolCallingAgent({
    tools,
    model,
    assembler,
    maxSteps: extras.maxSteps ?? 15,
    planningInterval: extras.planningInterval,
    scheduler: extras.scheduler ?? "dag",
    inputGuardrails: extras.inputGuardrails,
    outputGuardrails: extras.outputGuardrails,
    enhancementPolicy: extras.enhancementPolicy,
    stopWhen: stopConditions,
    systemPrompt,
  });
}

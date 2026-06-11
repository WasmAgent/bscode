import type {
  EnhancementPolicy,
  InputGuardrail,
  Model,
  OutputGuardrail,
  StopCondition,
  ToolDefinition,
} from "@agentkit-js/core";
import {
  costBudget,
  MessageAssembler,
  noProgress,
  stepCountIs,
  ToolCallingAgent,
  ToolRegistry,
} from "@agentkit-js/core";
import { bscodeFrameworkPrompt, type Framework } from "./prompts.js";

export type { Framework };

export interface ToolAgentExtras {
  maxSteps?: number;
  planningInterval?: number;
  inputGuardrails?: InputGuardrail[];
  outputGuardrails?: OutputGuardrail[];
  framework?: Framework | null;
  enhancementPolicy?: EnhancementPolicy;
  stopConditions?: string[];
  chunkSizeSteps?: number;
  systemPrefixTtl?: "5m" | "1h";
  scheduler?: "dag" | "parallel";
  /** Number of retries when outputSchema validation fails (default: 2) */
  outputSchemaRetries?: number;
  /**
   * C4 — Project-specific instructions discovered from AGENTS.md files.
   * Appended to the framework-default system prompt as a stable suffix
   * (kept in the prompt-cache prefix region so it doesn't blow the cache).
   */
  projectInstructions?: string;
}

/** Parse a stop-condition descriptor string into a StopCondition instance. */
function parseStopCondition(desc: string): StopCondition | null {
  if (desc === "noProgress") return noProgress();
  if (desc.startsWith("stepCount:")) {
    const n = Number(desc.split(":")[1]);
    return Number.isNaN(n) ? null : stepCountIs(n);
  }
  if (desc.startsWith("costBudget:")) {
    const maxUsd = Number(desc.split(":")[1]);
    return Number.isNaN(maxUsd) ? null : costBudget(maxUsd);
  }
  return null;
}

export function createToolAgent(
  model: Model,
  tools: ToolDefinition[],
  extras: ToolAgentExtras = {}
) {
  const baseSystemPrompt = bscodeFrameworkPrompt(extras.framework ?? "general");
  // C4 — Append AGENTS.md content as a stable suffix when present. The
  // `\n\n---\n\n` separator keeps it visibly delimited from the framework
  // prompt; we keep the project block AFTER the framework rules so the
  // model treats it as overriding (later-wins bias).
  const systemPrompt = extras.projectInstructions
    ? `${baseSystemPrompt}\n\n---\n\n${extras.projectInstructions}`
    : baseSystemPrompt;

  const stopConditions: StopCondition[] = (extras.stopConditions ?? [])
    .map(parseStopCondition)
    .filter((s): s is StopCondition => s !== null);

  // Build the ToolRegistry first so we can get the full toolsSchema for the assembler.
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
    outputSchemaRetries: extras.outputSchemaRetries,
  });
}

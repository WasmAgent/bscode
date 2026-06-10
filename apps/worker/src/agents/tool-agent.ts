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
  const systemPrompt = bscodeFrameworkPrompt(extras.framework ?? "general");

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

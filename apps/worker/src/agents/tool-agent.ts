import type { InputGuardrail, Model, OutputGuardrail, ToolDefinition } from "@agentkit-js/core";
import { ToolCallingAgent } from "@agentkit-js/core";

export interface ToolAgentExtras {
  maxSteps?: number;
  planningInterval?: number;
  inputGuardrails?: InputGuardrail[];
  outputGuardrails?: OutputGuardrail[];
}

export function createToolAgent(
  model: Model,
  tools: ToolDefinition[],
  extras: ToolAgentExtras = {}
) {
  return new ToolCallingAgent({
    tools,
    model,
    maxSteps: extras.maxSteps ?? 15,
    planningInterval: extras.planningInterval,
    scheduler: "dag",
    inputGuardrails: extras.inputGuardrails,
    outputGuardrails: extras.outputGuardrails,
    systemPrompt: `You are BSCode, an expert coding assistant.
You have access to a virtual file system. Use the provided tools to read, write, and search code.
When analyzing tasks: first list files, then read relevant ones, then write solutions.
Be concise and practical. Always verify your work by reading files after writing them.`,
  });
}

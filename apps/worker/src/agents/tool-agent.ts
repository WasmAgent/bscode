import { ToolCallingAgent } from "@agentkit-js/core";
import type { ToolDefinition, Model } from "@agentkit-js/core";

export function createToolAgent(model: Model, tools: ToolDefinition[]) {
  return new ToolCallingAgent({
    tools,
    model,
    maxSteps: 15,
    scheduler: "dag",
    systemPrompt: `You are BSCode, an expert coding assistant.
You have access to a virtual file system. Use the provided tools to read, write, and search code.
When analyzing tasks: first list files, then read relevant ones, then write solutions.
Be concise and practical. Always verify your work by reading files after writing them.`,
  });
}

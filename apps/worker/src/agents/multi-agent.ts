import type { AgentEvent, Model, ToolDefinition } from "@agentkit-js/core";
import { ToolCallingAgent } from "@agentkit-js/core";
import { createToolAgent } from "./tool-agent.js";

export interface MultiAgentExtras {
  maxSteps?: number;
  reviewMaxSteps?: number;
}

/**
 * Two-phase multi-agent workflow:
 *   Phase 1 (coding agent): Zero-tool ToolCallingAgent — must answer with plain text.
 *   Phase 2 (review agent): Reviews with full tool access.
 *
 * A "handoff" status event marks the transition between phases.
 */
export async function* multiAgentRun(
  model: Model,
  tools: ToolDefinition[],
  task: string,
  extras: MultiAgentExtras = {}
): AsyncGenerator<AgentEvent> {
  const traceId = `multi-${Date.now()}`;
  let step = 0;

  // ── Phase 1: Direct code generation with no tools ─────────────────────────
  // With tools=[], the ToolCallingAgent must return a plain text response as the final answer.
  // System prompt is explicit: respond immediately with the solution.
  const phase1Agent = new ToolCallingAgent({
    tools: [],
    model,
    maxSteps: extras.maxSteps ?? 3,
    systemPrompt:
      "Respond ONLY with your solution. No tool calls. No preamble. Just the answer.\n\n" +
      "For code tasks: write the code. For questions: write the answer.\n" +
      "Respond directly on your first message.",
  });

  let codeResult = "";

  for await (const ev of phase1Agent.run(task, traceId)) {
    yield ev;
    if (ev.event === "final_answer") {
      codeResult =
        typeof ev.data.answer === "string" ? ev.data.answer : JSON.stringify(ev.data.answer);
    }
    if (ev.event === "step_start") step = (ev.data as { step: number }).step;
  }

  if (!codeResult) return;

  // ── Handoff event ─────────────────────────────────────────────────────────
  yield {
    traceId,
    parentTraceId: null,
    timestampMs: Date.now(),
    channel: "status" as const,
    event: "handoff",
    data: { targetAgentName: "review-agent", step },
  } as AgentEvent;

  // ── Phase 2: Review with full tool set ────────────────────────────────────
  const reviewTask =
    `Review this solution. Task: ${task.slice(0, 300)}\n\n` +
    `Solution:\n${codeResult.slice(0, 2000)}\n\n` +
    `Provide brief feedback: correctness, edge cases, improvements.`;

  const reviewAgent = createToolAgent(model, tools, {
    maxSteps: extras.reviewMaxSteps ?? 4,
  });

  for await (const ev of reviewAgent.run(reviewTask, traceId)) {
    yield ev;
  }
}

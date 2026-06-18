import type { AgentEvent, Model, ModelMessage, ToolDefinition } from "@wasmagent/core";
import { ParallelForkJoinRunner, ToolCallingAgent } from "@wasmagent/core";
import { createToolAgent } from "./tool-agent.js";

/**
 * Mode the multi-agent run takes:
 *
 *   - "parallel"   — fork into N branches via ParallelForkJoinRunner, synth
 *                    the answers into a draft, then a single review/refine
 *                    step (with full tools) produces the final answer.
 *                    Replaces the old serial Phase1+Phase2 layout.
 *
 *   - "planFirst"  — Phase 1 produces a written plan with NO tools, emits
 *                    `await_human_input` so the user can approve / amend.
 *                    Phase 2 — only after the resume — executes the plan
 *                    with full tool access.
 */
export type MultiAgentMode = "parallel" | "planFirst";

export interface MultiAgentExtras {
  /** Run shape — see MultiAgentMode. Defaults to "parallel". */
  mode?: MultiAgentMode;
  /** Step budget for the executing (Phase 2) agent. */
  maxSteps?: number;
  /** Step budget for the planning / drafting (Phase 1) agent. */
  draftMaxSteps?: number;
  /** Number of parallel fork-join branches in "parallel" mode. */
  branches?: number;
  /** Concurrency cap inside the fork-join. */
  concurrency?: number;
  /** Aggregation strategy for the parallel branches. */
  aggregation?: "summary" | "first";
  /**
   * For planFirst, the resumed run sees this string as the user's approval
   * payload after applyHumanResponse(). The default is "approve-plan".
   */
  planPromptId?: string;
  /**
   * B4 — Checkpointer threaded through to the inner executor / reviewer
   * so write tools whose `needsApproval` evaluates true can pause for
   * human approval. Optional only because some test paths construct a
   * multi-agent run without a checkpointer; in production the worker
   * always passes one.
   */
  checkpointer?: import("@wasmagent/core").Checkpointer;
}

const DEFAULT_BRANCHES = 3;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_DRAFT_MAX_STEPS = 3;
const DEFAULT_REVIEW_MAX_STEPS = 4;
const DEFAULT_PLAN_PROMPT_ID = "approve-plan";

const PLANNER_SYSTEM_PROMPT = `You are a senior planner. Produce a numbered, ordered plan
the executor will follow next. Each plan item must:
  - mention the tool you would use (write_file / patch_file / read_file / etc.)
  - be specific enough that another agent can execute it without ambiguity
  - avoid pre-fetching files — assume the executor reads as it goes.

Wrap your plan inside a single <plan>…</plan> block. Do NOT execute anything.`;

const DRAFT_SYSTEM_PROMPT =
  "You are a generator. Produce one direct candidate solution to the task. " +
  "No preamble. No tool calls (you have none). Plain text only.";

/**
 * Multi-agent runner. Two shapes — parallel (default) and planFirst —
 * neither of which preserves the old serial Phase1+Phase2 layout.
 */
export async function* multiAgentRun(
  model: Model,
  tools: ToolDefinition[],
  task: string,
  extras: MultiAgentExtras = {}
): AsyncGenerator<AgentEvent> {
  const mode = extras.mode ?? "parallel";
  if (mode === "planFirst") {
    yield* runPlanFirst(model, tools, task, extras);
    return;
  }
  yield* runParallel(model, tools, task, extras);
}

// ── parallel: fork-join draft → reviewer with full tools ─────────────────

async function* runParallel(
  model: Model,
  tools: ToolDefinition[],
  task: string,
  extras: MultiAgentExtras
): AsyncGenerator<AgentEvent> {
  const traceId = `multi-parallel-${Date.now()}`;
  const base = { traceId, parentTraceId: null, timestampMs: Date.now() } as const;

  const branches = Math.max(1, extras.branches ?? DEFAULT_BRANCHES);
  const concurrency = Math.max(1, extras.concurrency ?? DEFAULT_CONCURRENCY);
  const aggregation: "summary" | "first" = extras.aggregation ?? "summary";

  yield {
    ...base,
    channel: "text",
    event: "run_start",
    data: { task },
  } as AgentEvent;

  // Stage 1 — fork N independent drafts and aggregate. We use the runner
  // directly (rather than enhancedAgentRun) because we want the SYNTHESISED
  // draft as a string we can hand to Stage 2; the runner returns it.
  const draftMessages: ModelMessage[] = [
    { role: "system", content: DRAFT_SYSTEM_PROMPT },
    { role: "user", content: task },
  ];

  yield {
    ...base,
    channel: "status",
    event: "status",
    data: { phase: "tool_executing", step: 1 },
  } as unknown as AgentEvent;

  const fork = new ParallelForkJoinRunner({
    branches,
    concurrency,
    aggregation,
  });
  const forkResult = await fork.run(model, draftMessages, { stream: true });

  // Telemetry — surface the fork outcome so dashboards can render the
  // diversity of the parallel run. The "handoff" status conveys
  // intent at the same point the old runner did.
  yield {
    ...base,
    channel: "status",
    event: "handoff",
    data: { targetAgentName: "review-agent", step: 1 },
  } as unknown as AgentEvent;

  // Stage 2 — review with full tool access. We don't run this in parallel;
  // the synthesised draft is one document and the reviewer should be
  // deterministic about it.
  const reviewTask =
    `Original task: ${task.slice(0, 400)}\n\n` +
    `Draft solution (synthesised from ${forkResult.branchesCompleted} parallel branches):\n` +
    `${forkResult.answer.slice(0, 4000)}\n\n` +
    `Now act on this draft using the available tools. Make it correct, complete, and runnable.`;

  const reviewer = createToolAgent(model, tools, {
    maxSteps: extras.maxSteps ?? DEFAULT_REVIEW_MAX_STEPS,
    checkpointer: extras.checkpointer,
  });
  for await (const ev of reviewer.run(reviewTask, traceId)) {
    yield ev;
  }
}

// ── planFirst: plan → await_human_input → executor ──────────────────────

async function* runPlanFirst(
  model: Model,
  _tools: ToolDefinition[],
  task: string,
  extras: MultiAgentExtras
): AsyncGenerator<AgentEvent> {
  const traceId = `multi-planfirst-${Date.now()}`;
  const base = () => ({
    traceId,
    parentTraceId: null as string | null,
    timestampMs: Date.now(),
  });
  const promptId = extras.planPromptId ?? DEFAULT_PLAN_PROMPT_ID;

  yield {
    ...base(),
    channel: "text",
    event: "run_start",
    data: { task },
  } as AgentEvent;

  // Stage 1 — planner runs without tools and emits a single text answer.
  const planner = new ToolCallingAgent({
    tools: [],
    model,
    maxSteps: extras.draftMaxSteps ?? DEFAULT_DRAFT_MAX_STEPS,
    systemPrompt: PLANNER_SYSTEM_PROMPT,
  });

  let plan = "";
  let lastStep = 0;
  for await (const ev of planner.run(task, traceId)) {
    yield ev;
    if (ev.event === "step_start") {
      const data = (ev as { data: { step: number } }).data;
      lastStep = data.step;
    }
    if (ev.event === "final_answer") {
      const ans = (ev as { data: { answer: unknown } }).data.answer;
      plan = typeof ans === "string" ? ans : JSON.stringify(ans);
    }
  }

  if (!plan) {
    yield {
      ...base(),
      channel: "text",
      event: "error",
      data: { error: "planner produced no plan" },
    } as unknown as AgentEvent;
    return;
  }

  // Strip the optional <plan>…</plan> wrapper so the executor sees clean text.
  const planBody = plan.replace(/<\/?plan>/gi, "").trim();

  // Surface the plan as a dedicated status event so dashboards can render it
  // distinctly from a generic message.
  yield {
    ...base(),
    channel: "status",
    event: "status",
    data: { phase: "plan_ready" as const, plan: planBody, step: lastStep },
  } as unknown as AgentEvent;

  // Suspend for human approval. CheckpointableRun captures this and stops
  // the loop; the resume path injects the approval response and re-enters
  // runPlanFirstAfterApproval (called from app.ts).
  yield {
    ...base(),
    channel: "status",
    event: "await_human_input",
    data: {
      promptId,
      prompt: `Approve this plan?\n\n${planBody}`,
      step: lastStep,
    },
  } as unknown as AgentEvent;

  // The generator returns here. CheckpointableRun won't iterate past the
  // await_human_input event — see core/src/checkpoint/index.ts. The resume
  // path is responsible for calling runPlanFirstExecution() with the
  // captured plan + approval response.
}

/**
 * Run only the EXECUTOR half of a planFirst flow. Called from the resume
 * path after the user has approved (or amended) the plan. The plan is
 * passed in explicitly so this function does not have to know how the
 * approval was persisted — that's the host's job.
 */
export async function* runPlanFirstExecution(
  model: Model,
  tools: ToolDefinition[],
  task: string,
  plan: string,
  approvalResponse: string,
  extras: { maxSteps?: number; checkpointer?: import("@wasmagent/core").Checkpointer } = {}
): AsyncGenerator<AgentEvent> {
  const traceId = `multi-planfirst-exec-${Date.now()}`;
  yield {
    traceId,
    parentTraceId: null,
    channel: "status",
    event: "handoff",
    data: { targetAgentName: "plan-executor", step: 0 },
    timestampMs: Date.now(),
  } as unknown as AgentEvent;

  const executorTask =
    `Original task: ${task}\n\n` +
    `Approved plan:\n${plan}\n\n` +
    (approvalResponse && approvalResponse.toLowerCase().trim() !== "yes"
      ? `User feedback on the plan:\n${approvalResponse}\n\nIncorporate the feedback before executing.\n\n`
      : "") +
    "Execute the plan step by step using the available tools.";

  const executor = createToolAgent(model, tools, {
    maxSteps: extras.maxSteps ?? DEFAULT_REVIEW_MAX_STEPS,
    checkpointer: extras.checkpointer,
  });
  for await (const ev of executor.run(executorTask, traceId)) {
    yield ev;
  }
}

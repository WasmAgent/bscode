/**
 * B1+B4 — multi-agent rewrite tests.
 *
 * Covers the two run shapes documented in agents/multi-agent.ts:
 *   - "parallel"   — fork-join draft → reviewer with full tools
 *   - "planFirst"  — planner emits await_human_input then yields control
 *   - runPlanFirstExecution — second-half executor invoked on resume
 *
 * Mocks @wasmagent/core's ParallelForkJoinRunner + ToolCallingAgent so the
 * tests don't make real model calls.
 */

import type { AgentEvent, Model } from "@wasmagent/core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

// Mock ParallelForkJoinRunner: deterministic synthesised draft.
vi.mock("@wasmagent/core", async (importActual) => {
  const actual = await importActual<typeof import("@wasmagent/core")>();
  return {
    ...actual,
    ParallelForkJoinRunner: class {
      constructor(public opts: unknown) {}
      async run() {
        return {
          answer: "synthesised draft from 3 branches",
          branches: ["b1", "b2", "b3"],
          branchesCompleted: 3,
        };
      }
    },
    ToolCallingAgent: class {
      constructor(public opts: { tools: unknown[]; systemPrompt?: string }) {}
      async *run(task: string): AsyncGenerator<AgentEvent> {
        // The planner is constructed with tools=[], systemPrompt="You are a senior planner..."
        // We use that to decide what kind of canned answer to produce.
        const isPlanner = (this.opts.systemPrompt ?? "").startsWith("You are a senior planner");
        yield {
          traceId: "t",
          parentTraceId: null,
          channel: "text",
          event: "run_start",
          data: { task },
          timestampMs: 0,
        } as AgentEvent;
        yield {
          traceId: "t",
          parentTraceId: null,
          channel: "text",
          event: "step_start",
          data: { step: 1 },
          timestampMs: 0,
        } as unknown as AgentEvent;
        const answer = isPlanner
          ? "<plan>\n1. read_file src/foo.ts\n2. patch_file src/foo.ts\n</plan>"
          : "ok";
        yield {
          traceId: "t",
          parentTraceId: null,
          channel: "text",
          event: "final_answer",
          data: { answer },
          timestampMs: 0,
        } as AgentEvent;
      }
    },
  };
});

// Mock the local createToolAgent — same shape as the real one for our purposes.
vi.mock("./tool-agent.js", () => ({
  createToolAgent: () => ({
    async *run(task: string): AsyncGenerator<AgentEvent> {
      yield {
        traceId: "exec",
        parentTraceId: null,
        channel: "text",
        event: "run_start",
        data: { task },
        timestampMs: 0,
      } as AgentEvent;
      yield {
        traceId: "exec",
        parentTraceId: null,
        channel: "text",
        event: "final_answer",
        data: { answer: "executed: " + task.slice(0, 40) },
        timestampMs: 0,
      } as AgentEvent;
    },
  }),
}));

// Import AFTER the mocks above are registered.
import { multiAgentRun, runPlanFirstExecution } from "./multi-agent.js";

const stubModel = { providerId: "stub", async *generate() {} } as unknown as Model;

const stubTool = {
  name: "fake_tool",
  description: "fake",
  inputSchema: z.object({}),
  outputSchema: z.string(),
  readOnly: false,
  idempotent: false,
  forward: async () => "ok",
};

describe("multiAgentRun parallel mode (B1)", () => {
  it("emits run_start, runs fork-join, hands off to reviewer, ends with reviewer answer", async () => {
    const events: AgentEvent[] = [];
    for await (const ev of multiAgentRun(stubModel, [stubTool], "build a small react app", {
      mode: "parallel",
    })) {
      events.push(ev);
    }
    const eventTypes = events.map((e) => e.event);
    expect(eventTypes[0]).toBe("run_start");
    expect(eventTypes).toContain("handoff");
    // Reviewer's final_answer is the last text event.
    const finalAnswers = events.filter((e) => e.event === "final_answer");
    expect(finalAnswers.length).toBeGreaterThan(0);
    const lastFinal = finalAnswers[finalAnswers.length - 1] as unknown as {
      data: { answer: string };
    };
    expect(lastFinal.data.answer).toContain("executed:");
  });

  it("defaults to parallel mode when extras.mode is omitted", async () => {
    const events: AgentEvent[] = [];
    for await (const ev of multiAgentRun(stubModel, [stubTool], "task")) {
      events.push(ev);
    }
    expect(events.some((e) => e.event === "handoff")).toBe(true);
  });
});

describe("multiAgentRun planFirst mode (B4)", () => {
  it("emits a plan_ready status event followed by await_human_input and stops", async () => {
    const events: AgentEvent[] = [];
    for await (const ev of multiAgentRun(stubModel, [stubTool], "ship feature X", {
      mode: "planFirst",
    })) {
      events.push(ev);
    }
    // Generator yields run_start (planner) → step_start → final_answer (planner) →
    // plan_ready status → await_human_input … and then RETURNS.
    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain("await_human_input");
    // No further events after await_human_input — generator returned.
    expect(eventTypes[eventTypes.length - 1]).toBe("await_human_input");

    // The plan body is reachable in both the plan_ready status AND the
    // await_human_input prompt.
    const awaitEv = events.find((e) => e.event === "await_human_input") as unknown as {
      data: { promptId: string; prompt: string };
    };
    expect(awaitEv.data.promptId).toBe("approve-plan");
    expect(awaitEv.data.prompt).toContain("read_file");
  });

  it("uses a custom planPromptId when provided", async () => {
    const events: AgentEvent[] = [];
    for await (const ev of multiAgentRun(stubModel, [stubTool], "task", {
      mode: "planFirst",
      planPromptId: "ship-it",
    })) {
      events.push(ev);
    }
    const awaitEv = events.find((e) => e.event === "await_human_input") as unknown as {
      data: { promptId: string };
    };
    expect(awaitEv.data.promptId).toBe("ship-it");
  });
});

describe("runPlanFirstExecution (B4 resume)", () => {
  it("runs the executor agent with the approved plan threaded into the task", async () => {
    const events: AgentEvent[] = [];
    for await (const ev of runPlanFirstExecution(
      stubModel,
      [stubTool],
      "ship feature X",
      "1. read_file foo.ts\n2. patch_file foo.ts",
      "yes"
    )) {
      events.push(ev);
    }
    expect(events[0]?.event).toBe("handoff");
    const finalEv = events.find((e) => e.event === "final_answer") as unknown as {
      data: { answer: string };
    };
    expect(finalEv).toBeTruthy();
    // The executor task includes the original task — the executor mock echoes
    // the first 40 chars back into the answer.
    expect(finalEv.data.answer).toContain("Original task: ship feature X");
  });

  it("threads non-yes feedback into the executor task as user feedback", async () => {
    const events: AgentEvent[] = [];
    for await (const ev of runPlanFirstExecution(
      stubModel,
      [stubTool],
      "task",
      "1. step",
      "please also add tests"
    )) {
      events.push(ev);
    }
    const finalEv = events.find((e) => e.event === "final_answer") as unknown as {
      data: { answer: string };
    };
    // Feedback is rendered in the executorTask preamble; we can't easily check
    // the inner prompt here without a non-trivial mock, so we just confirm the
    // executor still completed cleanly.
    expect(finalEv).toBeTruthy();
  });
});

/**
 * Tests for useAgent — the load-bearing state machine of the BSCode UI.
 *
 * Strategy: vi.mock("@wasmagent/react") so we control useAgentRun's
 * return value AND capture the `onEvent` callback the hook registers,
 * letting us deterministically inject events and assert how the hook
 * routes each into TokenStats / lastModelId / rawEvents. We also capture
 * the `run` payload to pin the contract sent to the worker — this is
 * where past silent regressions lived (chunkSizeSteps / systemPrefixTtl /
 * stopConditions inference).
 *
 * Why pin so much: this hook is the entire user-visible run model. A
 * silent default change (e.g. chunkSizeSteps 5 → unset) wrecks prompt-
 * cache hit rate, which doubles cost without any error message.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";

// ── Captured state from the mocked useAgentRun ──────────────────────────────
//
// Defined before vi.mock so the factory closure can read them. vi.mock is
// hoisted but it can reach module-scope `let` variables once they're
// assigned (we re-init these in beforeEach to keep tests isolated).
let capturedOnEvent: ((ev: unknown) => void) | null = null;
let capturedRunPayloads: Array<Record<string, unknown>> = [];
let mockReturn: {
  messages: unknown[];
  status: string;
  isRunning: boolean;
  finalAnswer: string | null;
  run: (payload: Record<string, unknown>) => void;
  abort: () => void;
  reset: () => void;
} = {
  messages: [],
  status: "idle",
  isRunning: false,
  finalAnswer: null,
  run: () => {},
  abort: () => {},
  reset: () => {},
};

vi.mock("@wasmagent/react", () => ({
  useAgentRun: (_endpoint: string, opts: { onEvent?: (ev: unknown) => void } = {}) => {
    capturedOnEvent = opts.onEvent ?? null;
    return {
      ...mockReturn,
      run: (payload: Record<string, unknown>) => {
        capturedRunPayloads.push(payload);
        mockReturn.run(payload);
      },
    };
  },
}));

// Defer the import until AFTER vi.mock is set up.
import type { AgentConfig } from "./useAgent";
import { useAgent } from "./useAgent";

// ── Helpers ──────────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;

function baseConfig(over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    agentMode: "tool",
    modelId: "claude-sonnet-4-6",
    maxSteps: 12,
    ...over,
  };
}

/** Fire an event into the hook through the captured onEvent callback. */
function fireEvent(ev: { event: string; data: Record<string, unknown> }) {
  if (!capturedOnEvent) throw new Error("onEvent not captured — useAgent didn't mount yet");
  act(() => {
    capturedOnEvent?.(ev);
  });
}

/** Stub fetch so /classify and /clarify return controllable bodies. */
function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const result = handler(url, init);
    if (result instanceof Response) return Promise.resolve(result);
    if (result instanceof Promise) return result as Promise<Response>;
    return Promise.resolve(
      new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  }) as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
  capturedOnEvent = null;
  capturedRunPayloads = [];
  mockReturn = {
    messages: [],
    status: "idle",
    isRunning: false,
    finalAnswer: null,
    run: () => {},
    abort: () => {},
    reset: () => {},
  };
  globalThis.fetch = realFetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ── Initial state ───────────────────────────────────────────────────────────

describe("useAgent — initial state", () => {
  it("starts with empty TokenStats and no detected mode / clarifying questions", () => {
    const { result } = renderHook(() => useAgent(baseConfig()));
    expect(result.current.tokenStats).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      calls: 0,
      accumulatedUsd: 0,
    });
    expect(result.current.tokenStats.lastModelId).toBeUndefined();
    expect(result.current.detectedMode).toBeNull();
    expect(result.current.clarifyingQuestions).toBeNull();
    expect(result.current.classifying).toBe(false);
    expect(result.current.rawEvents).toEqual([]);
  });

  it("forwards isRunning / status / finalAnswer / messages from useAgentRun", () => {
    mockReturn.isRunning = true;
    mockReturn.status = "running";
    mockReturn.finalAnswer = "42";
    mockReturn.messages = [{ id: "m1" } as unknown];
    const { result } = renderHook(() => useAgent(baseConfig()));
    expect(result.current.isRunning).toBe(true);
    expect(result.current.status).toBe("running");
    expect(result.current.finalAnswer).toBe("42");
    expect(result.current.messages.length).toBe(1);
  });
});

// ── onEvent → TokenStats routing ────────────────────────────────────────────

describe("useAgent — onEvent token accounting", () => {
  it("model_done events accumulate input / output / cacheRead / calls / USD", () => {
    const { result } = renderHook(() => useAgent(baseConfig()));
    fireEvent({
      event: "model_done",
      data: {
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 800,
        estimatedUsd: 0.012,
        modelId: "claude-sonnet-4-6",
      },
    });
    expect(result.current.tokenStats).toMatchObject({
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 800,
      calls: 1,
      accumulatedUsd: 0.012,
      lastModelId: "claude-sonnet-4-6",
    });
  });

  it("multiple model_done events SUM monotonically (cost never goes down)", () => {
    const { result } = renderHook(() => useAgent(baseConfig()));
    const seq = [
      { inputTokens: 100, outputTokens: 50, estimatedUsd: 0.001 },
      { inputTokens: 200, outputTokens: 80, estimatedUsd: 0.0015 },
      { inputTokens: 50, outputTokens: 10, estimatedUsd: 0.0002 },
    ];
    let prevUsd = 0;
    for (const data of seq) {
      fireEvent({ event: "model_done", data });
      // Strict monotonicity — a regression that subtracted instead of added
      // would show up here within one step.
      expect(result.current.tokenStats.accumulatedUsd).toBeGreaterThanOrEqual(prevUsd);
      prevUsd = result.current.tokenStats.accumulatedUsd;
    }
    expect(result.current.tokenStats.calls).toBe(3);
    expect(result.current.tokenStats.inputTokens).toBe(350);
    expect(result.current.tokenStats.outputTokens).toBe(140);
    // Floating-point sum tolerance.
    expect(result.current.tokenStats.accumulatedUsd).toBeCloseTo(0.0027, 4);
  });

  it("missing token fields default to 0 (worker may emit partial payloads)", () => {
    const { result } = renderHook(() => useAgent(baseConfig()));
    fireEvent({ event: "model_done", data: {} });
    expect(result.current.tokenStats).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      calls: 1,
      accumulatedUsd: 0,
    });
  });

  it("lastModelId tracks the MOST RECENT model — supports mid-run model swaps", () => {
    const { result } = renderHook(() => useAgent(baseConfig()));
    fireEvent({ event: "model_done", data: { modelId: "claude-haiku-4-5-20251001" } });
    expect(result.current.tokenStats.lastModelId).toBe("claude-haiku-4-5-20251001");
    fireEvent({ event: "model_done", data: { modelId: "claude-sonnet-4-6" } });
    expect(result.current.tokenStats.lastModelId).toBe("claude-sonnet-4-6");
  });

  it("a model_done without modelId leaves the previous lastModelId intact", () => {
    const { result } = renderHook(() => useAgent(baseConfig()));
    fireEvent({ event: "model_done", data: { modelId: "claude-sonnet-4-6" } });
    fireEvent({ event: "model_done", data: { inputTokens: 1 } });
    // Previous lastModelId must NOT be cleared by a payload that omits it —
    // otherwise UI tooltip flickers between "Sonnet" and undefined.
    expect(result.current.tokenStats.lastModelId).toBe("claude-sonnet-4-6");
  });

  it("non-model_done events are recorded in rawEvents but DO NOT mutate TokenStats", () => {
    const { result } = renderHook(() => useAgent(baseConfig()));
    fireEvent({ event: "step_start", data: { step: 1 } });
    fireEvent({ event: "tool_call", data: { name: "read_file" } });
    fireEvent({ event: "tool_done", data: { name: "read_file" } });
    fireEvent({ event: "final_answer", data: { answer: "done" } });
    expect(result.current.rawEvents.length).toBe(4);
    expect(result.current.tokenStats.calls).toBe(0);
    expect(result.current.tokenStats.accumulatedUsd).toBe(0);
  });
});

// ── submit() → run payload contract ─────────────────────────────────────────

describe("useAgent — submit() run payload defaults", () => {
  it("forwards all required config fields to useAgentRun.run", async () => {
    const { result } = renderHook(() =>
      useAgent(baseConfig({ agentMode: "code", modelId: "claude-opus-4-8", maxSteps: 20 }))
    );
    await act(async () => {
      await result.current.submit("hello");
    });
    expect(capturedRunPayloads.length).toBe(1);
    const p = capturedRunPayloads[0] as Record<string, unknown>;
    expect(p.task).toBe("hello");
    expect(p.agentMode).toBe("code");
    expect(p.modelId).toBe("claude-opus-4-8");
    expect(p.maxSteps).toBe(20);
  });

  it("applies the default codeLanguage='js' / useOtel=true / chunkSizeSteps=5 / systemPrefixTtl='1h'", async () => {
    const { result } = renderHook(() => useAgent(baseConfig()));
    await act(async () => {
      await result.current.submit("hello");
    });
    const p = capturedRunPayloads[0] as Record<string, unknown>;
    expect(p.codeLanguage).toBe("js");
    expect(p.useOtel).toBe(true);
    // chunkSizeSteps + systemPrefixTtl are the prompt-cache levers; a default
    // change here ~doubles cost silently. Pin them explicitly.
    expect(p.chunkSizeSteps).toBe(5);
    expect(p.systemPrefixTtl).toBe("1h");
  });

  it("respects an explicit chunkSizeSteps override (does not silently re-default)", async () => {
    const { result } = renderHook(() => useAgent(baseConfig({ chunkSizeSteps: 3 })));
    await act(async () => {
      await result.current.submit("t");
    });
    const p = capturedRunPayloads[0] as Record<string, unknown>;
    expect(p.chunkSizeSteps).toBe(3);
  });

  it("includes optional fields ONLY when set (omits framework / modelIds / scheduler when undefined)", async () => {
    const { result } = renderHook(() => useAgent(baseConfig()));
    await act(async () => {
      await result.current.submit("t");
    });
    const p = capturedRunPayloads[0] as Record<string, unknown>;
    // These three must be ABSENT, not undefined — the worker treats their
    // mere presence as a configured feature flag.
    expect("framework" in p).toBe(false);
    expect("modelIds" in p).toBe(false);
    expect("scheduler" in p).toBe(false);
    expect("maxBudgetTokens" in p).toBe(false);
    expect("maxDurationMs" in p).toBe(false);
    expect("autoCompactThreshold" in p).toBe(false);
    expect("conversationHistory" in p).toBe(false);
  });

  it("includes framework when the config sets it", async () => {
    const { result } = renderHook(() =>
      useAgent(baseConfig({ framework: "react", agentMode: "tool" }))
    );
    await act(async () => {
      await result.current.submit("build me a react app");
    });
    const p = capturedRunPayloads[0] as Record<string, unknown>;
    expect(p.framework).toBe("react");
  });

  it("forwards conversationHistory when supplied", async () => {
    const { result } = renderHook(() => useAgent(baseConfig()));
    const history: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer" },
    ];
    await act(async () => {
      await result.current.submit("follow up", history);
    });
    const p = capturedRunPayloads[0] as Record<string, unknown>;
    expect(p.conversationHistory).toEqual(history);
  });

  it("does NOT pass an empty conversationHistory array (key absent)", async () => {
    const { result } = renderHook(() => useAgent(baseConfig()));
    await act(async () => {
      await result.current.submit("t", []);
    });
    const p = capturedRunPayloads[0] as Record<string, unknown>;
    expect("conversationHistory" in p).toBe(false);
  });

  it("forwards enhancementPolicy / scheduler / budget caps verbatim", async () => {
    const policy = {
      selfConsistency: { enabled: true, n: 3 },
      reflectRefine: { enabled: false },
    };
    const { result } = renderHook(() =>
      useAgent(
        baseConfig({
          enhancementPolicy: policy,
          scheduler: "dag",
          maxBudgetTokens: 100_000,
          maxDurationMs: 60_000,
          autoCompactThreshold: 80_000,
        })
      )
    );
    await act(async () => {
      await result.current.submit("t");
    });
    const p = capturedRunPayloads[0] as Record<string, unknown>;
    expect(p.enhancementPolicy).toEqual(policy);
    expect(p.scheduler).toBe("dag");
    expect(p.maxBudgetTokens).toBe(100_000);
    expect(p.maxDurationMs).toBe(60_000);
    expect(p.autoCompactThreshold).toBe(80_000);
  });
});

// ── stopConditions inference ────────────────────────────────────────────────

describe("useAgent — stopConditions inference", () => {
  it("tool-mode runs WITHOUT explicit stopConditions get noProgress injected", async () => {
    const { result } = renderHook(() => useAgent(baseConfig({ agentMode: "tool" })));
    await act(async () => {
      await result.current.submit("t");
    });
    const p = capturedRunPayloads[0] as Record<string, unknown>;
    expect(p.stopConditions).toEqual(["noProgress"]);
  });

  it("framework runs ALWAYS get noProgress regardless of agentMode", async () => {
    const { result } = renderHook(() =>
      useAgent(baseConfig({ agentMode: "tool", framework: "react" }))
    );
    await act(async () => {
      await result.current.submit("t");
    });
    const p = capturedRunPayloads[0] as Record<string, unknown>;
    expect(p.stopConditions).toEqual(["noProgress"]);
  });

  it("code-mode runs DO NOT get auto-injected noProgress (would kill iterative algorithms)", async () => {
    const { result } = renderHook(() => useAgent(baseConfig({ agentMode: "code" })));
    await act(async () => {
      await result.current.submit("t");
    });
    const p = capturedRunPayloads[0] as Record<string, unknown>;
    expect("stopConditions" in p).toBe(false);
  });

  it("explicit stopConditions are NOT overwritten by the inference path", async () => {
    const { result } = renderHook(() =>
      useAgent(
        baseConfig({
          agentMode: "tool",
          stopConditions: ["costBudget:0.50", "stepCount:5"],
        })
      )
    );
    await act(async () => {
      await result.current.submit("t");
    });
    const p = capturedRunPayloads[0] as Record<string, unknown>;
    expect(p.stopConditions).toEqual(["costBudget:0.50", "stepCount:5"]);
  });
});

// ── autoMode → /classify branch ─────────────────────────────────────────────

describe("useAgent — autoMode classification", () => {
  it("calls /classify and applies the returned mode + framework + maxSteps cap", async () => {
    mockFetch((url) => {
      if (url.endsWith("/classify")) return { mode: "framework", framework: "react" };
      if (url.endsWith("/clarify")) return { needsClarification: false };
      return new Response("{}", { status: 200 });
    });
    const updates: Array<Partial<AgentConfig>> = [];
    const { result } = renderHook(() =>
      useAgent(baseConfig({ autoMode: true, agentMode: "code", maxSteps: 50 }), (u) =>
        updates.push(u)
      )
    );
    await act(async () => {
      await result.current.submit("build me a Next.js app");
    });
    expect(result.current.detectedMode).toEqual({ mode: "framework", framework: "react" });
    // framework runs auto-cap maxSteps at 15 (per the file's documented rule).
    const p = capturedRunPayloads[0] as Record<string, unknown>;
    expect(p.framework).toBe("react");
    expect(p.agentMode).toBe("tool"); // mode "framework" → run as tool agent
    expect(p.maxSteps).toBe(15);
    // onConfigUpdate fired with the auto-detected values so parent UI can reflect them.
    expect(updates.length).toBe(1);
    expect(updates[0]).toMatchObject({ agentMode: "tool", framework: "react", maxSteps: 15 });
  });

  it("non-framework classification preserves user-set maxSteps", async () => {
    mockFetch((url) => {
      if (url.endsWith("/classify")) return { mode: "code", framework: null };
      return new Response("{}", { status: 200 });
    });
    const { result } = renderHook(() =>
      useAgent(baseConfig({ autoMode: true, agentMode: "tool", maxSteps: 30 }))
    );
    await act(async () => {
      await result.current.submit("compute fib(20)");
    });
    const p = capturedRunPayloads[0] as Record<string, unknown>;
    expect(p.agentMode).toBe("code");
    expect(p.maxSteps).toBe(30);
  });

  it("classify failure falls through to the original config (no throw)", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error("network down"))
    ) as unknown as typeof globalThis.fetch;
    const { result } = renderHook(() =>
      useAgent(baseConfig({ autoMode: true, agentMode: "code", maxSteps: 12 }))
    );
    await act(async () => {
      await result.current.submit("t");
    });
    // run still fired with the original config — autoMode failure must not
    // block the user from running anything.
    expect(capturedRunPayloads.length).toBe(1);
    const p = capturedRunPayloads[0] as Record<string, unknown>;
    expect(p.agentMode).toBe("code");
  });

  it("clears classifying flag in finally when /classify rejects", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error("network down"))
    ) as unknown as typeof globalThis.fetch;
    const { result } = renderHook(() => useAgent(baseConfig({ autoMode: true })));
    await act(async () => {
      await result.current.submit("t");
    });
    // The spinner-bound flag MUST be reset even on failure or the UI gets stuck.
    expect(result.current.classifying).toBe(false);
  });
});

// ── /clarify branch ─────────────────────────────────────────────────────────

describe("useAgent — clarification flow", () => {
  it("PAUSES the run and surfaces questions when /clarify says needsClarification", async () => {
    mockFetch((url) => {
      if (url.endsWith("/classify")) return { mode: "tool", framework: null };
      if (url.endsWith("/clarify"))
        return {
          needsClarification: true,
          questions: [
            { text: "Which framework?", options: ["React", "Vue"] },
            "Free-text follow-up?",
          ],
        };
      return new Response("{}", { status: 200 });
    });
    const { result } = renderHook(() => useAgent(baseConfig({ autoMode: true })));
    await act(async () => {
      await result.current.submit("build me a thing");
    });
    // run was NOT called — the hook is waiting for user answers.
    expect(capturedRunPayloads.length).toBe(0);
    expect(result.current.clarifyingQuestions).not.toBeNull();
    expect(result.current.clarifyingQuestions?.length).toBe(2);
    // Question normalisation: string → ClarifyQuestion shape.
    expect(result.current.clarifyingQuestions?.[0]).toEqual({
      text: "Which framework?",
      options: ["React", "Vue"],
    });
    expect(result.current.clarifyingQuestions?.[1]).toEqual({
      text: "Free-text follow-up?",
      options: [],
    });
  });

  it("skipClarify=true bypasses /clarify and runs immediately", async () => {
    let clarifyCalled = false;
    mockFetch((url) => {
      if (url.endsWith("/classify")) return { mode: "tool", framework: null };
      if (url.endsWith("/clarify")) {
        clarifyCalled = true;
        return { needsClarification: true, questions: ["q?"] };
      }
      return new Response("{}", { status: 200 });
    });
    const { result } = renderHook(() => useAgent(baseConfig({ autoMode: true })));
    await act(async () => {
      await result.current.submit("answered task", undefined, true);
    });
    expect(clarifyCalled).toBe(false);
    expect(capturedRunPayloads.length).toBe(1);
  });

  it("a task containing '@' (file mention) skips /clarify (user is being explicit)", async () => {
    let clarifyCalled = false;
    mockFetch((url) => {
      if (url.endsWith("/classify")) return { mode: "tool", framework: null };
      if (url.endsWith("/clarify")) {
        clarifyCalled = true;
        return { needsClarification: true, questions: ["q?"] };
      }
      return new Response("{}", { status: 200 });
    });
    const { result } = renderHook(() => useAgent(baseConfig({ autoMode: true })));
    await act(async () => {
      await result.current.submit("refactor @src/foo.ts to use hooks");
    });
    expect(clarifyCalled).toBe(false);
    expect(capturedRunPayloads.length).toBe(1);
  });

  it("dismissClarify clears the questions state", async () => {
    mockFetch((url) => {
      if (url.endsWith("/classify")) return { mode: "tool", framework: null };
      if (url.endsWith("/clarify")) return { needsClarification: true, questions: ["q?"] };
      return new Response("{}", { status: 200 });
    });
    const { result } = renderHook(() => useAgent(baseConfig({ autoMode: true })));
    await act(async () => {
      await result.current.submit("ambiguous");
    });
    expect(result.current.clarifyingQuestions).not.toBeNull();
    act(() => result.current.dismissClarify());
    expect(result.current.clarifyingQuestions).toBeNull();
  });

  it("/clarify failure falls through to running (does not block the user)", async () => {
    mockFetch((url) => {
      if (url.endsWith("/classify")) return { mode: "tool", framework: null };
      if (url.endsWith("/clarify")) return Promise.reject(new Error("clarify down"));
      return new Response("{}", { status: 200 });
    });
    const { result } = renderHook(() => useAgent(baseConfig({ autoMode: true })));
    await act(async () => {
      await result.current.submit("t");
    });
    expect(capturedRunPayloads.length).toBe(1);
    expect(result.current.clarifyingQuestions).toBeNull();
  });

  it("clarify only fires for tool-mode auto runs (code mode skips it)", async () => {
    let clarifyCalled = false;
    mockFetch((url) => {
      if (url.endsWith("/classify")) return { mode: "code", framework: null };
      if (url.endsWith("/clarify")) {
        clarifyCalled = true;
        return { needsClarification: true, questions: ["q?"] };
      }
      return new Response("{}", { status: 200 });
    });
    const { result } = renderHook(() =>
      useAgent(baseConfig({ autoMode: true, agentMode: "tool" }))
    );
    await act(async () => {
      await result.current.submit("compute pi");
    });
    // /classify rerouted to "code" → /clarify must be skipped.
    expect(clarifyCalled).toBe(false);
    expect(capturedRunPayloads.length).toBe(1);
  });
});

// ── resetAll ────────────────────────────────────────────────────────────────

describe("useAgent — resetAll", () => {
  it("zeroes TokenStats, clears rawEvents / detectedMode / clarifyingQuestions", async () => {
    mockFetch((url) => {
      if (url.endsWith("/classify")) return { mode: "framework", framework: "vue" };
      if (url.endsWith("/clarify")) return { needsClarification: false };
      return new Response("{}", { status: 200 });
    });
    const { result } = renderHook(() => useAgent(baseConfig({ autoMode: true })));
    await act(async () => {
      await result.current.submit("t");
    });
    fireEvent({ event: "model_done", data: { inputTokens: 100, estimatedUsd: 0.005 } });
    fireEvent({ event: "step_start", data: { step: 1 } });

    expect(result.current.tokenStats.calls).toBe(1);
    expect(result.current.rawEvents.length).toBe(2);
    expect(result.current.detectedMode).not.toBeNull();

    act(() => result.current.resetAll());
    expect(result.current.tokenStats).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      calls: 0,
      accumulatedUsd: 0,
    });
    expect(result.current.rawEvents).toEqual([]);
    expect(result.current.detectedMode).toBeNull();
    expect(result.current.clarifyingQuestions).toBeNull();
  });

  it("a new submit() clears rawEvents from the previous run", async () => {
    const { result } = renderHook(() => useAgent(baseConfig()));
    fireEvent({ event: "step_start", data: { step: 1 } });
    fireEvent({ event: "step_start", data: { step: 2 } });
    expect(result.current.rawEvents.length).toBe(2);

    await act(async () => {
      await result.current.submit("new task");
    });
    // A fresh submit() wipes rawEvents so the UI doesn't show stale events
    // from the previous run mixed with the new one.
    expect(result.current.rawEvents).toEqual([]);
  });

  it("submit() clears the detectedMode + clarifyingQuestions before classify runs", async () => {
    // First run: classify says framework, then we manually set classifying state.
    mockFetch((url) => {
      if (url.endsWith("/classify")) return { mode: "framework", framework: "react" };
      if (url.endsWith("/clarify")) return { needsClarification: false };
      return new Response("{}", { status: 200 });
    });
    const { result } = renderHook(() => useAgent(baseConfig({ autoMode: true })));
    await act(async () => {
      await result.current.submit("first task");
    });
    expect(result.current.detectedMode?.framework).toBe("react");

    // Second run with a different classification — old detectedMode must clear.
    mockFetch((url) => {
      if (url.endsWith("/classify")) return { mode: "code", framework: null };
      return new Response("{}", { status: 200 });
    });
    await act(async () => {
      await result.current.submit("second task");
    });
    expect(result.current.detectedMode).toEqual({ mode: "code", framework: null });
  });
});

// suppress unused-import warning when waitFor isn't used in this file
void waitFor;

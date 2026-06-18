/**
 * Shared types for conversation turn rendering.
 *
 * Extracted out of `app/page.tsx` so that `TurnBlock` (and its tests) can
 * import the shape without pulling the entire page module. `ClassifyResult`
 * is re-exported from `useAgent` to keep a single source of truth.
 */

import type { ClassifyResult } from "@/hooks/useAgent";

export type { ClassifyResult } from "@/hooks/useAgent";

export interface ConversationTurn {
  id: string;
  task: string;
  detectedMode: ClassifyResult | null;
  timestamp: number;
  /** Accumulated agent output for this turn */
  agentText: string;
  /** Structured plan from <boltThinking> tags (shown before files are written) */
  planText: string | null;
  /** Tool calls/results summary lines */
  toolLines: string[];
  finalAnswer: string | null;
  error: string | null;
  status: "running" | "done" | "error";
  /** Write progress: list of file paths written so far (for framework mode) */
  writtenFiles: string[];
  /** Whether the thinking section is collapsed in the UI */
  thinkingCollapsed: boolean;
  /**
   * 2026-06-18 — Goal-directed agent state. Populated when this turn ran
   * with `agentMode === "goalDirected"`. The fields mirror events the
   * worker emits via `GoalDirectedAgent`:
   *   - `goalCriteria`: from `criteria_proposed` (Phase 1 output)
   *   - `goalIteration`: incremented by `goal_iteration_start`
   *   - `goalDone`: final tally from `goal_directed_done`
   * UI surfaces them as a timeline above the final answer so the user
   * can SEE the agent's self-imposed success bar before reading the
   * answer.
   */
  goalCriteria?: GoalCriterion[];
  goalIteration?: number;
  goalDone?: GoalDoneSummary;
}

export interface GoalCriterion {
  id: string;
  description: string;
  verify_method: string;
  arg?: unknown;
  path?: string;
}

export interface GoalDoneSummary {
  outcome: "verified" | "exhausted" | "budget" | "error" | "single-shot";
  iterationCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  lastHint?: string;
  lastError?: string;
  emptyCriteriaFallback?: boolean;
}

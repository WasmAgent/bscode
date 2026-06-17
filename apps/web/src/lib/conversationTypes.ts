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
}

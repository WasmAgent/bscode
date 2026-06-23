/**
 * Trajectory export — converts a completed bscode job into a rollout-wire JSONL
 * record consumable by wasmagent-js RolloutRanker and evomerge datafactory.
 *
 * Wire format mirrors wasmagent-js packages/core/src/ranking/schemas/rollout-wire.schema.json
 */

import type { BuildResultSnapshot } from "./build-results.js";
import type { JobSpec } from "./jobs/index.js";
import type { KvStore } from "./types.js";

export interface RolloutWireRecord {
  schema_version: "rollout-wire/v1";
  rollout_id: string;
  task: string;
  branch_index: number;
  temperature: number;
  session_id: string;
  tool_call_sequence: ToolCallEvent[];
  final_answer: string;
  build_result: BuildResultSnapshot | null;
  objective_score: number;
  rank: number;
  total_score: number;
  provenance: RolloutProvenance;
}

export interface ToolCallEvent {
  event: "tool_call" | "tool_result";
  data: Record<string, unknown>;
  timestamp_ms?: number;
}

export interface RolloutProvenance {
  source: "bscode";
  session_id: string;
  job_id: string;
  exported_at_ms: number;
}

/**
 * Build a RolloutWireRecord from job metadata and build result.
 * Returns null when the job has insufficient data for a training record.
 */
export function buildRolloutRecord(opts: {
  jobId: string;
  jobSpec: JobSpec;
  sessionId: string;
  branchIndex: number;
  buildResult: BuildResultSnapshot | null;
  toolCallSequence?: ToolCallEvent[];
  finalAnswer?: string;
}): RolloutWireRecord {
  const {
    jobId,
    jobSpec,
    sessionId,
    branchIndex,
    buildResult,
    toolCallSequence = [],
    finalAnswer = "",
  } = opts;

  // Three-valued encoding: null (no build triggered) → 0.5 neutral/unknown,
  // 'success' → 1, any failure/running state → 0.
  // Using 0 for null would make un-built rollouts indistinguishable from failed
  // builds, corrupting RolloutRanker preference pairs in RLAIF training data.
  const objectiveScore =
    buildResult === null ? 0.5 : buildResult.status === "success" ? 1 : 0;

  return {
    schema_version: "rollout-wire/v1",
    rollout_id: jobId,
    task: jobSpec.task,
    branch_index: branchIndex,
    temperature: (jobSpec.payload as { temperature?: number } | undefined)?.temperature ?? 0.2,
    session_id: sessionId,
    tool_call_sequence: toolCallSequence,
    final_answer: finalAnswer,
    build_result: buildResult,
    objective_score: objectiveScore,
    rank: 0,
    total_score: objectiveScore,
    provenance: {
      source: "bscode",
      session_id: sessionId,
      job_id: jobId,
      exported_at_ms: Date.now(),
    },
  };
}

/**
 * Serialize rollout records to JSONL string.
 */
export function toJsonl(records: RolloutWireRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

/**
 * Load job metadata needed for trajectory export.
 * Returns null if job or session data is unavailable.
 */
export async function loadJobForExport(
  jobId: string,
  sessionsKv: KvStore | undefined,
): Promise<{ spec: JobSpec; sessionId: string } | null> {
  if (!sessionsKv) return null;
  try {
    const raw = await sessionsKv.get(`job:${jobId}:spec`);
    if (!raw) return null;
    const data = JSON.parse(raw) as { spec: JobSpec; sessionId: string };
    return data;
  } catch {
    return null;
  }
}

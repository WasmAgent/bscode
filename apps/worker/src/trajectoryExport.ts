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
  objective_score: 0 | 1;
  objective_status: "pass" | "fail" | "unknown";
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

// ── PII redaction ────────────────────────────────────────────────────────────

const PII_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  // JWT tokens (three base64url segments starting with eyJ)
  { re: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, replacement: "[JWT]" },
  // API / secret keys: sk-, pk-, api- prefixed tokens of ≥20 chars
  { re: /\b(sk|pk|api)[_-]?[A-Za-z0-9]{20,}\b/g, replacement: "[REDACTED_KEY]" },
  // Email addresses
  { re: /[\w.+-]+@[\w-]+\.[\w.]+/g, replacement: "[EMAIL]" },
];

/**
 * Apply basic PII redaction to a plain string.
 * Replaces email addresses, API keys, and JWT tokens with safe placeholders.
 * Safe to call on already-clean text — no-op when no patterns match.
 */
export function redactPii(text: string): string {
  let result = text;
  for (const { re, replacement } of PII_PATTERNS) {
    result = result.replace(re, replacement);
  }
  return result;
}

// ── Record building ──────────────────────────────────────────────────────────

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

  // Strict binary encoding: 'success' → 1, any failure → 0, no-build → 0 with status=unknown.
  // unknown samples should not enter DPO pairs; they're logged for weak-label pools only.
  const objectiveStatus: "pass" | "fail" | "unknown" =
    buildResult === null ? "unknown" : buildResult.status === "success" ? "pass" : "fail";
  const objectiveScore: 0 | 1 = objectiveStatus === "pass" ? 1 : 0;

  const record: RolloutWireRecord = {
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
    objective_status: objectiveStatus,
    rank: 0,
    total_score: objectiveScore,
    provenance: {
      source: "bscode",
      session_id: sessionId,
      job_id: jobId,
      exported_at_ms: Date.now(),
    },
  };
  validateRolloutRecord(record);
  return record;
}

const VALID_OBJECTIVE_STATUSES = new Set(["pass", "fail", "unknown"]);

/**
 * Validate a RolloutWireRecord against rollout-wire/v1 schema invariants at runtime.
 * Throws an Error with a descriptive message if any invariant is violated.
 * Call this before persisting or exporting any record to prevent malformed
 * training data from entering the pipeline.
 */
export function validateRolloutRecord(record: RolloutWireRecord): void {
  if (record.schema_version !== "rollout-wire/v1") {
    throw new Error(
      `[rollout-export] invalid record: schema_version must be "rollout-wire/v1", got "${record.schema_version}"`,
    );
  }

  if (!record.rollout_id || typeof record.rollout_id !== "string") {
    throw new Error("[rollout-export] invalid record: rollout_id must be a non-empty string");
  }

  if (!record.task || typeof record.task !== "string") {
    throw new Error("[rollout-export] invalid record: task must be a non-empty string");
  }

  if (!record.session_id || typeof record.session_id !== "string") {
    throw new Error("[rollout-export] invalid record: session_id must be a non-empty string");
  }

  if (record.objective_score !== 0 && record.objective_score !== 1) {
    throw new Error(
      `[rollout-export] invalid record: objective_score must be 0 or 1, got ${record.objective_score}`,
    );
  }

  if (!VALID_OBJECTIVE_STATUSES.has(record.objective_status)) {
    throw new Error(
      `[rollout-export] invalid record: objective_status must be "pass", "fail", or "unknown", got "${record.objective_status}"`,
    );
  }

  if (record.build_result === null && record.objective_status !== "unknown") {
    throw new Error(
      `[rollout-export] invalid record: build_result is null but objective_status is "${record.objective_status}" (expected "unknown")`,
    );
  }

  if (record.build_result !== null && record.objective_status === "unknown") {
    throw new Error(
      `[rollout-export] invalid record: objective_status is "unknown" but build_result is not null`,
    );
  }

  if (record.build_result?.status === "success") {
    if (record.objective_status !== "pass") {
      throw new Error(
        `[rollout-export] invalid record: build_result.status is "success" but objective_status is "${record.objective_status}" (expected "pass")`,
      );
    }
    if (record.objective_score !== 1) {
      throw new Error(
        `[rollout-export] invalid record: build_result.status is "success" but objective_score is ${record.objective_score} (expected 1)`,
      );
    }
  }
}

/**
 * Serialize rollout records to JSONL string.
 * Applies PII redaction to `final_answer` before serialization to prevent
 * email addresses, API keys, and JWT tokens from entering training data.
 */
export function toJsonl(records: RolloutWireRecord[]): string {
  return (
    records
      .map((r) => JSON.stringify({ ...r, final_answer: redactPii(r.final_answer) }))
      .join("\n") + "\n"
  );
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

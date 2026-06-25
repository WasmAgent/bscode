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
  aep_evidence?: AEPEvidenceBundle;
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
  schema_version: "rollout-wire/v1";
  evidence_source: "client_reported";
  redaction_version: "bscode/pii-redact/v1";
}

// AEP evidence bundle embedded in rollout export (lightweight, no external dep needed)
export interface AEPCapabilityDecision {
  capability: string;
  subject: string;
  resource: string;
  decision: "allow" | "deny" | "ask_user" | "dry_run";
  reason_code?: string;
}

export interface AEPEvidenceBundle {
  schema_version: "aep/v0.1";
  run_id: string;
  model_id: string;
  capability_decisions: AEPCapabilityDecision[];
  tool_invocation_count: number;
  state_changing_actions: string[];
  verifier_passed: boolean | null;
  created_at_ms: number;
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
      schema_version: "rollout-wire/v1",
      evidence_source: "client_reported",
      redaction_version: "bscode/pii-redact/v1",
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
 * Apply PII redaction to all text-bearing fields of a record before export.
 * Covers: task, final_answer, tool_call_sequence (JSON-serialized), build_result.stderr.
 */
function redactRecord(r: RolloutWireRecord): RolloutWireRecord {
  const redactedToolCalls = r.tool_call_sequence.map((ev) => {
    const raw = JSON.stringify(ev.data);
    const redacted = redactPii(raw);
    return raw === redacted ? ev : { ...ev, data: JSON.parse(redacted) as Record<string, unknown> };
  });

  const redactedBuildResult =
    r.build_result?.stderr
      ? { ...r.build_result, stderr: redactPii(r.build_result.stderr) }
      : r.build_result;

  return {
    ...r,
    task: redactPii(r.task),
    final_answer: redactPii(r.final_answer),
    tool_call_sequence: redactedToolCalls,
    build_result: redactedBuildResult,
  };
}

/**
 * Serialize rollout records to JSONL string.
 * Applies PII redaction to all text-bearing fields before serialization.
 */
export function toJsonl(records: RolloutWireRecord[]): string {
  return records.map((r) => JSON.stringify(redactRecord(r))).join("\n") + "\n";
}

// ── Evidence manifest ────────────────────────────────────────────────────────

export interface EvidenceManifest {
  schema_version: "evidence-manifest/v1";
  session_id: string;
  exported_at_ms: number;
  n_records: number;
  /** SHA-256 of the full redacted JSONL payload — stable identifier for the batch. */
  content_hash: string;
  objective_score_summary: {
    n_pass: number;
    n_fail: number;
    n_unknown: number;
  };
  evidence_source: "client_reported";
  redaction_version: "bscode/pii-redact/v1";
}

/**
 * Build an EvidenceManifest for a set of rollout records.
 * The `content_hash` is computed over the redacted JSONL so downstream consumers
 * can verify the batch integrity without re-running redaction.
 */
export async function buildEvidenceManifest(
  records: RolloutWireRecord[],
  sessionId: string,
): Promise<EvidenceManifest> {
  const jsonl = toJsonl(records);
  const encoded = new TextEncoder().encode(jsonl);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  const contentHash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return {
    schema_version: "evidence-manifest/v1",
    session_id: sessionId,
    exported_at_ms: Date.now(),
    n_records: records.length,
    content_hash: contentHash,
    objective_score_summary: {
      n_pass: records.filter((r) => r.objective_status === "pass").length,
      n_fail: records.filter((r) => r.objective_status === "fail").length,
      n_unknown: records.filter((r) => r.objective_status === "unknown").length,
    },
    evidence_source: "client_reported",
    redaction_version: "bscode/pii-redact/v1",
  };
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

// ── AEP evidence ─────────────────────────────────────────────────────────────

// Tools that mutate external state (conservative list)
const STATE_CHANGING_TOOLS = new Set([
  "bash", "run_bash", "execute_bash", "write_file", "create_file",
  "delete_file", "git_commit", "git_push", "npm_publish",
]);

/**
 * Build a minimal AEP evidence bundle from a completed rollout record.
 * Used by trace-pipeline to validate evidence completeness before training export.
 */
export function buildAEPEvidence(opts: {
  run_id: string;
  model_id: string;
  tool_calls: ToolCallEvent[];
  objective_passed: boolean | null;
}): AEPEvidenceBundle {
  const stateChanging = opts.tool_calls
    .filter(e => e.event === "tool_call")
    .map(e => (e.data as Record<string, unknown>).name as string)
    .filter(Boolean)
    .filter(name => STATE_CHANGING_TOOLS.has(name));

  return {
    schema_version: "aep/v0.1",
    run_id: opts.run_id,
    model_id: opts.model_id,
    capability_decisions: [],
    tool_invocation_count: opts.tool_calls.filter(e => e.event === "tool_call").length,
    state_changing_actions: stateChanging,
    verifier_passed: opts.objective_passed,
    created_at_ms: Date.now(),
  };
}

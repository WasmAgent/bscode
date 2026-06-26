/**
 * Trajectory export — converts a completed bscode job into a rollout-wire JSONL
 * record consumable by wasmagent-js RolloutRanker and evomerge datafactory.
 *
 * Wire format mirrors wasmagent-js packages/core/src/ranking/schemas/rollout-wire.schema.json
 */

import {
  type ActionEvidence,
  AEPEmitter,
  type AEPRecord,
  type BudgetLedger,
  type CapabilityDecision,
  createLocalSignerFromSeed,
  type InputRef,
  type OutputRef,
  type VerifierResult,
} from "@wasmagent/aep";
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
  /** Full AEPRecord (aep/v0.2 with Ed25519 signature) — replaces the legacy AEPEvidenceBundle. */
  aep_evidence?: AEPRecord;
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

// ── AEP re-exports (for consumers that import from trajectoryExport) ──────────

// Re-export AEPRecord type and related types so consumers don't need to add
// @wasmagent/aep as a direct dependency for type usage.
export type {
  ActionEvidence,
  AEPRecord,
  BudgetLedger,
  CapabilityDecision,
  InputRef,
  OutputRef,
  VerifierResult,
} from "@wasmagent/aep";

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
      `[rollout-export] invalid record: schema_version must be "rollout-wire/v1", got "${record.schema_version}"`
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
      `[rollout-export] invalid record: objective_score must be 0 or 1, got ${record.objective_score}`
    );
  }

  if (!VALID_OBJECTIVE_STATUSES.has(record.objective_status)) {
    throw new Error(
      `[rollout-export] invalid record: objective_status must be "pass", "fail", or "unknown", got "${record.objective_status}"`
    );
  }

  if (record.build_result === null && record.objective_status !== "unknown") {
    throw new Error(
      `[rollout-export] invalid record: build_result is null but objective_status is "${record.objective_status}" (expected "unknown")`
    );
  }

  if (record.build_result !== null && record.objective_status === "unknown") {
    throw new Error(
      `[rollout-export] invalid record: objective_status is "unknown" but build_result is not null`
    );
  }

  if (record.build_result?.status === "success") {
    if (record.objective_status !== "pass") {
      throw new Error(
        `[rollout-export] invalid record: build_result.status is "success" but objective_status is "${record.objective_status}" (expected "pass")`
      );
    }
    if (record.objective_score !== 1) {
      throw new Error(
        `[rollout-export] invalid record: build_result.status is "success" but objective_score is ${record.objective_score} (expected 1)`
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

  const redactedBuildResult = r.build_result?.stderr
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
  sessionId: string
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
  sessionsKv: KvStore | undefined
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

// Tools that mutate external state (conservative list)
const STATE_CHANGING_TOOLS = new Set([
  "bash",
  "run_bash",
  "execute_bash",
  "write_file",
  "create_file",
  "delete_file",
  "git_commit",
  "git_push",
  "npm_publish",
]);

/** Default AEP seed used in development / CI. Override with BSCODE_AEP_SEED env var. */
const DEV_AEP_SEED = "0".repeat(64);

/**
 * Resolve the AEP signing seed from the environment.
 *
 * - Test / CI: set BSCODE_AEP_SEED to a 64-char hex string.
 * - Production: TODO — replace with a KMS adapter implementing AEPSigner
 *   (e.g. AwsKmsSigner wrapping AWS KMS Ed25519 key) and pass it to AEPEmitter.
 *   The KMS adapter must satisfy the `AEPSigner` interface from @wasmagent/aep.
 */
function resolveSeedHex(): string {
  const seed = (typeof process !== "undefined" ? process.env.BSCODE_AEP_SEED : undefined) ?? "";
  if (/^[0-9a-fA-F]{64}$/.test(seed)) return seed;
  // Fall back to deterministic dev seed — never use in production.
  return DEV_AEP_SEED;
}

/**
 * Build a complete AEPRecord (aep/v0.2) from a completed rollout's tool-call trace.
 *
 * Populates:
 *   - actions[]             — one ActionEvidence per tool_call event
 *   - verifier_results[]    — from explicit verifier_results param or auto-derived from objective_passed
 *   - capability_decisions[] — from explicit param or auto-derived from state-changing tool calls
 *   - budget_ledger         — from explicit param or auto-derived from tool call count
 *   - input_refs[]          — from explicit param
 *   - output_refs[]         — from explicit param
 *
 * Signs the record with an Ed25519 key derived from BSCODE_AEP_SEED env var (test/CI).
 * TODO (production): replace the LocalEd25519Signer with a KMS adapter.
 */
export async function buildAEPEvidence(opts: {
  run_id: string;
  model_id: string;
  tool_calls: ToolCallEvent[];
  objective_passed: boolean | null;
  /** Optional: explicit actions to add (if not provided, auto-derived from tool_calls). */
  actions?: ActionEvidence[];
  /** Optional: explicit verifier results. */
  verifier_results?: VerifierResult[];
  /** Optional: explicit capability decisions (if not provided, auto-derived from tool_calls). */
  capability_decisions?: CapabilityDecision[];
  /** Optional: explicit budget ledger. */
  budget_ledger?: BudgetLedger;
  /** Optional: input artifact references. */
  input_refs?: InputRef[];
  /** Optional: output artifact references. */
  output_refs?: OutputRef[];
  /** Optional: model provider string (e.g. "anthropic", "openai"). */
  model_provider?: string;
  /** Optional: creation timestamp override (ms) — useful for deterministic tests. */
  created_at_ms?: number;
}): Promise<AEPRecord> {
  const seedHex = resolveSeedHex();
  const signer = createLocalSignerFromSeed(seedHex, "bscode-aep-key-v1");

  const emitter = new AEPEmitter({
    run_id: opts.run_id,
    model_id: opts.model_id,
    model_provider: opts.model_provider,
    signer,
  });

  // ── Actions ──────────────────────────────────────────────────────────────
  if (opts.actions && opts.actions.length > 0) {
    for (const action of opts.actions) {
      emitter.addAction(action);
    }
  } else {
    // Auto-derive actions from tool_call events.
    const toolCallEvents = opts.tool_calls.filter((e) => e.event === "tool_call");
    for (let i = 0; i < toolCallEvents.length; i++) {
      const ev = toolCallEvents[i];
      const toolName = (ev.data as Record<string, unknown>).name as string | undefined;
      const isStateChanging = Boolean(toolName && STATE_CHANGING_TOOLS.has(toolName));
      emitter.addAction({
        action_id: `action-${i}`,
        tool_name: toolName ?? "unknown",
        state_changing: isStateChanging,
        evidence_refs: [],
        timestamp_ms: ev.timestamp_ms ?? Date.now() + i,
      });
    }
  }

  // ── Verifier results ─────────────────────────────────────────────────────
  if (opts.verifier_results && opts.verifier_results.length > 0) {
    for (const vr of opts.verifier_results) {
      emitter.addVerifierResult(vr);
    }
  } else if (opts.objective_passed !== null) {
    // Auto-derive from objective_passed flag.
    emitter.addVerifierResult({
      verifier_id: "bscode-build-verifier",
      passed: opts.objective_passed,
      score: opts.objective_passed ? 1 : 0,
      claim_ids: [],
    });
  }

  // ── Capability decisions ─────────────────────────────────────────────────
  if (opts.capability_decisions && opts.capability_decisions.length > 0) {
    for (const cd of opts.capability_decisions) {
      emitter.addCapabilityDecision(cd);
    }
  } else {
    // Auto-derive: mark each unique state-changing tool as "allow" (they ran).
    const stateChangingNames = new Set(
      opts.tool_calls
        .filter((e) => e.event === "tool_call")
        .map((e) => (e.data as Record<string, unknown>).name as string)
        .filter(Boolean)
        .filter((name) => STATE_CHANGING_TOOLS.has(name))
    );
    for (const name of stateChangingNames) {
      emitter.addCapabilityDecision({
        capability: name,
        subject: "bscode-agent",
        resource: "bscode-workspace",
        decision: "allow",
        reason_code: "auto_derived",
      });
    }
  }

  // ── Budget ledger ────────────────────────────────────────────────────────
  if (opts.budget_ledger) {
    emitter.setBudgetLedger(opts.budget_ledger);
  } else {
    const toolCount = opts.tool_calls.filter((e) => e.event === "tool_call").length;
    emitter.setBudgetLedger({
      tool_budget: { spent: toolCount },
    });
  }

  // ── Input / output refs ──────────────────────────────────────────────────
  if (opts.input_refs) {
    for (const ref of opts.input_refs) {
      emitter.addInputRef(ref);
    }
  }
  if (opts.output_refs) {
    for (const ref of opts.output_refs) {
      emitter.addOutputRef(ref);
    }
  }

  return emitter.emit(opts.created_at_ms);
}

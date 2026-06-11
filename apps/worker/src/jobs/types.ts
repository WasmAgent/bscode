/**
 * B1 — Job queue types.
 *
 * A "job" is one independently-running agent invocation. The queue accepts
 * many at once and runs them in parallel up to a concurrency cap; each job
 * has its own traceId and emits events into a per-job ring buffer that
 * web clients can poll or stream.
 *
 * The queue intentionally does NOT mandate what the job DOES — it accepts
 * a runner closure. This keeps queue.ts decoupled from the agent
 * machinery; tests can supply trivial runners and integration code wires
 * up real ToolCallingAgent / multiAgentRun calls.
 */

import type { AgentEvent } from "@agentkit-js/core";

/**
 * Lifecycle states a job moves through, monotonically:
 *   queued   → running → done | failed | aborted
 *
 * `queued` covers both "waiting for a concurrency slot" and "spawned but
 * the runner hasn't yielded its first event yet" — UI cannot tell those
 * apart and does not need to.
 */
export type JobStatus = "queued" | "running" | "done" | "failed" | "aborted";

/** Submitted by the client; passed verbatim to the runner. */
export interface JobSpec {
  /**
   * Human-readable task text. Used as the job's title in the dashboard;
   * also passed straight to the agent runner.
   */
  task: string;
  /** Optional session id — used for KV partitioning of build results, files. */
  sessionId?: string;
  /**
   * Free-form payload the runner needs (modelId, agentMode, framework,
   * conversationHistory, etc.). Stored as-is so the queue can stay agnostic
   * about the run shape.
   */
  payload?: Record<string, unknown>;
}

/** Snapshot of a job exposed to clients. */
export interface JobRecord {
  id: string;
  spec: JobSpec;
  status: JobStatus;
  /** Total events accumulated; eventTail is a bounded ring buffer view. */
  eventCount: number;
  /** Last few events (default: tail of size 100). */
  eventTail: AgentEvent[];
  /** Final answer text once status="done"; absent before that. */
  finalAnswer?: string;
  /** Error message if status="failed" or "aborted". */
  error?: string;
  /** Server-side milliseconds since epoch when the job entered each state. */
  submittedAtMs: number;
  startedAtMs?: number;
  finishedAtMs?: number;
}

/**
 * Adapter the queue invokes to actually run the job. The runner produces an
 * AsyncIterable<AgentEvent>; the queue takes care of buffering and lifecycle
 * accounting. The signal is forwarded so abort() can cancel cooperatively.
 *
 * `ctx.jobId` is supplied by the queue at start time so a runner that needs
 * its own id (e.g. for derived session ids in C2 isolation) does not have
 * to be told twice.
 */
export type JobRunner = (
  spec: JobSpec,
  signal: AbortSignal,
  ctx: { jobId: string }
) => AsyncIterable<AgentEvent>;

/** Queue-wide configuration knobs. */
export interface JobQueueOptions {
  /** Max concurrent running jobs (default: 4). */
  concurrency?: number;
  /** How many trailing events each job retains in memory (default: 100). */
  eventTailSize?: number;
  /** When set, mirrors finished-job records under `job:<id>` for cross-recycle reads. */
  durableKv?: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
    list(opts: { prefix: string }): Promise<{ keys: { name: string }[] }>;
    delete?(key: string): Promise<void>;
  };
  /**
   * `ctx.waitUntil` from the Cloudflare Workers runtime, when available.
   * Without it the worker may be reaped before the background job
   * finishes — fine for Node dev, problematic on real Workers. The queue
   * tolerates either case.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
  /**
   * C2 — Async hook invoked once per job, immediately before its runner
   * starts producing events. Hosts use this to provision per-job state
   * (workspace snapshots, branch forks, telemetry counters). Throwing
   * inside the hook fails the job with the error message — the runner
   * never runs. Called with the assigned `jobId` and the original `spec`
   * so the host can derive a stable session id.
   */
  onBeforeStart?: (jobId: string, spec: JobSpec) => Promise<void> | void;
  /**
   * C2 — Async hook invoked once per job, AFTER the runner has finished
   * (regardless of status). Hosts use this for cleanup or to record final
   * diff metadata. Errors here are logged and discarded — they never
   * mutate the job's terminal state. Receives the final job record.
   */
  onAfterFinish?: (record: JobRecord) => Promise<void> | void;
}

/**
 * B1 — Job queue.
 *
 * In-memory durable-runtime-aware queue for parallel agent invocations.
 * The dashboard pattern Mastra/Codex cloud/Antigravity 2.0 popularised:
 * submit N independent tasks, watch them run side-by-side, collect N
 * results without single-conversation linearisation.
 *
 * Design notes:
 *   - Jobs are stored as a Map<id, JobState>; each JobState owns a ring
 *     buffer of recent AgentEvents and an AbortController.
 *   - A FIFO `pending[]` plus a `running` counter implement concurrency.
 *     We do NOT use a third-party queue lib — the bscode worker has to
 *     run on the CF edge where every dependency is taxed by bundle size.
 *   - On terminal states we mirror a JobRecord into KV (when bound) so
 *     a /jobs/:id read after a worker recycle still returns the answer.
 *     Live event tails are NOT persisted — they're transient by design.
 *   - The runner's AbortSignal is the cooperative cancellation channel.
 *     We don't yank an iterator mid-yield; abort() flips the signal and
 *     trusts the runner to wind itself down.
 */

import type { AgentEvent } from "@wasmagent/core";
import type { JobQueueOptions, JobRecord, JobRunner, JobSpec, JobStatus } from "./types.js";

interface JobState {
  id: string;
  spec: JobSpec;
  runner: JobRunner;
  status: JobStatus;
  /** AbortController whose signal is forwarded to the runner. */
  controller: AbortController;
  /** All-events counter; eventTail.length tops out at eventTailSize. */
  eventCount: number;
  eventTail: AgentEvent[];
  finalAnswer?: string;
  error?: string;
  submittedAtMs: number;
  /** Monotonic submission order — used as a tiebreaker when timestamps collide. */
  seq: number;
  startedAtMs?: number;
  finishedAtMs?: number;
  /** H1 — accumulated cost + tokens from `model_done` events. */
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  hasModelStats: boolean;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TAIL_SIZE = 100;
const DURABLE_TTL_SECONDS = 60 * 60 * 24; // 24h

let monotonicCounter = 0;
function nextJobId(): string {
  monotonicCounter += 1;
  return `job-${Date.now().toString(36)}-${monotonicCounter.toString(36)}`;
}

export class JobQueue {
  readonly #jobs = new Map<string, JobState>();
  readonly #pending: string[] = [];
  readonly #concurrency: number;
  readonly #tailSize: number;
  readonly #durableKv: JobQueueOptions["durableKv"];
  readonly #waitUntil: JobQueueOptions["waitUntil"];
  readonly #onBeforeStart: JobQueueOptions["onBeforeStart"];
  readonly #onAfterFinish: JobQueueOptions["onAfterFinish"];
  #running = 0;

  constructor(opts: JobQueueOptions = {}) {
    this.#concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
    // Tail size only needs to be ≥1; users explicitly opting into 3 should
    // get 3, not a silent floor at 10.
    this.#tailSize = Math.max(1, opts.eventTailSize ?? DEFAULT_TAIL_SIZE);
    this.#durableKv = opts.durableKv;
    this.#waitUntil = opts.waitUntil;
    this.#onBeforeStart = opts.onBeforeStart;
    this.#onAfterFinish = opts.onAfterFinish;
  }

  /**
   * Submit a job. Returns the assigned id immediately; the runner is
   * scheduled and starts as soon as a concurrency slot frees up. Errors
   * thrown synchronously from the runner factory propagate; errors thrown
   * from the iterator surface as `status: "failed"` with `error: msg`.
   */
  submit(spec: JobSpec, runner: JobRunner): string {
    const id = nextJobId();
    const state: JobState = {
      id,
      spec,
      runner,
      status: "queued",
      controller: new AbortController(),
      eventCount: 0,
      eventTail: [],
      submittedAtMs: Date.now(),
      seq: monotonicCounter,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      hasModelStats: false,
    };
    this.#jobs.set(id, state);
    this.#pending.push(id);
    this.#drainSoon();
    return id;
  }

  /**
   * Abort a running or queued job. Returns true if the job existed and was
   * not already in a terminal state; false otherwise. The runner is signalled
   * via AbortSignal — terminal status is not set until the runner returns,
   * so the dashboard sees `status: "running"` until the abort propagates.
   */
  abort(id: string): boolean {
    const state = this.#jobs.get(id);
    if (!state) return false;
    if (state.status === "done" || state.status === "failed" || state.status === "aborted") {
      return false;
    }
    state.controller.abort();
    // For queued (not yet started) jobs flip status now — the runner will
    // never run, so there's no later transition.
    if (state.status === "queued") {
      const idx = this.#pending.indexOf(id);
      if (idx >= 0) this.#pending.splice(idx, 1);
      state.status = "aborted";
      state.finishedAtMs = Date.now();
      state.error = "aborted before start";
      void this.#mirrorIfTerminal(state);
    }
    return true;
  }

  /**
   * Snapshot a single job. Falls through to the durable KV mirror on miss
   * so a worker recycle does not erase finished-job results.
   */
  async get(id: string): Promise<JobRecord | null> {
    const state = this.#jobs.get(id);
    if (state) return this.#snapshot(state);
    if (this.#durableKv) {
      try {
        const raw = await this.#durableKv.get(`job:${id}`);
        if (raw) return JSON.parse(raw) as JobRecord;
      } catch (err) {
        console.warn("[jobs] durable read failed:", err);
      }
    }
    return null;
  }

  /**
   * List jobs with optional filters. Live in-memory snapshot — historic jobs
   * that have been swept from KV will not appear. Sorted newest-first.
   */
  list(filter?: { status?: JobStatus; sessionId?: string }): JobRecord[] {
    const out: JobRecord[] = [];
    for (const state of this.#jobs.values()) {
      if (filter?.status && state.status !== filter.status) continue;
      if (filter?.sessionId && state.spec.sessionId !== filter.sessionId) continue;
      out.push(this.#snapshot(state));
    }
    return out.sort((a, b) => {
      const dt = b.submittedAtMs - a.submittedAtMs;
      if (dt !== 0) return dt;
      // Same millisecond → fall back to monotonic submission order. We
      // don't expose seq in JobRecord, so look it up from internal state.
      const sa = this.#jobs.get(a.id)?.seq ?? 0;
      const sb = this.#jobs.get(b.id)?.seq ?? 0;
      return sb - sa;
    });
  }

  /** Number of currently-running jobs, useful for /jobs?stats=true. */
  get runningCount(): number {
    return this.#running;
  }

  /** Number of queued (not yet running) jobs. */
  get pendingCount(): number {
    return this.#pending.length;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Schedule pending jobs while concurrency permits. We deliberately don't
   * block the caller — `submit` returns synchronously, and the actual run
   * happens via a background promise (optionally pinned with waitUntil).
   */
  #drainSoon(): void {
    while (this.#running < this.#concurrency && this.#pending.length > 0) {
      const id = this.#pending.shift();
      if (id === undefined) break;
      const state = this.#jobs.get(id);
      if (state?.status !== "queued") continue;
      this.#running += 1;
      const promise = this.#runOne(state);
      if (this.#waitUntil) this.#waitUntil(promise);
    }
  }

  async #runOne(state: JobState): Promise<void> {
    const runner = state.runner;
    state.status = "running";
    state.startedAtMs = Date.now();
    try {
      // C2 — let the host provision per-job state (snapshot, fork, audit).
      // A throw here fails the job before any events are emitted.
      if (this.#onBeforeStart) {
        await this.#onBeforeStart(state.id, state.spec);
      }
      const iterable = runner(state.spec, state.controller.signal, { jobId: state.id });
      for await (const ev of iterable) {
        if (state.controller.signal.aborted) {
          // Capture any answer we managed to receive before the abort.
          if (ev.event === "final_answer" && state.finalAnswer === undefined) {
            const answer = (ev.data as { answer?: unknown })?.answer;
            if (typeof answer === "string") state.finalAnswer = answer;
          }
          break;
        }
        state.eventCount += 1;
        state.eventTail.push(ev);
        if (state.eventTail.length > this.#tailSize) state.eventTail.shift();
        if (ev.event === "final_answer") {
          const answer = (ev.data as { answer?: unknown })?.answer;
          if (typeof answer === "string") state.finalAnswer = answer;
        }
        // H1 — accumulate per-call cost + tokens. The worker's model adapters
        // emit { estimatedUsd, inputTokens, outputTokens, cacheReadTokens }
        // on every model call; we sum here so the dashboard does not have
        // to walk the eventTail.
        if (ev.event === "model_done") {
          const d = ev.data as
            | {
                estimatedUsd?: number;
                inputTokens?: number;
                outputTokens?: number;
                cacheReadTokens?: number;
              }
            | undefined;
          if (d) {
            if (typeof d.estimatedUsd === "number") state.costUsd += d.estimatedUsd;
            if (typeof d.inputTokens === "number") state.inputTokens += d.inputTokens;
            if (typeof d.outputTokens === "number") state.outputTokens += d.outputTokens;
            if (typeof d.cacheReadTokens === "number") state.cacheReadTokens += d.cacheReadTokens;
            state.hasModelStats = true;
          }
        }
      }
      if (state.controller.signal.aborted) {
        state.status = "aborted";
        state.error ??= "aborted by client";
      } else {
        state.status = "done";
      }
    } catch (err) {
      state.status = "failed";
      state.error = err instanceof Error ? err.message : String(err);
    } finally {
      state.finishedAtMs = Date.now();
      this.#running = Math.max(0, this.#running - 1);
      await this.#mirrorIfTerminal(state);
      // C2 — host cleanup hook. Errors are logged but do NOT mutate the
      // already-decided terminal state.
      if (this.#onAfterFinish) {
        try {
          await this.#onAfterFinish(this.#snapshot(state));
        } catch (err) {
          console.warn("[jobs] onAfterFinish hook threw:", err);
        }
      }
      this.#drainSoon();
    }
  }

  async #mirrorIfTerminal(state: JobState): Promise<void> {
    if (!this.#durableKv) return;
    if (state.status !== "done" && state.status !== "failed" && state.status !== "aborted") return;
    try {
      await this.#durableKv.put(`job:${state.id}`, JSON.stringify(this.#snapshot(state)), {
        expirationTtl: DURABLE_TTL_SECONDS,
      });
    } catch (err) {
      console.warn("[jobs] durable mirror failed:", err);
    }
  }

  #snapshot(state: JobState): JobRecord {
    return {
      id: state.id,
      spec: state.spec,
      status: state.status,
      eventCount: state.eventCount,
      // Copy the tail so external mutation can't corrupt internal state.
      eventTail: [...state.eventTail],
      ...(state.finalAnswer !== undefined ? { finalAnswer: state.finalAnswer } : {}),
      ...(state.error !== undefined ? { error: state.error } : {}),
      submittedAtMs: state.submittedAtMs,
      ...(state.startedAtMs !== undefined ? { startedAtMs: state.startedAtMs } : {}),
      ...(state.finishedAtMs !== undefined ? { finishedAtMs: state.finishedAtMs } : {}),
      // H1 — only emit cost/token fields when at least one model_done
      // event contributed; otherwise stay clean (a job that ran a trivial
      // tool-only flow shouldn't surface "0.0000 USD" in the dashboard).
      ...(state.hasModelStats
        ? {
            costUsd: state.costUsd,
            inputTokens: state.inputTokens,
            outputTokens: state.outputTokens,
            cacheReadTokens: state.cacheReadTokens,
          }
        : {}),
    };
  }

  /** Test seam — wipe internal state. NOT exported via the package barrel. */
  _resetForTests(): void {
    for (const state of this.#jobs.values()) {
      try {
        state.controller.abort();
      } catch {
        /* ignore */
      }
    }
    this.#jobs.clear();
    this.#pending.length = 0;
    this.#running = 0;
  }
}

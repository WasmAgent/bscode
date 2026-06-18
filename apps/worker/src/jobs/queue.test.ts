/**
 * B1 — Job queue tests.
 *
 * Verifies the contract documented in queue.ts:
 *   - submit returns an id; runner runs in the background
 *   - concurrency cap is honoured (over-N jobs queue rather than spawn)
 *   - get/list reflect status transitions
 *   - abort cancels via AbortSignal; queued-aborts don't run at all
 *   - final_answer is captured into the snapshot
 *   - durable KV mirror lets terminal-state get() survive recycle
 *   - failed runner surfaces error string instead of throwing out
 */

import type { AgentEvent } from "@wasmagent/core";
import { afterEach, describe, expect, it } from "vitest";
import { MemKvStore } from "../platform.js";
import { JobQueue } from "./queue.js";

let q: JobQueue;
afterEach(() => {
  q?._resetForTests();
});

/** Helper — yields a final_answer after `delayMs` unless aborted. */
function delayedAnswerRunner(answer: string, delayMs = 5) {
  return async function* (_spec: { task: string }, signal: AbortSignal): AsyncIterable<AgentEvent> {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, delayMs);
      signal.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new Error("aborted-during-delay"));
      });
    });
    yield {
      traceId: "t",
      parentTraceId: null,
      channel: "text",
      event: "final_answer",
      data: { answer },
      timestampMs: Date.now(),
    } as AgentEvent;
  };
}

/** Helper — wait until predicate is true or `timeoutMs` elapses. */
async function waitFor<T>(
  fn: () => T | Promise<T>,
  predicate: (v: T) => boolean,
  timeoutMs = 1000
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (predicate(v)) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe("JobQueue", () => {
  it("submit returns an id and runs a job to completion", async () => {
    q = new JobQueue();
    const id = q.submit({ task: "hello" }, delayedAnswerRunner("world"));
    expect(id).toMatch(/^job-/);
    const final = await waitFor(
      () => q.get(id),
      (rec) => rec?.status === "done"
    );
    expect(final?.finalAnswer).toBe("world");
    expect(final?.eventCount).toBe(1);
  });

  it("respects the concurrency cap", async () => {
    q = new JobQueue({ concurrency: 2 });
    // Spawn 5 long-ish jobs, then sample the running counter mid-flight.
    const ids = Array.from({ length: 5 }).map((_, i) =>
      q.submit({ task: `t${i}` }, delayedAnswerRunner(`a${i}`, 30))
    );
    // Give the scheduler a microtask tick to start running.
    await new Promise((r) => setTimeout(r, 5));
    expect(q.runningCount).toBeLessThanOrEqual(2);
    expect(q.pendingCount).toBeGreaterThanOrEqual(3);
    // Wait for everyone to finish.
    for (const id of ids) {
      await waitFor(
        () => q.get(id),
        (r) => r?.status === "done"
      );
    }
    expect(q.runningCount).toBe(0);
    expect(q.pendingCount).toBe(0);
  });

  it("list returns newest-first and supports status filter", async () => {
    q = new JobQueue();
    const a = q.submit({ task: "first" }, delayedAnswerRunner("A"));
    const b = q.submit({ task: "second" }, delayedAnswerRunner("B"));
    await waitFor(
      () => q.get(a),
      (r) => r?.status === "done"
    );
    await waitFor(
      () => q.get(b),
      (r) => r?.status === "done"
    );
    const all = q.list();
    expect(all.length).toBe(2);
    expect(all[0]?.id).toBe(b); // newest first
    const done = q.list({ status: "done" });
    expect(done.length).toBe(2);
    const queued = q.list({ status: "queued" });
    expect(queued.length).toBe(0);
  });

  it("session filter partitions list output", async () => {
    q = new JobQueue();
    const a = q.submit({ task: "x", sessionId: "alice" }, delayedAnswerRunner("A"));
    const b = q.submit({ task: "y", sessionId: "bob" }, delayedAnswerRunner("B"));
    await waitFor(
      () => q.get(a),
      (r) => r?.status === "done"
    );
    await waitFor(
      () => q.get(b),
      (r) => r?.status === "done"
    );
    expect(q.list({ sessionId: "alice" }).map((r) => r.id)).toEqual([a]);
    expect(q.list({ sessionId: "bob" }).map((r) => r.id)).toEqual([b]);
  });

  it("abort during delay marks the job aborted", async () => {
    q = new JobQueue();
    const id = q.submit({ task: "long" }, delayedAnswerRunner("late", 200));
    // Let runner start, then abort.
    await new Promise((r) => setTimeout(r, 5));
    expect(q.abort(id)).toBe(true);
    const rec = await waitFor(
      () => q.get(id),
      (r) => r?.status === "aborted" || r?.status === "failed"
    );
    // The runner throws on abort during delay; that surfaces as "failed" with
    // the abort message, OR the queue beats it to the abort-flag check; either
    // is acceptable so long as the job ended without a final answer.
    expect(["aborted", "failed"]).toContain(rec?.status);
    expect(rec?.finalAnswer).toBeUndefined();
  });

  it("abort on a queued (not yet started) job marks it aborted without running", async () => {
    q = new JobQueue({ concurrency: 1 });
    let ran = 0;
    const blockerRunner = async function* (
      _s: { task: string },
      sig: AbortSignal
    ): AsyncIterable<AgentEvent> {
      ran += 1;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 60);
        sig.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        });
      });
    };
    const blocker = q.submit({ task: "block" }, blockerRunner);
    const queued = q.submit({ task: "queued" }, blockerRunner);
    // Give blocker a tick to start; queued is still pending.
    await new Promise((r) => setTimeout(r, 5));
    expect(q.abort(queued)).toBe(true);
    const rec = await q.get(queued);
    expect(rec?.status).toBe("aborted");
    // Queued runner must NOT have executed.
    // (`ran` should equal 1 — only the blocker.)
    expect(ran).toBe(1);
    // Cleanup so the blocker exits.
    q.abort(blocker);
  });

  it("abort returns false on unknown or already-terminal jobs", async () => {
    q = new JobQueue();
    expect(q.abort("nope")).toBe(false);
    const id = q.submit({ task: "x" }, delayedAnswerRunner("a"));
    await waitFor(
      () => q.get(id),
      (r) => r?.status === "done"
    );
    expect(q.abort(id)).toBe(false);
  });

  it("runner that throws surfaces as failed with the error message", async () => {
    q = new JobQueue();
    const id = q.submit({ task: "boom" }, async function* () {
      // Unreachable yield keeps the generator return type valid; the throw
      // is what the test exercises.
      if (false as boolean) yield {} as AgentEvent;
      throw new Error("kaboom");
    });
    const rec = await waitFor(
      () => q.get(id),
      (r) => r?.status === "failed"
    );
    expect(rec?.error).toContain("kaboom");
    expect(rec?.finalAnswer).toBeUndefined();
  });

  it("event tail is bounded by eventTailSize", async () => {
    q = new JobQueue({ eventTailSize: 3 });
    const id = q.submit({ task: "spam" }, async function* () {
      for (let i = 0; i < 10; i++) {
        yield {
          traceId: "t",
          parentTraceId: null,
          channel: "text",
          event: "step_start",
          data: { step: i },
          timestampMs: Date.now(),
        } as unknown as AgentEvent;
      }
      yield {
        traceId: "t",
        parentTraceId: null,
        channel: "text",
        event: "final_answer",
        data: { answer: "ok" },
        timestampMs: Date.now(),
      } as AgentEvent;
    });
    const rec = await waitFor(
      () => q.get(id),
      (r) => r?.status === "done"
    );
    expect(rec?.eventCount).toBe(11);
    expect(rec?.eventTail.length).toBe(3); // tail bounded
    // Last event in tail should be the final_answer.
    expect(rec?.eventTail[2]?.event).toBe("final_answer");
  });

  it("durable KV mirror serves get() after the in-memory state is wiped", async () => {
    const kv = new MemKvStore();
    q = new JobQueue({ durableKv: kv });
    const id = q.submit({ task: "persisted" }, delayedAnswerRunner("kept"));
    await waitFor(
      () => q.get(id),
      (r) => r?.status === "done"
    );

    // Simulate worker recycle: fresh queue instance bound to the same KV.
    q._resetForTests();
    const q2 = new JobQueue({ durableKv: kv });
    const restored = await q2.get(id);
    expect(restored?.status).toBe("done");
    expect(restored?.finalAnswer).toBe("kept");
    q2._resetForTests();
  });
});

import type { AgentEvent } from "@wasmagent/core";
import type { Hono } from "hono";
import { getBuildResult } from "../build-results.js";
import type { JobQueue, JobSpec } from "../jobs/index.js";
import {
  deriveJobSessionId,
  diffSessions,
  discardJobSession,
  type MergeStrategy,
  mergeSessions,
} from "../jobs/jobBranches.js";
import type { AppConfig, KvStore } from "../platform.js";

export interface JobRoutesDeps {
  jobQueue: JobQueue;
  buildResultNonces: Map<string, { sessionId: string; jobId: string; expiresAt: number }>;
  sessionIdOf(
    c: { req: { header: (n: string) => string | undefined } },
    config?: AppConfig
  ): string;
  resolveFilesKv(sessionId: string | undefined, config: AppConfig): KvStore | undefined;
  /** The Hono app instance — used by the job runner to self-fetch /run */
  app: Hono;
}

export function mountJobRoutes(app: Hono, config: AppConfig, deps: JobRoutesDeps): void {
  const { jobQueue, buildResultNonces, sessionIdOf, app: appRef } = deps;

  // ── B1 — Job runner factory ──────────────────────────────────────────────
  // The runner self-fetches /run with the supplied body. That keeps the
  // queued path bit-identical to the synchronous /run path; if /run grows
  // a feature, jobs inherit it for free.
  //
  // C2 — At run time we override `X-Session-Id` to the derived job session
  // id. The parent's snapshot already lives there (onBeforeStart did the
  // copy), so the agent reads/writes against an isolated KV view; the
  // parent session is untouched until the user calls /jobs/:id/merge.
  function jobRunnerFor(body: Record<string, unknown>, headers: Record<string, string>) {
    return async function* (
      spec: JobSpec,
      signal: AbortSignal,
      ctx: { jobId: string }
    ): AsyncIterable<AgentEvent> {
      const parent = spec.sessionId ?? "default";
      const derived = deriveJobSessionId(parent, ctx.jobId);
      const runHeaders = { ...headers, "X-Session-Id": derived };
      const res = await appRef.fetch(
        new Request("http://localhost/run", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...runHeaders },
          body: JSON.stringify(body),
          signal,
        })
      );
      if (!res.body) {
        throw new Error(`/run returned no body (status ${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // Process complete SSE messages — separated by blank lines.
        let nl = buf.indexOf("\n\n");
        while (nl !== -1) {
          const chunk = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6);
            if (payload === "[DONE]") return;
            try {
              yield JSON.parse(payload) as AgentEvent;
            } catch {
              // Malformed SSE chunk — skip.
            }
          }
          nl = buf.indexOf("\n\n");
        }
      }
    };
  }

  /**
   * POST /jobs — submit one or many tasks for background execution.
   *
   * Body shapes accepted:
   *   { task: "...", agentMode: "tool", ... }                     // single
   *   { jobs: [{ task: "...", ... }, { task: "...", ... }, ...] } // batch
   *
   * Returns `{ jobIds: string[] }` immediately. The agent payload is the same
   * shape /run accepts, minus `task` which is required at the top level of
   * each job.
   */
  app.post("/jobs", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const sessionHeader = c.req.header("X-Session-Id");
    const auth = c.req.header("Authorization");
    const headers: Record<string, string> = {};
    if (sessionHeader) headers["X-Session-Id"] = sessionHeader;
    if (auth) headers.Authorization = auth;

    // Normalise to a list of {task, payload} jobs.
    let entries: Array<Record<string, unknown>>;
    if (Array.isArray((body as { jobs?: unknown }).jobs)) {
      entries = (body as { jobs: unknown[] }).jobs as Array<Record<string, unknown>>;
    } else if (typeof (body as { task?: unknown }).task === "string") {
      entries = [body];
    } else {
      return c.json({ error: "Body must contain `task` or a `jobs[]` array" }, 400);
    }
    if (entries.length === 0) return c.json({ error: "jobs[] is empty" }, 400);
    if (entries.length > 20) return c.json({ error: "too many jobs (max 20 per request)" }, 400);

    const jobIds: string[] = [];
    for (const entry of entries) {
      const task = entry.task;
      if (typeof task !== "string" || !task.length) {
        return c.json({ error: "each job must have a non-empty `task`" }, 400);
      }
      const spec: JobSpec = {
        task,
        ...(sessionHeader ? { sessionId: sessionHeader } : {}),
        payload: entry,
      };
      const id = jobQueue.submit(spec, jobRunnerFor(entry, headers));
      jobIds.push(id);
    }
    return c.json({ jobIds });
  });

  /** GET /jobs — list jobs, optionally filtered by status / sessionId. */
  app.get("/jobs", (c) => {
    const status = c.req.query("status") as
      | "queued"
      | "running"
      | "done"
      | "failed"
      | "aborted"
      | undefined;
    const sessionId = c.req.query("sessionId") ?? c.req.header("X-Session-Id");
    const filter: { status?: typeof status; sessionId?: string } = {};
    if (status) filter.status = status;
    if (sessionId) filter.sessionId = sessionId;
    const jobs = jobQueue.list(filter);
    return c.json({
      jobs,
      stats: {
        running: jobQueue.runningCount,
        pending: jobQueue.pendingCount,
        total: jobs.length,
      },
    });
  });

  /** GET /jobs/:id — full snapshot of one job (with eventTail). */
  app.get("/jobs/:id", async (c) => {
    const job = await jobQueue.get(c.req.param("id"));
    if (!job) return c.json({ error: "job not found" }, 404);
    return c.json(job);
  });

  /** GET /jobs/:id/build-nonce — issue a one-time nonce for POST /build-result. */
  app.get("/jobs/:id/build-nonce", async (c) => {
    const jobId = c.req.param("id");
    const job = await jobQueue.get(jobId);
    if (!job) return c.json({ error: "job not found" }, 404);
    const sessionId = sessionIdOf(c, config);
    const nonce = crypto.randomUUID();
    buildResultNonces.set(nonce, { sessionId, jobId, expiresAt: Date.now() + 15 * 60 * 1000 });
    return c.json({ nonce });
  });

  /** DELETE /jobs/:id — cooperative abort. Returns whether the abort took. */
  app.delete("/jobs/:id", (c) => {
    const ok = jobQueue.abort(c.req.param("id"));
    if (!ok) return c.json({ error: "job not found or already finished" }, 404);
    return c.json({ ok: true });
  });

  // ── C2 — per-job diff / merge ────────────────────────────────────────────
  // After a parallel job finishes, the user reviews its file changes and
  // decides whether to merge them into the parent session. /diff is read-only.
  // /merge applies the changes; conflicts (concurrent base edits since the
  // job started) are returned structured rather than auto-resolved.

  /** GET /jobs/:id/diff — list the file changes the job made vs its snapshot. */
  app.get("/jobs/:id/diff", async (c) => {
    if (!config.filesKv) return c.json({ error: "files KV not bound" }, 503);
    const job = await jobQueue.get(c.req.param("id"));
    if (!job) return c.json({ error: "job not found" }, 404);
    const parent = job.spec.sessionId ?? "default";
    const derived = deriveJobSessionId(parent, job.id);
    const changes = await diffSessions(config.filesKv, derived);
    return c.json({ jobId: job.id, parentSessionId: parent, derivedSessionId: derived, changes });
  });

  /**
   * POST /jobs/:id/merge — apply the job's changes to its parent session.
   * Body: { strategy?: "fail-on-conflict" | "ours" | "theirs", discard?: boolean }
   *
   * On a clean merge with `discard: true` (default true) the derived session
   * and snapshot are removed. On conflicts the derived session is kept so
   * the user can re-run the merge with a different strategy.
   */
  app.post("/jobs/:id/merge", async (c) => {
    if (!config.filesKv) return c.json({ error: "files KV not bound" }, 503);
    const job = await jobQueue.get(c.req.param("id"));
    if (!job) return c.json({ error: "job not found" }, 404);
    if (job.status !== "done") {
      return c.json({ error: `cannot merge a job in state ${job.status}` }, 409);
    }
    let body: { strategy?: MergeStrategy; discard?: boolean } = {};
    try {
      body = await c.req.json();
    } catch {
      // empty body is fine — caller wants defaults.
    }
    const strategy = body.strategy ?? "fail-on-conflict";
    const discard = body.discard ?? true;
    const parent = job.spec.sessionId ?? "default";
    const derived = deriveJobSessionId(parent, job.id);
    const result = await mergeSessions(config.filesKv, parent, derived, strategy);
    const cleanedUp = discard && result.conflicts.length === 0;
    if (cleanedUp) {
      await discardJobSession(config.filesKv, derived).catch(() => undefined);
    }
    return c.json({
      jobId: job.id,
      strategy,
      applied: result.applied,
      conflicts: result.conflicts,
      cleanedUp,
    });
  });

  /**
   * DELETE /jobs/:id/branch — discard the per-job derived session without
   * merging. Use after the user decides the job's output is not worth
   * keeping; frees KV space.
   */
  app.delete("/jobs/:id/branch", async (c) => {
    if (!config.filesKv) return c.json({ error: "files KV not bound" }, 503);
    const job = await jobQueue.get(c.req.param("id"));
    if (!job) return c.json({ error: "job not found" }, 404);
    const parent = job.spec.sessionId ?? "default";
    const derived = deriveJobSessionId(parent, job.id);
    await discardJobSession(config.filesKv, derived).catch(() => undefined);
    return c.json({ ok: true, derivedSessionId: derived });
  });

  // ── RLAIF trajectory export ───────────────────────────────────────────────

  /**
   * GET /jobs/:id/rollout-export — export a completed job as a rollout-wire
   * JSONL record for RLAIF training (wasmagent-js RolloutRanker / evomerge).
   *
   * Query params:
   *   format=jsonl  (default) — application/x-ndjson response
   *   format=json             — single JSON object response
   */
  app.get("/jobs/:id/rollout-export", async (c) => {
    const jobId = c.req.param("id");
    const job = await jobQueue.get(jobId);
    if (!job) return c.json({ error: "job not found" }, 404);

    const { buildRolloutRecord, toJsonl, buildEvidenceManifest } = await import("../trajectoryExport.js");
    const sessionId = job.spec.sessionId ?? sessionIdOf(c, config);
    const derived = deriveJobSessionId(sessionId, jobId);
    const buildResult = await getBuildResult(derived, config.buildResultsKv);

    const record = buildRolloutRecord({
      jobId,
      jobSpec: job.spec,
      sessionId,
      branchIndex: 0,
      buildResult: buildResult.status !== "unknown" ? buildResult : null,
      finalAnswer: job.finalAnswer ?? "",
    });

    const format = c.req.query("format") ?? "jsonl";
    if (format === "json") return c.json(record);
    const manifest = await buildEvidenceManifest([record], sessionId);
    return new Response(toJsonl([record]), {
      headers: {
        "Content-Type": "application/x-ndjson",
        "X-Evidence-Manifest": JSON.stringify(manifest),
        "X-Evidence-Content-Hash": manifest.content_hash,
      },
    });
  });

  /**
   * GET /rollouts/export — export all completed/failed jobs for the current
   * session as JSONL (for evomerge datafactory ingestion).
   *
   * Query params:
   *   sessionId       — override the X-Session-Id header for the filter
   *   include_unknown — when "false" (default), records with
   *                     objective_status === "unknown" (no build triggered)
   *                     are excluded to prevent no-build samples from
   *                     entering training data.
   */
  app.get("/rollouts/export", async (c) => {
    const sessionId = sessionIdOf(c, config);
    const { buildRolloutRecord, toJsonl, buildEvidenceManifest } = await import("../trajectoryExport.js");

    // Default: filter out unknown-status records so no-build samples stay out
    // of the training data pipeline. Pass include_unknown=true to opt in.
    const includeUnknown = c.req.query("include_unknown") === "true";

    const jobs = jobQueue.list({ sessionId });
    const terminal = jobs.filter((j) => j.status === "done" || j.status === "failed");

    const allRecords = await Promise.all(
      terminal.map(async (j, i) => {
        const derived = deriveJobSessionId(sessionId, j.id);
        const buildSnap = await getBuildResult(derived, config.buildResultsKv);
        return buildRolloutRecord({
          jobId: j.id,
          jobSpec: j.spec,
          sessionId,
          branchIndex: i,
          buildResult: buildSnap.status !== "unknown" ? buildSnap : null,
          finalAnswer: j.finalAnswer ?? "",
        });
      })
    );

    const records = includeUnknown
      ? allRecords
      : allRecords.filter((r) => r.objective_status !== "unknown");

    const manifest = await buildEvidenceManifest(records, sessionId);

    return new Response(toJsonl(records), {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Content-Disposition": `attachment; filename="rollouts-${sessionId.slice(0, 8)}.jsonl"`,
        "X-Evidence-Manifest": JSON.stringify(manifest),
        "X-Evidence-Content-Hash": manifest.content_hash,
      },
    });
  });
}

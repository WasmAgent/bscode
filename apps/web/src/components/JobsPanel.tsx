"use client";

/**
 * B1 — Jobs panel.
 *
 * Multi-run dashboard: submit several tasks at once, watch them progress
 * in parallel, abort or inspect any one of them. Backed by /jobs on the
 * worker; polls every 2s while at least one job is queued/running.
 *
 * This component is intentionally self-contained — it does NOT plug into
 * the existing AgentPanel's conversation model. The single-conversation UI
 * stays as it was; this is the "Codex cloud / Antigravity 2.0" form factor
 * sitting beside it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getWorkerUrl } from "@/lib/workerUrl";

interface JobRecord {
  id: string;
  spec: { task: string; sessionId?: string };
  status: "queued" | "running" | "done" | "failed" | "aborted";
  eventCount: number;
  finalAnswer?: string;
  error?: string;
  submittedAtMs: number;
  startedAtMs?: number;
  finishedAtMs?: number;
}

interface ListResponse {
  jobs: JobRecord[];
  stats: { running: number; pending: number; total: number };
}

const POLL_INTERVAL_MS = 2000;

function statusColor(s: JobRecord["status"]): string {
  switch (s) {
    case "queued":   return "#888";
    case "running":  return "#0a7";
    case "done":     return "#08c";
    case "failed":   return "#c33";
    case "aborted":  return "#a60";
  }
}

function relTime(ms?: number): string {
  if (!ms) return "—";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

export interface JobsPanelProps {
  /** Worker base URL. Defaults to NEXT_PUBLIC_WORKER_URL. */
  workerUrl?: string;
  /** Session id used for both submission and listing filter. */
  sessionId: string;
}

export function JobsPanel({ workerUrl, sessionId }: JobsPanelProps) {
  const base = workerUrl ?? getWorkerUrl();
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [stats, setStats] = useState<ListResponse["stats"]>({
    running: 0, pending: 0, total: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch(
        `${base}/jobs?sessionId=${encodeURIComponent(sessionId)}`,
        { headers: { "X-Session-Id": sessionId } },
      );
      if (!res.ok) throw new Error(`GET /jobs ${res.status}`);
      const body = (await res.json()) as ListResponse;
      setJobs(body.jobs);
      setStats(body.stats);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [base, sessionId]);

  // Poll while any job is non-terminal; idle otherwise.
  useEffect(() => {
    fetchJobs();
    const hasLive = jobs.some((j) => j.status === "queued" || j.status === "running");
    if (!hasLive) return;
    pollTimerRef.current = setTimeout(fetchJobs, POLL_INTERVAL_MS);
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [fetchJobs, jobs]);

  const submit = useCallback(async () => {
    const lines = tasks
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (lines.length === 0) {
      setError("Enter at least one task (one per line).");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`${base}/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Session-Id": sessionId },
        body: JSON.stringify({
          jobs: lines.map((task) => ({ task, agentMode: "tool" })),
        }),
      });
      const body = (await res.json()) as { jobIds?: string[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? `POST /jobs ${res.status}`);
      setTasks("");
      await fetchJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [base, sessionId, tasks, fetchJobs]);

  const abort = useCallback(
    async (id: string) => {
      try {
        await fetch(`${base}/jobs/${id}`, {
          method: "DELETE",
          headers: { "X-Session-Id": sessionId },
        });
        await fetchJobs();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [base, sessionId, fetchJobs],
  );

  const sortedJobs = useMemo(() => jobs, [jobs]);

  return (
    <div data-testid="jobs-panel" style={{ fontFamily: "ui-sans-serif, system-ui" }}>
      <div style={{ marginBottom: 8, display: "flex", gap: 12, alignItems: "baseline" }}>
        <strong>Jobs</strong>
        <span style={{ color: "#666", fontSize: 12 }}>
          {stats.running} running · {stats.pending} queued · {stats.total} total
        </span>
        <button type="button" onClick={fetchJobs} style={{ marginLeft: "auto" }}>
          Refresh
        </button>
      </div>

      {error ? (
        <div role="alert" style={{ color: "#c33", fontSize: 12, marginBottom: 8 }}>
          {error}
        </div>
      ) : null}

      <textarea
        aria-label="Tasks (one per line)"
        placeholder="One task per line — submit batch"
        rows={3}
        value={tasks}
        onChange={(e) => setTasks(e.target.value)}
        disabled={submitting}
        style={{ width: "100%", fontFamily: "ui-monospace, monospace", fontSize: 12 }}
      />
      <div style={{ marginTop: 6, marginBottom: 12 }}>
        <button type="button" onClick={submit} disabled={submitting}>
          {submitting ? "Submitting…" : "Submit batch"}
        </button>
      </div>

      <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
            <th>Status</th>
            <th>Task</th>
            <th>Events</th>
            <th>Submitted</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {sortedJobs.length === 0 ? (
            <tr>
              <td colSpan={5} style={{ color: "#888", padding: 8 }}>
                No jobs yet — paste tasks above and click Submit.
              </td>
            </tr>
          ) : (
            sortedJobs.map((j) => (
              <tr key={j.id} style={{ borderBottom: "1px solid #f0f0f0" }}>
                <td>
                  <span
                    style={{
                      display: "inline-block",
                      padding: "1px 6px",
                      borderRadius: 8,
                      background: statusColor(j.status),
                      color: "white",
                      fontWeight: 600,
                      fontSize: 11,
                    }}
                  >
                    {j.status}
                  </span>
                </td>
                <td title={j.spec.task} style={{ maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {j.spec.task}
                </td>
                <td>{j.eventCount}</td>
                <td title={new Date(j.submittedAtMs).toISOString()}>{relTime(j.submittedAtMs)} ago</td>
                <td>
                  {j.status === "queued" || j.status === "running" ? (
                    <button type="button" onClick={() => abort(j.id)}>Abort</button>
                  ) : null}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export default JobsPanel;

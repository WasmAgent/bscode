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
import { theme } from "@/lib/theme";

// Reusable inline-style fragments so the JSX below stays scannable.
const inputStyle = {
  width: "100%",
  fontFamily: "ui-monospace, monospace",
  fontSize: 12,
  background: theme.bgInput,
  color: theme.textSecondary,
  border: `1px solid ${theme.borderDefault}`,
  borderRadius: 4,
  padding: "6px 8px",
  resize: "vertical" as const,
} as const;
const buttonStyle = {
  background: theme.bgPanel,
  color: theme.textSecondary,
  border: `1px solid ${theme.borderDefault}`,
  borderRadius: 4,
  padding: "4px 10px",
  cursor: "pointer",
  fontSize: 12,
} as const;

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
  // All values must reach ≥ 4.5:1 contrast against white badge text — Lighthouse
  // failed on the lighter shades (#888, #0a7, #08c) at the 11px badge size.
  switch (s) {
    case "queued":
      return "#5a5a5a"; // gray
    case "running":
      return "#0e7c4c"; // forest green
    case "done":
      return "#1a5fb4"; // deep blue
    case "failed":
      return "#a32525"; // brick red
    case "aborted":
      return "#8a4500"; // dark orange
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
    running: 0,
    pending: 0,
    total: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirror of the latest jobs[] for the polling driver, kept up to date by
  // the same setter that updates state. Reading state from the timer
  // callback would race with React's render queue; reading from a ref is
  // synchronous and consistent.
  const liveCountRef = useRef(0);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch(`${base}/jobs?sessionId=${encodeURIComponent(sessionId)}`, {
        headers: { "X-Session-Id": sessionId },
      });
      if (!res.ok) throw new Error(`GET /jobs ${res.status}`);
      const body = (await res.json()) as ListResponse;
      setJobs(body.jobs);
      setStats(body.stats);
      // Update the polling driver's live-count without touching reactive deps.
      liveCountRef.current = body.jobs.filter(
        (j) => j.status === "queued" || j.status === "running"
      ).length;
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [base, sessionId]);

  // Self-rescheduling poller. The effect runs ONCE per (base, sessionId) —
  // it does NOT depend on `jobs`, so a state update from the previous poll
  // cannot retrigger the effect (the cause of the runaway-request bug
  // surfaced by Chrome DevTools E2E: 34k requests in 60s when the deps were
  // `[fetchJobs, jobs]`). The timer fires every POLL_INTERVAL_MS while at
  // least one job is non-terminal, then naturally idles when all are done.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await fetchJobs();
      if (cancelled) return;
      // Reschedule only while there is something to watch. The next user
      // submit will call fetchJobs() directly, which sets liveCountRef and
      // (via the submit() handler below) restarts the loop.
      if (liveCountRef.current > 0) {
        pollTimerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
      }
    };
    tick();
    return () => {
      cancelled = true;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [fetchJobs]);

  // Restart the poller after a manual fetch (submit / abort / refresh) when
  // there are live jobs to watch. Idempotent — clears any previous timer
  // first so we never end up with two concurrent ticks.
  const ensurePolling = useCallback(() => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    if (liveCountRef.current > 0) {
      pollTimerRef.current = setTimeout(async () => {
        await fetchJobs();
        if (liveCountRef.current > 0) ensurePolling();
      }, POLL_INTERVAL_MS);
    }
  }, [fetchJobs]);

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
      // Newly-submitted jobs are queued/running — kick the poller back on.
      ensurePolling();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [base, sessionId, tasks, fetchJobs, ensurePolling]);

  const abort = useCallback(
    async (id: string) => {
      try {
        await fetch(`${base}/jobs/${id}`, {
          method: "DELETE",
          headers: { "X-Session-Id": sessionId },
        });
        await fetchJobs();
        ensurePolling();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [base, sessionId, fetchJobs, ensurePolling]
  );

  const sortedJobs = useMemo(() => jobs, [jobs]);

  return (
    <div data-testid="jobs-panel" style={{ fontFamily: "ui-sans-serif, system-ui" }}>
      <div style={{ marginBottom: 8, display: "flex", gap: 12, alignItems: "baseline" }}>
        <strong style={{ color: theme.textPrimary }}>Jobs</strong>
        <span style={{ color: theme.textMuted, fontSize: 12 }}>
          {stats.running} running · {stats.pending} queued · {stats.total} total
        </span>
        <button
          type="button"
          onClick={fetchJobs}
          style={{ ...buttonStyle, marginLeft: "auto" }}
        >
          Refresh
        </button>
      </div>

      {error ? (
        <div role="alert" style={{ color: theme.statusError, fontSize: 12, marginBottom: 8 }}>
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
        style={inputStyle}
      />
      <div style={{ marginTop: 6, marginBottom: 12 }}>
        <button type="button" onClick={submit} disabled={submitting} style={buttonStyle}>
          {submitting ? "Submitting…" : "Submit batch"}
        </button>
      </div>

      <table
        style={{
          width: "100%",
          fontSize: 12,
          borderCollapse: "collapse",
          color: theme.textSecondary,
        }}
      >
        <thead>
          <tr style={{ textAlign: "left", borderBottom: `1px solid ${theme.borderDefault}` }}>
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
              <td colSpan={5} style={{ color: theme.textDim, padding: 8 }}>
                No jobs yet — paste tasks above and click Submit.
              </td>
            </tr>
          ) : (
            sortedJobs.map((j) => (
              <tr key={j.id} style={{ borderBottom: `1px solid ${theme.borderDefault}` }}>
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
                <td
                  title={j.spec.task}
                  style={{
                    maxWidth: 300,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {j.spec.task}
                </td>
                <td>{j.eventCount}</td>
                <td title={new Date(j.submittedAtMs).toISOString()}>
                  {relTime(j.submittedAtMs)} ago
                </td>
                <td>
                  {j.status === "queued" || j.status === "running" ? (
                    <button type="button" onClick={() => abort(j.id)} style={buttonStyle}>
                      Abort
                    </button>
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

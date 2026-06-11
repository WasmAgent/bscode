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
import { theme } from "@/lib/theme";
import { getWorkerUrl } from "@/lib/workerUrl";

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

interface JobEvent {
  channel: string;
  event: string;
  data?: Record<string, unknown>;
  timestampMs: number;
}

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
  /** Present on GET /jobs/:id, absent on the list endpoint. */
  eventTail?: JobEvent[];
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
  /** Set of job ids whose detail panel is currently expanded. */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  /** id → fetched detail (eventTail). Cached per id; refreshed when reopened. */
  const [details, setDetails] = useState<Record<string, JobRecord>>({});
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Coalesce concurrent list fetches. Rapid Refresh clicks (or Refresh racing
   * the poll tick) used to fan out N parallel GETs against the worker; this
   * flag drops anything that arrives while one is in flight.
   */
  const fetchInFlightRef = useRef(false);
  // Mirror of the latest jobs[] for the polling driver, kept up to date by
  // the same setter that updates state. Reading state from the timer
  // callback would race with React's render queue; reading from a ref is
  // synchronous and consistent.
  const liveCountRef = useRef(0);

  const fetchJobs = useCallback(async () => {
    if (fetchInFlightRef.current) return;
    fetchInFlightRef.current = true;
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
    } finally {
      fetchInFlightRef.current = false;
    }
  }, [base, sessionId]);

  /**
   * Fetch GET /jobs/:id (eventTail + finalAnswer). Caches into `details`.
   * Called on row-expand and on poll-tick for any expanded-and-still-live job.
   */
  const fetchDetail = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`${base}/jobs/${encodeURIComponent(id)}`, {
          headers: { "X-Session-Id": sessionId },
        });
        if (!res.ok) throw new Error(`GET /jobs/${id} ${res.status}`);
        const body = (await res.json()) as JobRecord;
        setDetails((prev) => ({ ...prev, [id]: body }));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [base, sessionId]
  );

  const toggleExpanded = useCallback(
    (id: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
          // Fetch on open; cache may be stale for live jobs but the next
          // poll tick will refresh.
          fetchDetail(id);
        }
        return next;
      });
    },
    [fetchDetail]
  );

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

  /** id → eventCount we last fetched detail for. Avoids reading `details`
   * in the effect below (which would force `details` into the dep list and
   * loop on every successful detail fetch). */
  const detailFetchedAtCountRef = useRef<Record<string, number>>({});

  // When the list refreshes, re-fetch detail for any expanded job whose
  // event count or status has changed since we last fetched its detail.
  // This is what makes the expanded panel show fresh events as a live job
  // streams, and what backfills the final_answer once a job lands.
  useEffect(() => {
    if (expanded.size === 0) return;
    const fetchedAt = detailFetchedAtCountRef.current;
    for (const j of jobs) {
      if (!expanded.has(j.id)) continue;
      const last = fetchedAt[j.id];
      if (last === undefined || last !== j.eventCount) {
        fetchedAt[j.id] = j.eventCount;
        fetchDetail(j.id);
      }
    }
  }, [jobs, expanded, fetchDetail]);

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
        <button type="button" onClick={fetchJobs} style={{ ...buttonStyle, marginLeft: "auto" }}>
          Refresh
        </button>
      </div>

      {error ? (
        <div role="alert" style={{ color: theme.statusError, fontSize: 12, marginBottom: 8 }}>
          {error}
        </div>
      ) : null}

      <textarea
        id="jobs-tasks"
        name="tasks"
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
            sortedJobs.map((j) => {
              const isOpen = expanded.has(j.id);
              const detail = details[j.id];
              return (
                <FragmentRow
                  key={j.id}
                  job={j}
                  isOpen={isOpen}
                  detail={detail}
                  onToggle={() => toggleExpanded(j.id)}
                  onAbort={() => abort(j.id)}
                />
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

export default JobsPanel;

// ── Row + detail panel ────────────────────────────────────────────────────
// A row is a real <tr>; opening it inserts a sibling <tr> with a colspan=5
// detail panel showing the final answer (or error) and the most recent
// events. This is what addresses the long-standing UX gap "I clicked done
// but I can't see the answer" — Chrome DevTools E2E surfaced it as soon as
// jobs ran end-to-end.

interface FragmentRowProps {
  job: JobRecord;
  isOpen: boolean;
  detail: JobRecord | undefined;
  onToggle: () => void;
  onAbort: () => void;
}

function FragmentRow({ job, isOpen, detail, onToggle, onAbort }: FragmentRowProps) {
  const isLive = job.status === "queued" || job.status === "running";
  // Keep table semantics intact — `aria-expanded` is only valid on
  // treegrid rows, not on plain `<tr>`. Lighthouse caught this regression
  // (acc 100→96, agentic 100→50). Move the toggle to a real <button> in
  // the Task cell so keyboard + screen-reader users get a proper widget.
  return (
    <>
      <tr
        style={{
          borderBottom: `1px solid ${theme.borderDefault}`,
          background: isOpen ? theme.bgInput : undefined,
        }}
        data-testid={`jobs-row-${job.id}`}
      >
        <td>
          <span
            style={{
              display: "inline-block",
              padding: "1px 6px",
              borderRadius: 8,
              background: statusColor(job.status),
              color: "white",
              fontWeight: 600,
              fontSize: 11,
            }}
          >
            {job.status}
          </span>
        </td>
        <td
          title={job.spec.task}
          style={{
            maxWidth: 300,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={isOpen}
            aria-controls={`jobs-detail-${job.id}`}
            data-testid={`jobs-toggle-${job.id}`}
            style={{
              background: "none",
              border: 0,
              // Padded out to ≥ 24×24 touch target (Lighthouse target-size).
              padding: "4px 6px",
              margin: 0,
              minHeight: 24,
              color: theme.textSecondary,
              fontFamily: "inherit",
              fontSize: "inherit",
              cursor: "pointer",
              textAlign: "left",
              maxWidth: "100%",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            <span style={{ marginRight: 6, color: theme.textMuted }}>{isOpen ? "▼" : "▶"}</span>
            {job.spec.task}
          </button>
        </td>
        <td>{job.eventCount}</td>
        <td title={new Date(job.submittedAtMs).toISOString()}>{relTime(job.submittedAtMs)} ago</td>
        <td>
          {isLive ? (
            <button type="button" onClick={onAbort} style={buttonStyle}>
              Abort
            </button>
          ) : null}
        </td>
      </tr>
      {isOpen ? (
        <tr style={{ background: theme.bgInput }}>
          <td colSpan={5} style={{ padding: "8px 12px" }}>
            <JobDetail job={job} detail={detail} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

interface JobDetailProps {
  job: JobRecord;
  detail: JobRecord | undefined;
}

function JobDetail({ job, detail }: JobDetailProps) {
  const tail = detail?.eventTail ?? [];
  const finalAnswer =
    detail?.finalAnswer ??
    (tail.find((e) => e.event === "final_answer")?.data?.answer as string | undefined);
  const errorMessage =
    detail?.error ?? (tail.find((e) => e.event === "error")?.data?.message as string | undefined);

  return (
    <div
      id={`jobs-detail-${job.id}`}
      data-testid={`jobs-detail-${job.id}`}
      style={{ fontSize: 12, color: theme.textSecondary }}
    >
      <div style={{ marginBottom: 4, color: theme.textMuted }}>
        Job <code>{job.id}</code>
      </div>
      {finalAnswer ? (
        <div style={{ marginBottom: 8 }}>
          <strong style={{ color: theme.textPrimary }}>Answer:</strong>
          <pre
            style={{
              marginTop: 4,
              padding: 8,
              background: theme.bgPanel,
              border: `1px solid ${theme.borderDefault}`,
              borderRadius: 4,
              whiteSpace: "pre-wrap",
              fontSize: 12,
            }}
          >
            {finalAnswer}
          </pre>
        </div>
      ) : null}
      {errorMessage ? (
        <div style={{ marginBottom: 8, color: theme.statusError }}>
          <strong>Error:</strong> {errorMessage}
        </div>
      ) : null}
      <details>
        <summary style={{ cursor: "pointer", color: theme.textMuted }}>
          Events ({tail.length})
        </summary>
        <ul
          style={{ margin: "6px 0 0 0", padding: "0 0 0 16px", maxHeight: 220, overflow: "auto" }}
        >
          {tail.length === 0 ? (
            <li style={{ color: theme.textDim }}>Loading events…</li>
          ) : (
            tail.map((e) => (
              <li
                // Tail is append-only and the worker stamps every event
                // with monotonic (timestampMs, channel, event); good enough
                // as a stable key for a read-only debug list.
                key={`${e.timestampMs}-${e.channel}-${e.event}`}
                style={{ marginBottom: 2 }}
              >
                <code style={{ color: theme.textMuted }}>{e.channel}</code>{" "}
                <strong>{e.event}</strong>
              </li>
            ))
          )}
        </ul>
      </details>
    </div>
  );
}

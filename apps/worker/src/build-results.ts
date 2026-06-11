/**
 * B2 — Build Result Channel
 *
 * Closed-loop validation: when the agent writes code on the worker, it has
 * historically been "blind" — `run_command` is disabled on Cloudflare edge,
 * and the WebContainer build/install only runs in the user's browser. The
 * agent never saw whether the project actually compiled.
 *
 * This module wires the reverse channel:
 *   1. The browser side (useWebContainer) POSTs the latest install/build
 *      outcome (or error) to `/build-result?sessionId=…`.
 *   2. The worker keeps a per-session snapshot — the LATEST result wins.
 *      Older results are overwritten because the agent only cares about
 *      the most recent build state of the workspace.
 *   3. The `read_build_result` tool reads that snapshot, so the agent can
 *      inspect outcomes and self-correct (bolt.new / Replit pattern).
 *
 * Storage strategy (matches the pattern used by sessionFileTrees in app.ts):
 *   - Always cache in-memory for fast `read_build_result` access.
 *   - When a `BUILD_RESULTS` KV is bound, mirror writes there so a worker
 *     recycle does NOT lose the last build state mid-conversation.
 */

import type { KvStore } from "./types.js";

/**
 * Snapshot reported by the browser-side WebContainer wrapper. All fields
 * except `status` and `ranAtMs` are best-effort: a "starting" snapshot
 * may have no exit code yet, and a successful run may have empty stderr.
 */
export interface BuildResultSnapshot {
  /**
   * High-level outcome the agent should branch on.
   *  - "success"     — install AND dev-server start both completed.
   *  - "failed"      — install or build crashed; exitCode/stderr explain why.
   *  - "running"     — process is still going; agent should wait or back off.
   *  - "unknown"     — no result has been reported yet for this session.
   */
  status: "success" | "failed" | "running" | "unknown";
  /**
   * Stage the result is from: install, build, dev-server, test. Helps the
   * agent target the right fix (a failing `npm install` is rarely fixed by
   * editing source files; a failing build usually is).
   */
  stage?: "install" | "build" | "dev" | "test";
  /** Process exit code when the stage finished. */
  exitCode?: number;
  /**
   * Last ~2000 characters of combined stderr/stdout. Capped so a single
   * massive build log can't flood the agent's context window.
   */
  stderr?: string;
  /** Wall time in ms — handy for deciding whether to retry. */
  wallTimeMs?: number;
  /** Server-side timestamp the snapshot was recorded at. */
  ranAtMs: number;
  /** URL of the dev server when stage="dev" + status="success". */
  previewUrl?: string;
  /**
   * C3 — Visual verification snapshot. Populated by the browser-side
   * `runVisualCheck()` helper after the dev server is reachable. The agent
   * reads this through `read_build_result` and self-corrects on
   * console errors / missing-element / wrong-render situations the way it
   * already does for build failures.
   *
   * All fields are optional — visual checks are best-effort, and the
   * channel must keep working even when only the build half reports.
   */
  visual?: VisualCheckSnapshot;
}

/**
 * Visual check report — what the browser observed about the rendered preview.
 * Kept JSON-shaped (no Blob / DataURL bytes inside) so it round-trips through
 * KV cleanly. The agent uses these signals to decide whether to investigate
 * the rendered UI; full image comparison is intentionally out of scope here.
 */
export interface VisualCheckSnapshot {
  /** When the check ran (browser-side wall clock). */
  ranAtMs: number;
  /**
   * Optional screenshot. Stored as a data URL so the channel stays JSON-only
   * — capped to the lower-resolution 256×256 thumbnail browsers can produce
   * cheaply. Absent on environments without canvas access.
   */
  thumbnailDataUrl?: string;
  /** Console errors observed during the check window. Capped to 20 entries. */
  consoleErrors?: Array<{ message: string; source?: string }>;
  /** Uncaught exceptions observed during the check window. Capped to 10. */
  uncaughtErrors?: Array<{ message: string; source?: string }>;
  /**
   * Lightweight DOM probes the host can run. Each probe gets a name and a
   * boolean — the agent decides what to do with "missing" probes.
   * Use sparingly: too many probes turn this into a UI test framework
   * masquerading as a heuristic.
   */
  domProbes?: Array<{ name: string; ok: boolean; detail?: string }>;
  /** True when the page rendered above-the-fold non-empty pixel content. */
  rendersNonEmpty?: boolean;
}

/** Cap on stderr length. Anything longer is tail-truncated by the reader. */
export const MAX_STDERR_CHARS = 2000;

/** TTL for KV-mirrored build results — long enough to survive a worker recycle. */
const BUILD_RESULT_TTL_SECONDS = 60 * 60; // 1h

const memoryStore = new Map<string, BuildResultSnapshot>();

function kvKey(sessionId: string): string {
  return `build-result:${sessionId}`;
}

/**
 * Replace this session's snapshot with the given one. The most recent
 * result always wins — older results are NOT preserved (the agent only
 * cares about the current build state).
 *
 * KV mirroring is best-effort: failure does NOT propagate. This keeps a
 * flaky KV from blocking the browser → worker path; the in-memory copy
 * is enough for the very common "single-region same-worker" run.
 */
export async function putBuildResult(
  sessionId: string,
  snapshot: BuildResultSnapshot,
  kv?: KvStore | undefined
): Promise<void> {
  // Truncate stderr defensively so a runaway log can't blow up later reads.
  const trimmed: BuildResultSnapshot = {
    ...snapshot,
    ...(snapshot.stderr && snapshot.stderr.length > MAX_STDERR_CHARS
      ? { stderr: snapshot.stderr.slice(-MAX_STDERR_CHARS) }
      : {}),
  };
  memoryStore.set(sessionId, trimmed);
  if (kv) {
    try {
      await kv.put(kvKey(sessionId), JSON.stringify(trimmed), {
        expirationTtl: BUILD_RESULT_TTL_SECONDS,
      });
    } catch (err) {
      // Keep the in-memory copy; just log and move on.
      console.warn("[build-results] KV mirror failed:", err);
    }
  }
}

/**
 * Read this session's most recent snapshot.
 *
 *  - In-memory is checked first (free, synchronous-ish).
 *  - KV is consulted only when memory is empty AND a KV was bound: this
 *    handles the "worker recycled mid-conversation" path. When KV returns
 *    a result we re-prime the in-memory cache so subsequent reads stay
 *    fast.
 *  - If both miss, returns the canonical "unknown" sentinel rather than
 *    null, so callers don't have to special-case absence.
 */
export async function getBuildResult(
  sessionId: string,
  kv?: KvStore | undefined
): Promise<BuildResultSnapshot> {
  const cached = memoryStore.get(sessionId);
  if (cached) return cached;
  if (kv) {
    try {
      const raw = await kv.get(kvKey(sessionId));
      if (raw) {
        const snap = JSON.parse(raw) as BuildResultSnapshot;
        memoryStore.set(sessionId, snap);
        return snap;
      }
    } catch (err) {
      console.warn("[build-results] KV read failed:", err);
    }
  }
  return { status: "unknown", ranAtMs: 0 };
}

/**
 * Drop a session's snapshot. Called by /reset and equivalent UI actions
 * so a fresh run never sees a stale build state from a previous task.
 */
export async function clearBuildResult(sessionId: string, kv?: KvStore | undefined): Promise<void> {
  memoryStore.delete(sessionId);
  if (kv?.delete) {
    try {
      await kv.delete(kvKey(sessionId));
    } catch (err) {
      console.warn("[build-results] KV delete failed:", err);
    }
  }
}

/**
 * Test-only — wipes all in-memory state. NOT exported via the package
 * barrel; tests import from this module directly.
 */
export function _resetForTests(): void {
  memoryStore.clear();
}

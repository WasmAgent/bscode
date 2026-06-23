/**
 * Worker URL resolution.
 *
 * Three layers, last wins:
 *   1. Build-time default (`NEXT_PUBLIC_WORKER_URL`, baked by Next at compile).
 *   2. Hard-coded fallback (`http://localhost:8788`).
 *   3. Per-user override in `localStorage["bscode:workerUrl"]` (set via Settings).
 */

const LS_KEY = "bscode:workerUrl";
const BUILD_DEFAULT = process.env.NEXT_PUBLIC_WORKER_URL ?? "http://localhost:8788";

function readUrl(): string {
  if (typeof window === "undefined") return BUILD_DEFAULT;
  try {
    const saved = localStorage.getItem(LS_KEY);
    if (saved && saved.trim().length > 0) return saved.trim().replace(/\/+$/, "");
  } catch {
    // private mode / disabled storage → fall through
  }
  return BUILD_DEFAULT.replace(/\/+$/, "");
}

/**
 * Resolve the worker base URL.
 * Re-reads from localStorage on every call so Settings changes take effect
 * immediately without requiring a page reload.
 * The trailing slash is stripped so callers can write `${WORKER_URL}/run`.
 */
export function getWorkerUrl(): string {
  return readUrl();
}

/** Re-read from localStorage. Kept for backward compatibility. */
export function refreshWorkerUrl(): string {
  return readUrl();
}

/**
 * Worker URL resolution.
 *
 * Three layers, last wins:
 *   1. Build-time default (`NEXT_PUBLIC_WORKER_URL`, baked by Next at compile).
 *   2. Hard-coded fallback (`http://localhost:8788`).
 *   3. Per-user override in `localStorage["bscode:workerUrl"]` (set via Settings).
 *
 * Settings says "Reload to apply" because the URL is read once on module import
 * here. Re-reading on every fetch would let runtime UI changes take effect
 * without a reload, but it would also race with React's render — every call
 * site would be a closure over the URL at call time, not render time. Keeping
 * the read at module init keeps the model simple.
 */

const LS_KEY = "bscode:workerUrl";
const BUILD_DEFAULT = process.env.NEXT_PUBLIC_WORKER_URL ?? "http://localhost:8788";

function readOnce(): string {
  // SSR / pre-hydration safety: localStorage is undefined on the server.
  if (typeof window === "undefined") return BUILD_DEFAULT;
  try {
    const saved = localStorage.getItem(LS_KEY);
    if (saved && saved.trim().length > 0) return saved.trim().replace(/\/+$/, "");
  } catch {
    // private mode / disabled storage → fall through
  }
  return BUILD_DEFAULT.replace(/\/+$/, "");
}

let cached: string | null = null;

/**
 * Resolve the worker base URL.
 *
 * Returns the same value within a session unless `refresh()` is called.
 * The trailing slash is stripped so callers can write `${WORKER_URL}/run`.
 */
export function getWorkerUrl(): string {
  if (cached === null) cached = readOnce();
  return cached;
}

/** Re-read from localStorage. Called by SettingsDrawer after saving. */
export function refreshWorkerUrl(): string {
  cached = readOnce();
  return cached;
}

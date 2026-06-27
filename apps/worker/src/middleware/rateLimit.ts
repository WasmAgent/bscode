/**
 * Per-session rate limit middleware.
 *
 * Reads BSCODE_RATE_LIMIT_RPM (default 60) and BSCODE_RATE_LIMIT_BURST
 * (default 10) from the environment. Uses a KVNamespace (BSCODE_RATE_KV)
 * to count requests. Key format: rate:<session_id>:<minute_bucket>, TTL 120s.
 *
 * When no KV binding is provided, degrades to a no-op (warns once).
 * Only applied to POST /run — health, files, etc. are unaffected.
 */
import type { KvStore } from "../types.js";

export interface RateLimiterOpts {
  /** Requests per minute allowed per session. Default: 60. */
  rpm?: number;
  /** Burst allowance above RPM. Default: 10. */
  burst?: number;
  /**
   * Optional KV store for counting requests across instances.
   * When absent, the middleware degrades to a no-op.
   */
  rateKv?: KvStore;
}

// Warn at most once per process lifetime when KV is absent.
let kvWarned = false;

/**
 * Per-key in-flight chain. Read-then-write against KvStore is not atomic, so
 * two concurrent requests on the same session/bucket can both read the same
 * counter and each write `count + 1`, undercounting by N-1. We serialise the
 * read-then-write region per key by chaining on a shared Promise.
 *
 * Scope: same process only. On Cloudflare Workers each isolate carries its own
 * chain; cross-isolate residual race ≤ N_isolates, which is acceptable because
 * Workers KV is eventually consistent anyway. For Node self-host this fully
 * eliminates the in-process race that was the actual issue (#011).
 */
const inFlight = new Map<string, Promise<unknown>>();

function minuteBucket(): number {
  return Math.floor(Date.now() / 60_000);
}

/**
 * Returns a Hono-compatible middleware function that enforces per-session
 * rate limits on POST /run. All other routes pass through unchanged.
 *
 * Usage in app.ts:
 *   app.post("/run", createRateLimiter({ rateKv: config.rateKv }), handler)
 *
 * Or as a global middleware (filters internally):
 *   app.use("*", createRateLimiter({ rateKv: config.rateKv }))
 */
export function createRateLimiter(opts: RateLimiterOpts = {}) {
  const rpm = opts.rpm ?? Number(process.env.BSCODE_RATE_LIMIT_RPM ?? "60");
  const burst = opts.burst ?? Number(process.env.BSCODE_RATE_LIMIT_BURST ?? "10");
  const limit = rpm + burst;
  const { rateKv } = opts;

  return async (
    // biome-ignore lint/suspicious/noExplicitAny: hono Context type is complex; cast at boundary
    c: any,
    // biome-ignore lint/suspicious/noExplicitAny: hono Next type is complex; cast at boundary
    next: any
  ) => {
    // Only enforce on POST /run — all other routes pass through.
    const method: string = c.req.method;
    const path: string = new URL(c.req.url).pathname;
    if (method !== "POST" || path !== "/run") return next();

    // No KV — degrade to no-op (warn once).
    if (!rateKv) {
      if (!kvWarned) {
        kvWarned = true;
        console.warn("[rateLimit] BSCODE_RATE_KV is not bound — rate limiting is disabled");
      }
      return next();
    }

    // Derive session id from header; fall back to "anon".
    const sessionId: string = c.req.header("X-Session-Id") ?? "anon";
    const bucket = minuteBucket();
    const key = `rate:${sessionId}:${bucket}`;

    // Serialise the read-then-write region per key against concurrent requests
    // in the same process. Without this, two requests can both read `count`
    // and each write `count + 1`, allowing limit + N concurrent calls through.
    const prev = inFlight.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    inFlight.set(key, gate);
    try {
      await prev;

      // Read current counter.
      const raw = await rateKv.get(key);
      const count = raw ? Number(raw) : 0;

      if (count >= limit) {
        const secondsUntilNextMinute = 60 - (Math.floor(Date.now() / 1000) % 60);
        return c.json(
          { error: "rate limit exceeded", retryAfterSeconds: secondsUntilNextMinute },
          429
        );
      }

      // Increment with 120s TTL so the key auto-expires two buckets later.
      await rateKv.put(key, String(count + 1), { expirationTtl: 120 });
    } finally {
      release();
      // Drop the entry only if no later request has chained on top of ours,
      // so the Map does not grow unboundedly under churn.
      if (inFlight.get(key) === gate) inFlight.delete(key);
    }

    return next();
  };
}

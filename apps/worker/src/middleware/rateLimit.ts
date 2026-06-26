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

    return next();
  };
}

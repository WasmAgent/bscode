/**
 * Unit tests for the per-session rate limit middleware.
 *
 * Uses a MemKvStore (same as other test files) to simulate KV backend.
 * No real HTTP server is needed; we call the middleware function directly.
 */
import { describe, expect, it } from "bun:test";
import { MemKvStore } from "../platform.js";
import { createRateLimiter } from "./rateLimit.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal Hono-like context object used to drive the middleware. */
function makeCtx(opts: {
  method?: string;
  path?: string;
  sessionId?: string;
}): { req: any; json: (body: unknown, status: number) => Response; _response?: Response } {
  const { method = "POST", path = "/run", sessionId } = opts;
  const headers: Record<string, string | undefined> = {};
  if (sessionId) headers["x-session-id"] = sessionId;

  const ctx: any = {
    req: {
      method,
      url: `http://localhost${path}`,
      header: (name: string) => headers[name.toLowerCase()],
    },
    json: (body: unknown, status: number) => {
      const res = new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
      ctx._response = res;
      return res;
    },
    _response: undefined,
  };
  return ctx;
}

/** Runs the middleware and returns either its return value or the next() sentinel. */
async function runMiddleware(
  middleware: (c: any, next: any) => Promise<unknown>,
  ctx: ReturnType<typeof makeCtx>
): Promise<{ passed: boolean; response?: Response }> {
  let passed = false;
  const next = async () => {
    passed = true;
  };
  const result = await middleware(ctx, next);
  if (result instanceof Response) return { passed: false, response: result };
  return { passed, response: ctx._response };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createRateLimiter", () => {
  it("passes requests within the burst allowance", async () => {
    const rateKv = new MemKvStore();
    // rpm=2, burst=3 → limit=5 requests per minute
    const middleware = createRateLimiter({ rpm: 2, burst: 3, rateKv });

    for (let i = 0; i < 5; i++) {
      const ctx = makeCtx({ sessionId: "session-burst-test" });
      const { passed } = await runMiddleware(middleware, ctx);
      expect(passed).toBe(true);
    }
  });

  it("returns 429 when requests exceed the limit (rpm + burst)", async () => {
    const rateKv = new MemKvStore();
    // rpm=2, burst=1 → limit=3
    const middleware = createRateLimiter({ rpm: 2, burst: 1, rateKv });
    const sessionId = "session-over-limit";

    // First 3 should pass
    for (let i = 0; i < 3; i++) {
      const ctx = makeCtx({ sessionId });
      const { passed } = await runMiddleware(middleware, ctx);
      expect(passed).toBe(true);
    }

    // 4th request should be rate-limited
    const ctx = makeCtx({ sessionId });
    const { passed, response } = await runMiddleware(middleware, ctx);
    expect(passed).toBe(false);
    expect(response?.status).toBe(429);

    const body = (await response?.json()) as { error: string; retryAfterSeconds: number };
    expect(body.error).toBe("rate limit exceeded");
    expect(typeof body.retryAfterSeconds).toBe("number");
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("does not limit non-POST /run requests (health check etc.)", async () => {
    const rateKv = new MemKvStore();
    // Very tight limit to verify non-/run routes are never blocked
    const middleware = createRateLimiter({ rpm: 0, burst: 0, rateKv });

    const cases = [
      { method: "GET", path: "/health" },
      { method: "GET", path: "/files" },
      { method: "POST", path: "/files" },
      { method: "GET", path: "/run" },
    ];

    for (const tc of cases) {
      const ctx = makeCtx({ ...tc, sessionId: "session-norun" });
      const { passed } = await runMiddleware(middleware, ctx);
      expect(passed).toBe(true);
    }
  });

  it("degrades to no-op when rateKv is not provided (no blocking)", async () => {
    // Intentionally do NOT pass rateKv
    const middleware = createRateLimiter({ rpm: 0, burst: 0 });

    for (let i = 0; i < 20; i++) {
      const ctx = makeCtx({ sessionId: "session-no-kv" });
      const { passed } = await runMiddleware(middleware, ctx);
      expect(passed).toBe(true);
    }
  });

  it("isolates counters per session id", async () => {
    const rateKv = new MemKvStore();
    // rpm=1, burst=0 → limit=1 per session per minute
    const middleware = createRateLimiter({ rpm: 1, burst: 0, rateKv });

    // session-A uses up its 1 slot
    const ctxA1 = makeCtx({ sessionId: "session-A" });
    expect((await runMiddleware(middleware, ctxA1)).passed).toBe(true);

    // session-A is now blocked
    const ctxA2 = makeCtx({ sessionId: "session-A" });
    expect((await runMiddleware(middleware, ctxA2)).passed).toBe(false);

    // session-B is independent — still allowed
    const ctxB = makeCtx({ sessionId: "session-B" });
    expect((await runMiddleware(middleware, ctxB)).passed).toBe(true);
  });
});

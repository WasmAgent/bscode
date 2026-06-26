import type { AppConfig } from "../platform.js";
import { timingSafeEqual } from "../util.js";

/**
 * Returns true when this worker is running in production mode.
 * Production = not in the local-dev fallback mode (allowLocalSessionFallback is the
 * canonical "dev/test" gate used throughout the codebase).
 */
function isProduction(config: AppConfig): boolean {
  return !config.allowLocalSessionFallback;
}

/**
 * Derive a stable principal identifier from the validated bearer token.
 * We use a simple deterministic hash so we never store the raw token.
 *
 * Returns "anonymous" when no token is in use (dev mode / no clientToken).
 */
async function derivePrincipal(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`bscode-principal:${token}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `p:${hex.slice(0, 16)}`;
}

/**
 * P1-7: Session ownership registry backed by sessionsKv.
 *
 * When principalBoundSessions is enabled:
 *  - On first use of a sessionId by a principal, the ownership record is written.
 *  - On subsequent requests, ownership is verified; cross-principal use returns 403.
 *
 * We store ownership records under the key `session-owner:<sessionId>`.
 * Records have a 7-day TTL so orphaned entries are automatically evicted.
 */
async function enforceSessionOwnership(
  config: AppConfig,
  sessionId: string,
  principal: string
): Promise<{ ok: boolean; reason?: string }> {
  const kv = config.sessionsKv;
  if (!kv) return { ok: true }; // no KV → can't enforce ownership, allow through

  const ownerKey = `session-owner:${sessionId}`;
  const existing = await kv.get(ownerKey);

  if (existing === null) {
    // First use — register the ownership record.
    await kv.put(ownerKey, principal, { expirationTtl: 7 * 24 * 60 * 60 });
    return { ok: true };
  }

  if (existing !== principal) {
    return {
      ok: false,
      reason: `Session '${sessionId}' is owned by a different principal`,
    };
  }

  return { ok: true };
}

export function createAuthMiddleware(config: AppConfig) {
  // Production fail-fast: if clientToken is absent in production, log once and
  // reject all non-health-check requests with 401 rather than silently allowing
  // unauthenticated access.
  const productionWithNoToken = isProduction(config) && !config.clientToken;
  if (productionWithNoToken) {
    console.error(
      "ERROR: BSCODE_CLIENT_TOKEN is not set in production — all requests will be rejected"
    );
  }

  return async (
    // biome-ignore lint/suspicious/noExplicitAny: hono Context type is complex; cast at boundary
    c: any,
    // biome-ignore lint/suspicious/noExplicitAny: hono Next type is complex; cast at boundary
    next: any
  ) => {
    const method = c.req.method;
    const path = new URL(c.req.url).pathname;

    // Health check is always public (used by load balancers / uptime monitors).
    if (method === "GET" && path === "/health") return next();

    // Production with no token: reject everything except /health.
    if (productionWithNoToken) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // Dev mode or token is set — proceed with normal auth logic.
    if (!config.clientToken) {
      // P1-7: In dev/no-token mode, still enforce session ownership if enabled.
      if (config.principalBoundSessions) {
        const rawSession = c.req.header("X-Session-Id");
        if (rawSession) {
          const check = await enforceSessionOwnership(config, rawSession, "anonymous");
          if (!check.ok) {
            return c.json({ error: check.reason ?? "Session ownership violation" }, 403);
          }
        }
      }
      return next();
    }

    if (method === "GET" && path === "/capabilities") return next();

    // P0-4: /mcp is only public when publicMcpEnabled is explicitly true.
    // Default is false — protected by clientToken.
    if ((path === "/mcp" || path.startsWith("/mcp/")) && config.publicMcpEnabled === true) {
      return next();
    }

    const auth = c.req.header("Authorization") ?? "";
    if (!timingSafeEqual(auth, `Bearer ${config.clientToken}`)) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // P1-7: Token is valid — enforce session ownership binding.
    if (config.principalBoundSessions) {
      const rawSession = c.req.header("X-Session-Id");
      if (rawSession) {
        const principal = await derivePrincipal(config.clientToken);
        const check = await enforceSessionOwnership(config, rawSession, principal);
        if (!check.ok) {
          return c.json({ error: check.reason ?? "Session ownership violation" }, 403);
        }
      }
    }

    return next();
  };
}

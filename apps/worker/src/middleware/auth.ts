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

  return async (c: any, next: any) => {
    const method = c.req.method;
    const path = new URL(c.req.url).pathname;

    // Health check is always public (used by load balancers / uptime monitors).
    if (method === "GET" && path === "/health") return next();

    // Production with no token: reject everything except /health.
    if (productionWithNoToken) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // Dev mode or token is set — proceed with normal auth logic.
    if (!config.clientToken) return next();

    if (method === "GET" && path === "/capabilities") return next();
    if ((path === "/mcp" || path.startsWith("/mcp/")) && config.publicMcpEnabled) return next();
    const auth = c.req.header("Authorization") ?? "";
    if (!timingSafeEqual(auth, `Bearer ${config.clientToken}`))
      return c.json({ error: "Unauthorized" }, 401);
    return next();
  };
}

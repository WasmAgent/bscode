import type { AppConfig } from "../platform.js";
import { timingSafeEqual } from "../util.js";

export function createAuthMiddleware(config: AppConfig) {
  return async (c: any, next: any) => {
    if (!config.clientToken) return next();
    const method = c.req.method;
    const path = new URL(c.req.url).pathname;
    if (method === "GET" && (path === "/health" || path === "/capabilities")) return next();
    if (path === "/mcp" || path.startsWith("/mcp/")) return next();
    const auth = c.req.header("Authorization") ?? "";
    if (!timingSafeEqual(auth, `Bearer ${config.clientToken}`))
      return c.json({ error: "Unauthorized" }, 401);
    return next();
  };
}

import type { Hono } from "hono";
import {
  type BuildResultSnapshot,
  clearBuildResult,
  getBuildResult,
  putBuildResult,
} from "../build-results.js";
import type { AppConfig } from "../platform.js";

export interface BuildResultRoutesDeps {
  buildResultNonces: Map<string, { sessionId: string; jobId: string; expiresAt: number }>;
  sessionIdOf(
    c: { req: { header: (n: string) => string | undefined } },
    config?: AppConfig
  ): string;
}

export function mountBuildResultRoutes(
  app: Hono,
  config: AppConfig,
  deps: BuildResultRoutesDeps
): void {
  const { buildResultNonces, sessionIdOf } = deps;

  /**
   * POST /build-result — body shape mirrors {@link BuildResultSnapshot},
   * but `ranAtMs` is server-stamped to avoid clock-skew shenanigans.
   * Returns 400 for malformed payloads; KV mirroring is best-effort.
   */
  app.post("/build-result", async (c) => {
    const now = Date.now();
    for (const [k, v] of buildResultNonces) {
      if (v.expiresAt < now) buildResultNonces.delete(k);
    }
    const sessionId = sessionIdOf(c, config);
    let body: Partial<BuildResultSnapshot> & { nonce?: string };
    try {
      body = await c.req.json<Partial<BuildResultSnapshot> & { nonce?: string }>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    // Nonce check is the sole auth gate when clientToken middleware is absent.
    // It must run unconditionally — skipping it when buildResultsKv is unbound
    // would let any caller POST arbitrary build results against a public endpoint.
    // The only intentional bypass is an explicit dev-mode flag.
    if (!config.allowLocalSessionFallback) {
      const nonce = body.nonce;
      const entry = nonce ? buildResultNonces.get(nonce) : undefined;
      if (!entry || entry.expiresAt < Date.now() || entry.sessionId !== sessionId) {
        return c.json({ error: "invalid or missing build-result nonce" }, 401);
      }
      buildResultNonces.delete(nonce!);
    }
    if (typeof body.stderr === "string" && body.stderr.length > 64_000) {
      return c.json({ error: "stderr too large" }, 413);
    }
    if (typeof body.previewUrl === "string" && !/^https?:\/\//i.test(body.previewUrl)) {
      return c.json({ error: "invalid previewUrl" }, 400);
    }
    const status = body.status;
    if (status !== "success" && status !== "failed" && status !== "running") {
      return c.json({ error: "status must be one of: success, failed, running" }, 400);
    }
    const snap: BuildResultSnapshot = {
      status,
      ranAtMs: Date.now(),
      ...(body.stage ? { stage: body.stage } : {}),
      ...(typeof body.exitCode === "number" ? { exitCode: body.exitCode } : {}),
      ...(typeof body.stderr === "string" ? { stderr: body.stderr } : {}),
      ...(typeof body.wallTimeMs === "number" ? { wallTimeMs: body.wallTimeMs } : {}),
      ...(typeof body.previewUrl === "string" ? { previewUrl: body.previewUrl } : {}),
      // C3 — accept the optional visual check payload. The browser sends
      // this once the dev server is reachable; we trust the shape (the
      // VisualCheckSnapshot interface) and forward verbatim.
      ...(body.visual && typeof body.visual === "object" ? { visual: body.visual } : {}),
    };
    await putBuildResult(sessionId, snap, config.buildResultsKv);
    return c.json({ ok: true });
  });

  /** GET /build-result — debug readback; the agent uses the tool, not this. */
  app.get("/build-result", async (c) => {
    const sessionId = sessionIdOf(c, config);
    const snap = await getBuildResult(sessionId, config.buildResultsKv);
    return c.json(snap);
  });

  /** DELETE /build-result — clears stale state on session reset. */
  app.delete("/build-result", async (c) => {
    const sessionId = sessionIdOf(c, config);
    await clearBuildResult(sessionId, config.buildResultsKv);
    return c.json({ ok: true });
  });
}

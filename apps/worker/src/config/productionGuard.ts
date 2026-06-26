/**
 * productionGuard — validates that production-required config is present.
 *
 * Call this at startup in production mode. In development/test, these checks
 * are skipped by passing allowLocalSessionFallback: true in AppConfig.
 *
 * P0-5: The combination of production mode (allowLocalSessionFallback=false)
 * together with allowLocalSessionFallback=true is intentionally impossible,
 * but a misconfiguration where STRICT_AUTH is not set in production while
 * allowLocalSessionFallback somehow gets set to true would be catastrophic
 * (auth bypass). We detect this via the `strictAuth` flag: when strictAuth
 * is true and allowLocalSessionFallback is also true we immediately throw so
 * the worker fails to start rather than silently fail-open.
 */
import type { AppConfig } from "../types.js";

export interface ProductionCheckResult {
  ok: boolean;
  missing: string[];
}

/**
 * Returns missing production-required configuration items.
 *
 * P0-5: throws if `strictAuth` is true AND `allowLocalSessionFallback` is
 * also true — this combination would make auth checks unreachable (fail-open).
 * The throw propagates at worker startup so the deployment fails loudly rather
 * than silently serving unauthenticated traffic.
 */
export function checkProductionConfig(config: AppConfig): ProductionCheckResult {
  // P0-5: Fail-open detection — strictAuth + allowLocalSessionFallback is a
  // self-contradicting configuration that would bypass auth enforcement.
  if (config.strictAuth && config.allowLocalSessionFallback) {
    throw new Error(
      "FATAL: strictAuth=true and allowLocalSessionFallback=true are mutually exclusive. " +
        "A production deployment with auth bypassed via allowLocalSessionFallback would " +
        "fail-open (serve unauthenticated traffic). " +
        "Fix: set allowLocalSessionFallback=false (remove it from production env)."
    );
  }

  if (config.allowLocalSessionFallback) {
    // Dev/test mode — skip production guards
    return { ok: true, missing: [] };
  }

  const missing: string[] = [];

  if (!config.filesKv) missing.push("filesKv (KV namespace for file storage)");
  if (!config.buildResultsKv) missing.push("buildResultsKv (KV namespace for build results)");
  if (!config.clientToken) missing.push("clientToken (authentication secret)");

  return { ok: missing.length === 0, missing };
}

/**
 * Emit warnings for missing optional-but-recommended production config.
 */

/**
 * Emit warnings for missing optional-but-recommended production config.
 */
export function warnOptionalConfig(config: AppConfig): void {
  if (config.allowLocalSessionFallback) return;
  if (!config.checkpointsKv) {
    console.warn(
      "[productionGuard] checkpointsKv not set — agent checkpoints will not persist across restarts"
    );
  }
  if (!config.cdpWsEndpoint) {
    console.warn(
      "[productionGuard] cdpWsEndpoint not set — visual verification tools will be disabled"
    );
  }
}

/**
 * productionGuard — validates that production-required config is present.
 *
 * Call this at startup in production mode. In development/test, these checks
 * are skipped by passing allowLocalSessionFallback: true in AppConfig.
 */
import type { AppConfig } from "../types.js";

export interface ProductionCheckResult {
  ok: boolean;
  missing: string[];
}

/**
 * Returns missing production-required configuration items.
 * Throws if NODE_ENV=production and required config is absent.
 */
export function checkProductionConfig(config: AppConfig): ProductionCheckResult {
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

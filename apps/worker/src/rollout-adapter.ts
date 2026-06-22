/**
 * rollout-adapter — bridges bscode's build-result channel to wasmagent-js
 * RLAIF verifiers (BuildPassesVerifier, VisualAssertVerifier).
 *
 * wasmagent-js verifiers accept a callback `(sessionId) => Promise<Result>`
 * that is decoupled from bscode internals. This file provides those callbacks
 * by wrapping getBuildResult() and mapping the bscode BuildResultSnapshot
 * shape onto the minimal interfaces the verifiers expect.
 *
 * Usage (in a rollout orchestration script):
 *
 *   import { makeBuildResultReader, makeVisualResultReader } from "./rollout-adapter.js";
 *   import { BuildPassesVerifier } from "@wasmagent/core";
 *
 *   const verifier = new BuildPassesVerifier({
 *     getBuildResult: makeBuildResultReader(appConfig.buildResultsKv),
 *   });
 */

import type { BuildResult, VisualResult } from "@wasmagent/core";
import { getBuildResult } from "./build-results.js";
import type { KvStore } from "./types.js";

/**
 * Create a BuildResultReader callback for BuildPassesVerifier.
 *
 * Maps bscode's BuildResultSnapshot status/exitCode to the minimal
 * { status, exitCode, stdout, stderr } shape wasmagent-js expects.
 * Session IDs must be the derived job session IDs from deriveJobSessionId().
 */
export function makeBuildResultReader(
  kv?: KvStore
): (sessionId: string) => Promise<BuildResult | null> {
  return async (sessionId: string): Promise<BuildResult | null> => {
    const snap = await getBuildResult(sessionId, kv);
    if (snap.status === "unknown" && snap.ranAtMs === 0) {
      return null; // never written — not found
    }
    return {
      status: mapBuildStatus(snap.status),
      exitCode: snap.exitCode ?? null,
      stdout: "",
      stderr: snap.stderr ?? "",
    };
  };
}

/**
 * Create a VisualResultReader callback for VisualAssertVerifier.
 *
 * Maps the visual.verdict sub-object from BuildResultSnapshot onto the
 * { verdict, reason } shape wasmagent-js expects.
 */
export function makeVisualResultReader(
  kv?: KvStore
): (sessionId: string) => Promise<VisualResult | null> {
  return async (sessionId: string): Promise<VisualResult | null> => {
    const snap = await getBuildResult(sessionId, kv);
    if (!snap.visual) return null;
    const v = snap.visual;
    if (v.verdict) {
      return {
        verdict: v.verdict.matchesIntent ? "pass" : "fail",
        reason: v.verdict.reason,
      };
    }
    // No explicit verdict but visual check ran — infer from error signals.
    const hasErrors =
      (v.consoleErrors && v.consoleErrors.length > 0) ||
      (v.uncaughtErrors && v.uncaughtErrors.length > 0);
    if (hasErrors) return { verdict: "fail", reason: "console or uncaught errors detected" };
    if (v.rendersNonEmpty === false) return { verdict: "fail", reason: "page rendered empty" };
    if (v.rendersNonEmpty === true) return { verdict: "pass" };
    return { verdict: "unknown" };
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapBuildStatus(
  status: "success" | "failed" | "running" | "unknown"
): BuildResult["status"] {
  switch (status) {
    case "success":
      return "success";
    case "failed":
      return "failure";
    case "running":
      return "running";
    case "unknown":
      return "unknown";
  }
}

/**
 * B2 — read_build_result tool.
 *
 * Used by framework-mode agents (where `run_command` is disabled) to learn
 * whether the project they just wrote actually compiles. Pairs with the
 * browser-side reverse channel in apps/web/src/hooks/useWebContainer.ts:
 * the browser POSTs build outcomes to `/build-result`, and the agent
 * pulls them via this tool.
 *
 * The tool is read-only and idempotent — calling it multiple times in a
 * row is safe (and common, while a build is in progress).
 */

import type { ToolDefinition } from "@agentkit-js/core";
import { z } from "zod";
import {
  type BuildResultSnapshot,
  getBuildResult,
} from "../build-results.js";
import type { KvStore } from "../types.js";

export interface CreateReadBuildResultToolOptions {
  /** Session id of the current run — same key the browser posts under. */
  sessionId: string | undefined;
  /** Optional KV mirror; falls back to in-memory only when omitted. */
  kv?: KvStore | undefined;
  /**
   * Test seam — override the underlying read. Production callers can leave
   * this undefined; the default reads from build-results.ts.
   */
  read?: (sessionId: string) => Promise<BuildResultSnapshot>;
}

/**
 * Format a snapshot into a string the LLM can act on. Keep it terse:
 * the model treats this as tool output, so the structure must be obvious
 * at a glance even when stderr is long.
 */
export function formatBuildResult(snap: BuildResultSnapshot): string {
  if (snap.status === "unknown")
    return "(no build result reported yet — wait for the browser to finish installing/building, or ask the user to run the project)";

  const stage = snap.stage ? ` (${snap.stage})` : "";
  const age =
    snap.ranAtMs > 0
      ? ` ${Math.round((Date.now() - snap.ranAtMs) / 1000)}s ago`
      : "";
  const head = `status: ${snap.status}${stage}${age}`;

  const lines: string[] = [head];
  if (snap.exitCode !== undefined) lines.push(`exitCode: ${snap.exitCode}`);
  if (snap.wallTimeMs !== undefined) lines.push(`wallTimeMs: ${snap.wallTimeMs}`);
  if (snap.previewUrl) lines.push(`previewUrl: ${snap.previewUrl}`);
  if (snap.stderr) {
    // The store already truncates to 2000 chars; just delimit clearly.
    lines.push("--- stderr (tail) ---");
    lines.push(snap.stderr);
  }
  return lines.join("\n");
}

export function createReadBuildResultTool(
  opts: CreateReadBuildResultToolOptions,
): ToolDefinition<Record<string, never>, string> {
  const { sessionId, kv, read } = opts;
  return {
    name: "read_build_result",
    description:
      "Check the most recent install/build/test outcome reported by the browser-side WebContainer. " +
      "Use AFTER writing files to verify the project compiles. Returns 'status: success/failed/running/unknown' " +
      "plus stderr tail when failed. If status is 'running' or 'unknown', wait briefly then call again — " +
      "do NOT loop forever; give up after 2-3 polls if no result arrives.",
    inputSchema: z.object({}).strict(),
    outputSchema: z.string(),
    readOnly: true,
    idempotent: true,
    forward: async () => {
      if (!sessionId) {
        return "Error: no session id available — build result channel requires X-Session-Id header.";
      }
      const snap = read
        ? await read(sessionId)
        : await getBuildResult(sessionId, kv);
      return formatBuildResult(snap);
    },
  };
}

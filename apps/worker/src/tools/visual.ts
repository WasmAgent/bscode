/**
 * C3 — `visual_verify` and `visual_interact` tools.
 *
 * `visual_verify` is read-only: navigate to the running preview, capture a
 * screenshot, run the agent's selector / textContains probes, and (when an
 * intent is supplied + a vision judge is wired) score whether the render
 * matches. The result is also written into the build-result store so
 * subsequent `read_build_result` calls see it without a re-check.
 *
 * `visual_interact` is write-class: it clicks/fills elements. Its
 * `needsApproval` returns true so the existing `applyApprovalPolicy`
 * gate fires — clients can keep it permanently locked behind HITL or
 * map a `browserInteract` op kind in their policy.
 */

import type { Model, ToolDefinition } from "@wasmagent/core";
import { z } from "zod";
import { type BuildResultSnapshot, putBuildResult } from "../build-results.js";
import type { KvStore } from "../types.js";
import { createModelVisionJudge, type VisionJudge } from "../visionJudge.js";
import {
  runVisualInteraction,
  runVisualVerification,
  type VisualInteractOp,
  type VisualProbeSpec,
} from "../visualVerifier.js";

export interface CreateVisualToolsOptions {
  /** Session id — same one the build-result store keys on. */
  sessionId: string | undefined;
  /** Build-results KV mirror; same one passed to `createReadBuildResultTool`. */
  buildResultsKv?: KvStore | undefined;
  /** CDP WebSocket endpoint — when omitted, both tools degrade gracefully. */
  cdpWsEndpoint?: string | undefined;
  /**
   * Vision-capable model used to judge intent-vs-render. When omitted, the
   * verifier still runs (probes + screenshot) but skips the verdict.
   */
  judgeModel?: Model | undefined;
  /** Pre-built judge wins over `judgeModel` — primarily a test seam. */
  judge?: VisionJudge | undefined;
  /**
   * Most recent preview URL — usually pulled from the build-result snapshot
   * but can be overridden per call. Required: the agent has no other way to
   * know which port the WebContainer landed on.
   */
  resolvePreviewUrl?: () => Promise<string | undefined> | string | undefined;
}

const VISUAL_VERIFY_INPUT = z.object({
  intent: z.string().optional().describe("What the rendered page SHOULD show, in plain English"),
  probes: z
    .array(
      z.object({
        name: z.string(),
        selector: z.string().optional(),
        textContains: z.string().optional(),
      })
    )
    .optional()
    .describe(
      "Selector or textContains assertions the verifier will run on the page. Each probe needs ONE of selector|textContains."
    ),
  previewUrl: z
    .string()
    .url()
    .optional()
    .describe("Override preview URL. Otherwise pulled from the latest build-result snapshot."),
});
type VisualVerifyInput = z.infer<typeof VISUAL_VERIFY_INPUT>;

export function createVisualVerifyTool(
  opts: CreateVisualToolsOptions
): ToolDefinition<VisualVerifyInput, string> {
  const judge =
    opts.judge ?? (opts.judgeModel ? createModelVisionJudge(opts.judgeModel) : undefined);
  return {
    name: "visual_verify",
    description:
      "Drive a CDP browser session against the running preview, capture screenshot + DOM probes + console events, " +
      "and (when an intent is provided) ask a vision-judge whether the render matches. Read-only — does NOT click " +
      "or fill anything. Use AFTER read_build_result reports stage=dev/status=success.",
    inputSchema: VISUAL_VERIFY_INPUT,
    outputSchema: z.string(),
    readOnly: true,
    idempotent: false, // re-running may catch flaky rendering
    forward: async (input) => {
      const previewUrl = input.previewUrl ?? (await resolveUrl(opts));
      if (!previewUrl) {
        return "Error: no preview URL available — the WebContainer dev server has not reported ready yet. Try again after read_build_result shows stage=dev, status=success.";
      }
      const snap = await runVisualVerification({
        previewUrl,
        ...(opts.cdpWsEndpoint !== undefined ? { cdpWsEndpoint: opts.cdpWsEndpoint } : {}),
        ...(input.probes ? { probes: input.probes as VisualProbeSpec[] } : {}),
        ...(input.intent ? { intent: input.intent } : {}),
        ...(judge ? { judge } : {}),
      });
      // Mirror into the build-result store so a follow-up `read_build_result`
      // sees the same signals without re-running the CDP flow.
      if (opts.sessionId) {
        const existing: BuildResultSnapshot = {
          status: "success",
          stage: "dev",
          ranAtMs: Date.now(),
          previewUrl,
          visual: snap,
        };
        await putBuildResult(opts.sessionId, existing, opts.buildResultsKv);
      }
      return formatVerify(snap);
    },
  };
}

const VISUAL_INTERACT_INPUT = z.object({
  ops: z
    .array(
      z.object({
        kind: z.enum(["click", "fill"]),
        selector: z.string(),
        value: z.string().optional(),
      })
    )
    .min(1),
  previewUrl: z.string().url().optional(),
});
type VisualInteractInput = z.infer<typeof VISUAL_INTERACT_INPUT>;

export function createVisualInteractTool(
  opts: CreateVisualToolsOptions
): ToolDefinition<VisualInteractInput, string> {
  return {
    name: "visual_interact",
    description:
      "Click / fill UI elements in the running preview through CDP. Write-class: the bscode approval policy " +
      "gates this tool by default. Use ONLY when you need to drive the UI to reach a specific state before " +
      "running visual_verify.",
    inputSchema: VISUAL_INTERACT_INPUT,
    outputSchema: z.string(),
    readOnly: false,
    idempotent: false,
    needsApproval: () => true,
    forward: async (input) => {
      const previewUrl = input.previewUrl ?? (await resolveUrl(opts));
      if (!previewUrl) {
        return "Error: no preview URL available.";
      }
      const snap = await runVisualInteraction({
        previewUrl,
        ...(opts.cdpWsEndpoint !== undefined ? { cdpWsEndpoint: opts.cdpWsEndpoint } : {}),
        ops: input.ops as VisualInteractOp[],
      });
      return formatVerify(snap);
    },
  };
}

async function resolveUrl(opts: CreateVisualToolsOptions): Promise<string | undefined> {
  if (!opts.resolvePreviewUrl) return undefined;
  const v = await opts.resolvePreviewUrl();
  return v ?? undefined;
}

/** Render a verifier snapshot into a compact string the model can act on. */
function formatVerify(
  snap: ReturnType<typeof runVisualVerification> extends Promise<infer T> ? T : never
): string {
  const lines: string[] = [];
  lines.push(`source: ${snap.source ?? "browser"}`);
  if (snap.pageTitle) lines.push(`pageTitle: ${snap.pageTitle}`);
  if (snap.rendersNonEmpty === false) lines.push("rendersNonEmpty: false (page appears blank)");
  else if (snap.rendersNonEmpty === true) lines.push("rendersNonEmpty: true");
  if (snap.verdict) {
    lines.push(`verdict.matchesIntent: ${snap.verdict.matchesIntent}`);
    lines.push(`verdict.reason: ${snap.verdict.reason}`);
  }
  if (snap.consoleErrors?.length) {
    lines.push(`consoleErrors: ${snap.consoleErrors.length}`);
    for (const e of snap.consoleErrors.slice(0, 5)) {
      lines.push(`  • ${e.message}${e.source ? ` @ ${e.source}` : ""}`);
    }
  }
  if (snap.domProbes?.length) {
    const failing = snap.domProbes.filter((p) => !p.ok);
    lines.push(`domProbes: ${snap.domProbes.length} (${failing.length} failing)`);
    for (const p of failing.slice(0, 5)) {
      lines.push(`  ✗ ${p.name}${p.detail ? ` — ${p.detail}` : ""}`);
    }
  }
  // Never inline thumbnailDataUrl — would burn tokens.
  return lines.join("\n");
}

/**
 * C3 — Vision-judge.
 *
 * Asks a vision-capable model whether a screenshot matches the agent's
 * stated intent. The output is a structured `{ matchesIntent, reason }`
 * pair the verifier folds into `VisualCheckSnapshot.verdict`.
 *
 * The judge is provider-agnostic: anything that implements the wasmagent
 * `Model` interface and accepts an `ImageBlock` (Anthropic Claude, OpenAI
 * GPT-4o, etc.) works. Ergonomically we wrap that behind a `VisionJudge`
 * function so callers don't have to know about `ModelMessage` shape.
 *
 * Robustness: judges hallucinate. The prompt insists on a small JSON
 * envelope and we parse it defensively — anything we can't parse becomes
 * `matchesIntent: false` with the raw output as the reason, so the agent
 * still has signal it can react to.
 */

import type { ImageBlock, Model, ModelMessage } from "@wasmagent/core";

export interface VisionJudgeInput {
  intent: string;
  screenshotDataUrl: string;
}

export interface VisionJudgeOutput {
  matchesIntent: boolean;
  reason: string;
}

export type VisionJudge = (input: VisionJudgeInput) => Promise<VisionJudgeOutput>;

/** Build a `VisionJudge` backed by a real model. */
export function createModelVisionJudge(model: Model): VisionJudge {
  return async ({ intent, screenshotDataUrl }) => {
    const image = decodeDataUrl(screenshotDataUrl);
    if (!image) {
      return {
        matchesIntent: false,
        reason: "vision-judge: screenshot was not a valid data URL",
      };
    }
    const imageBlock: ImageBlock = {
      type: "image",
      source: image.base64,
      mediaType: image.mediaType,
    };
    const messages: ModelMessage[] = [
      {
        role: "system",
        content:
          "You are a strict UI reviewer. Given a screenshot and the developer's stated intent, " +
          "decide whether the rendered page actually delivers that intent. Reply with a SINGLE " +
          'JSON object on one line: {"matchesIntent": boolean, "reason": "<≤300 chars>"}. ' +
          "Set matchesIntent=false for blank pages, error overlays, missing key elements, or " +
          "anything that would frustrate the user.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: `Intent: ${intent}` },
          imageBlock,
          { type: "text", text: "Reply now with the JSON envelope only." },
        ],
      },
    ];
    let raw = "";
    for await (const ev of model.generate(messages, {
      stream: true,
      temperature: 0,
      maxTokens: 200,
    })) {
      if (ev.type === "text_delta" && ev.delta) raw += ev.delta;
    }
    return parseJudgeReply(raw);
  };
}

/** Extract `{ matchesIntent, reason }` from the model's freeform output. */
export function parseJudgeReply(raw: string): VisionJudgeOutput {
  const trimmed = raw.trim();
  // Find the first balanced JSON object — models occasionally wrap with
  // markdown fences or commentary.
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) {
    return {
      matchesIntent: false,
      reason: `unparseable judge reply: ${trimmed.slice(0, 200)}`,
    };
  }
  try {
    const parsed = JSON.parse(match[0]) as {
      matchesIntent?: unknown;
      reason?: unknown;
    };
    const matchesIntent = typeof parsed.matchesIntent === "boolean" ? parsed.matchesIntent : false;
    const reason =
      typeof parsed.reason === "string" ? parsed.reason.slice(0, 400) : "(no reason given)";
    return { matchesIntent, reason };
  } catch (e) {
    return {
      matchesIntent: false,
      reason: `judge JSON parse failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Convenience wrapper: run a judge and reshape the result for the verifier. */
export async function judgeRender(opts: {
  judge: VisionJudge;
  intent: string;
  screenshotDataUrl: string;
}): Promise<{ matchesIntent: boolean; reason: string; intent: string }> {
  const out = await opts.judge({
    intent: opts.intent,
    screenshotDataUrl: opts.screenshotDataUrl,
  });
  return { ...out, intent: opts.intent };
}

interface DecodedDataUrl {
  base64: string;
  mediaType: ImageBlock["mediaType"];
}

/** Pull base64 + media-type out of a `data:image/png;base64,...` URL. */
function decodeDataUrl(dataUrl: string): DecodedDataUrl | null {
  const m = dataUrl.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/);
  if (!m) return null;
  return {
    mediaType: m[1] as ImageBlock["mediaType"],
    base64: m[2] as string,
  };
}

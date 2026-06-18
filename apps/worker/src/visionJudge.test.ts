/**
 * C3 — visionJudge tests.
 *
 * Covers `parseJudgeReply` (handles raw JSON, fenced JSON, malformed
 * JSON, and missing fields) and the model-backed judge factory.
 */

import type { Model, ModelMessage, StreamEvent } from "@wasmagent/core";
import { describe, expect, it } from "bun:test";
import { createModelVisionJudge, parseJudgeReply } from "./visionJudge.js";

function fakeModel(reply: string): Model {
  return {
    providerId: "fake",
    async *generate(_messages: ModelMessage[]): AsyncGenerator<StreamEvent> {
      yield { type: "text_delta", delta: reply };
    },
  };
}

describe("parseJudgeReply", () => {
  it("parses a clean JSON envelope", () => {
    const out = parseJudgeReply('{"matchesIntent": true, "reason": "looks good"}');
    expect(out).toEqual({ matchesIntent: true, reason: "looks good" });
  });

  it("recovers JSON wrapped in markdown fences and prose", () => {
    const out = parseJudgeReply('```json\n{"matchesIntent": false, "reason": "blank"}\n```');
    expect(out.matchesIntent).toBe(false);
    expect(out.reason).toBe("blank");
  });

  it("falls back to matchesIntent=false on unparseable output", () => {
    const out = parseJudgeReply("the page is fine");
    expect(out.matchesIntent).toBe(false);
    expect(out.reason).toMatch(/unparseable judge reply/);
  });

  it("treats invalid JSON as matchesIntent=false with the parse error in reason", () => {
    const out = parseJudgeReply("{matchesIntent: yes}"); // not valid JSON
    expect(out.matchesIntent).toBe(false);
    expect(out.reason).toMatch(/parse failed/);
  });

  it("treats missing fields as matchesIntent=false with placeholder reason", () => {
    const out = parseJudgeReply('{"unrelated": 1}');
    expect(out).toEqual({ matchesIntent: false, reason: "(no reason given)" });
  });

  it("truncates absurdly long reasons", () => {
    const long = "x".repeat(1000);
    const out = parseJudgeReply(`{"matchesIntent": true, "reason": "${long}"}`);
    expect(out.reason.length).toBe(400);
  });
});

describe("createModelVisionJudge", () => {
  it("rejects screenshots that are not data URLs", async () => {
    const judge = createModelVisionJudge(fakeModel("ignored"));
    const out = await judge({
      intent: "show a button",
      screenshotDataUrl: "https://not-a-data-url",
    });
    expect(out.matchesIntent).toBe(false);
    expect(out.reason).toMatch(/not a valid data URL/);
  });

  it("round-trips a verdict through the model", async () => {
    const judge = createModelVisionJudge(
      fakeModel('{"matchesIntent": true, "reason": "Login form rendered correctly"}')
    );
    const out = await judge({
      intent: "render a login form",
      screenshotDataUrl: "data:image/png;base64,AAAA",
    });
    expect(out).toEqual({
      matchesIntent: true,
      reason: "Login form rendered correctly",
    });
  });
});

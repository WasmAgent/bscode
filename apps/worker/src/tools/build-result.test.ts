/**
 * B2 — read_build_result tool tests.
 *
 * Verifies the tool's contract:
 *   - returns 'unknown' message before any build result is reported
 *   - formats success/failed/running snapshots in a model-readable shape
 *   - tail-truncates long stderr (the underlying store does this; tool
 *     just confirms the result the model sees stays bounded)
 *   - errors out cleanly when no sessionId is available
 *   - tool advertises readOnly + idempotent so the runner can cache it
 */

import { afterEach, describe, expect, it } from "bun:test";
import { _resetForTests, putBuildResult } from "../build-results.js";
import { createReadBuildResultTool, formatBuildResult } from "./build-result.js";

afterEach(() => {
  _resetForTests();
});

describe("read_build_result tool", () => {
  it("declares readOnly and idempotent", () => {
    const tool = createReadBuildResultTool({ sessionId: "s" });
    expect(tool.readOnly).toBe(true);
    expect(tool.idempotent).toBe(true);
    expect(tool.name).toBe("read_build_result");
  });

  it("returns the 'unknown' message when no result has been reported", async () => {
    const tool = createReadBuildResultTool({ sessionId: "s" });
    const out = await tool.forward({});
    expect(out).toMatch(/no build result reported yet/i);
  });

  it("formats a successful dev-stage snapshot with previewUrl", async () => {
    await putBuildResult("s", {
      status: "success",
      stage: "dev",
      ranAtMs: Date.now(),
      previewUrl: "https://x.local",
    });
    const tool = createReadBuildResultTool({ sessionId: "s" });
    const out = await tool.forward({});
    expect(out).toMatch(/status: success/);
    expect(out).toContain("(dev)");
    expect(out).toContain("previewUrl: https://x.local");
  });

  it("formats a failed install snapshot with stderr tail", async () => {
    await putBuildResult("s", {
      status: "failed",
      stage: "install",
      exitCode: 1,
      stderr: "npm ERR! 404 Not Found - GET https://registry.npmjs.org/no-such-pkg",
      wallTimeMs: 4321,
      ranAtMs: Date.now(),
    });
    const tool = createReadBuildResultTool({ sessionId: "s" });
    const out = await tool.forward({});
    expect(out).toMatch(/status: failed/);
    expect(out).toContain("exitCode: 1");
    expect(out).toContain("wallTimeMs: 4321");
    expect(out).toContain("npm ERR!");
    expect(out).toContain("--- stderr (tail) ---");
  });

  it("returns an error string when sessionId is missing", async () => {
    const tool = createReadBuildResultTool({ sessionId: undefined });
    const out = await tool.forward({});
    expect(out.startsWith("Error:")).toBe(true);
    expect(out).toMatch(/X-Session-Id/);
  });

  it("respects the test-seam read override", async () => {
    let calls = 0;
    const tool = createReadBuildResultTool({
      sessionId: "s",
      read: async (id) => {
        calls++;
        return {
          status: "running",
          stage: "build",
          ranAtMs: Date.now(),
          stderr: `read for ${id}`,
        };
      },
    });
    const out = await tool.forward({});
    expect(calls).toBe(1);
    expect(out).toMatch(/status: running/);
    expect(out).toContain("read for s");
  });
});

describe("formatBuildResult helper", () => {
  it("includes a relative age when ranAtMs is set", () => {
    const out = formatBuildResult({
      status: "success",
      ranAtMs: Date.now() - 5000,
    });
    expect(out).toMatch(/\d+s ago/);
  });

  it("omits exitCode/wallTimeMs/previewUrl when not provided", () => {
    const out = formatBuildResult({ status: "running", ranAtMs: Date.now() });
    expect(out).not.toContain("exitCode");
    expect(out).not.toContain("wallTimeMs");
    expect(out).not.toContain("previewUrl");
  });

  // ── C3 — visual signals in the formatted output ───────────────────────────

  it("renders a visual section with consoleErrors when present", () => {
    const out = formatBuildResult({
      status: "success",
      stage: "dev",
      ranAtMs: Date.now(),
      previewUrl: "http://localhost:3000",
      visual: {
        ranAtMs: Date.now(),
        rendersNonEmpty: true,
        consoleErrors: [
          { message: "Warning: useEffect ran twice", source: "react.js" },
          { message: "Failed prop type" },
        ],
      },
    });
    expect(out).toContain("--- visual ---");
    expect(out).toContain("rendersNonEmpty: true");
    expect(out).toContain("consoleErrors: 2");
    expect(out).toContain("Warning: useEffect ran twice");
  });

  it("flags rendersNonEmpty:false as a blank-page signal", () => {
    const out = formatBuildResult({
      status: "success",
      stage: "dev",
      ranAtMs: Date.now(),
      visual: { ranAtMs: Date.now(), rendersNonEmpty: false },
    });
    expect(out).toContain("page appears blank");
  });

  it("lists failing DOM probes with their detail message", () => {
    const out = formatBuildResult({
      status: "success",
      stage: "dev",
      ranAtMs: Date.now(),
      visual: {
        ranAtMs: Date.now(),
        domProbes: [
          { name: "h1 visible", ok: true },
          { name: "submit button", ok: false, detail: "not in DOM" },
        ],
      },
    });
    expect(out).toMatch(/domProbes: 2 \(1 failing\)/);
    expect(out).toContain("✗ submit button — not in DOM");
    // Passing probes are NOT listed individually — the summary line is enough.
    expect(out).not.toContain("✗ h1 visible");
  });

  it("never inlines the thumbnail data URL into the agent context", () => {
    const out = formatBuildResult({
      status: "success",
      stage: "dev",
      ranAtMs: Date.now(),
      visual: {
        ranAtMs: Date.now(),
        rendersNonEmpty: true,
        thumbnailDataUrl: "data:image/png;base64,AAAAAAAAAAAAAAAAAA",
      },
    });
    expect(out).not.toContain("base64");
    expect(out).not.toContain("data:image");
  });
});

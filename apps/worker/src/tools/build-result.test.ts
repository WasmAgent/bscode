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

import { afterEach, describe, expect, it } from "vitest";
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
});

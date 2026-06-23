import { describe, expect, it } from "bun:test";
import { checkProductionConfig } from "./productionGuard.js";

describe("checkProductionConfig", () => {
  it("passes in dev mode (allowLocalSessionFallback: true)", () => {
    const result = checkProductionConfig({ allowLocalSessionFallback: true });
    expect(result.ok).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  it("fails when production config is incomplete", () => {
    const result = checkProductionConfig({});
    expect(result.ok).toBe(false);
    expect(result.missing.length).toBeGreaterThan(0);
    expect(result.missing.some((m) => m.includes("clientToken"))).toBe(true);
  });

  it("passes when all required production config is present", () => {
    const mockKv = { get: async () => null, put: async () => {}, list: async () => ({ keys: [] }) };
    const result = checkProductionConfig({
      clientToken: "secret",
      filesKv: mockKv,
      buildResultsKv: mockKv,
    });
    expect(result.ok).toBe(true);
  });
});

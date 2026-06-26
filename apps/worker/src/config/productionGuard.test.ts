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

  // P0-5: production fail-open detection
  describe("P0-5 — strictAuth + allowLocalSessionFallback is a fatal misconfiguration", () => {
    it("throws when strictAuth=true and allowLocalSessionFallback=true are both set", () => {
      expect(() =>
        checkProductionConfig({ strictAuth: true, allowLocalSessionFallback: true })
      ).toThrow(/FATAL.*strictAuth.*allowLocalSessionFallback/);
    });

    it("does NOT throw when strictAuth=true and allowLocalSessionFallback is false/absent", () => {
      const mockKv = {
        get: async () => null,
        put: async () => {},
        list: async () => ({ keys: [] }),
      };
      // strictAuth=true without allowLocalSessionFallback — normal production config
      expect(() =>
        checkProductionConfig({
          strictAuth: true,
          clientToken: "secret",
          filesKv: mockKv,
          buildResultsKv: mockKv,
        })
      ).not.toThrow();
    });

    it("does NOT throw when strictAuth is absent and allowLocalSessionFallback=true (normal dev)", () => {
      expect(() => checkProductionConfig({ allowLocalSessionFallback: true })).not.toThrow();
    });

    it("does NOT throw when both strictAuth and allowLocalSessionFallback are absent", () => {
      expect(() => checkProductionConfig({})).not.toThrow();
    });
  });
});

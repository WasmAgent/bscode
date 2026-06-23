/**
 * Tests for lib/workerUrl.ts.
 *
 * getWorkerUrl() re-reads localStorage on every call so Settings changes
 * take effect immediately without a reload.
 * Cover:
 *   1. localStorage override wins over the build default.
 *   2. Trailing slashes stripped (so callers can write `${WORKER_URL}/run`).
 *   3. Whitespace-only / empty saved value falls through to the default.
 *   4. localStorage read throwing (Safari private mode) falls through.
 *   5. SSR / no-window safety: returns the build default without crashing.
 *   6. getWorkerUrl picks up mutations immediately (no stale cache).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getWorkerUrl, refreshWorkerUrl } from "./workerUrl";

describe("getWorkerUrl", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("returns the build default when localStorage is empty", () => {
    expect(getWorkerUrl()).toMatch(/^https?:\/\//);
  });

  it("uses the localStorage override when present", () => {
    localStorage.setItem("bscode:workerUrl", "https://custom.example.com");
    expect(getWorkerUrl()).toBe("https://custom.example.com");
  });

  it("strips trailing slashes from the resolved URL", () => {
    localStorage.setItem("bscode:workerUrl", "https://x.example.com/");
    expect(getWorkerUrl()).toBe("https://x.example.com");
  });

  it("strips multiple trailing slashes", () => {
    localStorage.setItem("bscode:workerUrl", "https://x.example.com///");
    expect(getWorkerUrl()).toBe("https://x.example.com");
  });

  it("trims surrounding whitespace from the override", () => {
    localStorage.setItem("bscode:workerUrl", "  https://trimmed.example.com  ");
    expect(getWorkerUrl()).toBe("https://trimmed.example.com");
  });

  it("ignores whitespace-only saved values and falls through to the default", () => {
    localStorage.setItem("bscode:workerUrl", "   ");
    expect(getWorkerUrl()).not.toBe("");
    expect(getWorkerUrl()).toMatch(/^https?:\/\//);
  });

  it("ignores empty-string saved values and falls through", () => {
    localStorage.setItem("bscode:workerUrl", "");
    expect(getWorkerUrl()).toMatch(/^https?:\/\//);
  });

  it("falls through to the default when localStorage.getItem throws (private mode)", () => {
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("QuotaExceededError: storage disabled");
    };
    try {
      expect(() => getWorkerUrl()).not.toThrow();
      expect(getWorkerUrl()).toMatch(/^https?:\/\//);
    } finally {
      Storage.prototype.getItem = orig;
    }
  });

  it("picks up storage mutations immediately on the next call", () => {
    localStorage.setItem("bscode:workerUrl", "https://first.example.com");
    expect(getWorkerUrl()).toBe("https://first.example.com");
    localStorage.setItem("bscode:workerUrl", "https://second.example.com");
    expect(getWorkerUrl()).toBe("https://second.example.com");
  });

  it("refreshWorkerUrl re-reads from localStorage", () => {
    localStorage.setItem("bscode:workerUrl", "https://first.example.com");
    expect(getWorkerUrl()).toBe("https://first.example.com");
    localStorage.setItem("bscode:workerUrl", "https://second.example.com");
    expect(refreshWorkerUrl()).toBe("https://second.example.com");
    expect(getWorkerUrl()).toBe("https://second.example.com");
  });

  it("refreshWorkerUrl returns the build default after the override is cleared", () => {
    localStorage.setItem("bscode:workerUrl", "https://override.example.com");
    expect(getWorkerUrl()).toBe("https://override.example.com");
    localStorage.removeItem("bscode:workerUrl");
    const refreshed = refreshWorkerUrl();
    expect(refreshed).toMatch(/^https?:\/\//);
    expect(refreshed).not.toBe("https://override.example.com");
  });
});

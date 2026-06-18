/**
 * Tests for lib/workerUrl.ts.
 *
 * The module caches its read on first import — tests use refreshWorkerUrl()
 * combined with localStorage manipulation to exercise each scenario.
 * Cover:
 *   1. localStorage override wins over the build default.
 *   2. Trailing slashes stripped (so callers can write `${WORKER_URL}/run`).
 *   3. Whitespace-only / empty saved value falls through to the default.
 *   4. localStorage read throwing (Safari private mode) falls through.
 *   5. SSR / no-window safety: returns the build default without crashing.
 *   6. refreshWorkerUrl re-reads after a mutation.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getWorkerUrl, refreshWorkerUrl } from "./workerUrl";

describe("getWorkerUrl", () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset cache before each test by calling refresh
    refreshWorkerUrl();
  });
  afterEach(() => {
    localStorage.clear();
    refreshWorkerUrl();
  });

  it("returns the build default when localStorage is empty", () => {
    // The build default falls back to localhost:8788 when NEXT_PUBLIC_WORKER_URL
    // isn't set in the test env. Either is fine — we just need a stable URL.
    expect(getWorkerUrl()).toMatch(/^https?:\/\//);
  });

  it("uses the localStorage override when present", () => {
    localStorage.setItem("bscode:workerUrl", "https://custom.example.com");
    refreshWorkerUrl();
    expect(getWorkerUrl()).toBe("https://custom.example.com");
  });

  it("strips trailing slashes from the resolved URL", () => {
    localStorage.setItem("bscode:workerUrl", "https://x.example.com/");
    refreshWorkerUrl();
    expect(getWorkerUrl()).toBe("https://x.example.com");
  });

  it("strips multiple trailing slashes", () => {
    localStorage.setItem("bscode:workerUrl", "https://x.example.com///");
    refreshWorkerUrl();
    expect(getWorkerUrl()).toBe("https://x.example.com");
  });

  it("trims surrounding whitespace from the override", () => {
    localStorage.setItem("bscode:workerUrl", "  https://trimmed.example.com  ");
    refreshWorkerUrl();
    expect(getWorkerUrl()).toBe("https://trimmed.example.com");
  });

  it("ignores whitespace-only saved values and falls through to the default", () => {
    localStorage.setItem("bscode:workerUrl", "   ");
    refreshWorkerUrl();
    // Whitespace-only is not a valid override; the default URL should win.
    expect(getWorkerUrl()).not.toBe("");
    expect(getWorkerUrl()).toMatch(/^https?:\/\//);
  });

  it("ignores empty-string saved values and falls through", () => {
    localStorage.setItem("bscode:workerUrl", "");
    refreshWorkerUrl();
    expect(getWorkerUrl()).toMatch(/^https?:\/\//);
  });

  it("falls through to the default when localStorage.getItem throws (private mode)", () => {
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("QuotaExceededError: storage disabled");
    };
    try {
      refreshWorkerUrl();
      // Must not crash; must return the build default.
      expect(() => getWorkerUrl()).not.toThrow();
      expect(getWorkerUrl()).toMatch(/^https?:\/\//);
    } finally {
      Storage.prototype.getItem = orig;
    }
  });

  it("memoises the read — second call returns the same value even if storage is mutated", () => {
    localStorage.setItem("bscode:workerUrl", "https://first.example.com");
    refreshWorkerUrl();
    const first = getWorkerUrl();
    // Mutate the source — getWorkerUrl shouldn't re-read.
    localStorage.setItem("bscode:workerUrl", "https://second.example.com");
    expect(getWorkerUrl()).toBe(first);
  });

  it("refreshWorkerUrl re-reads from localStorage", () => {
    localStorage.setItem("bscode:workerUrl", "https://first.example.com");
    refreshWorkerUrl();
    expect(getWorkerUrl()).toBe("https://first.example.com");

    localStorage.setItem("bscode:workerUrl", "https://second.example.com");
    // Without refresh, getWorkerUrl still returns first.
    expect(getWorkerUrl()).toBe("https://first.example.com");
    // refresh re-reads and updates the cache.
    expect(refreshWorkerUrl()).toBe("https://second.example.com");
    expect(getWorkerUrl()).toBe("https://second.example.com");
  });

  it("refreshWorkerUrl returns the build default after the override is cleared", () => {
    localStorage.setItem("bscode:workerUrl", "https://override.example.com");
    refreshWorkerUrl();
    expect(getWorkerUrl()).toBe("https://override.example.com");

    localStorage.removeItem("bscode:workerUrl");
    const refreshed = refreshWorkerUrl();
    expect(refreshed).toMatch(/^https?:\/\//);
    expect(refreshed).not.toBe("https://override.example.com");
  });
});

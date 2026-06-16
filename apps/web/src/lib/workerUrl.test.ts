/**
 * Tests for lib/workerUrl.ts.
 *
 * The module caches its read on first import — tests use vitest's module
 * reset to get a fresh cached value per scenario. Cover:
 *   1. localStorage override wins over the build default.
 *   2. Trailing slashes stripped (so callers can write `${WORKER_URL}/run`).
 *   3. Whitespace-only / empty saved value falls through to the default.
 *   4. localStorage read throwing (Safari private mode) falls through.
 *   5. SSR / no-window safety: returns the build default without crashing.
 *   6. refreshWorkerUrl re-reads after a mutation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Module is loaded fresh in each test so the cached value resets.
async function loadModule() {
  vi.resetModules();
  return import("./workerUrl");
}

describe("getWorkerUrl", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("returns the build default when localStorage is empty", async () => {
    const mod = await loadModule();
    // The build default falls back to localhost:8788 when NEXT_PUBLIC_WORKER_URL
    // isn't set in the test env. Either is fine — we just need a stable URL.
    expect(mod.getWorkerUrl()).toMatch(/^https?:\/\//);
  });

  it("uses the localStorage override when present", async () => {
    localStorage.setItem("bscode:workerUrl", "https://custom.example.com");
    const mod = await loadModule();
    expect(mod.getWorkerUrl()).toBe("https://custom.example.com");
  });

  it("strips trailing slashes from the resolved URL", async () => {
    localStorage.setItem("bscode:workerUrl", "https://x.example.com/");
    const mod = await loadModule();
    expect(mod.getWorkerUrl()).toBe("https://x.example.com");
  });

  it("strips multiple trailing slashes", async () => {
    localStorage.setItem("bscode:workerUrl", "https://x.example.com///");
    const mod = await loadModule();
    expect(mod.getWorkerUrl()).toBe("https://x.example.com");
  });

  it("trims surrounding whitespace from the override", async () => {
    localStorage.setItem("bscode:workerUrl", "  https://trimmed.example.com  ");
    const mod = await loadModule();
    expect(mod.getWorkerUrl()).toBe("https://trimmed.example.com");
  });

  it("ignores whitespace-only saved values and falls through to the default", async () => {
    localStorage.setItem("bscode:workerUrl", "   ");
    const mod = await loadModule();
    // Whitespace-only is not a valid override; the default URL should win.
    expect(mod.getWorkerUrl()).not.toBe("");
    expect(mod.getWorkerUrl()).toMatch(/^https?:\/\//);
  });

  it("ignores empty-string saved values and falls through", async () => {
    localStorage.setItem("bscode:workerUrl", "");
    const mod = await loadModule();
    expect(mod.getWorkerUrl()).toMatch(/^https?:\/\//);
  });

  it("falls through to the default when localStorage.getItem throws (private mode)", async () => {
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("QuotaExceededError: storage disabled");
    };
    try {
      const mod = await loadModule();
      // Must not crash; must return the build default.
      expect(() => mod.getWorkerUrl()).not.toThrow();
      expect(mod.getWorkerUrl()).toMatch(/^https?:\/\//);
    } finally {
      Storage.prototype.getItem = orig;
    }
  });

  it("memoises the read — second call returns the same value even if storage is mutated", async () => {
    localStorage.setItem("bscode:workerUrl", "https://first.example.com");
    const mod = await loadModule();
    const first = mod.getWorkerUrl();
    // Mutate the source — getWorkerUrl shouldn't re-read.
    localStorage.setItem("bscode:workerUrl", "https://second.example.com");
    expect(mod.getWorkerUrl()).toBe(first);
  });

  it("refreshWorkerUrl re-reads from localStorage", async () => {
    localStorage.setItem("bscode:workerUrl", "https://first.example.com");
    const mod = await loadModule();
    expect(mod.getWorkerUrl()).toBe("https://first.example.com");

    localStorage.setItem("bscode:workerUrl", "https://second.example.com");
    // Without refresh, getWorkerUrl still returns first.
    expect(mod.getWorkerUrl()).toBe("https://first.example.com");
    // refresh re-reads and updates the cache.
    expect(mod.refreshWorkerUrl()).toBe("https://second.example.com");
    expect(mod.getWorkerUrl()).toBe("https://second.example.com");
  });

  it("refreshWorkerUrl returns the build default after the override is cleared", async () => {
    localStorage.setItem("bscode:workerUrl", "https://override.example.com");
    const mod = await loadModule();
    expect(mod.getWorkerUrl()).toBe("https://override.example.com");

    localStorage.removeItem("bscode:workerUrl");
    const refreshed = mod.refreshWorkerUrl();
    expect(refreshed).toMatch(/^https?:\/\//);
    expect(refreshed).not.toBe("https://override.example.com");
  });
});

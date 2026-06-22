/**
 * B2 — Build Result store tests.
 *
 * Verifies the in-memory + KV mirror behaviour described in build-results.ts:
 *   - put then get round-trips a snapshot
 *   - the most recent put wins (no history accumulates)
 *   - stderr is truncated to MAX_STDERR_CHARS
 *   - clear wipes the snapshot
 *   - KV mirror is consulted only when in-memory is cold
 *   - KV write/read failures fall through gracefully
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import {
  _resetForTests,
  type BuildResultSnapshot,
  clearBuildResult,
  DEFAULT_SESSION_ID,
  getBuildResult,
  MAX_STDERR_CHARS,
  putBuildResult,
} from "./build-results.js";
import { MemKvStore } from "./platform.js";

afterEach(() => {
  _resetForTests();
  vi.restoreAllMocks();
});

describe("build-results store", () => {
  it("get returns 'unknown' before any put", async () => {
    const snap = await getBuildResult("session-a");
    expect(snap.status).toBe("unknown");
    expect(snap.ranAtMs).toBe(0);
  });

  it("put then get round-trips the snapshot", async () => {
    await putBuildResult("session-a", {
      status: "success",
      stage: "dev",
      exitCode: 0,
      previewUrl: "https://x.local",
      ranAtMs: 1000,
    });
    const got = await getBuildResult("session-a");
    expect(got.status).toBe("success");
    expect(got.stage).toBe("dev");
    expect(got.previewUrl).toBe("https://x.local");
  });

  it("most recent put wins; older snapshot is overwritten", async () => {
    await putBuildResult("s", { status: "running", stage: "install", ranAtMs: 1 });
    await putBuildResult("s", {
      status: "failed",
      stage: "install",
      exitCode: 1,
      stderr: "ENOTFOUND",
      ranAtMs: 2,
    });
    const got = await getBuildResult("s");
    expect(got.status).toBe("failed");
    expect(got.stderr).toBe("ENOTFOUND");
  });

  it("stderr longer than MAX_STDERR_CHARS is tail-truncated", async () => {
    const longStderr = "x".repeat(MAX_STDERR_CHARS + 500) + "TAIL";
    await putBuildResult("s", {
      status: "failed",
      stage: "build",
      stderr: longStderr,
      ranAtMs: 1,
    });
    const got = await getBuildResult("s");
    expect(got.stderr?.length).toBe(MAX_STDERR_CHARS);
    // Tail of the original string is preserved.
    expect(got.stderr?.endsWith("TAIL")).toBe(true);
  });

  it("clearBuildResult removes the snapshot", async () => {
    await putBuildResult("s", { status: "success", ranAtMs: 1 });
    await clearBuildResult("s");
    const got = await getBuildResult("s");
    expect(got.status).toBe("unknown");
  });

  it("two sessions are isolated", async () => {
    await putBuildResult("a", { status: "success", ranAtMs: 1 });
    await putBuildResult("b", { status: "failed", ranAtMs: 2 });
    expect((await getBuildResult("a")).status).toBe("success");
    expect((await getBuildResult("b")).status).toBe("failed");
  });

  it("KV is consulted when in-memory is cold (worker recycle path)", async () => {
    const kv = new MemKvStore();
    // Seed KV directly as if a previous worker had written it.
    const seeded: BuildResultSnapshot = {
      status: "success",
      stage: "dev",
      previewUrl: "https://restored",
      ranAtMs: 12345,
    };
    await kv.put("build-result:s", JSON.stringify(seeded));
    // In-memory is empty; getBuildResult must hydrate from KV.
    const got = await getBuildResult("s", kv);
    expect(got.status).toBe("success");
    expect(got.previewUrl).toBe("https://restored");
    // Subsequent reads should be served from memory — check by deleting the
    // KV row, then reading again.
    await kv.delete?.("build-result:s");
    const second = await getBuildResult("s", kv);
    expect(second.status).toBe("success");
  });

  it("put mirrors to KV when bound", async () => {
    const kv = new MemKvStore();
    await putBuildResult("s", { status: "success", ranAtMs: 1 }, kv);
    const raw = await kv.get("build-result:s");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as BuildResultSnapshot;
    expect(parsed.status).toBe("success");
  });

  it("KV write failure does NOT throw", async () => {
    const fakeKv = {
      get: async () => null,
      put: async () => {
        throw new Error("simulated KV outage");
      },
      list: async () => ({ keys: [] }),
      delete: async () => {},
    };
    // Mute the warn print so it doesn't pollute test output.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let threw = false;
    try {
      await putBuildResult("s", { status: "success", ranAtMs: 1 }, fakeKv);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    // Memory snapshot is still readable.
    const got = await getBuildResult("s");
    expect(got.status).toBe("success");
  });

  it("KV read failure falls through to 'unknown' instead of throwing", async () => {
    const fakeKv = {
      get: async () => {
        throw new Error("simulated KV outage");
      },
      put: async () => {},
      list: async () => ({ keys: [] }),
      delete: async () => {},
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const got = await getBuildResult("cold-session", fakeKv);
    expect(got.status).toBe("unknown");
  });
});

describe("1-D — build-results state boundary hardening", () => {
  it("putBuildResult with default session emits a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await putBuildResult(DEFAULT_SESSION_ID, { status: "success", ranAtMs: 1 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("default session"));
  });

  it("getBuildResult with default session emits a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await getBuildResult(DEFAULT_SESSION_ID);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("default session"));
  });

  it("putBuildResult with explicit session id does NOT warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await putBuildResult("session-explicit", { status: "success", ranAtMs: 1 });
    expect(warn).not.toHaveBeenCalled();
  });

  it("strictKvMode=true causes KV write failure to throw", async () => {
    const fakeKv = {
      get: async () => null,
      put: async () => {
        throw new Error("KV write failed");
      },
      list: async () => ({ keys: [] }),
      delete: async () => {},
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      putBuildResult("s", { status: "success", ranAtMs: 1 }, fakeKv, { strictKvMode: true })
    ).rejects.toThrow("KV write failed");
  });

  it("strictKvMode=false (default) swallows KV write failure", async () => {
    const fakeKv = {
      get: async () => null,
      put: async () => {
        throw new Error("KV write failed");
      },
      list: async () => ({ keys: [] }),
      delete: async () => {},
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      putBuildResult("s", { status: "success", ranAtMs: 1 }, fakeKv)
    ).resolves.toBeUndefined();
  });

  it("concurrent two-job puts with distinct session ids do not pollute each other", async () => {
    await Promise.all([
      putBuildResult("job-A", { status: "success", ranAtMs: 1 }),
      putBuildResult("job-B", { status: "failed", ranAtMs: 2, exitCode: 1 }),
    ]);
    expect((await getBuildResult("job-A")).status).toBe("success");
    expect((await getBuildResult("job-B")).status).toBe("failed");
  });
});

describe("C3 — visual check payload round-trips", () => {
  it("put preserves the visual sub-object verbatim", async () => {
    const snap: BuildResultSnapshot = {
      status: "success",
      stage: "dev",
      ranAtMs: 0,
      previewUrl: "http://localhost:3000",
      visual: {
        ranAtMs: 1234,
        rendersNonEmpty: true,
        consoleErrors: [{ message: "Warning: useEffect ran twice", source: "react.js" }],
        uncaughtErrors: [],
        domProbes: [
          { name: "h1 visible", ok: true },
          { name: "submit button", ok: false, detail: "not in DOM" },
        ],
        thumbnailDataUrl: "data:image/png;base64,iVBORw0KGgo=",
      },
    };
    await putBuildResult("v1", snap);
    const got = await getBuildResult("v1");
    expect(got.visual).toEqual(snap.visual);
  });

  it("missing visual field is preserved as undefined (no synthetic empty object)", async () => {
    await putBuildResult("v2", { status: "success", stage: "dev", ranAtMs: 0 });
    const got = await getBuildResult("v2");
    expect(got.visual).toBeUndefined();
  });
});

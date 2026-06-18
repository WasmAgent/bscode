/**
 * goal-directed-runner unit tests — KV→WorkspaceReader adapter + scout
 * snapshot extraction. The end-to-end path (which spans the actual
 * `GoalDirectedAgent`) is covered in wasmagent/packages/core's
 * `GoalDirectedAgent.test.ts`; this file pins down the bscode-specific
 * thin wiring.
 */

import { describe, expect, it } from "bun:test";
import type { KvStore } from "../types.js";
import { kvWorkspaceReader, snapshotWorkspaceEntries } from "./goal-directed-runner.js";

function memKv(initial: Record<string, string> = {}): KvStore {
  const data = new Map(Object.entries(initial));
  return {
    async get(key) {
      return data.get(key) ?? null;
    },
    async put(key, value) {
      data.set(key, value);
    },
    async list({ prefix }) {
      return {
        keys: [...data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      };
    },
    async delete(key) {
      data.delete(key);
    },
  };
}

describe("kvWorkspaceReader", () => {
  it("readFile maps file:<path> → kv get", async () => {
    const ws = kvWorkspaceReader(memKv({ "file:foo.md": "hello" }));
    expect(await ws.readFile("foo.md")).toBe("hello");
  });

  it("fileExists returns false for missing files (not throws)", async () => {
    const ws = kvWorkspaceReader(memKv({}));
    expect(await ws.fileExists("missing.md")).toBe(false);
  });

  it("readFile throws ENOENT for missing files", async () => {
    const ws = kvWorkspaceReader(memKv({}));
    await expect(ws.readFile("missing.md")).rejects.toThrow(/ENOENT/);
  });

  it("fileSize reports UTF-8 bytes — Chinese characters count as 3 bytes each", async () => {
    const ws = kvWorkspaceReader(memKv({ "file:zh.md": "半干电池" }));
    // 4 CJK chars × 3 bytes UTF-8 = 12 bytes
    expect(await ws.fileSize("zh.md")).toBe(12);
  });

  it("fileSize on empty file returns 0", async () => {
    const ws = kvWorkspaceReader(memKv({ "file:empty.md": "" }));
    expect(await ws.fileSize("empty.md")).toBe(0);
  });
});

describe("snapshotWorkspaceEntries", () => {
  it("strips the file: prefix and respects the limit", async () => {
    const kv = memKv({
      "file:a.md": "x",
      "file:b/c.ts": "y",
      "file:d.json": "z",
      "session:zzz": "ignored",
    });
    const entries = await snapshotWorkspaceEntries(kv);
    expect(entries.sort()).toEqual(["a.md", "b/c.ts", "d.json"]);
  });

  it("caps the snapshot at the requested limit", async () => {
    const initial: Record<string, string> = {};
    for (let i = 0; i < 100; i++) initial[`file:f${i}.md`] = "x";
    const entries = await snapshotWorkspaceEntries(memKv(initial), 5);
    expect(entries.length).toBe(5);
  });

  it("returns [] when listing throws (graceful degradation)", async () => {
    const angry: KvStore = {
      async get() {
        return null;
      },
      async put() {},
      async list() {
        throw new Error("upstream offline");
      },
    };
    const entries = await snapshotWorkspaceEntries(angry);
    expect(entries).toEqual([]);
  });
});

/**
 * Unit tests for KV store implementations in platform.ts.
 *
 * MemKvStore  — in-memory store used by Node.js dev server and tests
 * FsKvStore   — file-system backed store (uses Bun.file / Bun.write)
 * SessionKvStore — session-namespaced wrapper around any KvStore
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsKvStore, MemKvStore, SessionKvStore } from "./platform.js";

// ── MemKvStore ────────────────────────────────────────────────────────────────

describe("MemKvStore", () => {
  let kv: MemKvStore;

  beforeEach(() => {
    kv = new MemKvStore();
  });

  it("returns null for missing key", async () => {
    expect(await kv.get("missing")).toBeNull();
  });

  it("stores and retrieves a value", async () => {
    await kv.put("k", "hello");
    expect(await kv.get("k")).toBe("hello");
  });

  it("overwrites an existing value", async () => {
    await kv.put("k", "first");
    await kv.put("k", "second");
    expect(await kv.get("k")).toBe("second");
  });

  it("deletes a key", async () => {
    await kv.put("k", "v");
    await kv.delete("k");
    expect(await kv.get("k")).toBeNull();
  });

  it("delete is idempotent on missing key", async () => {
    await expect(kv.delete("nope")).resolves.toBeUndefined();
  });

  it("lists keys by prefix", async () => {
    await kv.put("file:a.ts", "a");
    await kv.put("file:b.ts", "b");
    await kv.put("meta:x", "x");
    const { keys } = await kv.list({ prefix: "file:" });
    expect(keys.map((k) => k.name).sort()).toEqual(["file:a.ts", "file:b.ts"]);
  });

  it("list returns empty array when no keys match prefix", async () => {
    await kv.put("file:a.ts", "a");
    const { keys } = await kv.list({ prefix: "session:" });
    expect(keys).toHaveLength(0);
  });

  it("respects expirationTtl — expired entry returns null", async () => {
    vi.useFakeTimers();
    await kv.put("tmp", "val", { expirationTtl: 1 }); // 1 second TTL
    vi.advanceTimersByTime(1001);
    expect(await kv.get("tmp")).toBeNull();
    vi.useRealTimers();
  });

  it("non-expired entry remains readable", async () => {
    vi.useFakeTimers();
    await kv.put("tmp", "val", { expirationTtl: 60 });
    vi.advanceTimersByTime(30_000);
    expect(await kv.get("tmp")).toBe("val");
    vi.useRealTimers();
  });

  it("expired entry is removed from list results", async () => {
    vi.useFakeTimers();
    await kv.put("file:old.ts", "v", { expirationTtl: 1 });
    await kv.put("file:new.ts", "v");
    vi.advanceTimersByTime(2000);
    // get() evicts expired entries
    await kv.get("file:old.ts");
    const { keys } = await kv.list({ prefix: "file:" });
    expect(keys.map((k) => k.name)).toEqual(["file:new.ts"]);
    vi.useRealTimers();
  });
});

// ── FsKvStore ─────────────────────────────────────────────────────────────────

describe("FsKvStore", () => {
  let tmpDir: string;
  let kv: FsKvStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bscode-fs-kv-"));
    kv = new FsKvStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null for missing key", async () => {
    expect(await kv.get("file:missing.ts")).toBeNull();
  });

  it("writes and reads a file", async () => {
    await kv.put("file:hello.ts", "export const x = 1;");
    expect(await kv.get("file:hello.ts")).toBe("export const x = 1;");
  });

  it("creates parent directories automatically", async () => {
    await kv.put("file:src/lib/util.ts", "// util");
    expect(await kv.get("file:src/lib/util.ts")).toBe("// util");
  });

  it("overwrites an existing file", async () => {
    await kv.put("file:a.ts", "v1");
    await kv.put("file:a.ts", "v2");
    expect(await kv.get("file:a.ts")).toBe("v2");
  });

  it("deletes a file", async () => {
    await kv.put("file:del.ts", "bye");
    await kv.delete("file:del.ts");
    expect(await kv.get("file:del.ts")).toBeNull();
  });

  it("delete is idempotent on missing file", async () => {
    await expect(kv.delete("file:nope.ts")).resolves.toBeUndefined();
  });

  it("lists files under a prefix", async () => {
    await kv.put("file:src/a.ts", "a");
    await kv.put("file:src/b.ts", "b");
    await kv.put("file:test/c.ts", "c");
    const { keys } = await kv.list({ prefix: "file:src/" });
    const names = keys.map((k) => k.name).sort();
    expect(names).toEqual(["file:src/a.ts", "file:src/b.ts"]);
  });

  it("list returns empty for non-existent directory", async () => {
    const { keys } = await kv.list({ prefix: "file:nonexistent/" });
    expect(keys).toHaveLength(0);
  });

  it("rejects path traversal via ../ in key — throws instead of silently stripping", async () => {
    // SEC-016: path.resolve + path.relative guard replaces the old
    // single-pass regex that could be bypassed with "..../" tricks.
    // The store must throw a FsKvStore: error and must NOT write anything.
    await expect(kv.put("file:../../etc/evil", "pwned")).rejects.toThrow(
      /FsKvStore: path traversal/
    );
    // Verify nothing was written outside the sandbox root.
    const { readFile } = await import("node:fs/promises");
    await expect(readFile("/etc/evil")).rejects.toThrow();
  });

  it("rejects the '..../' double-dot double-slash evasion (SEC-016)", async () => {
    // "....//etc/evil": after one-pass regex replacement of "../" the old code
    // produced "../etc/evil", escaping the root. path.resolve collapses it correctly.
    for (const key of [
      "file:....//etc/evil",
      "file:..../",
      "file:....///etc/evil",
      "file:..//..//etc/passwd",
    ]) {
      await expect(kv.put(key, "x"), `put(${key}) should throw`).rejects.toThrow(/FsKvStore:/);
      await expect(kv.get(key), `get(${key}) should throw`).rejects.toThrow(/FsKvStore:/);
    }
  });

  it("rejects keys with NUL bytes (SEC-016)", async () => {
    const NUL = String.fromCharCode(0x00);
    const key = `file:hello${NUL}evil.ts`;
    await expect(kv.put(key, "x")).rejects.toThrow(/FsKvStore:.*control/);
    await expect(kv.get(key)).rejects.toThrow(/FsKvStore:.*control/);
  });

  it("rejects keys with LF/CR control characters (SEC-016)", async () => {
    for (const cc of [0x0a, 0x0d]) {
      const key = `file:hello${String.fromCharCode(cc)}evil.ts`;
      await expect(kv.put(key, "x")).rejects.toThrow(/FsKvStore:.*control/);
    }
  });

  it("rejects a symlink that points outside the root (SEC-016)", async () => {
    // Create a symlink inside tmpDir that points to an outside directory.
    const outsideDir = await mkdtemp(join(tmpdir(), "bscode-outside-"));
    try {
      // Write a sensitive file outside the root
      await writeFile(join(outsideDir, "secret.txt"), "top secret");
      // Create a symlink inside root pointing outside
      await symlink(outsideDir, join(tmpDir, "escape-link"));
      // Attempt to read through the symlink — must be blocked
      await expect(kv.get("file:escape-link/secret.txt")).rejects.toThrow(
        /FsKvStore: symlink escape/
      );
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("recursively lists nested files", async () => {
    await kv.put("file:a/b/c.ts", "deep");
    await kv.put("file:a/d.ts", "shallow");
    const { keys } = await kv.list({ prefix: "file:" });
    const names = keys.map((k) => k.name).sort();
    expect(names).toContain("file:a/b/c.ts");
    expect(names).toContain("file:a/d.ts");
  });
});

// ── SessionKvStore ────────────────────────────────────────────────────────────

describe("SessionKvStore", () => {
  let backing: MemKvStore;

  beforeEach(() => {
    backing = new MemKvStore();
  });

  it("prefixes all keys with session:{id}:", async () => {
    const sess = new SessionKvStore(backing, "abc123");
    await sess.put("file:main.ts", "code");
    // Backing store has session-prefixed key
    expect(await backing.get("session:abc123:file:main.ts")).toBe("code");
  });

  it("reads through the prefix", async () => {
    const sess = new SessionKvStore(backing, "s1");
    await sess.put("k", "v");
    expect(await sess.get("k")).toBe("v");
  });

  it("sessions are isolated from each other", async () => {
    const s1 = new SessionKvStore(backing, "session-1");
    const s2 = new SessionKvStore(backing, "session-2");
    await s1.put("file:index.ts", "s1-code");
    await s2.put("file:index.ts", "s2-code");
    expect(await s1.get("file:index.ts")).toBe("s1-code");
    expect(await s2.get("file:index.ts")).toBe("s2-code");
  });

  it("list strips the session prefix from returned keys", async () => {
    const sess = new SessionKvStore(backing, "xyz");
    await sess.put("file:a.ts", "a");
    await sess.put("file:b.ts", "b");
    const { keys } = await sess.list({ prefix: "file:" });
    const names = keys.map((k) => k.name).sort();
    expect(names).toEqual(["file:a.ts", "file:b.ts"]);
  });

  it("list only returns keys belonging to this session", async () => {
    const s1 = new SessionKvStore(backing, "alpha");
    const s2 = new SessionKvStore(backing, "beta");
    await s1.put("file:x.ts", "x");
    await s2.put("file:y.ts", "y");
    const { keys } = await s1.list({ prefix: "file:" });
    expect(keys.map((k) => k.name)).toEqual(["file:x.ts"]);
  });

  it("delete removes through the prefix", async () => {
    const sess = new SessionKvStore(backing, "del-sess");
    await sess.put("k", "v");
    await sess.delete("k");
    expect(await sess.get("k")).toBeNull();
  });

  it("forwards expirationTtl to backing store", async () => {
    vi.useFakeTimers();
    const sess = new SessionKvStore(backing, "ttl-sess");
    await sess.put("tmp", "val", { expirationTtl: 1 });
    vi.advanceTimersByTime(2000);
    expect(await sess.get("tmp")).toBeNull();
    vi.useRealTimers();
  });
});

/**
 * Unit tests for KV store implementations in platform.ts.
 *
 * MemKvStore  — in-memory store used by Node.js dev server and tests
 * FsKvStore   — file-system backed store (uses Bun.file / Bun.write)
 * SessionKvStore — session-namespaced wrapper around any KvStore
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    await expect(kv.delete("nope")).resolves.not.toThrow();
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
    await expect(kv.delete("file:nope.ts")).resolves.not.toThrow();
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

  it("prevents path traversal via ../ in key", async () => {
    // Should write inside tmpDir, not escape it
    await kv.put("file:../../etc/evil", "pwned");
    // The file lands inside tmpDir, not at /etc/evil
    const content = await kv.get("file:../../etc/evil");
    // Either it was sanitised (no content outside root) or stored safely inside root
    // The key point: /etc/evil should not be written
    const { readFile } = await import("node:fs/promises");
    await expect(readFile("/etc/evil")).rejects.toThrow();
    // And the store returns the value from inside root
    expect(content).toBe("pwned");
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

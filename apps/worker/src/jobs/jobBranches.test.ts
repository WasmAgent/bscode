/**
 * C2 — Job branching tests.
 *
 * Pin down the contract:
 *   1. snapshot copies file:* keys verbatim and writes immutable snap entries
 *   2. derived ids are stable + reversible
 *   3. diff reports added / modified / deleted relative to the snapshot,
 *      not relative to current base — concurrent base edits never appear
 *      in the head's diff
 *   4. clean merges (no concurrent base edits) write to base and produce
 *      no conflicts
 *   5. base-changed-after-snapshot produces structured conflicts and never
 *      silently overwrites
 *   6. modified-vs-deleted and deleted-vs-modified land with the right
 *      reason labels
 *   7. "ours" / "theirs" strategies behave as documented
 *   8. discardJobSession removes both working copy and snapshot
 */

import { describe, expect, it } from "bun:test";
import { MemKvStore } from "../platform.js";
import {
  deriveJobSessionId,
  diffSessions,
  discardJobSession,
  mergeSessions,
  parentOfJobSessionId,
  snapshotSession,
} from "./jobBranches.js";

async function seedSession(kv: MemKvStore, sessionId: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await kv.put(`session:${sessionId}:file:${path}`, content);
  }
}

async function readSession(
  kv: MemKvStore,
  sessionId: string,
  path: string
): Promise<string | null> {
  return kv.get(`session:${sessionId}:file:${path}`);
}

// ── derivation ───────────────────────────────────────────────────────────────

describe("deriveJobSessionId / parentOfJobSessionId", () => {
  it("derives a stable, reversible id", () => {
    const derived = deriveJobSessionId("alice", "job-abc");
    expect(derived).toBe("alice#job-abc");
    expect(parentOfJobSessionId(derived)).toBe("alice");
  });

  it("falls back to 'default' when the parent is undefined", () => {
    expect(deriveJobSessionId(undefined, "job-x")).toBe("default#job-x");
  });

  it("returns null for non-derived ids", () => {
    expect(parentOfJobSessionId("plain-session")).toBeNull();
    expect(parentOfJobSessionId("alice#not-a-job")).toBeNull();
  });
});

// ── snapshot ────────────────────────────────────────────────────────────────

describe("snapshotSession", () => {
  it("copies every file:* key from parent into the derived session and stores an immutable snapshot", async () => {
    const kv = new MemKvStore();
    await seedSession(kv, "alice", { "src/a.ts": "1", "README.md": "hi" });
    const head = deriveJobSessionId("alice", "job-1");
    const copied = await snapshotSession(kv, "alice", head);
    expect(copied).toBe(2);
    expect(await readSession(kv, head, "src/a.ts")).toBe("1");
    expect(await readSession(kv, head, "README.md")).toBe("hi");
    // Snapshot bucket too:
    expect(await kv.get(`jobsnap:${head}:src/a.ts`)).toBe("1");
    expect(await kv.get(`jobsnap:${head}:README.md`)).toBe("hi");
  });

  it("returns 0 when parent has no files", async () => {
    const kv = new MemKvStore();
    const head = deriveJobSessionId("empty", "job-1");
    expect(await snapshotSession(kv, "empty", head)).toBe(0);
  });
});

// ── diff ────────────────────────────────────────────────────────────────────

describe("diffSessions", () => {
  it("reports added / modified / deleted relative to the snapshot", async () => {
    const kv = new MemKvStore();
    await seedSession(kv, "alice", {
      "keep.ts": "0",
      "change.ts": "0",
      "gone.ts": "0",
    });
    const head = deriveJobSessionId("alice", "job-1");
    await snapshotSession(kv, "alice", head);

    // Job edits.
    await kv.put(`session:${head}:file:change.ts`, "1");
    await kv.delete?.(`session:${head}:file:gone.ts`);
    await kv.put(`session:${head}:file:new.ts`, "fresh");

    const delta = await diffSessions(kv, head);
    expect(delta).toEqual([
      {
        path: "change.ts",
        kind: "modified",
        headContent: "1",
        baseContent: "0",
      },
      { path: "gone.ts", kind: "deleted", headContent: null, baseContent: "0" },
      { path: "new.ts", kind: "added", headContent: "fresh", baseContent: null },
    ]);
  });

  it("does not report files whose content is identical to the snapshot", async () => {
    const kv = new MemKvStore();
    await seedSession(kv, "alice", { "a.ts": "v" });
    const head = deriveJobSessionId("alice", "job-1");
    await snapshotSession(kv, "alice", head);
    await kv.put(`session:${head}:file:a.ts`, "v"); // rewrite same content
    const delta = await diffSessions(kv, head);
    expect(delta).toEqual([]);
  });

  it("ignores concurrent base edits — diff is head-vs-snapshot, not head-vs-base", async () => {
    const kv = new MemKvStore();
    await seedSession(kv, "alice", { "a.ts": "v0" });
    const head = deriveJobSessionId("alice", "job-1");
    await snapshotSession(kv, "alice", head);
    // Base session changes a.ts AFTER the snapshot. Head did NOT touch it.
    await kv.put("session:alice:file:a.ts", "v-base-changed");
    const delta = await diffSessions(kv, head);
    expect(delta).toEqual([]);
  });
});

// ── merge ───────────────────────────────────────────────────────────────────

describe("mergeSessions", () => {
  it("clean merge writes head changes to base and reports them as applied", async () => {
    const kv = new MemKvStore();
    await seedSession(kv, "alice", { "a.ts": "v0", "b.ts": "v0" });
    const head = deriveJobSessionId("alice", "job-1");
    await snapshotSession(kv, "alice", head);

    await kv.put(`session:${head}:file:a.ts`, "v1");
    await kv.put(`session:${head}:file:c.ts`, "new");

    const result = await mergeSessions(kv, "alice", head);
    expect(result.conflicts).toEqual([]);
    expect(result.applied.sort()).toEqual(["a.ts", "c.ts"]);
    expect(await readSession(kv, "alice", "a.ts")).toBe("v1");
    expect(await readSession(kv, "alice", "c.ts")).toBe("new");
    expect(await readSession(kv, "alice", "b.ts")).toBe("v0"); // untouched
  });

  it("base-changed-after-snapshot produces a both-modified conflict and does not overwrite", async () => {
    const kv = new MemKvStore();
    await seedSession(kv, "alice", { "x.ts": "v0" });
    const head = deriveJobSessionId("alice", "job-1");
    await snapshotSession(kv, "alice", head);

    // Both head and base mutate x.ts AFTER the snapshot.
    await kv.put(`session:${head}:file:x.ts`, "v-head");
    await kv.put("session:alice:file:x.ts", "v-base");

    const result = await mergeSessions(kv, "alice", head);
    expect(result.applied).toEqual([]);
    expect(result.conflicts).toEqual([
      {
        path: "x.ts",
        headContent: "v-head",
        baseContent: "v-base",
        snapshotContent: "v0",
        reason: "both-modified",
      },
    ]);
    // Base must not have been silently rewritten.
    expect(await readSession(kv, "alice", "x.ts")).toBe("v-base");
  });

  it("modified-vs-deleted (head modifies, base deletes after snapshot)", async () => {
    const kv = new MemKvStore();
    await seedSession(kv, "alice", { "doc.md": "# original" });
    const head = deriveJobSessionId("alice", "job-1");
    await snapshotSession(kv, "alice", head);

    await kv.put(`session:${head}:file:doc.md`, "# updated");
    await kv.delete?.("session:alice:file:doc.md");

    const result = await mergeSessions(kv, "alice", head);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.reason).toBe("modified-vs-deleted");
  });

  it("deleted-vs-modified (head deletes, base modifies after snapshot)", async () => {
    const kv = new MemKvStore();
    await seedSession(kv, "alice", { "doc.md": "# original" });
    const head = deriveJobSessionId("alice", "job-1");
    await snapshotSession(kv, "alice", head);

    await kv.delete?.(`session:${head}:file:doc.md`);
    await kv.put("session:alice:file:doc.md", "# concurrent edit");

    const result = await mergeSessions(kv, "alice", head);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.reason).toBe("deleted-vs-modified");
  });

  it("strategy=theirs applies head's change unconditionally", async () => {
    const kv = new MemKvStore();
    await seedSession(kv, "alice", { "x.ts": "v0" });
    const head = deriveJobSessionId("alice", "job-1");
    await snapshotSession(kv, "alice", head);

    await kv.put(`session:${head}:file:x.ts`, "v-head");
    await kv.put("session:alice:file:x.ts", "v-base");

    const result = await mergeSessions(kv, "alice", head, "theirs");
    expect(result.conflicts).toEqual([]);
    expect(result.applied).toEqual(["x.ts"]);
    expect(await readSession(kv, "alice", "x.ts")).toBe("v-head");
  });

  it("strategy=ours leaves base untouched but records the path as considered", async () => {
    const kv = new MemKvStore();
    await seedSession(kv, "alice", { "x.ts": "v0" });
    const head = deriveJobSessionId("alice", "job-1");
    await snapshotSession(kv, "alice", head);

    await kv.put(`session:${head}:file:x.ts`, "v-head");
    await kv.put("session:alice:file:x.ts", "v-base");

    const result = await mergeSessions(kv, "alice", head, "ours");
    expect(result.conflicts).toEqual([]);
    expect(result.applied).toEqual(["x.ts"]);
    expect(await readSession(kv, "alice", "x.ts")).toBe("v-base");
  });
});

// ── cleanup ─────────────────────────────────────────────────────────────────

describe("discardJobSession", () => {
  it("removes both working copy and snapshot", async () => {
    const kv = new MemKvStore();
    await seedSession(kv, "alice", { "a.ts": "v" });
    const head = deriveJobSessionId("alice", "job-1");
    await snapshotSession(kv, "alice", head);
    await discardJobSession(kv, head);

    const headLeft = await kv.list({ prefix: `session:${head}:` });
    const snapLeft = await kv.list({ prefix: `jobsnap:${head}:` });
    expect(headLeft.keys).toEqual([]);
    expect(snapLeft.keys).toEqual([]);
    // Parent session is untouched.
    expect(await readSession(kv, "alice", "a.ts")).toBe("v");
  });
});

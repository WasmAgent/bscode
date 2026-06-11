/**
 * C2 — bscode parallel-agent isolation + diff/merge.
 *
 * Cursor 3 / Claude Code "agent teams" require each parallel job to run in
 * its own filesystem view, then surface a structured diff for the user to
 * review before merging back into the trunk session.
 *
 * bscode already isolates by `X-Session-Id`: every file write goes through
 * `SessionKvStore`, which prefixes the underlying KV with `session:<id>:`.
 * That gives us cheap per-job isolation for free — we just need to give
 * each job a derived session id, snapshot the parent session into it on
 * submit, and provide diff/merge endpoints that compare the two prefixes.
 *
 * This is the same shape as agentkit-js's framework-level
 * `BranchableWorkspace` (F3) but specialised to bscode's KV layout. The two
 * could be unified once bscode migrates its mass file storage to
 * `wsfile:` keys, but that's a bigger refactor than C2 needs and would force
 * a breaking change on every bscode user. C2 ships against today's layout.
 *
 * ## Design
 *
 *   1. `deriveJobSessionId(parent, jobId)` — stable derivation. We append
 *      `#job-<id>` so the derived id is immediately recognisable in logs
 *      (and crucially is NOT a valid HTTP header value, which prevents
 *      accidental forwarding to clients).
 *   2. `snapshotSession(filesKv, from, to)` — clone every `file:*` key from
 *      `from` into `to`. Cost is one KV `list` + N `get/put` pairs.
 *   3. `diffSessions(filesKv, base, head)` — enumerate both prefixes and
 *      report `added | modified | deleted | unchanged`.
 *   4. `mergeSessions(filesKv, base, head, strategy)` — apply the diff to
 *      `base`. Conflicts (concurrent edits to the same file in `base` since
 *      the snapshot was taken) come back as a structured list — never
 *      auto-resolved.
 */

import type { KvStore } from "../platform.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type FileChangeKind = "added" | "modified" | "deleted";

export interface FileDelta {
  path: string;
  kind: FileChangeKind;
  /** Content as seen on `head`. null when kind="deleted". */
  headContent: string | null;
  /** Content as seen on `base`. null when kind="added". */
  baseContent: string | null;
}

export interface MergeConflict {
  path: string;
  /** What the head branch (the job) wrote. */
  headContent: string | null;
  /** What the base branch (trunk) currently shows. Differs from the */
  /** snapshot that head started from — that's why it's a conflict. */
  baseContent: string | null;
  /** Snapshot from when the job was forked — useful for 3-way previews. */
  snapshotContent: string | null;
  reason: "both-modified" | "modified-vs-deleted" | "deleted-vs-modified";
}

export interface MergeResult {
  applied: string[];
  conflicts: MergeConflict[];
}

export type MergeStrategy = "fail-on-conflict" | "ours" | "theirs";

const FILE_PREFIX = "file:";
const SNAPSHOT_PREFIX = "jobsnap:";

// ── Session id derivation ───────────────────────────────────────────────────

/**
 * Build the derived session id for a job. The `#` separator is intentional:
 * it's an HTTP header-invalid character, so a derived id can never be
 * mistaken for a parent (you can't echo it back as `X-Session-Id` without
 * encoding). Job ids supplied by `JobQueue.nextJobId()` already start with
 * `job-` and contain no `#`, so the result is unambiguous.
 */
export function deriveJobSessionId(parentSessionId: string | undefined, jobId: string): string {
  const parent = parentSessionId ?? "default";
  return `${parent}#${jobId}`;
}

/**
 * Reverse of `deriveJobSessionId`. Returns null when the id was not derived
 * (no `#` separator or no `job-` segment after).
 */
export function parentOfJobSessionId(jobSessionId: string): string | null {
  const idx = jobSessionId.indexOf("#");
  if (idx < 0) return null;
  const tail = jobSessionId.slice(idx + 1);
  if (!tail.startsWith("job-")) return null;
  return jobSessionId.slice(0, idx);
}

// ── Snapshot ────────────────────────────────────────────────────────────────

/**
 * Copy every `file:*` key from the `from` session into the `to` session,
 * AND record an immutable snapshot under the derived id. The snapshot is
 * what `mergeSessions` later compares against to detect concurrent edits.
 *
 * Returns the number of files copied. Idempotent: re-running with the same
 * `to` only re-copies files whose content has changed in `from`.
 */
export async function snapshotSession(filesKv: KvStore, from: string, to: string): Promise<number> {
  const fromPrefix = `session:${from}:${FILE_PREFIX}`;
  const toPrefix = `session:${to}:${FILE_PREFIX}`;
  const snapPrefix = `${SNAPSHOT_PREFIX}${to}:`;

  const list = await filesKv.list({ prefix: fromPrefix });
  let copied = 0;
  await Promise.all(
    list.keys.map(async (k) => {
      const path = k.name.slice(fromPrefix.length);
      const content = await filesKv.get(k.name);
      if (content === null) return;
      // Write the working copy AND the immutable snapshot. Snapshots never
      // get rewritten by the job — that's how merge() detects "head changed
      // a file the snapshot already had, but base also changed it since".
      await Promise.all([
        filesKv.put(`${toPrefix}${path}`, content),
        filesKv.put(`${snapPrefix}${path}`, content),
      ]);
      copied++;
    })
  );
  return copied;
}

// ── Diff ────────────────────────────────────────────────────────────────────

/**
 * Compare the head session against its starting snapshot (NOT against the
 * current base — that's what merge does). Returns one entry per changed
 * path; unchanged paths are omitted.
 */
export async function diffSessions(filesKv: KvStore, head: string): Promise<FileDelta[]> {
  const headPrefix = `session:${head}:${FILE_PREFIX}`;
  const snapPrefix = `${SNAPSHOT_PREFIX}${head}:`;

  const [headList, snapList] = await Promise.all([
    filesKv.list({ prefix: headPrefix }),
    filesKv.list({ prefix: snapPrefix }),
  ]);
  const headPaths = new Set(headList.keys.map((k) => k.name.slice(headPrefix.length)));
  const snapPaths = new Set(snapList.keys.map((k) => k.name.slice(snapPrefix.length)));

  const out: FileDelta[] = [];
  // Anything in head that wasn't (with same content) in the snapshot is added/modified.
  for (const path of headPaths) {
    const [headContent, snapContent] = await Promise.all([
      filesKv.get(`${headPrefix}${path}`),
      filesKv.get(`${snapPrefix}${path}`),
    ]);
    if (snapContent === null) {
      out.push({ path, kind: "added", headContent, baseContent: null });
    } else if (headContent !== snapContent) {
      out.push({ path, kind: "modified", headContent, baseContent: snapContent });
    }
    // identical content → no-op, omit.
  }
  // Anything in the snapshot but missing from head was deleted by the job.
  for (const path of snapPaths) {
    if (headPaths.has(path)) continue;
    const snapContent = await filesKv.get(`${snapPrefix}${path}`);
    out.push({ path, kind: "deleted", headContent: null, baseContent: snapContent });
  }

  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

// ── Merge ───────────────────────────────────────────────────────────────────

/**
 * Apply the head session's changes onto `base`. Conflicts arise when the
 * base session changed a file that the job also touched (between snapshot
 * time and merge time) — exactly the race that motivates this whole module.
 *
 * Strategy:
 *   - "fail-on-conflict" (default): write only changes that don't conflict.
 *   - "ours": keep base's version on conflict (reject head's change).
 *   - "theirs": apply head's version unconditionally.
 *
 * Returns `applied` (paths that landed on base) and `conflicts` (paths that
 * needed human resolution).
 */
export async function mergeSessions(
  filesKv: KvStore,
  base: string,
  head: string,
  strategy: MergeStrategy = "fail-on-conflict"
): Promise<MergeResult> {
  const basePrefix = `session:${base}:${FILE_PREFIX}`;
  const snapPrefix = `${SNAPSHOT_PREFIX}${head}:`;

  const headDelta = await diffSessions(filesKv, head);
  const applied: string[] = [];
  const conflicts: MergeConflict[] = [];

  for (const change of headDelta) {
    const baseKey = `${basePrefix}${change.path}`;
    const snapKey = `${snapPrefix}${change.path}`;
    const [baseContent, snapContent] = await Promise.all([
      filesKv.get(baseKey),
      filesKv.get(snapKey),
    ]);
    // The job started from snapContent. If base now differs from snapContent,
    // base was edited concurrently — that's our conflict signal.
    const baseChanged = baseContent !== snapContent;

    if (!baseChanged) {
      // Clean apply: write head's change to base.
      await applyChange(filesKv, baseKey, change);
      applied.push(change.path);
      continue;
    }

    // Conflict — pick a reason that matches the kinds.
    const reason = pickConflictReason(change.kind, baseContent, snapContent);
    if (strategy === "fail-on-conflict") {
      conflicts.push({
        path: change.path,
        headContent: change.headContent,
        baseContent,
        snapshotContent: snapContent,
        reason,
      });
      continue;
    }
    if (strategy === "theirs") {
      await applyChange(filesKv, baseKey, change);
      applied.push(change.path);
      continue;
    }
    // "ours" — record the path as considered but do not modify base.
    applied.push(change.path);
  }

  return { applied, conflicts };
}

async function applyChange(filesKv: KvStore, baseKey: string, change: FileDelta): Promise<void> {
  if (change.kind === "deleted") {
    if (filesKv.delete) await filesKv.delete(baseKey);
    return;
  }
  await filesKv.put(baseKey, change.headContent ?? "");
}

function pickConflictReason(
  kind: FileChangeKind,
  baseContent: string | null,
  snapContent: string | null
): MergeConflict["reason"] {
  if (kind === "deleted" && baseContent !== null && baseContent !== snapContent) {
    return "deleted-vs-modified";
  }
  if (kind !== "deleted" && baseContent === null) {
    return "modified-vs-deleted";
  }
  return "both-modified";
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

/**
 * Drop the working copy AND the immutable snapshot for a finished job.
 * Should be called after a successful merge or after the user discards the
 * job. Best-effort — failures are swallowed (KV may not support delete).
 */
export async function discardJobSession(filesKv: KvStore, head: string): Promise<void> {
  if (!filesKv.delete) return;
  const headPrefix = `session:${head}:${FILE_PREFIX}`;
  const snapPrefix = `${SNAPSHOT_PREFIX}${head}:`;
  const [headList, snapList] = await Promise.all([
    filesKv.list({ prefix: headPrefix }),
    filesKv.list({ prefix: snapPrefix }),
  ]);
  const del = filesKv.delete.bind(filesKv);
  await Promise.all(headList.keys.map((k) => del(k.name).catch(() => undefined)));
  await Promise.all(snapList.keys.map((k) => del(k.name).catch(() => undefined)));
}

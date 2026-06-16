/**
 * Tests for shell.ts — createShellRunner + createGitTools.
 *
 * Strategy:
 *   - createShellRunner: assert it returns undefined when enableShell=false
 *     or when workdir is missing (the edge-runtime / CF Workers contract).
 *   - createGitTools: empty array in the same disabled scenarios.
 *   - Real-spawn smoke test: when both flags are present, run `git status`
 *     against a freshly-init'd workdir under os.tmpdir() and assert the
 *     formatted "exit:0\n…" envelope makes it back. This pins the spawn
 *     path without trying to mock Bun.spawn (which is hard to replace
 *     under vitest's module loader without leaking globals).
 *   - Tool surface: the 5 git tools are present with correct names,
 *     readOnly flags, and idempotency hints — agents rely on these
 *     for DAG-scheduled parallel reads.
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitTools, createShellRunner } from "./shell.js";

describe("createShellRunner", () => {
  it("returns undefined when enableShell is false", () => {
    expect(createShellRunner({ enableShell: false, workdir: "/tmp" })).toBeUndefined();
  });

  it("returns undefined when workdir is missing", () => {
    expect(createShellRunner({ enableShell: true })).toBeUndefined();
  });

  it("returns undefined when both flags are missing", () => {
    expect(createShellRunner({})).toBeUndefined();
  });
});

describe("createGitTools", () => {
  it("returns an empty array when shell is disabled", () => {
    expect(createGitTools({ enableShell: false, workdir: "/tmp" })).toEqual([]);
  });

  it("returns an empty array when workdir is missing", () => {
    expect(createGitTools({ enableShell: true })).toEqual([]);
  });

  it("returns 5 tools with the expected names + readOnly flags when enabled", () => {
    const tools = createGitTools({ enableShell: true, workdir: "/tmp" });
    expect(tools.map((t) => t.name)).toEqual([
      "git_status",
      "git_diff",
      "git_log",
      "git_commit",
      "git_checkout",
    ]);
    // Read-class tools (status/diff/log) are advertised readOnly + idempotent
    // so the DAG scheduler can run them in parallel speculatively.
    const status = tools.find((t) => t.name === "git_status");
    expect(status?.readOnly).toBe(true);
    expect(status?.idempotent).toBe(true);

    const diff = tools.find((t) => t.name === "git_diff");
    expect(diff?.readOnly).toBe(true);

    const log = tools.find((t) => t.name === "git_log");
    expect(log?.readOnly).toBe(true);

    // Write-class tools must NOT be marked readOnly — that would let the
    // scheduler reorder them past read tools and lose linearizability.
    const commit = tools.find((t) => t.name === "git_commit");
    expect(commit?.readOnly).toBe(false);
    expect(commit?.idempotent).toBe(false);

    const checkout = tools.find((t) => t.name === "git_checkout");
    expect(checkout?.readOnly).toBe(false);
    expect(checkout?.idempotent).toBe(false);
  });
});

// ── Real-spawn smoke test ───────────────────────────────────────────────────
//
// Only runs under Bun (Bun.spawn is the spawn primitive shell.ts uses).
// On Node-hosted vitest runs, the test is skipped — Bun.spawn is undefined
// and shell.ts is shipped as edge code that only executes under bun --filter.
const HAS_BUN_SPAWN =
  typeof (globalThis as { Bun?: { spawn?: unknown } }).Bun?.spawn === "function";

describe.skipIf(!HAS_BUN_SPAWN)("git_status (real spawn)", () => {
  let tmp = "";

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "bscode-shell-test-"));
    // Initialise a tiny git repo so `git status` returns something deterministic.
    execSync("git init -q && git config user.email t@test && git config user.name t", {
      cwd: tmp,
    });
    writeFileSync(join(tmp, "untracked.txt"), "hi\n");
  });

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("git_status spawns bash and returns exit:0 envelope", async () => {
    const tools = createGitTools({ enableShell: true, workdir: tmp });
    const status = tools.find((t) => t.name === "git_status");
    expect(status).toBeDefined();
    const out = (await status?.forward({})) as string;
    expect(out).toMatch(/^exit:0/);
    // The untracked file should appear in `git status --short` output.
    expect(out).toMatch(/\?\?\s+untracked\.txt/);
  });
});

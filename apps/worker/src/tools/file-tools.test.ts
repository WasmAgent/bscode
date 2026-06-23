/**
 * Unit tests for the plain file tools defined in tools/index.ts.
 *
 * The agent-side tool surface is what bscode promises models. revert_file +
 * list_file_versions are pinned in revert.test.ts; this file pins down the
 * other eight tools that previously had no direct unit coverage:
 *
 *   read_file / list_files / search_code / write_file / patch_file /
 *   delete_file / rename_file / run_command (+ init_agents_md)
 *
 * Goals:
 *   - Each tool's happy path returns the documented "OK: ..." / content shape.
 *   - Each tool's known error paths return *strings starting with "Error:"*
 *     rather than throwing — agents handle string errors gracefully but a
 *     thrown exception surfaces as a tool failure that wastes a step.
 *   - run_command's pre/post-execution rewrites + block list are exercised.
 *   - init_agents_md's draft is well-formed markdown referencing real files.
 */

import { FileTreeManager } from "@wasmagent/core";
import { describe, expect, it } from "bun:test";
import { MemKvStore } from "../platform.js";
import {
  assertWorkspacePath,
  createDeleteFileTool,
  createInitAgentsMdTool,
  createListFilesTool,
  createPatchFileTool,
  createReadFileTool,
  createRenameFileTool,
  createRunCommandTool,
  createSearchCodeTool,
  createWriteFileTool,
} from "./index.js";

// ── read_file ───────────────────────────────────────────────────────────────
describe("read_file", () => {
  it("returns the stored content", async () => {
    const kv = new MemKvStore();
    await kv.put("file:src/a.ts", "hello");
    const tool = createReadFileTool(kv);
    const out = await tool.forward({ path: "src/a.ts" });
    expect(out).toBe("hello");
  });

  it("returns 'Error: File not found' for unknown path", async () => {
    const tool = createReadFileTool(new MemKvStore());
    const out = await tool.forward({ path: "missing.ts" });
    expect(out).toMatch(/^Error: File not found/);
  });

  it("returns an actionable error when KV is undefined", async () => {
    const tool = createReadFileTool(undefined);
    const out = await tool.forward({ path: "x.ts" });
    expect(out).toMatch(/^Error: file system unavailable/);
  });

  it("normalises leading slashes — read('/x.ts') matches stored 'x.ts'", async () => {
    const kv = new MemKvStore();
    await kv.put("file:x.ts", "one");
    const tool = createReadFileTool(kv);
    expect(await tool.forward({ path: "/x.ts" })).toBe("one");
  });
});

// ── list_files ──────────────────────────────────────────────────────────────
describe("list_files", () => {
  it("returns newline-separated paths without the 'file:' prefix", async () => {
    const kv = new MemKvStore();
    await kv.put("file:a.ts", "A");
    await kv.put("file:b/c.ts", "C");
    const tool = createListFilesTool(kv);
    const out = await tool.forward({});
    expect(out.split("\n").sort()).toEqual(["a.ts", "b/c.ts"]);
  });

  it("filters by prefix", async () => {
    const kv = new MemKvStore();
    await kv.put("file:src/a.ts", "");
    await kv.put("file:tests/x.ts", "");
    const tool = createListFilesTool(kv);
    const out = await tool.forward({ prefix: "src/" });
    expect(out).toBe("src/a.ts");
  });

  it("returns '(no files found)' on empty result", async () => {
    const tool = createListFilesTool(new MemKvStore());
    expect(await tool.forward({})).toBe("(no files found)");
  });

  it("returns actionable error when KV is undefined", async () => {
    const tool = createListFilesTool(undefined);
    expect(await tool.forward({})).toMatch(/^Error: file system unavailable/);
  });
});

// ── search_code ─────────────────────────────────────────────────────────────
describe("search_code", () => {
  it("returns lines matching the query with file:line: prefix", async () => {
    const kv = new MemKvStore();
    await kv.put("file:src/a.ts", "alpha\nbeta gamma\nalpha again");
    const tool = createSearchCodeTool(kv);
    const out = await tool.forward({ query: "alpha" });
    // Two matches in src/a.ts, lines 1 and 3.
    expect(out).toContain("src/a.ts:1: alpha");
    expect(out).toContain("src/a.ts:3: alpha again");
    expect(out).not.toContain("src/a.ts:2");
  });

  it("is case-insensitive", async () => {
    const kv = new MemKvStore();
    await kv.put("file:x.ts", "Hello\nworld");
    const tool = createSearchCodeTool(kv);
    const out = await tool.forward({ query: "hello" });
    expect(out).toMatch(/x\.ts:1:/);
  });

  it("returns 'No matches found' message when nothing matches", async () => {
    const kv = new MemKvStore();
    await kv.put("file:x.ts", "noise");
    const tool = createSearchCodeTool(kv);
    expect(await tool.forward({ query: "ghost" })).toMatch(/^No matches found for: ghost/);
  });

  it("respects path filter (limits the prefix sweep)", async () => {
    const kv = new MemKvStore();
    await kv.put("file:src/a.ts", "needle");
    await kv.put("file:other/b.ts", "needle");
    const tool = createSearchCodeTool(kv);
    const out = await tool.forward({ query: "needle", path: "src/a.ts" });
    expect(out).toContain("src/a.ts:1");
    expect(out).not.toContain("other/b.ts");
  });
});

// ── write_file ──────────────────────────────────────────────────────────────
describe("write_file", () => {
  it("writes content into KV and returns OK with char count", async () => {
    const kv = new MemKvStore();
    const tool = createWriteFileTool(kv);
    const out = await tool.forward({ path: "out.md", content: "hello world" });
    expect(out).toMatch(/^OK: written 11 chars to out\.md/);
    expect(await kv.get("file:out.md")).toBe("hello world");
  });

  it("records a version in FileTreeManager when one is wired", async () => {
    const kv = new MemKvStore();
    const tree = new FileTreeManager();
    const tool = createWriteFileTool(kv, tree);
    await tool.forward({ path: "y.ts", content: "v1" });
    await tool.forward({ path: "y.ts", content: "v2" });
    const versions = tree.getVersions("y.ts");
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
  });

  it("rejects writes to hard-locked paths (.dev.vars) with Error: ...", async () => {
    const kv = new MemKvStore();
    const tool = createWriteFileTool(kv);
    const out = await tool.forward({ path: ".dev.vars", content: "DANGER" });
    expect(out).toMatch(/^Error: /);
    // KV must NOT have been written.
    expect(await kv.get("file:.dev.vars")).toBeNull();
  });

  it("returns actionable error when KV is undefined", async () => {
    const tool = createWriteFileTool(undefined);
    const out = await tool.forward({ path: "a.ts", content: "x" });
    expect(out).toMatch(/^Error: file system unavailable/);
  });

  it("indexer upsert failures are logged but do NOT fail the write", async () => {
    const kv = new MemKvStore();
    const indexer = {
      upsert: async () => {
        throw new Error("boom");
      },
      remove: async () => {},
      rename: async () => {},
      search: async () => [],
      // SemanticIndexer requires a `retriever` field; tests don't exercise it
      // so a minimal shim is enough — the cast keeps the tool factory happy.
      retriever: { retrieve: async () => [] },
    };
    // biome-ignore lint/suspicious/noExplicitAny: minimal SemanticIndexer shim for the failure-isolation test
    const tool = createWriteFileTool(kv, undefined, indexer as any);
    const out = await tool.forward({ path: "z.ts", content: "ok" });
    expect(out).toMatch(/^OK: written/);
    expect(await kv.get("file:z.ts")).toBe("ok");
  });
});

// ── patch_file ──────────────────────────────────────────────────────────────
describe("patch_file", () => {
  // Minimal valid unified-diff patch: rewrite "alpha" to "ALPHA".
  // (jsdiff's applyPatch is permissive about hunk headers — keep this
  //  patch faithful to a real `diff -u` output so the test exercises
  //  the production code path.)
  const VALID_PATCH = ["--- a/x.ts", "+++ b/x.ts", "@@ -1 +1 @@", "-alpha", "+ALPHA", ""].join(
    "\n"
  );

  it("applies a unified-diff patch and returns OK with size delta", async () => {
    const kv = new MemKvStore();
    await kv.put("file:x.ts", "alpha\n");
    const tool = createPatchFileTool(kv);
    const out = await tool.forward({ path: "x.ts", patch: VALID_PATCH });
    expect(out).toMatch(/^OK: patched x\.ts \(\d+ → \d+ chars\)/);
    expect(await kv.get("file:x.ts")).toBe("ALPHA\n");
  });

  it("returns 'Error: File not found' when the target doesn't exist", async () => {
    const tool = createPatchFileTool(new MemKvStore());
    expect(await tool.forward({ path: "missing.ts", patch: VALID_PATCH })).toMatch(
      /^Error: File not found/
    );
  });

  it("returns 'Error: Patch failed' when the hunk doesn't match", async () => {
    const kv = new MemKvStore();
    await kv.put("file:x.ts", "totally different content\n");
    const tool = createPatchFileTool(kv);
    const out = await tool.forward({ path: "x.ts", patch: VALID_PATCH });
    expect(out).toMatch(/^Error: Patch failed/);
    // The original content is preserved on a failed patch.
    expect(await kv.get("file:x.ts")).toBe("totally different content\n");
  });

  it("rejects writes to hard-locked paths with Error: ...", async () => {
    const kv = new MemKvStore();
    await kv.put("file:.dev.vars", "API_KEY=real\n");
    const tool = createPatchFileTool(kv);
    const out = await tool.forward({ path: ".dev.vars", patch: VALID_PATCH });
    expect(out).toMatch(/^Error: /);
    expect(await kv.get("file:.dev.vars")).toBe("API_KEY=real\n");
  });
});

// ── delete_file ─────────────────────────────────────────────────────────────
describe("delete_file", () => {
  it("removes the file and returns OK", async () => {
    const kv = new MemKvStore();
    await kv.put("file:doomed.ts", "x");
    const tool = createDeleteFileTool(kv);
    const out = await tool.forward({ path: "doomed.ts" });
    expect(out).toMatch(/^OK: deleted doomed\.ts/);
    expect(await kv.get("file:doomed.ts")).toBeNull();
  });

  it("returns 'Error: File not found' for unknown path", async () => {
    const tool = createDeleteFileTool(new MemKvStore());
    expect(await tool.forward({ path: "ghost.ts" })).toMatch(/^Error: File not found/);
  });

  it("rejects writes to hard-locked paths", async () => {
    const kv = new MemKvStore();
    await kv.put("file:.dev.vars", "secret\n");
    const tool = createDeleteFileTool(kv);
    expect(await tool.forward({ path: ".dev.vars" })).toMatch(/^Error: /);
    expect(await kv.get("file:.dev.vars")).toBe("secret\n");
  });

  it("returns actionable error when KV is undefined", async () => {
    const tool = createDeleteFileTool(undefined);
    expect(await tool.forward({ path: "a.ts" })).toMatch(/^Error: file system unavailable/);
  });
});

// ── rename_file ─────────────────────────────────────────────────────────────
describe("rename_file", () => {
  it("moves content from src to dst and removes src", async () => {
    const kv = new MemKvStore();
    await kv.put("file:old.ts", "content");
    const tool = createRenameFileTool(kv);
    const out = await tool.forward({ from: "old.ts", to: "new.ts" });
    expect(out).toMatch(/^OK: renamed old\.ts → new\.ts/);
    expect(await kv.get("file:old.ts")).toBeNull();
    expect(await kv.get("file:new.ts")).toBe("content");
  });

  it("returns 'Error: File not found' when src is missing", async () => {
    const tool = createRenameFileTool(new MemKvStore());
    expect(await tool.forward({ from: "ghost.ts", to: "new.ts" })).toMatch(
      /^Error: File not found/
    );
  });
});

// ── run_command ─────────────────────────────────────────────────────────────
describe("run_command", () => {
  it("returns simulation hint when no shellRunner is wired", async () => {
    const tool = createRunCommandTool(undefined);
    const out = await tool.forward({ command: "npm test" });
    // The simulation echoes the command and notes the unavailable shell.
    expect(out).toContain("$ npm test");
    expect(out).toMatch(/simulation/);
  });

  it("simulation branch with `code` does NOT execute model-supplied JS (SEC-014)", async () => {
    // Regression: before the SEC-014 fix, this branch ran Function() over
    // the supplied code. The argument here would have escaped that sandbox
    // by reaching globalThis. We assert the safe replacement string.
    const tool = createRunCommandTool(undefined);
    const out = await tool.forward({
      command: "noop",
      code: "globalThis.__pwned = true",
    });
    expect(out).toMatch(/code execution disabled/);
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
  });

  it("delegates to shellRunner and returns its output", async () => {
    const calls: string[][] = [];
    const runner = async (argv: string[]) => {
      calls.push(argv);
      return "exit:0\nhello world";
    };
    const tool = createRunCommandTool(runner);
    const out = await tool.forward({ command: "echo hello world" });
    expect(calls).toEqual([["echo", "hello", "world"]]);
    expect(out).toBe("exit:0\nhello world");
  });

  it("auto-rewrites bare `rm` to `rm -f` to dodge No-such-file failures", async () => {
    const calls: string[][] = [];
    const runner = async (argv: string[]) => {
      calls.push(argv);
      return "exit:0\n";
    };
    const tool = createRunCommandTool(runner);
    await tool.forward({ command: "rm /tmp/some-thing" });
    expect(calls[0]).toEqual(["rm", "-f", "/tmp/some-thing"]);
  });

  it("auto-rewrites bare `mkdir` to `mkdir -p` to dodge already-exists failures", async () => {
    const calls: string[][] = [];
    const runner = async (argv: string[]) => {
      calls.push(argv);
      return "exit:0\n";
    };
    const tool = createRunCommandTool(runner);
    await tool.forward({ command: "mkdir foo/bar" });
    expect(calls[0]).toEqual(["mkdir", "-p", "foo/bar"]);
  });

  it("blocks rm -rf / with 'Error: Command blocked'", async () => {
    const runner = async () => "should-not-run";
    const tool = createRunCommandTool(runner);
    expect(await tool.forward({ command: "rm -rf /" })).toMatch(/^Error: Command blocked/);
  });

  it("blocks rm -rf with extra slashes after root (regression for SEC-015)", async () => {
    // Before SEC-015 the bare `rm -rf /` (no trailing path segment) slipped
    // past the block list because the original `\b` anchor required a
    // word-char neighbour. Cover both the bare and the trailing-segment
    // forms so the regression can't recur silently.
    const runner = async () => "should-not-run";
    const tool = createRunCommandTool(runner);
    for (const cmd of ["rm -rf /", "rm -rf / ", "rm -rf /usr/local", "rm  -rf  /"]) {
      const out = await tool.forward({ command: cmd });
      expect(out, `expected '${cmd}' to be blocked`).toMatch(/^Error: Command blocked/);
    }
  });

  it("blocks DROP TABLE / DELETE FROM ... ; statements", async () => {
    const runner = async () => "should-not-run";
    const tool = createRunCommandTool(runner);
    expect(await tool.forward({ command: "DROP TABLE users" })).toMatch(/^Error: Command blocked/);
    expect(await tool.forward({ command: "DELETE FROM users;" })).toMatch(
      /^Error: Command blocked/
    );
  });

  it("appends a 'No such file' hint when exit-code is non-zero", async () => {
    const runner = async () => "exit:1\nls: cannot access 'x': No such file or directory";
    const tool = createRunCommandTool(runner);
    const out = await tool.forward({ command: "ls x" });
    expect(out).toMatch(/Hint: The file\/directory doesn't exist/);
  });

  it("appends a 'command not found' hint and surfaces the missing binary", async () => {
    const runner = async () => "exit:127\nbash: foozle: command not found";
    const tool = createRunCommandTool(runner);
    const out = await tool.forward({ command: "foozle" });
    expect(out).toMatch(/Hint: 'foozle' not found/);
  });

  it("appends a 'Permission denied' hint", async () => {
    const runner = async () => "exit:1\nbash: ./script.sh: Permission denied";
    const tool = createRunCommandTool(runner);
    const out = await tool.forward({ command: "./script.sh" });
    expect(out).toMatch(/Hint: Permission denied/);
  });

  it("appends a 'Cannot find module' hint", async () => {
    const runner = async () => "exit:1\nError: Cannot find module 'react'";
    const tool = createRunCommandTool(runner);
    const out = await tool.forward({ command: "node app.js" });
    expect(out).toMatch(/Hint: Missing npm package/);
  });

  it("appends a runtime-error hint for SyntaxError/TypeError", async () => {
    const runner = async () => "exit:1\nReferenceError: foo is not defined";
    const tool = createRunCommandTool(runner);
    const out = await tool.forward({ command: "node bad.js" });
    expect(out).toMatch(/Hint: Code syntax\/runtime error/);
  });
});

// ── init_agents_md ──────────────────────────────────────────────────────────
describe("init_agents_md", () => {
  it("declares needsApproval=true so it cannot bypass the HITL gate", () => {
    const tool = createInitAgentsMdTool(new MemKvStore());
    expect(tool.needsApproval).toBe(true);
  });

  it("returns a draft that mentions sampled files from the workspace", async () => {
    const kv = new MemKvStore();
    await kv.put("file:package.json", "{}");
    await kv.put("file:src/index.ts", "export {}");
    await kv.put("file:README.md", "# Project");
    const tool = createInitAgentsMdTool(kv);
    const draft = await tool.forward({ scope: "" });
    expect(typeof draft).toBe("string");
    expect((draft as string).startsWith("# AGENTS.md")).toBe(true);
    expect(draft).toContain("package.json");
    expect(draft).toContain("src/index.ts");
    expect(draft).toContain("README.md");
    // Section headers are present.
    expect(draft).toMatch(/## Conventions/);
    expect(draft).toMatch(/## Build & test/);
    expect(draft).toMatch(/## Boundaries/);
  });

  it("includes user notes when supplied", async () => {
    const tool = createInitAgentsMdTool(new MemKvStore());
    const draft = (await tool.forward({
      scope: "",
      notes: "Use bun. Run pnpm test before committing.",
    })) as string;
    expect(draft).toContain("## Project-specific notes");
    expect(draft).toContain("Use bun. Run pnpm test before committing.");
  });

  it("scopes file sampling to the requested subdirectory", async () => {
    const kv = new MemKvStore();
    await kv.put("file:apps/worker/package.json", "{}");
    await kv.put("file:apps/web/package.json", "{}");
    const tool = createInitAgentsMdTool(kv);
    const draft = (await tool.forward({ scope: "apps/worker" })) as string;
    expect(draft).toContain("apps/worker/package.json");
    expect(draft).not.toContain("apps/web/package.json");
    // Header reflects the scope.
    expect(draft).toMatch(/^# AGENTS\.md \(apps\/worker\)/);
  });

  it("returns the no-files-visible placeholder when KV is empty", async () => {
    const tool = createInitAgentsMdTool(new MemKvStore());
    const draft = (await tool.forward({ scope: "" })) as string;
    expect(draft).toContain("(no files visible to sample)");
  });

  it("falls back gracefully when filesKv is undefined", async () => {
    const tool = createInitAgentsMdTool(undefined);
    const draft = (await tool.forward({ scope: "" })) as string;
    expect(draft).toContain("(no files visible to sample)");
  });
});

// ── assertWorkspacePath ─────────────────────────────────────────────────────
//
// SEC-013 (commit 22791ae) added path validation but the regression
// fixtures only covered the traversal + absolute-path cases. The control-
// character / bidi-override branch was never directly tested — and that's
// the branch most likely to silently regress when refactored. Pin every
// rejection class so any future change to assertWorkspacePath proves
// it still rejects each.

describe("assertWorkspacePath", () => {
  it("accepts ordinary workspace-relative paths", () => {
    for (const p of ["a.ts", "src/a.ts", "deep/nested/path/file.ts", "weird name.md"]) {
      expect(() => assertWorkspacePath(p)).not.toThrow();
    }
  });

  it("rejects empty / non-string input", () => {
    expect(() => assertWorkspacePath("")).toThrow(/non-empty string/);
    // biome-ignore lint/suspicious/noExplicitAny: deliberate bad input for type-edge coverage
    expect(() => assertWorkspacePath(null as any)).toThrow(/non-empty string/);
  });

  it("rejects paths exceeding 1024 chars", () => {
    expect(() => assertWorkspacePath("a".repeat(1025))).toThrow(/exceeds 1024/);
  });

  it("rejects absolute paths", () => {
    for (const p of ["/etc/passwd", "/var/log/x", "/"]) {
      expect(() => assertWorkspacePath(p)).toThrow(/absolute paths are not allowed/);
    }
  });

  it("rejects ../ traversal segments (forward + back slashes)", () => {
    for (const p of ["../etc", "src/../../../etc", "..\\.\\..\\windows"]) {
      expect(() => assertWorkspacePath(p)).toThrow(/traversal segments are not allowed/);
    }
  });

  it("rejects NUL byte and other C0 control codes (regression for bidi/control branch)", () => {
    // The branch implementing this rejection was rewritten 2026-06-16 from
    // a regex with raw control bytes to a charCode scan. Pin every class
    // of codepoint it rejects so the next refactor preserves the security
    // property. Construct fixtures via String.fromCharCode so the source
    // file stays free of literal control bytes.
    const NUL = String.fromCharCode(0x00);
    const TAB = String.fromCharCode(0x09);
    const LF = String.fromCharCode(0x0a);
    const ESC = String.fromCharCode(0x1b);
    for (const cc of [NUL, TAB, LF, ESC]) {
      expect(() => assertWorkspacePath(`bad${cc}name.txt`)).toThrow(
        /control or unicode-override characters/
      );
    }
  });

  it("rejects DEL (U+007F)", () => {
    const DEL = String.fromCharCode(0x7f);
    expect(() => assertWorkspacePath(`bad${DEL}name.txt`)).toThrow(/control or unicode-override/);
  });

  it("rejects bidi formatting overrides (U+202A..U+202E)", () => {
    // RTL/LRO override marks let an attacker spoof a path that looks like
    // "report.pdf" but reads as "report.exe" in audit logs. Reject all 5.
    for (const cc of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e]) {
      const p = `safe${String.fromCharCode(cc)}name.txt`;
      expect(() => assertWorkspacePath(p), `expected U+${cc.toString(16)} to be rejected`).toThrow(
        /control or unicode-override/
      );
    }
  });

  it("rejects bidi isolates (U+2066..U+2069)", () => {
    for (const cc of [0x2066, 0x2067, 0x2068, 0x2069]) {
      const p = `safe${String.fromCharCode(cc)}name.txt`;
      expect(() => assertWorkspacePath(p), `expected U+${cc.toString(16)} to be rejected`).toThrow(
        /control or unicode-override/
      );
    }
  });

  it("accepts non-control unicode (CJK, accented Latin) — only the override range is forbidden", () => {
    // Sanity that the rejection isn't over-broad — it must let through
    // legitimate non-ASCII characters used in real filenames.
    for (const p of ["报告.md", "café.md", "naïve_test.ts"]) {
      expect(() => assertWorkspacePath(p)).not.toThrow();
    }
  });
});

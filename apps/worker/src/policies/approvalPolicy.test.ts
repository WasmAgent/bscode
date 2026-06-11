/**
 * B4 — Approval policy tests.
 *
 * Verifies the contract from approvalPolicy.ts:
 *   - default verdict applies when no rules match
 *   - first matching rule decides; later rules don't get a vote
 *   - path matching is prefix-based (eg "src" matches "src/foo.ts")
 *   - op filtering and minSizeChars filtering compose with paths
 *   - applyApprovalPolicy wraps write/patch/delete/rename tools and
 *     leaves unrelated tools alone
 *   - presets behave as advertised
 */

import { z } from "zod";
import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@agentkit-js/core";
import {
  applyApprovalPolicy,
  ApprovalPolicy,
  PolicyPresets,
} from "./approvalPolicy.js";

function fakeTool(name: string, hasInput: boolean): ToolDefinition {
  return {
    name,
    description: `fake ${name}`,
    inputSchema: hasInput
      ? z.object({ path: z.string(), content: z.string().optional(), patch: z.string().optional(), from: z.string().optional() })
      : z.object({}),
    outputSchema: z.string(),
    readOnly: false,
    idempotent: false,
    forward: async () => "ok",
  } satisfies ToolDefinition;
}

describe("ApprovalPolicy", () => {
  it("returns the default verdict when no rules match", () => {
    const allowing = new ApprovalPolicy({ defaultVerdict: "allow", rules: [] });
    const requiring = new ApprovalPolicy({ defaultVerdict: "require", rules: [] });
    const q = { op: "write" as const, path: "src/foo.ts", sizeChars: 100 };
    expect(allowing.needsApproval(q)).toBe(false);
    expect(requiring.needsApproval(q)).toBe(true);
  });

  it("first matching rule decides — later rules don't get a vote", () => {
    const policy = new ApprovalPolicy({
      defaultVerdict: "require",
      rules: [
        { id: "allow-tests", match: { paths: ["test/"] }, verdict: "allow" },
        { id: "require-everything", verdict: "require" }, // would otherwise win
      ],
    });
    expect(policy.needsApproval({ op: "write", path: "test/foo.ts", sizeChars: 0 })).toBe(false);
    // The "allow-tests" rule didn't match; defaults to require.
    expect(policy.needsApproval({ op: "write", path: "src/foo.ts", sizeChars: 0 })).toBe(true);
  });

  it("path matching is prefix-based", () => {
    const policy = new ApprovalPolicy({
      defaultVerdict: "allow",
      rules: [{ id: ".env-block", match: { paths: [".env"] }, verdict: "require" }],
    });
    expect(policy.needsApproval({ op: "write", path: ".env", sizeChars: 0 })).toBe(true);
    // Both ".env.local" (same-prefix sibling, single string) and "src/foo.ts" handled correctly.
    expect(policy.needsApproval({ op: "write", path: ".env.local", sizeChars: 0 })).toBe(true);
    expect(policy.needsApproval({ op: "write", path: "src/foo.ts", sizeChars: 0 })).toBe(false);
  });

  it("op filter narrows a rule to specific operations", () => {
    const policy = new ApprovalPolicy({
      defaultVerdict: "allow",
      rules: [{ id: "no-delete", match: { op: "delete" }, verdict: "require" }],
    });
    expect(policy.needsApproval({ op: "write", path: "x", sizeChars: 0 })).toBe(false);
    expect(policy.needsApproval({ op: "delete", path: "x", sizeChars: 0 })).toBe(true);
  });

  it("minSizeChars gates large writes", () => {
    const policy = new ApprovalPolicy({
      defaultVerdict: "allow",
      rules: [
        { id: "big-writes", match: { op: "write", minSizeChars: 1000 }, verdict: "require" },
      ],
    });
    expect(policy.needsApproval({ op: "write", path: "x", sizeChars: 500 })).toBe(false);
    expect(policy.needsApproval({ op: "write", path: "x", sizeChars: 5000 })).toBe(true);
  });

  it("explain surfaces the matched rule id (audit log)", () => {
    const policy = new ApprovalPolicy({
      defaultVerdict: "allow",
      rules: [{ id: "rule-1", match: { paths: ["src/"] }, verdict: "require" }],
    });
    expect(policy.explain({ op: "write", path: "src/x.ts", sizeChars: 0 })).toEqual({
      ruleId: "rule-1",
      verdict: "require",
    });
    expect(policy.explain({ op: "write", path: "docs/x.md", sizeChars: 0 })).toEqual({
      ruleId: null,
      verdict: "allow",
    });
  });
});

describe("applyApprovalPolicy", () => {
  it("wraps write_file with a policy-driven needsApproval", () => {
    const tools = [
      fakeTool("write_file", true),
      fakeTool("read_file", true),
    ];
    const policy = new ApprovalPolicy({
      defaultVerdict: "allow",
      rules: [{ id: "block-env", match: { paths: [".env"] }, verdict: "require" }],
    });
    const wrapped = applyApprovalPolicy(policy, tools);
    const writeTool = wrapped.find((t) => t.name === "write_file");
    expect(typeof writeTool?.needsApproval).toBe("function");
    const fn = writeTool?.needsApproval as (input: { path: string; content: string }) => boolean;
    expect(fn({ path: "src/foo.ts", content: "x" })).toBe(false);
    expect(fn({ path: ".env", content: "x" })).toBe(true);

    // Unrelated tool is left alone.
    const readTool = wrapped.find((t) => t.name === "read_file");
    expect(readTool?.needsApproval).toBeUndefined();
  });

  it("wraps patch_file using the patch length as size", () => {
    const tools = [fakeTool("patch_file", true)];
    const policy = new ApprovalPolicy({
      defaultVerdict: "allow",
      rules: [{ id: "big-patches", match: { op: "patch", minSizeChars: 100 }, verdict: "require" }],
    });
    const wrapped = applyApprovalPolicy(policy, tools);
    const fn = wrapped[0]?.needsApproval as (i: { path: string; patch: string }) => boolean;
    expect(fn({ path: "x", patch: "small" })).toBe(false);
    expect(fn({ path: "x", patch: "L".repeat(200) })).toBe(true);
  });

  it("wraps delete_file and rename_file based on op", () => {
    const tools = [fakeTool("delete_file", true), fakeTool("rename_file", true)];
    const policy = new ApprovalPolicy({
      defaultVerdict: "allow",
      rules: [{ id: "no-destructive", match: { op: ["delete", "rename"] }, verdict: "require" }],
    });
    const wrapped = applyApprovalPolicy(policy, tools);
    const del = wrapped.find((t) => t.name === "delete_file");
    const ren = wrapped.find((t) => t.name === "rename_file");
    expect((del?.needsApproval as (i: { path: string }) => boolean)({ path: "x" })).toBe(true);
    expect((ren?.needsApproval as (i: { from: string; to: string }) => boolean)({ from: "a", to: "b" })).toBe(true);
  });
});

describe("PolicyPresets", () => {
  it("permissive lets every write through", () => {
    const policy = PolicyPresets.permissive();
    expect(policy.needsApproval({ op: "write", path: ".env", sizeChars: 100_000 })).toBe(false);
  });

  it("strict requires approval on every write", () => {
    const policy = PolicyPresets.strict();
    expect(policy.needsApproval({ op: "write", path: "src/foo.ts", sizeChars: 0 })).toBe(true);
  });

  it("balanced gates dotfiles, deletes, renames, and large writes", () => {
    const policy = PolicyPresets.balanced();
    // Dotfile — required.
    expect(policy.needsApproval({ op: "write", path: ".env", sizeChars: 50 })).toBe(true);
    // Small write to a normal path — allowed.
    expect(policy.needsApproval({ op: "write", path: "src/foo.ts", sizeChars: 100 })).toBe(false);
    // Large write to a normal path — required.
    expect(policy.needsApproval({ op: "write", path: "src/foo.ts", sizeChars: 6_000 })).toBe(true);
    // Delete — required.
    expect(policy.needsApproval({ op: "delete", path: "src/foo.ts", sizeChars: 0 })).toBe(true);
    // Rename — required.
    expect(policy.needsApproval({ op: "rename", path: "src/foo.ts", sizeChars: 0 })).toBe(true);
  });
});

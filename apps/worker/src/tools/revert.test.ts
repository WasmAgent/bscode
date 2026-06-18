/**
 * B4 — revert_file + list_file_versions tool tests.
 */

import { FileTreeManager } from "@wasmagent/core";
import { describe, expect, it } from "bun:test";
import { MemKvStore } from "../platform.js";
import { createListFileVersionsTool, createRevertFileTool, createWriteFileTool } from "./index.js";

describe("revert_file + list_file_versions (B4)", () => {
  it("write_file records versions; revert restores prior content", async () => {
    const kv = new MemKvStore();
    const tree = new FileTreeManager();
    const writeTool = createWriteFileTool(kv, tree);
    const revertTool = createRevertFileTool(kv, tree);
    const listTool = createListFileVersionsTool(tree);

    await writeTool.forward({ path: "src/foo.ts", content: "v1 content" });
    await writeTool.forward({ path: "src/foo.ts", content: "v2 content" });
    await writeTool.forward({ path: "src/foo.ts", content: "v3 content" });

    const versionsRaw = await listTool.forward({ path: "src/foo.ts" });
    expect(versionsRaw).toContain("v1");
    expect(versionsRaw).toContain("v2");
    expect(versionsRaw).toContain("v3");

    const result = await revertTool.forward({ path: "src/foo.ts", version: 1 });
    expect(result.startsWith("OK:")).toBe(true);

    // Live KV must reflect the rollback.
    expect(await kv.get("file:src/foo.ts")).toBe("v1 content");
  });

  it("revert_file returns an error for unknown version", async () => {
    const kv = new MemKvStore();
    const tree = new FileTreeManager();
    const writeTool = createWriteFileTool(kv, tree);
    const revertTool = createRevertFileTool(kv, tree);

    await writeTool.forward({ path: "a.ts", content: "x" });
    const out = await revertTool.forward({ path: "a.ts", version: 999 });
    expect(out.startsWith("Error:")).toBe(true);
  });

  it("list_file_versions returns informative message when no history exists", async () => {
    const tree = new FileTreeManager();
    const listTool = createListFileVersionsTool(tree);
    expect(await listTool.forward({ path: "missing.ts" })).toContain("No versions");
  });

  it("revert tool advertises non-readOnly so it routes through the write path", () => {
    const tool = createRevertFileTool(undefined, undefined);
    expect(tool.readOnly).toBe(false);
    expect(tool.idempotent).toBe(false);
  });
});

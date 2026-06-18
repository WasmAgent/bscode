/**
 * B2 — semantic_search tool tests.
 *
 * Covers the in-process TF-IDF path (zero-deps default) end-to-end:
 *  - upsert/remove/rename keep the index in sync
 *  - the tool returns ranked hits with path + preview
 *  - tombstoned entries (deleted files) are filtered from results
 */

import { describe, expect, it } from "bun:test";
import { createSemanticIndexer, createSemanticSearchTool } from "./semanticSearch.js";

describe("createSemanticIndexer (in-process default)", () => {
  it("upsert + search returns the most relevant doc first", async () => {
    const idx = createSemanticIndexer();
    await idx.upsert("src/auth.ts", "authentication module: validates JWT tokens and sessions");
    await idx.upsert("src/cart.ts", "shopping cart code — adds items, computes totals");
    await idx.upsert("src/email.ts", "send confirmation email via SMTP transport");

    const tool = createSemanticSearchTool(idx);
    const result = await tool.forward({ query: "where is auth handled", topK: 3 });
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]?.path).toBe("src/auth.ts");
  });

  it("remove tombstones the entry so it stops appearing in results", async () => {
    const idx = createSemanticIndexer();
    await idx.upsert("a.ts", "alpha bravo charlie tokens");
    await idx.upsert("b.ts", "alpha delta echo tokens");
    await idx.remove("a.ts");

    const tool = createSemanticSearchTool(idx);
    const result = await tool.forward({ query: "alpha bravo", topK: 5 });
    // The deleted entry must not appear in the surfaced results.
    expect(result.results.find((r) => r.path === "a.ts")).toBeUndefined();
  });

  it("rename moves the entry id without losing recall", async () => {
    const idx = createSemanticIndexer();
    await idx.upsert("old.ts", "checkout payment processor stripe integration");
    await idx.rename("old.ts", "new.ts", "checkout payment processor stripe integration");

    const tool = createSemanticSearchTool(idx);
    const result = await tool.forward({ query: "stripe payment", topK: 3 });
    expect(result.results[0]?.path).toBe("new.ts");
    expect(result.results.find((r) => r.path === "old.ts")).toBeUndefined();
  });

  it("tool advertises readOnly + idempotent so DAG scheduler can run it speculatively", () => {
    const idx = createSemanticIndexer();
    const tool = createSemanticSearchTool(idx);
    expect(tool.readOnly).toBe(true);
    expect(tool.idempotent).toBe(true);
    expect(tool.trust).toBe("untrusted");
  });

  it("preview is truncated to ≤200 chars", async () => {
    const idx = createSemanticIndexer();
    await idx.upsert("big.ts", "x".repeat(5000));
    const tool = createSemanticSearchTool(idx);
    const result = await tool.forward({ query: "x", topK: 1 });
    expect(result.results[0]?.preview.length).toBeLessThanOrEqual(200);
  });
});

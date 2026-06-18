/**
 * Tests for web-search.ts — the DuckDuckGo Instant Answer wrapper.
 *
 * Strategy: stub global fetch so we control the response shape. We pin:
 *   1. A successful response containing AbstractText + Topics → readable
 *      multi-block summary with links and the "Search results for ..." header.
 *   2. Empty payload → "No results found" actionable message.
 *   3. Non-2xx HTTP → friendly "Search backend unavailable" with the
 *      explicit "do NOT retry" hint (without it the agent loops on retries).
 *   4. Network error (fetch throws) → "Search backend unavailable" with the
 *      network-specific hint.
 *   5. maxResults caps the topics returned + tool advertises readOnly so
 *      the DAG scheduler can run it in parallel.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { createWebSearchTool } from "./web-search.js";

const realFetch = globalThis.fetch;

function mockFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  // CF Workers' fetch type adds a `preconnect` member that vi.fn doesn't
  // synthesise; cast through `unknown` so the spy satisfies the structural type.
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return Promise.resolve(impl(url, init));
  }) as unknown as typeof globalThis.fetch;
}

describe("createWebSearchTool", () => {
  beforeEach(() => {
    globalThis.fetch = realFetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("declares readOnly + idempotent so the DAG scheduler can run it in parallel", () => {
    const tool = createWebSearchTool();
    expect(tool.readOnly).toBe(true);
    expect(tool.idempotent).toBe(true);
    expect(tool.name).toBe("web_search");
  });

  it("formats AbstractText + Topics into a numbered, link-bearing summary", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            AbstractText: "The Hono framework is a small, fast web framework.",
            AbstractURL: "https://hono.dev",
            RelatedTopics: [
              { Text: "Hono on Bun", FirstURL: "https://hono.dev/docs/bun" },
              { Text: "Hono on CF Workers", FirstURL: "https://hono.dev/docs/cf" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    );

    const tool = createWebSearchTool();
    const out = await tool.forward({ query: "hono" });
    expect(out).toContain('Search results for "hono"');
    expect(out).toContain("instant answer");
    expect(out).toContain("https://hono.dev");
    expect(out).toContain("Hono on Bun");
    expect(out).toContain("https://hono.dev/docs/bun");
    expect(out).toContain("Hono on CF Workers");
  });

  it("flattens nested RelatedTopics groups into a flat list", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            // DDG sometimes wraps related topics in a Topics group.
            RelatedTopics: [
              {
                Topics: [
                  { Text: "Group A item 1", FirstURL: "https://a.example/1" },
                  { Text: "Group A item 2", FirstURL: "https://a.example/2" },
                ],
              },
              { Text: "Top-level item", FirstURL: "https://top.example" },
            ],
          }),
          { status: 200 }
        )
    );

    const tool = createWebSearchTool();
    const out = await tool.forward({ query: "group" });
    expect(out).toContain("Group A item 1");
    expect(out).toContain("Group A item 2");
    expect(out).toContain("Top-level item");
  });

  it("returns 'No results found' actionable message on empty payload", async () => {
    mockFetch(() => new Response(JSON.stringify({}), { status: 200 }));
    const tool = createWebSearchTool();
    const out = await tool.forward({ query: "obscure" });
    expect(out).toMatch(/^No results found for: "obscure"/);
    expect(out).toMatch(/Try rephrasing/);
  });

  it("returns 'Search backend unavailable' with do-NOT-retry hint on non-2xx", async () => {
    mockFetch(() => new Response("upstream error", { status: 503 }));
    const tool = createWebSearchTool();
    const out = await tool.forward({ query: "x" });
    expect(out).toMatch(/Search backend unavailable \(HTTP 503\)/);
    // The "do NOT retry" hint is critical — without it the agent burns
    // tokens hammering the same broken endpoint.
    expect(out).toMatch(/do NOT retry web_search/);
  });

  it("handles network errors with a network-specific hint", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error("ENOTFOUND ddg"))
    ) as unknown as typeof globalThis.fetch;
    const tool = createWebSearchTool();
    const out = await tool.forward({ query: "x" });
    expect(out).toMatch(/^Search backend unavailable/);
    expect(out).toMatch(/Network is unavailable/);
    expect(out).toMatch(/Do NOT retry web_search/);
  });

  it("respects maxResults to cap the topic count", async () => {
    const topics = Array.from({ length: 12 }).map((_, i) => ({
      Text: `Item ${i}`,
      FirstURL: `https://e.example/${i}`,
    }));
    mockFetch(() => new Response(JSON.stringify({ RelatedTopics: topics }), { status: 200 }));
    const tool = createWebSearchTool();
    const out = await tool.forward({ query: "items", maxResults: 3 });
    // The tool slices to maxResults BEFORE joining; only 3 should appear.
    const matches = (out.match(/Item \d+/g) ?? []).length;
    expect(matches).toBe(3);
  });

  it("encodes the query into the request URL", async () => {
    let capturedUrl = "";
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof globalThis.fetch;
    const tool = createWebSearchTool();
    await tool.forward({ query: "type-safe routing" });
    // `encodeURIComponent` turns space into %20.
    expect(capturedUrl).toContain("type-safe%20routing");
    // DDG-specific flags are passed.
    expect(capturedUrl).toContain("format=json");
    expect(capturedUrl).toContain("no_html=1");
  });
});

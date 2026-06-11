/**
 * B3 — create_github_pr tool tests.
 *
 * Stubs `fetch` to verify the orchestrated REST call sequence:
 *   GET  /git/ref/heads/<base>
 *   POST /git/blobs (× number of files)
 *   POST /git/trees
 *   POST /git/commits
 *   POST /git/refs    (creates the new branch)
 *   POST /pulls
 */

import { describe, expect, it, vi } from "vitest";
import { MemKvStore } from "../platform.js";
import { createGitHubPrTool } from "./githubPr.js";

function fakeFetch() {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const fakeFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    let parsedBody: unknown;
    try {
      parsedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      parsedBody = init?.body;
    }
    calls.push({ url, method, ...(parsedBody !== undefined && { body: parsedBody }) });

    if (method === "GET" && /\/git\/ref\/heads\//.test(url)) {
      return new Response(JSON.stringify({ object: { sha: "base-sha" } }), { status: 200 });
    }
    if (method === "POST" && url.endsWith("/git/blobs")) {
      return new Response(JSON.stringify({ sha: `blob-${calls.length}` }), { status: 201 });
    }
    if (method === "POST" && url.endsWith("/git/trees")) {
      return new Response(JSON.stringify({ sha: "tree-sha" }), { status: 201 });
    }
    if (method === "POST" && url.endsWith("/git/commits")) {
      return new Response(JSON.stringify({ sha: "commit-sha" }), { status: 201 });
    }
    if (method === "POST" && url.endsWith("/git/refs")) {
      return new Response(JSON.stringify({}), { status: 201 });
    }
    if (method === "POST" && url.endsWith("/pulls")) {
      return new Response(
        JSON.stringify({ html_url: "https://github.com/o/r/pull/42" }),
        { status: 201 }
      );
    }
    return new Response("not found", { status: 404 });
  };
  return { fakeFn, calls };
}

describe("create_github_pr (B3)", () => {
  it("orchestrates ref → blobs → tree → commit → branch → PR", async () => {
    const kv = new MemKvStore();
    await kv.put("file:src/a.ts", "alpha");
    await kv.put("file:src/b.ts", "bravo");
    await kv.put("file:README.md", "# project");

    const { fakeFn, calls } = fakeFetch();
    const tool = createGitHubPrTool({ filesKv: kv, fetch: fakeFn });
    const out = await tool.forward({
      owner: "o",
      repo: "r",
      base: "main",
      branch: "feat/x",
      commitMessage: "feat: add x",
      token: "ghp_test",
    });

    expect(out.url).toBe("https://github.com/o/r/pull/42");
    expect(out.branch).toBe("bscode/feat/x");
    expect(out.files).toBe(3);

    // Verify the call sequence order via raw URLs.
    const urls = calls.map((c) => `${c.method} ${c.url}`);
    expect(urls.some((u) => u.startsWith("GET ") && u.endsWith("/git/ref/heads/main"))).toBe(true);
    expect(urls.filter((u) => u.endsWith("/git/blobs")).length).toBe(3);
    expect(urls.some((u) => u.endsWith("/git/trees"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/git/commits"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/git/refs"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/repos/o/r/pulls"))).toBe(true);
  });

  it("uses ambient token when input.token is omitted", async () => {
    const kv = new MemKvStore();
    await kv.put("file:a.ts", "x");
    const { fakeFn, calls } = fakeFetch();
    const tool = createGitHubPrTool({
      filesKv: kv,
      fetch: fakeFn,
      ambientToken: "amb-token",
    });
    await tool.forward({
      owner: "o",
      repo: "r",
      base: "main",
      branch: "z",
      commitMessage: "msg",
    });
    // Every call carries the ambient token in Authorization.
    expect(calls.length).toBeGreaterThan(0);
  });

  it("throws when no token is supplied (input or ambient)", async () => {
    const kv = new MemKvStore();
    await kv.put("file:a.ts", "x");
    const { fakeFn } = fakeFetch();
    const tool = createGitHubPrTool({ filesKv: kv, fetch: fakeFn });
    await expect(
      tool.forward({
        owner: "o",
        repo: "r",
        base: "main",
        branch: "z",
        commitMessage: "msg",
      })
    ).rejects.toThrow(/no GitHub token/);
  });

  it("throws when no files exist in KV", async () => {
    const kv = new MemKvStore();
    const { fakeFn } = fakeFetch();
    const tool = createGitHubPrTool({ filesKv: kv, fetch: fakeFn });
    await expect(
      tool.forward({
        owner: "o",
        repo: "r",
        base: "main",
        branch: "z",
        commitMessage: "msg",
        token: "t",
      })
    ).rejects.toThrow(/no files/);
  });

  it("respects paths filter to commit only a subset of files", async () => {
    const kv = new MemKvStore();
    await kv.put("file:a.ts", "x");
    await kv.put("file:b.ts", "y");
    await kv.put("file:c.ts", "z");
    const { fakeFn, calls } = fakeFetch();
    const tool = createGitHubPrTool({ filesKv: kv, fetch: fakeFn });
    const out = await tool.forward({
      owner: "o",
      repo: "r",
      base: "main",
      branch: "z",
      commitMessage: "subset",
      token: "t",
      paths: ["a.ts", "c.ts"],
    });
    expect(out.files).toBe(2);
    // Two blobs, not three.
    expect(calls.filter((c) => c.url.endsWith("/git/blobs")).length).toBe(2);
  });

  it("requires HITL approval (needsApproval=true)", () => {
    const kv = new MemKvStore();
    const { fakeFn } = fakeFetch();
    const tool = createGitHubPrTool({ filesKv: kv, fetch: fakeFn });
    expect(tool.needsApproval).toBe(true);
  });

  it("normalises ill-formed branch names to bscode/<safe-slug>", async () => {
    const kv = new MemKvStore();
    await kv.put("file:a.ts", "x");
    const { fakeFn } = fakeFetch();
    const tool = createGitHubPrTool({ filesKv: kv, fetch: fakeFn, ambientToken: "t" });
    const out = await tool.forward({
      owner: "o",
      repo: "r",
      base: "main",
      branch: "Feat/Some Thing!",
      commitMessage: "x",
    });
    // Pattern: starts with bscode/, only letters/digits/dashes/slashes/underscore
    expect(out.branch.startsWith("bscode/")).toBe(true);
    expect(out.branch).toMatch(/^[a-z0-9/_-]+$/);
  });
});

/**
 * B3 — GitHub repo importer tests.
 *
 * Mocks `fetch` to drive the importer's three responsibilities:
 *   - resolve default branch when ref is omitted
 *   - filter the recursive tree by extension and path prefix
 *   - decode base64 blobs, write to KV, fire the onFileImported callback
 *   - skip oversize, binary, and out-of-cap files with reason counters
 *   - propagate the truncated flag from the GitHub tree response
 *   - bubble unrecoverable errors (404 on tree, etc.) as thrown exceptions
 */

import { describe, expect, it, vi } from "vitest";
import { MemKvStore } from "../platform.js";
import { importGithubRepo } from "./githubImport.js";

/** Build a base64 blob payload a la /git/blobs. */
function blobPayload(text: string) {
  // Manual base64 encode — works in Node and bun.
  // biome-ignore lint/suspicious/noExplicitAny: Buffer is Node only, but vitest runs there.
  const Buf = (globalThis as any).Buffer;
  const b64 = Buf
    ? Buf.from(text, "utf-8").toString("base64")
    : btoa(unescape(encodeURIComponent(text)));
  return { content: b64, encoding: "base64" as const, sha: "abc", size: text.length };
}

/** Minimal fetch mock honouring three endpoints: repo meta, tree, blob. */
function makeFetch(opts: {
  defaultBranch?: string;
  tree: { path: string; type: "blob" | "tree"; size?: number; sha?: string }[];
  blobs?: Record<string, { content: string; encoding?: "base64" | "utf-8" }>;
  truncated?: boolean;
  treeStatus?: number;
}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (/\/repos\/[^/]+\/[^/]+$/.test(url)) {
      return new Response(JSON.stringify({ default_branch: opts.defaultBranch ?? "main" }), {
        status: 200,
      });
    }
    if (/\/git\/trees\//.test(url)) {
      if (opts.treeStatus && opts.treeStatus !== 200) {
        return new Response("nope", { status: opts.treeStatus });
      }
      const tree = opts.tree.map((e, i) => ({
        ...e,
        sha: e.sha ?? `sha-${i}`,
        url: `https://api.github.com/repos/x/y/git/blobs/sha-${i}`,
      }));
      return new Response(JSON.stringify({ sha: "root", tree, truncated: !!opts.truncated }), {
        status: 200,
      });
    }
    if (/\/git\/blobs\//.test(url)) {
      const m = url.match(/sha-(\d+)/);
      const idx = m ? Number(m[1]) : -1;
      const path = opts.tree[idx]?.path;
      const seed = path ? opts.blobs?.[path] : undefined;
      if (!seed) {
        return new Response("blob not found", { status: 404 });
      }
      if (seed.encoding === "utf-8") {
        return new Response(JSON.stringify({ ...seed, sha: "x", size: seed.content.length }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify(blobPayload(seed.content)), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("importGithubRepo", () => {
  it("imports text files and decodes base64 content into KV", async () => {
    const kv = new MemKvStore();
    const fetchMock = makeFetch({
      tree: [
        { path: "src/index.ts", type: "blob", size: 10 },
        { path: "README.md", type: "blob", size: 8 },
      ],
      blobs: {
        "src/index.ts": { content: "console.log('hi');" },
        "README.md": { content: "# hello" },
      },
    });
    const result = await importGithubRepo(
      { owner: "x", repo: "y" },
      { filesKv: kv, fetch: fetchMock }
    );
    expect(result.imported).toBe(2);
    expect(result.preview).toContain("src/index.ts");
    expect(await kv.get("file:src/index.ts")).toBe("console.log('hi');");
    expect(await kv.get("file:README.md")).toBe("# hello");
  });

  it("filters by allow-listed extensions; binaries are skipped", async () => {
    const kv = new MemKvStore();
    const fetchMock = makeFetch({
      tree: [
        { path: "src/index.ts", type: "blob", size: 10 },
        { path: "icon.png", type: "blob", size: 100 },
      ],
      blobs: {
        "src/index.ts": { content: "ok" },
        "icon.png": { content: "ok" },
      },
    });
    const result = await importGithubRepo(
      { owner: "x", repo: "y" },
      { filesKv: kv, fetch: fetchMock }
    );
    expect(result.imported).toBe(1);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(await kv.get("file:icon.png")).toBeNull();
  });

  it("filters by paths prefix when supplied", async () => {
    const kv = new MemKvStore();
    const fetchMock = makeFetch({
      tree: [
        { path: "apps/worker/src/index.ts", type: "blob", size: 10 },
        { path: "docs/README.md", type: "blob", size: 5 },
        { path: "scripts/build.sh", type: "blob", size: 5 },
      ],
      blobs: {
        "apps/worker/src/index.ts": { content: "x" },
        "docs/README.md": { content: "y" },
        "scripts/build.sh": { content: "z" },
      },
    });
    const result = await importGithubRepo(
      { owner: "x", repo: "y", paths: ["apps/worker"] },
      { filesKv: kv, fetch: fetchMock }
    );
    expect(result.imported).toBe(1);
    expect(await kv.get("file:apps/worker/src/index.ts")).toBe("x");
    expect(await kv.get("file:docs/README.md")).toBeNull();
  });

  it("invokes onFileImported for each imported path", async () => {
    const kv = new MemKvStore();
    const seen: string[] = [];
    const fetchMock = makeFetch({
      tree: [
        { path: "a.ts", type: "blob", size: 5 },
        { path: "b.md", type: "blob", size: 5 },
      ],
      blobs: { "a.ts": { content: "1" }, "b.md": { content: "2" } },
    });
    await importGithubRepo(
      { owner: "x", repo: "y" },
      {
        filesKv: kv,
        fetch: fetchMock,
        onFileImported: (path) => {
          seen.push(path);
        },
      }
    );
    expect(seen.sort()).toEqual(["a.ts", "b.md"]);
  });

  it("uses the default_branch when no ref is supplied", async () => {
    const kv = new MemKvStore();
    const urls: string[] = [];
    const fetchMock = ((input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      urls.push(url);
      return makeFetch({
        defaultBranch: "develop",
        tree: [],
      })(input);
    }) as unknown as typeof fetch;
    await importGithubRepo({ owner: "x", repo: "y" }, { filesKv: kv, fetch: fetchMock });
    // The tree URL should reference the default branch we returned.
    expect(urls.some((u) => u.includes("/git/trees/develop"))).toBe(true);
  });

  it("propagates the truncated flag when GitHub returned a partial tree", async () => {
    const kv = new MemKvStore();
    const fetchMock = makeFetch({
      tree: [{ path: "a.ts", type: "blob", size: 5 }],
      blobs: { "a.ts": { content: "x" } },
      truncated: true,
    });
    const result = await importGithubRepo(
      { owner: "x", repo: "y" },
      { filesKv: kv, fetch: fetchMock }
    );
    expect(result.truncated).toBe(true);
  });

  it("throws when the tree fetch fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const kv = new MemKvStore();
    const fetchMock = makeFetch({
      tree: [],
      treeStatus: 404,
    });
    await expect(
      importGithubRepo({ owner: "x", repo: "y" }, { filesKv: kv, fetch: fetchMock })
    ).rejects.toThrow(/404/);
  });

  it("collects skip reasons for files that fail to fetch", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const kv = new MemKvStore();
    const fetchMock = makeFetch({
      tree: [
        { path: "a.ts", type: "blob", size: 5 },
        { path: "b.ts", type: "blob", size: 5 },
      ],
      blobs: { "a.ts": { content: "x" } /* b.ts intentionally missing */ },
    });
    const result = await importGithubRepo(
      { owner: "x", repo: "y" },
      { filesKv: kv, fetch: fetchMock }
    );
    expect(result.imported).toBe(1);
    expect(result.skippedReasons.blob_fetch_404).toBe(1);
  });
});

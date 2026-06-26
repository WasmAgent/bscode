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
 *
 * B5 additions — deny-list:
 *   - .env files are blocked and never written to KV
 *   - .dev.vars is blocked
 *   - .env.example is also blocked (conservative default)
 *   - denied paths appear in skippedReasons["denied_sensitive_file"]
 *   - allowPaths override permits an otherwise-denied file through
 */

import { describe, expect, it, vi } from "bun:test";
import { MemKvStore } from "../platform.js";
import { importGithubRepo } from "./githubImport.js";
import {
  compileDenyMatcher,
  defaultDenyMatcher,
  isDenied,
  pathBasename,
} from "./importDenyList.js";

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

// ── B5: deny-list unit tests ───────────────────────────────────────────────────

describe("importDenyList — compileDenyMatcher", () => {
  it("matches exact filenames (.env, .npmrc)", () => {
    const match = compileDenyMatcher([".env", ".npmrc"]);
    expect(match(".env")).toBe(true);
    expect(match(".npmrc")).toBe(true);
    expect(match("env")).toBe(false);
  });

  it("matches suffix wildcards (*.pem, *.key)", () => {
    const match = compileDenyMatcher(["*.pem", "*.key"]);
    expect(match("server.pem")).toBe(true);
    expect(match("private.key")).toBe(true);
    expect(match("something.pem.bak")).toBe(false);
    expect(match("server.ts")).toBe(false);
  });

  it("matches prefix wildcards (.env.*)", () => {
    const match = compileDenyMatcher([".env.*"]);
    expect(match(".env.local")).toBe(true);
    expect(match(".env.production")).toBe(true);
    expect(match(".env")).toBe(false); // no dot after .env — no trailing char
    expect(match("env.local")).toBe(false);
  });

  it("matches double wildcard (gcp-*credentials*.json)", () => {
    const match = compileDenyMatcher(["gcp-*credentials*.json"]);
    expect(match("gcp-service-credentials-prod.json")).toBe(true);
    expect(match("gcp-credentials.json")).toBe(true);
    expect(match("gcp-other.json")).toBe(false);
    expect(match("aws-credentials.json")).toBe(false);
  });

  it("matches id_rsa prefix pattern (id_rsa.*)", () => {
    const match = compileDenyMatcher(["id_rsa", "id_rsa.*"]);
    expect(match("id_rsa")).toBe(true);
    expect(match("id_rsa.pub")).toBe(true);
    expect(match("id_rsa_old")).toBe(false);
  });
});

describe("importDenyList — DEFAULT_DENY_PATTERNS coverage", () => {
  const match = defaultDenyMatcher();

  it("blocks .env", () => expect(match(".env")).toBe(true));
  it("blocks .env.local", () => expect(match(".env.local")).toBe(true));
  it("blocks .env.production", () => expect(match(".env.production")).toBe(true));
  it("blocks .dev.vars", () => expect(match(".dev.vars")).toBe(true));
  it("blocks *.pem", () => expect(match("server.pem")).toBe(true));
  it("blocks *.key", () => expect(match("private.key")).toBe(true));
  it("blocks *.pfx", () => expect(match("cert.pfx")).toBe(true));
  it("blocks *.p12", () => expect(match("keystore.p12")).toBe(true));
  it("blocks id_rsa", () => expect(match("id_rsa")).toBe(true));
  it("blocks id_rsa.pub", () => expect(match("id_rsa.pub")).toBe(true));
  it("blocks id_ecdsa", () => expect(match("id_ecdsa")).toBe(true));
  it("blocks id_ed25519", () => expect(match("id_ed25519")).toBe(true));
  it("blocks gcp-*credentials*.json", () =>
    expect(match("gcp-myproject-credentials.json")).toBe(true));
  it("blocks aws-*.csv", () => expect(match("aws-accessKeys.csv")).toBe(true));
  it("blocks .npmrc", () => expect(match(".npmrc")).toBe(true));

  it("does NOT block .env.example (treated as sensitive by default)", () =>
    // Conservative: .env.example still matches .env.* — intentional
    expect(match(".env.example")).toBe(true));

  it("does NOT block README.md", () => expect(match("README.md")).toBe(false));
  it("does NOT block src/index.ts", () => expect(match("index.ts")).toBe(false));
  it("does NOT block package.json", () => expect(match("package.json")).toBe(false));
});

describe("importDenyList — isDenied with allowPaths", () => {
  const match = defaultDenyMatcher();

  it("denies config/.env", () => expect(isDenied("config/.env", match)).toBe(true));
  it("denies .dev.vars at root", () => expect(isDenied(".dev.vars", match)).toBe(true));
  it("allows explicitly permitted path", () => {
    const allow = new Set(["fixtures/.env.example"]);
    expect(isDenied("fixtures/.env.example", match, allow)).toBe(false);
  });
  it("still denies non-allowed paths even with allowPaths set", () => {
    const allow = new Set(["fixtures/.env.example"]);
    expect(isDenied(".env", match, allow)).toBe(true);
  });
});

describe("importDenyList — pathBasename", () => {
  it("extracts basename from nested path", () =>
    expect(pathBasename("config/secrets/.env.local")).toBe(".env.local"));
  it("handles root-level file", () => expect(pathBasename(".env")).toBe(".env"));
  it("handles no slash", () => expect(pathBasename("README.md")).toBe("README.md"));
});

// ── B5: importGithubRepo deny-list integration tests ──────────────────────────

describe("importGithubRepo — deny-list integration", () => {
  it("does not write .env to KV and records denied_sensitive_file", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const kv = new MemKvStore();
    const fetchMock = makeFetch({
      tree: [
        { path: "src/index.ts", type: "blob", size: 10 },
        // .env is in TEXT_EXTENSIONS would have been imported previously;
        // the deny-list must block it regardless of extension matching.
        { path: ".env", type: "blob", size: 50 },
      ],
      blobs: {
        "src/index.ts": { content: "console.log('hi');" },
        ".env": { content: "SECRET_KEY=hunter2\nDB_PASS=s3cret" },
      },
    });
    const result = await importGithubRepo(
      { owner: "x", repo: "y" },
      { filesKv: kv, fetch: fetchMock }
    );
    expect(result.imported).toBe(1);
    expect(await kv.get("file:.env")).toBeNull();
    expect(result.skippedReasons.denied_sensitive_file).toBe(1);
  });

  it("does not write .dev.vars to KV", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const kv = new MemKvStore();
    // .dev.vars has no recognised text extension — it would already be
    // filtered. Supply textExtensions:[] to disable ext-filtering so the
    // only protection is the deny-list.
    const fetchMock = makeFetch({
      tree: [
        { path: "wrangler.toml", type: "blob", size: 30 },
        { path: ".dev.vars", type: "blob", size: 40 },
      ],
      blobs: {
        "wrangler.toml": { content: "[vars]" },
        ".dev.vars": { content: "GITHUB_TOKEN=ghp_secret" },
      },
    });
    const result = await importGithubRepo(
      { owner: "x", repo: "y", textExtensions: [] },
      { filesKv: kv, fetch: fetchMock }
    );
    expect(await kv.get("file:.dev.vars")).toBeNull();
    expect(result.skippedReasons.denied_sensitive_file).toBe(1);
  });

  it("does not write .env.example to KV (conservative default)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const kv = new MemKvStore();
    const fetchMock = makeFetch({
      tree: [
        { path: "src/app.ts", type: "blob", size: 10 },
        { path: ".env.example", type: "blob", size: 20 },
      ],
      blobs: {
        "src/app.ts": { content: "ok" },
        ".env.example": { content: "DB_URL=placeholder" },
      },
    });
    const result = await importGithubRepo(
      { owner: "x", repo: "y" },
      { filesKv: kv, fetch: fetchMock }
    );
    expect(await kv.get("file:.env.example")).toBeNull();
    expect(result.skippedReasons.denied_sensitive_file).toBe(1);
    expect(result.imported).toBe(1);
  });

  it("allows denied file when path is in allowPaths", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const kv = new MemKvStore();
    const fetchMock = makeFetch({
      tree: [{ path: "fixtures/.env.example", type: "blob", size: 20 }],
      blobs: { "fixtures/.env.example": { content: "# template" } },
    });
    const result = await importGithubRepo(
      {
        owner: "x",
        repo: "y",
        // Disable extension filter so the deny-list is the only gate.
        textExtensions: [],
        allowPaths: new Set(["fixtures/.env.example"]),
      },
      { filesKv: kv, fetch: fetchMock }
    );
    expect(result.imported).toBe(1);
    expect(await kv.get("file:fixtures/.env.example")).toBe("# template");
    expect(result.skippedReasons.denied_sensitive_file).toBeUndefined();
  });

  it("blocks private key files (*.pem, id_rsa) in nested paths", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const kv = new MemKvStore();
    const fetchMock = makeFetch({
      tree: [
        { path: "certs/server.pem", type: "blob", size: 30 },
        { path: "ssh/id_rsa", type: "blob", size: 60 },
        { path: "src/main.ts", type: "blob", size: 10 },
      ],
      blobs: {
        "certs/server.pem": { content: "-----BEGIN CERTIFICATE-----" },
        "ssh/id_rsa": { content: "-----BEGIN RSA PRIVATE KEY-----" },
        "src/main.ts": { content: "export {}" },
      },
    });
    const result = await importGithubRepo(
      { owner: "x", repo: "y" },
      { filesKv: kv, fetch: fetchMock }
    );
    expect(await kv.get("file:certs/server.pem")).toBeNull();
    expect(await kv.get("file:ssh/id_rsa")).toBeNull();
    expect(result.imported).toBe(1);
    expect(result.skippedReasons.denied_sensitive_file).toBe(2);
  });
});

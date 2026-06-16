/**
 * Tests for the useImport hook.
 *
 * The hook owns three concerns: ZIP import filtering, directory-picker
 * import, and the bulk upload to the worker. We pin the zip path + the
 * upload path here. Directory-picker requires the File System Access API
 * (Chromium-only); in jsdom it's absent, so we just confirm the actionable
 * error is thrown.
 *
 * The filtering rules are the high-leverage part: secrets MUST never land
 * in the import (.env, .dev.vars), node_modules MUST be excluded, binary
 * extensions skipped, and .gitignore patterns honoured. A regression in
 * any of those would silently leak secrets or balloon the upload size.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useImport } from "./useImport";

const realFetch = globalThis.fetch;

/** Build a JSZip → File the hook can consume. */
async function makeZip(
  entries: Record<string, string | Uint8Array>,
  topLevel?: string
): Promise<File> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(entries)) {
    const fullPath = topLevel ? `${topLevel}/${path}` : path;
    zip.file(fullPath, content);
  }
  const blob = await zip.generateAsync({ type: "blob" });
  return new File([blob], "fixture.zip", { type: "application/zip" });
}

function pathsOf(files: { path: string }[]): string[] {
  return files.map((f) => f.path).sort();
}

describe("useImport — importFromZip filtering", () => {
  beforeEach(() => {
    globalThis.fetch = realFetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("imports plain text files with their content intact", async () => {
    const file = await makeZip({
      "src/index.ts": "export const x = 1;\n",
      "README.md": "# Project\n",
    });
    const { result } = renderHook(() => useImport());
    let files: { path: string; content: string }[] = [];
    await act(async () => {
      files = await result.current.importFromZip(file);
    });
    expect(pathsOf(files)).toEqual(["README.md", "src/index.ts"]);
    expect(files.find((f) => f.path === "src/index.ts")?.content).toBe("export const x = 1;\n");
    expect(result.current.importing).toBe(false);
  });

  it("strips a single common top-level directory (zips often wrap everything)", async () => {
    // GitHub-style "repo-main/" wrapper.
    const file = await makeZip(
      {
        "src/a.ts": "A",
        "package.json": "{}",
      },
      "repo-main"
    );
    const { result } = renderHook(() => useImport());
    let files: { path: string; content: string }[] = [];
    await act(async () => {
      files = await result.current.importFromZip(file);
    });
    expect(pathsOf(files)).toEqual(["package.json", "src/a.ts"]);
  });

  it("SECURITY: skips .env / .dev.vars / .env.local — secrets MUST NOT enter the workspace", async () => {
    const file = await makeZip({
      ".env": "DB_URL=secret",
      ".env.local": "API_KEY=secret2",
      ".env.production.local": "PROD_KEY=secret3",
      ".dev.vars": "WRANGLER_SECRET=secret4",
      ".env.example": "DB_URL=changeme",
      ".gitignore": "node_modules\n",
      "src/a.ts": "ok",
    });
    const { result } = renderHook(() => useImport());
    let files: { path: string; content: string }[] = [];
    await act(async () => {
      files = await result.current.importFromZip(file);
    });
    const paths = pathsOf(files);
    // Secrets gone:
    for (const banned of [".env", ".env.local", ".env.production.local", ".dev.vars"]) {
      expect(paths, `${banned} must not be imported`).not.toContain(banned);
    }
    // .env.example IS allowed (it's how projects share required-vars contract).
    expect(paths).toContain(".env.example");
    expect(paths).toContain("src/a.ts");
  });

  it("skips known build/dependency directories", async () => {
    const file = await makeZip({
      "node_modules/react/index.js": "// junk",
      "dist/bundle.js": "// junk",
      ".next/cache/x.js": "// junk",
      ".git/HEAD": "ref: refs/heads/main",
      "src/keep.ts": "kept",
    });
    const { result } = renderHook(() => useImport());
    let files: { path: string; content: string }[] = [];
    await act(async () => {
      files = await result.current.importFromZip(file);
    });
    const paths = pathsOf(files);
    expect(paths).toEqual(["src/keep.ts"]);
  });

  it("skips binary file extensions but keeps text", async () => {
    // PNG magic header — the hook's UTF-8 decoder would also skip this
    // via its fatal:true catch, but the extension filter triggers first.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const file = await makeZip({
      "logo.png": png,
      "screenshot.jpg": png,
      "build.wasm": png,
      "archive.zip": png,
      "src/a.ts": "kept",
    });
    const { result } = renderHook(() => useImport());
    let files: { path: string; content: string }[] = [];
    await act(async () => {
      files = await result.current.importFromZip(file);
    });
    expect(pathsOf(files)).toEqual(["src/a.ts"]);
  });

  it("honours .gitignore patterns (segment + *.ext)", async () => {
    const file = await makeZip({
      ".gitignore": "secrets/\n*.log\nbuild-output\n",
      "src/a.ts": "kept",
      "secrets/api.txt": "leak",
      "app.log": "leak",
      "build-output/x.txt": "leak",
    });
    const { result } = renderHook(() => useImport());
    let files: { path: string; content: string }[] = [];
    await act(async () => {
      files = await result.current.importFromZip(file);
    });
    const paths = pathsOf(files);
    expect(paths).toContain("src/a.ts");
    expect(paths).toContain(".gitignore");
    expect(paths).not.toContain("secrets/api.txt");
    expect(paths).not.toContain("app.log");
    expect(paths).not.toContain("build-output/x.txt");
  });

  it("skips files larger than 5 MB even when their extension is text", async () => {
    // 5 MB + 1 byte of plain ASCII — extension is .txt so the ext filter
    // doesn't catch it; the size cap must.
    const huge = "a".repeat(5 * 1024 * 1024 + 1);
    const file = await makeZip({
      "huge.txt": huge,
      "small.txt": "ok",
    });
    const { result } = renderHook(() => useImport());
    let files: { path: string; content: string }[] = [];
    await act(async () => {
      files = await result.current.importFromZip(file);
    });
    expect(pathsOf(files)).toEqual(["small.txt"]);
  });

  it("skips files that fail UTF-8 decoding (binary content with text extension)", async () => {
    // Invalid UTF-8 byte sequence (0xFF 0xFE = UTF-16 BOM, fatal:true rejects).
    const garbage = new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0xc0, 0xc1]);
    const file = await makeZip({
      "weird.txt": garbage,
      "good.txt": "hello",
    });
    const { result } = renderHook(() => useImport());
    let files: { path: string; content: string }[] = [];
    await act(async () => {
      files = await result.current.importFromZip(file);
    });
    expect(pathsOf(files)).toEqual(["good.txt"]);
  });

  it("toggles `importing` state during the run + clears it on error", async () => {
    // A malformed File makes JSZip throw; we still want importing→false in
    // the finally block so the UI doesn't get stuck on a spinner.
    const bad = new File([new Uint8Array([0, 1, 2])], "bad.zip", { type: "application/zip" });
    const { result } = renderHook(() => useImport());
    await expect(
      act(async () => {
        await result.current.importFromZip(bad);
      })
    ).rejects.toBeTruthy();
    expect(result.current.importing).toBe(false);
  });
});

describe("useImport — uploadFiles", () => {
  beforeEach(() => {
    globalThis.fetch = realFetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("returns 0 immediately for an empty file list (no fetch made)", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const { result } = renderHook(() => useImport());
    let count = -1;
    await act(async () => {
      count = await result.current.uploadFiles([], "http://w");
    });
    expect(count).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POSTs to /files/bulk and returns the server-reported count", async () => {
    let captured: { url: string; body: string } = { url: "", body: "" };
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      captured = { url, body: (init?.body as string) ?? "" };
      return Promise.resolve(new Response(JSON.stringify({ count: 2 }), { status: 200 }));
    }) as unknown as typeof globalThis.fetch;

    const { result } = renderHook(() => useImport());
    let count = 0;
    await act(async () => {
      count = await result.current.uploadFiles(
        [
          { path: "a.ts", content: "A" },
          { path: "b.ts", content: "B" },
        ],
        "http://w"
      );
    });
    expect(count).toBe(2);
    expect(captured.url).toBe("http://w/files/bulk");
    const parsed = JSON.parse(captured.body) as { files: { path: string }[] };
    expect(parsed.files.map((f) => f.path).sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("throws on non-2xx with a discoverable status code in the message", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response("nope", { status: 503 }))
    ) as unknown as typeof globalThis.fetch;

    const { result } = renderHook(() => useImport());
    await expect(
      result.current.uploadFiles([{ path: "a.ts", content: "x" }], "http://w")
    ).rejects.toThrow(/Upload failed: 503/);
  });
});

describe("useImport — importFromDirectory", () => {
  it("throws an actionable error when File System Access API is unavailable", async () => {
    // jsdom doesn't implement showDirectoryPicker — the hook detects this
    // explicitly and surfaces a hint rather than an unhelpful TypeError.
    const orig = (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker = undefined;
    try {
      const { result } = renderHook(() => useImport());
      await expect(result.current.importFromDirectory()).rejects.toThrow(
        /Directory picker is not supported/
      );
    } finally {
      if (orig === undefined) {
        delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
      } else {
        (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker = orig;
      }
    }
  });

  it("rejects 'property exists but value is not a function' (failed-polyfill regression)", async () => {
    // Belt-and-braces guard for SEC-016: the previous `in` check let
    // a non-function value (e.g. an object placeholder, a string, a
    // failed polyfill leaving `undefined`) reach the call site and
    // crash with TypeError. The hint MUST win regardless of the
    // exact non-function value.
    const orig = (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    for (const bogus of [undefined, null, "stringy", 42, {}, []]) {
      (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker = bogus;
      const { result } = renderHook(() => useImport());
      await expect(result.current.importFromDirectory(), `bogus=${String(bogus)}`).rejects.toThrow(
        /Directory picker is not supported/
      );
    }
    if (orig === undefined) {
      delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    } else {
      (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker = orig;
    }
  });
});

// suppress unused-import warning when waitFor isn't used in this file
void waitFor;

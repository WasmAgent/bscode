import type { FileTreeManager } from "@wasmagent/core/beta";
import type { Hono } from "hono";
import type { AppConfig, KvStore } from "../platform.js";
import type { SessionFileTreeStore } from "../sessionFileTreeStore.js";
import { assertWorkspacePath, MAX_FILE_BYTES } from "../tools/index.js";

const MAX_BULK_FILES = 100;
const MAX_BULK_TOTAL_BYTES = 2 * 1024 * 1024;

export interface FileRoutesDeps {
  sessionFileTrees: SessionFileTreeStore<FileTreeManager>;
  resolveFilesKv(sessionId: string | undefined, config: AppConfig): KvStore | undefined;
  sessionIdOf(
    c: { req: { header: (n: string) => string | undefined } },
    config?: AppConfig
  ): string;
  fileTreeFor(
    c: { req: { header: (n: string) => string | undefined } },
    config: AppConfig
  ): FileTreeManager;
}

export function mountFilesRoutes(app: Hono, config: AppConfig, deps: FileRoutesDeps): void {
  const { resolveFilesKv, sessionIdOf, fileTreeFor, sessionFileTrees } = deps;

  app.get("/files", async (c) => {
    const kv = resolveFilesKv(c.req.header("X-Session-Id"), config);
    if (!kv) return c.json({ files: [] });
    const list = await kv.list({ prefix: "file:" });
    const files = list.keys.map((k) => ({
      path: k.name.replace(/^file:/, ""),
      name:
        k.name
          .replace(/^file:/, "")
          .split("/")
          .pop() ?? "",
    }));
    return c.json({ files });
  });

  // Bulk fetch — returns all files with their contents in one request.
  // Used by the frontend to mount the workspace into WebContainers without N+1 fetches.
  app.get("/files/bulk", async (c) => {
    const kv = resolveFilesKv(c.req.header("X-Session-Id"), config);
    if (!kv) return c.json({ files: [] });
    const list = await kv.list({ prefix: "file:" });
    const files = await Promise.all(
      list.keys.map(async (k) => {
        const path = k.name.replace(/^file:/, "");
        const content = await kv.get(k.name);
        return { path, content: content ?? "" };
      })
    );
    return c.json({ files });
  });

  // Batch write — import multiple files in one request (used by ZIP/directory import).
  app.post("/files/bulk", async (c) => {
    const kv = resolveFilesKv(c.req.header("X-Session-Id"), config);
    if (!kv) return c.json({ error: "KV not bound" }, 503);
    const { files } = await c.req.json<{ files: { path: string; content: string }[] }>();
    if (!Array.isArray(files) || files.length === 0)
      return c.json({ error: "files array required" }, 400);
    if (files.length > MAX_BULK_FILES)
      return c.json({ error: `too many files: max ${MAX_BULK_FILES}` }, 413);
    const enc = new TextEncoder();
    let totalBytes = 0;
    for (const f of files) {
      try {
        assertWorkspacePath(f.path);
      } catch (_err) {
        return c.json({ error: `invalid path: ${f.path}` }, 400);
      }
      const bytes = enc.encode(f.content ?? "").byteLength;
      if (bytes > MAX_FILE_BYTES) return c.json({ error: `file too large: ${f.path}` }, 413);
      totalBytes += bytes;
      if (totalBytes > MAX_BULK_TOTAL_BYTES)
        return c.json({ error: "bulk payload too large" }, 413);
    }
    await Promise.all(
      files.map(({ path, content }) => kv.put(`file:${path.replace(/^\/+/, "")}`, content ?? ""))
    );
    return c.json({ ok: true, count: files.length, paths: files.map((f) => f.path) });
  });

  // ── File version history (v0.dev checkpoint pattern) ─────────────────────
  app.get("/files/:path{.+}/versions", async (c) => {
    const path = c.req.param("path");
    const versions = fileTreeFor(c, config).getVersions(path);
    return c.json({
      path,
      versions: versions.map((v) => ({ version: v.version, hash: v.hash, savedAtMs: v.savedAtMs })),
    });
  });

  // Fetch the actual content of a specific historical version. Used by the
  // DiffViewer to show before/after content side-by-side.
  app.get("/files/:path{.+}/versions/:version", async (c) => {
    const path = c.req.param("path");
    const versionNum = Number(c.req.param("version"));
    if (Number.isNaN(versionNum)) return c.json({ error: "version must be a number" }, 400);
    const versions = fileTreeFor(c, config).getVersions(path);
    const target = versions.find((v) => v.version === versionNum);
    if (!target) return c.json({ error: `version ${versionNum} not found` }, 404);
    return c.json({
      path,
      version: target.version,
      content: target.content,
      hash: target.hash,
      savedAtMs: target.savedAtMs,
    });
  });

  app.post("/files/:path{.+}/rollback", async (c) => {
    const path = c.req.param("path");
    const kv = resolveFilesKv(c.req.header("X-Session-Id"), config);
    const { version } = await c.req.json<{ version: number }>();
    const content = fileTreeFor(c, config).rollback(path, version);
    if (!content) return c.json({ error: `Version ${version} not found for ${path}` }, 404);
    if (kv) await kv.put(`file:${path.replace(/^\/+/, "")}`, content);
    return c.json({ ok: true, path, version, chars: content.length });
  });

  app.post("/files", async (c) => {
    const kv = resolveFilesKv(c.req.header("X-Session-Id"), config);
    const { path, content } = await c.req.json<{ path: string; content: string }>();
    if (!path || content === undefined) return c.json({ error: "path and content required" }, 400);
    try {
      assertWorkspacePath(path);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    if (typeof content === "string" && content.length > MAX_FILE_BYTES) {
      return c.json({ error: `file exceeds ${MAX_FILE_BYTES} bytes` }, 413);
    }
    if (kv) await kv.put(`file:${path.replace(/^\/+/, "")}`, content);
    // Keep FileTreeManager in sync for conflict detection and context relevance
    fileTreeFor(c, config).recordWrite(path.replace(/^\/+/, ""), content);
    return c.json({ ok: true, path });
  });

  app.get("/files/:path{.+}", async (c) => {
    const kv = resolveFilesKv(c.req.header("X-Session-Id"), config);
    const path = c.req.param("path");
    try {
      assertWorkspacePath(path);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    if (!kv) return c.json({ error: "KV not bound" }, 503);
    const content = await kv.get(`file:${path}`);
    if (content === null) return c.json({ error: "not found" }, 404);
    return c.json({ path, content });
  });

  // DELETE /files — clear ALL workspace files (called before each new framework run)
  app.delete("/files", async (c) => {
    const kv = resolveFilesKv(c.req.header("X-Session-Id"), config);
    if (!kv) return c.json({ error: "KV not bound" }, 503);
    if (typeof config.filesKv?.delete !== "function") {
      // Fail loud rather than silently no-op — the caller is asking us
      // to clear state and we must not pretend success when we can't.
      return c.json({ error: "KV backend does not support delete" }, 501);
    }
    const list = await kv.list({ prefix: "file:" });
    await Promise.all(list.keys.map((k) => kv.delete?.(k.name)));
    // Also reset the in-memory file tree (and version history) for this
    // session — otherwise stale versions linger after a workspace wipe.
    sessionFileTrees.delete(sessionIdOf(c, config));
    return c.json({ ok: true, cleared: list.keys.length });
  });

  app.delete("/files/:path{.+}", async (c) => {
    const kv = resolveFilesKv(c.req.header("X-Session-Id"), config);
    const path = c.req.param("path");
    if (!kv) return c.json({ error: "KV not bound" }, 503);
    try {
      assertWorkspacePath(path);
    } catch (_err) {
      return c.json({ error: `invalid path: ${path}` }, 400);
    }
    if (typeof config.filesKv?.delete !== "function") {
      return c.json({ error: "KV backend does not support delete" }, 501);
    }
    await kv.delete?.(`file:${path}`);
    // Drop the in-memory entry + its version history so a follow-up
    // GET /files/:path/versions doesn't return phantom versions.
    fileTreeFor(c, config).remove(path);
    return c.json({ ok: true, path });
  });
}

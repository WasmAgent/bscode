"use client";
import JSZip from "jszip";
import { useCallback, useState } from "react";

/**
 * Files that should never be imported — contain secrets or are machine-generated.
 * The user keeps these locally; we import .env.example instead.
 */
const SKIP_EXACT: ReadonlySet<string> = new Set([
  ".env",
  ".env.local",
  ".env.development.local",
  ".env.test.local",
  ".env.production.local",
  ".dev.vars", // Wrangler secrets
  ".dev.vars.local",
]);

/**
 * Directory/prefix patterns that should be skipped entirely.
 * Checked against every path segment.
 */
const SKIP_DIRS: ReadonlyArray<string> = [
  "node_modules",
  ".git",
  "dist",
  ".next",
  ".turbo",
  ".wrangler",
  ".vercel",
  "__pycache__",
  ".cache",
  "coverage",
  ".venv",
  "venv",
  ".tox",
  "build", // Python/Go build output
];

/**
 * File extensions that are binary or too large to be useful as text.
 */
const SKIP_EXTENSIONS: ReadonlySet<string> = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".svg",
  ".mp4",
  ".mp3",
  ".wav",
  ".ogg",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".7z",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".pdf",
  ".docx",
  ".xlsx",
  ".wasm", // compiled — not useful to import as text
  ".lock", // not .lock files but package-lock and yarn.lock are fine — handled below
]);

/** Max file size in bytes — skip files larger than this (5 MB). */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

function shouldSkip(path: string): boolean {
  // Normalise separators
  const p = path.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = p.split("/");
  const filename = parts[parts.length - 1];

  // Skip hidden system files but keep .env.example, .gitignore, etc.
  if (SKIP_EXACT.has(filename) || SKIP_EXACT.has(p)) return true;

  // Skip if any directory segment matches a skip dir
  for (const part of parts.slice(0, -1)) {
    if (SKIP_DIRS.includes(part)) return true;
  }

  // Skip by extension
  const ext = filename.includes(".") ? "." + filename.split(".").pop()?.toLowerCase() : "";
  if (ext && SKIP_EXTENSIONS.has(ext)) return true;

  return false;
}

/** Parse a .gitignore file content into a simple list of patterns. */
function parseGitignore(content: string): string[] {
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/** Check whether a path is ignored by any gitignore pattern (simple glob match). */
function isGitignored(path: string, patterns: string[]): boolean {
  const p = path.replace(/\\/g, "/");
  for (const pattern of patterns) {
    const pat = pattern.replace(/\/$/, ""); // strip trailing slash
    // Simple contains-segment check
    if (
      p === pat ||
      p.startsWith(pat + "/") ||
      p.includes("/" + pat + "/") ||
      p.endsWith("/" + pat)
    )
      return true;
    // Wildcard: *.ext
    if (pat.startsWith("*") && p.endsWith(pat.slice(1))) return true;
  }
  return false;
}

export interface ImportedFile {
  path: string;
  content: string;
}

export interface UseImportReturn {
  importing: boolean;
  importFromZip: (file: File) => Promise<ImportedFile[]>;
  importFromDirectory: () => Promise<ImportedFile[]>;
  uploadFiles: (files: ImportedFile[], workerUrl: string) => Promise<number>;
}

export function useImport(): UseImportReturn {
  const [importing, setImporting] = useState(false);

  /**
   * Read a ZIP file and return its filtered text contents.
   */
  const importFromZip = useCallback(async (file: File): Promise<ImportedFile[]> => {
    setImporting(true);
    try {
      const zip = await JSZip.loadAsync(file);
      const results: ImportedFile[] = [];

      // Find .gitignore if present
      let gitignorePatterns: string[] = [];
      const gitignoreFile = zip.file(".gitignore");
      if (gitignoreFile) {
        const gi = await gitignoreFile.async("string");
        gitignorePatterns = parseGitignore(gi);
      }

      // Strip common top-level folder that zips often wrap everything in
      const allPaths = Object.keys(zip.files);
      const topDirs = new Set(allPaths.map((p) => p.split("/")[0]));
      const stripPrefix = topDirs.size === 1 ? [...topDirs][0] + "/" : "";

      for (const [zipPath, entry] of Object.entries(zip.files)) {
        if (entry.dir) continue;

        // Strip top-level prefix
        const path = stripPrefix ? zipPath.slice(stripPrefix.length) : zipPath;
        if (!path) continue;

        if (shouldSkip(path)) continue;
        if (isGitignored(path, gitignorePatterns)) continue;

        // Check size
        const data = await entry.async("uint8array");
        if (data.byteLength > MAX_FILE_BYTES) continue;

        // Try to decode as UTF-8; skip binary
        try {
          const content = new TextDecoder("utf-8", { fatal: true }).decode(data);
          results.push({ path, content });
        } catch {
          // Binary file — skip
        }
      }

      return results;
    } finally {
      setImporting(false);
    }
  }, []);

  /**
   * Use the File System Access API to pick a directory and read its files.
   * Falls back gracefully if the API is not supported.
   */
  const importFromDirectory = useCallback(async (): Promise<ImportedFile[]> => {
    if (!("showDirectoryPicker" in window)) {
      throw new Error("Directory picker is not supported in this browser. Try Chrome or Edge.");
    }

    setImporting(true);
    try {
      // biome-ignore lint/suspicious/noExplicitAny: File System Access API
      const dirHandle = await (window as any).showDirectoryPicker({ mode: "read" });
      const results: ImportedFile[] = [];

      // Read .gitignore first if present
      let gitignorePatterns: string[] = [];
      try {
        const giHandle = await dirHandle.getFileHandle(".gitignore");
        const giFile = await giHandle.getFile();
        const giText = await giFile.text();
        gitignorePatterns = parseGitignore(giText);
      } catch {
        // No .gitignore — fine
      }

      // Recursively walk the directory
      async function walk(
        // biome-ignore lint/suspicious/noExplicitAny: File System Access API
        handle: any,
        prefix: string
      ): Promise<void> {
        for await (const [name, entry] of handle.entries()) {
          const path = prefix ? `${prefix}/${name}` : name;

          if (entry.kind === "directory") {
            if (SKIP_DIRS.includes(name)) continue;
            if (isGitignored(path + "/", gitignorePatterns)) continue;
            await walk(entry, path);
          } else {
            if (shouldSkip(path)) continue;
            if (isGitignored(path, gitignorePatterns)) continue;

            const file = await entry.getFile();
            if (file.size > MAX_FILE_BYTES) continue;

            try {
              const content = await file.text();
              results.push({ path, content });
            } catch {
              // Binary — skip
            }
          }
        }
      }

      await walk(dirHandle, "");
      return results;
    } finally {
      setImporting(false);
    }
  }, []);

  /**
   * Upload a list of files to the worker via POST /files/bulk.
   * Returns the number of files successfully uploaded.
   */
  const uploadFiles = useCallback(
    async (files: ImportedFile[], workerUrl: string): Promise<number> => {
      if (!files.length) return 0;
      const res = await fetch(`${workerUrl}/files/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files }),
      });
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
      const data = (await res.json()) as { count: number };
      return data.count;
    },
    []
  );

  return { importing, importFromZip, importFromDirectory, uploadFiles };
}

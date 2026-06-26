/**
 * B3 — GitHub repo importer.
 *
 * Pulls a repo's tree from the GitHub REST API and writes each text file
 * into the bscode worker's KV file store. Pairs with the existing
 * `create_github_pr` tool so the same agent can both READ (this) and
 * WRITE (PR tool) against real-world repositories — the difference between
 * an "edge demo" and "edge Codex cloud".
 *
 * The importer intentionally does NOT use Octokit / @octokit/rest — the
 * worker bundle has to stay edge-friendly. We hit the REST endpoints
 * directly with `fetch`, the same pattern githubPr.ts already established.
 */

import type { KvStore } from "../types.js";
import { defaultDenyMatcher, isDenied } from "./importDenyList.js";

/** Default extensions we treat as text. Binaries are skipped. */
const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".mdx",
  ".txt",
  ".yaml",
  ".yml",
  ".css",
  ".scss",
  ".less",
  ".html",
  ".svg",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".sh",
  ".toml",
  ".gitignore",
]);

/** Max bytes we'll persist per file. Anything bigger is recorded as a stub. */
const MAX_FILE_BYTES = 200 * 1024; // 200 KB per file
/** Max total files imported per call — guard against runaway monorepos. */
const MAX_FILES_PER_IMPORT = 2000;

interface TreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  size?: number;
  sha: string;
  url: string;
}

interface GhTreeResponse {
  sha: string;
  tree: TreeEntry[];
  truncated?: boolean;
}

interface GhBlobResponse {
  content: string;
  encoding: "base64" | "utf-8";
  sha: string;
  size: number;
}

export interface ImportGithubInput {
  /** "owner/repo" or { owner, repo }. */
  owner: string;
  repo: string;
  /** Branch / tag / commit SHA. Defaults to the repo's default branch. */
  ref?: string;
  /** Per-call GitHub token. When omitted, only public repos are accessible. */
  token?: string;
  /**
   * Optional path prefixes — only files matching at least one prefix are
   * imported. Empty/undefined = import everything. Useful for monorepos.
   */
  paths?: string[];
  /**
   * Optional override of the text-extension allowlist. Pass an empty
   * array to disable allow-listing (everything text-decoded is imported).
   */
  textExtensions?: string[];
  /**
   * Optional set of exact file paths that are explicitly permitted even
   * when they match the built-in sensitive-file deny-list. Use sparingly —
   * this is intended for test fixtures and controlled imports only.
   * Example: new Set([".env.example"]) to allow a template dotenv file.
   */
  allowPaths?: ReadonlySet<string>;
}

export interface ImportGithubOutput {
  imported: number;
  skipped: number;
  skippedReasons: Record<string, number>;
  /** First few imported file paths — useful for the human verifying the import. */
  preview: string[];
  /** When true, the GitHub tree itself was truncated (>100k entries). */
  truncated: boolean;
}

export interface ImportOptions {
  /** Filesystem KV — the same one /run reads from. */
  filesKv: KvStore;
  /** Optional fetch override for tests. */
  fetch?: typeof fetch;
  /** Optional callback invoked once per imported file path — for indexers. */
  onFileImported?: (path: string, content: string) => void | Promise<void>;
}

/**
 * Run the import. Throws on any unrecoverable error (missing repo, bad
 * token, network failure on the tree fetch). Per-file fetch failures are
 * collected into `skippedReasons` and reported back; we do NOT abort.
 */
export async function importGithubRepo(
  input: ImportGithubInput,
  opts: ImportOptions
): Promise<ImportGithubOutput> {
  const fetchImpl = opts.fetch ?? fetch;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "bscode-importer",
  };
  if (input.token) headers.Authorization = `Bearer ${input.token}`;

  // Resolve default branch if no ref was given.
  let ref = input.ref;
  if (!ref) {
    const repoMeta = await fetchImpl(`https://api.github.com/repos/${input.owner}/${input.repo}`, {
      headers,
    });
    if (!repoMeta.ok) {
      const body = await repoMeta.text().catch(() => "");
      throw new Error(
        `GitHub ${repoMeta.status} on /repos/${input.owner}/${input.repo}: ${body.slice(0, 200)}`
      );
    }
    const meta = (await repoMeta.json()) as { default_branch?: string };
    ref = meta.default_branch ?? "main";
  }

  // Fetch the recursive tree.
  const treeUrl = `https://api.github.com/repos/${input.owner}/${input.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
  const treeRes = await fetchImpl(treeUrl, { headers });
  if (!treeRes.ok) {
    const body = await treeRes.text().catch(() => "");
    throw new Error(`GitHub ${treeRes.status} on tree ${ref}: ${body.slice(0, 200)}`);
  }
  const tree = (await treeRes.json()) as GhTreeResponse;

  // Decide which entries to fetch.
  const allowedExt = input.textExtensions ? new Set(input.textExtensions) : TEXT_EXTENSIONS;
  const useExtFilter = input.textExtensions === undefined || input.textExtensions.length > 0;

  // Build the deny matcher once per import call.
  // The deny-list is checked BEFORE the extension filter so that sensitive
  // files are reliably blocked even when textExtensions:[] is passed.
  const denyMatcher = defaultDenyMatcher();

  const skippedReasons: Record<string, number> = {};
  const bump = (k: string) => {
    skippedReasons[k] = (skippedReasons[k] ?? 0) + 1;
  };

  // Split the raw blob list into: denied | ext-or-path-filtered | candidates.
  const candidates: TreeEntry[] = [];
  let skipped = 0;
  for (const e of tree.tree) {
    if (e.type !== "blob") continue;

    // 1. Deny-list takes highest priority — checked regardless of extension.
    if (isDenied(e.path, denyMatcher, input.allowPaths)) {
      bump("denied_sensitive_file");
      skipped += 1;
      console.warn(`[github-import] denied sensitive file: ${e.path}`);
      continue;
    }

    // 2. Path-prefix filter.
    if (input.paths && input.paths.length > 0) {
      if (
        !input.paths.some((p) => e.path === p || e.path.startsWith(`${p}/`) || e.path.startsWith(p))
      ) {
        bump("filtered_by_extension_or_path");
        skipped += 1;
        continue;
      }
    }

    // 3. Extension / known-text filter.
    if (useExtFilter) {
      const dot = e.path.lastIndexOf(".");
      const ext = dot === -1 ? "" : e.path.slice(dot);
      // Match by full extension OR by trailing filename (eg ".gitignore").
      const base = e.path.slice(e.path.lastIndexOf("/") + 1);
      if (!allowedExt.has(ext) && !allowedExt.has(base)) {
        bump("filtered_by_extension_or_path");
        skipped += 1;
        continue;
      }
    }

    candidates.push(e);
  }
  // Non-blob entries (trees / submodule commits) silently excluded — they are
  // not counted as skipped because they were never import candidates.

  const preview: string[] = [];
  let imported = 0;

  for (const entry of candidates) {
    if (imported >= MAX_FILES_PER_IMPORT) {
      bump("max_files_cap");
      skipped += 1;
      continue;
    }

    if (entry.size !== undefined && entry.size > MAX_FILE_BYTES) {
      bump("file_too_large");
      skipped += 1;
      continue;
    }

    let blob: GhBlobResponse;
    try {
      const blobRes = await fetchImpl(entry.url, { headers });
      if (!blobRes.ok) {
        bump(`blob_fetch_${blobRes.status}`);
        skipped += 1;
        continue;
      }
      blob = (await blobRes.json()) as GhBlobResponse;
    } catch (err) {
      bump("blob_fetch_threw");
      skipped += 1;
      console.warn(`[github-import] failed to fetch ${entry.path}:`, err);
      continue;
    }

    let text: string;
    if (blob.encoding === "base64") {
      // atob is available on edge / modern Node.
      try {
        const bin = atob(blob.content.replace(/\n/g, ""));
        // Detect non-printable density — if > 20% of bytes are control chars
        // outside whitespace, treat as binary and skip.
        let bad = 0;
        for (let i = 0; i < Math.min(bin.length, 4096); i++) {
          const c = bin.charCodeAt(i);
          if ((c < 9 || (c > 13 && c < 32)) && c !== 0x09) bad += 1;
        }
        if (bin.length > 0 && bad / Math.min(bin.length, 4096) > 0.2) {
          bump("binary_detected");
          skipped += 1;
          continue;
        }
        text = bin;
      } catch (err) {
        bump("base64_decode_failed");
        skipped += 1;
        console.warn(`[github-import] base64 decode failed for ${entry.path}:`, err);
        continue;
      }
    } else {
      text = blob.content;
    }

    await opts.filesKv.put(`file:${entry.path}`, text);
    if (opts.onFileImported) {
      try {
        await opts.onFileImported(entry.path, text);
      } catch (err) {
        console.warn(`[github-import] onFileImported threw for ${entry.path}:`, err);
      }
    }
    imported += 1;
    if (preview.length < 8) preview.push(entry.path);
  }

  return {
    imported,
    skipped,
    skippedReasons,
    preview,
    truncated: Boolean(tree.truncated),
  };
}

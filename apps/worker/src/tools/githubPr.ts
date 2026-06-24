/**
 * B3 — GitHub PR output loop.
 *
 * Adds a `create_github_pr` tool that closes the prototype → maintenance gap
 * (Bolt/Lovable parity, per the 2026-06-11 plan): aggregates the agent's
 * multi-file workspace changes into a branch + commit + pull request against
 * an existing repository, using the GitHub REST API directly (works in edge
 * runtimes, no local git required).
 *
 * Auth: callers must supply a GitHub token at run time. The tool ignores any
 * env var fallback to stay generic — bscode wires the token in via the agent
 * config so users opt-in per request.
 *
 * Safety: the tool is `needsApproval: true`, which routes it through the
 * WasmAgent HITL gate (A3). A reviewer must approve before any push happens.
 */

import type { ToolDefinition } from "@wasmagent/core";
import { z } from "zod";
import type { KvStore } from "../types.js";

// ── GitHub REST helpers ──────────────────────────────────────────────────────

// Index signature lets TS treat this as Record<string, string> for fetch's
// HeadersInit requirement, while still documenting the always-present keys.
type GhHeaders = {
  Authorization: string;
  Accept: string;
  "Content-Type": string;
} & Record<string, string>;

async function ghJson<T>(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub ${res.status} ${res.statusText} on ${url}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

function normaliseBranchName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

// ── Tool factory ─────────────────────────────────────────────────────────────

export interface CreateGitHubPrToolOptions {
  /**
   * KV-backed file store the worker has already populated through
   * `write_file` / `patch_file`. Required so the tool can enumerate files
   * to commit.
   */
  filesKv: KvStore;
  /**
   * Optional fetch override (testing). Defaults to the global fetch.
   */
  fetch?: typeof fetch;
  /**
   * Optional ambient GitHub token (e.g. from the worker env). When unset,
   * callers MUST supply `token` in the tool input.
   */
  ambientToken?: string;
}

export interface GitHubPrInput {
  owner: string;
  repo: string;
  /** Default branch name to base the PR against (e.g. "main"). */
  base: string;
  /** New branch name. Auto-prefixed with "bscode/" if missing. */
  branch: string;
  /** Commit message — first line is also used as the PR title fallback. */
  commitMessage: string;
  /** Pull-request title (defaults to commitMessage's first line). */
  prTitle?: string;
  /** Pull-request body. */
  prBody?: string;
  /** Per-call GitHub token. Overrides any ambient token. */
  token?: string;
  /**
   * Limit to a subset of paths (e.g. ["src/index.ts", "README.md"]). When
   * omitted, every file under the worker's KV file: prefix is included.
   */
  paths?: string[];
}

export interface GitHubPrOutput {
  /** Pull-request HTML URL. */
  url: string;
  /** Branch ref used for the push. */
  branch: string;
  /** Number of files included in the commit. */
  files: number;
}

export function createGitHubPrTool(
  opts: CreateGitHubPrToolOptions
): ToolDefinition<GitHubPrInput, GitHubPrOutput> {
  const fetchImpl = opts.fetch ?? fetch;

  return {
    name: "create_github_pr",
    description:
      "Aggregate the workspace into a branch + commit + pull request against an existing GitHub " +
      "repository. Use after multi-file changes when the user wants the work landed as a PR. " +
      "Requires a GitHub token (input `token` or worker env). HITL-gated.",
    inputSchema: z.object({
      owner: z.string().describe("Repository owner (user or org)"),
      repo: z.string().describe("Repository name"),
      base: z.string().describe('Base branch the PR targets, e.g. "main"'),
      branch: z.string().describe("Feature branch name (will be created)"),
      commitMessage: z.string().describe("Commit message"),
      prTitle: z.string().optional().describe("Pull-request title"),
      prBody: z.string().optional().describe("Pull-request body / description"),
      token: z.string().optional().describe("GitHub personal access token (overrides ambient)"),
      paths: z.array(z.string()).optional().describe("Restrict to these paths"),
    }),
    outputSchema: z.object({
      url: z.string(),
      branch: z.string(),
      files: z.number(),
    }),
    readOnly: false,
    idempotent: false,
    needsApproval: true,
    async forward(input) {
      const token = input.token ?? opts.ambientToken;
      if (!token) {
        throw new Error(
          "create_github_pr: no GitHub token supplied (input.token and ambientToken both empty)"
        );
      }

      const headers: GhHeaders = {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      };

      // 1. Enumerate workspace files (KV "file:*" namespace).
      const list = await opts.filesKv.list({ prefix: "file:" });
      let entries = list.keys.map((k) => k.name).filter((name) => name.startsWith("file:"));
      if (input.paths && input.paths.length > 0) {
        const allowed = new Set(input.paths.map((p) => `file:${p.replace(/^\/+/, "")}`));
        entries = entries.filter((k) => allowed.has(k));
      }
      if (entries.length === 0) {
        throw new Error("create_github_pr: no files found to commit");
      }

      const apiBase = `https://api.github.com/repos/${input.owner}/${input.repo}`;
      const branchName = normaliseBranchName(
        input.branch.startsWith("bscode/") ? input.branch : `bscode/${input.branch}`
      );
      const prTitle = input.prTitle ?? input.commitMessage.split("\n", 1)[0] ?? "bscode change";

      // 2. Resolve base branch SHA.
      const baseRef = await ghJson<{ object: { sha: string } }>(
        `${apiBase}/git/ref/heads/${encodeURIComponent(input.base)}`,
        { method: "GET", headers },
        fetchImpl
      );
      const baseSha = baseRef.object.sha;

      // 3. Create blobs for each file (in parallel — independent calls).
      const blobs = await Promise.all(
        entries.map(async (key) => {
          const content = (await opts.filesKv.get(key)) ?? "";
          const blob = await ghJson<{ sha: string }>(
            `${apiBase}/git/blobs`,
            {
              method: "POST",
              headers,
              body: JSON.stringify({ content, encoding: "utf-8" }),
            },
            fetchImpl
          );
          return { path: key.replace(/^file:/, ""), sha: blob.sha };
        })
      );

      // 4. Create tree based on base branch's tree.
      const tree = await ghJson<{ sha: string }>(
        `${apiBase}/git/trees`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            base_tree: baseSha,
            tree: blobs.map(({ path, sha }) => ({
              path,
              mode: "100644",
              type: "blob",
              sha,
            })),
          }),
        },
        fetchImpl
      );

      // 5. Create commit pointing at the new tree.
      const commit = await ghJson<{ sha: string }>(
        `${apiBase}/git/commits`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            message: input.commitMessage,
            tree: tree.sha,
            parents: [baseSha],
          }),
        },
        fetchImpl
      );

      // 6. Create the branch ref.
      await ghJson<unknown>(
        `${apiBase}/git/refs`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            ref: `refs/heads/${branchName}`,
            sha: commit.sha,
          }),
        },
        fetchImpl
      );

      // 7. Open the pull request.
      const pr = await ghJson<{ html_url: string }>(
        `${apiBase}/pulls`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: prTitle,
            head: branchName,
            base: input.base,
            body: input.prBody ?? "",
          }),
        },
        fetchImpl
      );

      return {
        url: pr.html_url,
        branch: branchName,
        files: blobs.length,
      };
    },
  };
}

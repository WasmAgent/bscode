"use client";
import { useCallback, useEffect, useState } from "react";

const GH_TOKEN_KEY = "bscode_github_token";

export interface GitHubUser {
  login: string;
  avatar_url: string;
  name: string | null;
}

export interface PushResult {
  repoUrl: string;
  repoName: string;
}

export function useGitHub() {
  const [token, setToken] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return localStorage.getItem(GH_TOKEN_KEY);
  });
  const [user, setUser] = useState<GitHubUser | null>(null);
  const [pushing, setPushing] = useState(false);

  // Fetch user profile whenever token changes
  useEffect(() => {
    if (!token) {
      setUser(null);
      return;
    }
    fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    })
      .then((r) => r.json())
      .then((u: GitHubUser) => setUser(u))
      .catch(() => {
        setToken(null);
        localStorage.removeItem(GH_TOKEN_KEY);
      });
  }, [token]);

  // Read token from URL fragment after OAuth redirect
  useEffect(() => {
    const hash = window.location.hash;
    if (hash.includes("github-token=")) {
      const params = new URLSearchParams(hash.slice(1));
      const t = params.get("github-token");
      if (t) {
        localStorage.setItem(GH_TOKEN_KEY, t);
        setToken(t);
        // Clean the fragment from URL without reloading
        window.history.replaceState(null, "", window.location.pathname);
      }
    }
  }, []);

  const login = useCallback(() => {
    const clientId = process.env.NEXT_PUBLIC_GITHUB_CLIENT_ID;
    if (!clientId) {
      alert("GitHub OAuth not configured — set NEXT_PUBLIC_GITHUB_CLIENT_ID in .env.local");
      return;
    }
    const state = Math.random().toString(36).slice(2);
    const callbackUrl = `${window.location.origin}/api/github/callback`;
    const url = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(callbackUrl)}&scope=repo&state=${state}`;
    // Open as popup so user doesn't leave the page
    const popup = window.open(url, "github-oauth", "width=600,height=700,left=400,top=100");
    if (!popup) window.location.href = url; // fallback if popups blocked
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(GH_TOKEN_KEY);
    setToken(null);
    setUser(null);
  }, []);

  /**
   * Create a new GitHub repo and push all workspace files to it.
   * Files come from the worker's /files/bulk endpoint.
   */
  const pushToGitHub = useCallback(
    async (workerUrl: string, repoName?: string): Promise<PushResult> => {
      if (!token || !user) throw new Error("Not authenticated");
      setPushing(true);
      try {
        // 1. Fetch workspace files
        const filesRes = await fetch(`${workerUrl}/files/bulk`);
        const { files } = (await filesRes.json()) as { files: { path: string; content: string }[] };
        if (!files?.length) throw new Error("No files to push");

        // 2. Derive repo name from package.json if available, else timestamp
        const pkgFile = files.find((f) => f.path === "package.json");
        let name = repoName;
        if (!name) {
          if (pkgFile) {
            try {
              const pkg = JSON.parse(pkgFile.content) as { name?: string };
              name = pkg.name?.replace(/[^a-z0-9-]/g, "-") || undefined;
            } catch {
              /* ignore */
            }
          }
          name = name || `bscode-project-${Date.now().toString(36)}`;
        }

        // 3. Create the repo
        const createRes = await fetch("https://api.github.com/user/repos", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name,
            description: "Created with BSCode AI Coding Assistant",
            private: false,
            auto_init: false,
          }),
        });
        if (!createRes.ok) {
          const err = (await createRes.json()) as { message?: string };
          throw new Error(err.message ?? "Failed to create repo");
        }
        const repo = (await createRes.json()) as { full_name: string; html_url: string };

        // 4. Push files via GitHub Contents API (blob + tree + commit)
        const ghApi = `https://api.github.com/repos/${repo.full_name}`;
        const headers = {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        };

        // Create blobs for all files
        const blobs = await Promise.all(
          files.map(async ({ path, content }) => {
            const blobRes = await fetch(`${ghApi}/git/blobs`, {
              method: "POST",
              headers,
              body: JSON.stringify({ content, encoding: "utf-8" }),
            });
            const blob = (await blobRes.json()) as { sha: string };
            return { path, sha: blob.sha };
          })
        );

        // Create tree
        const treeRes = await fetch(`${ghApi}/git/trees`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            tree: blobs.map(({ path, sha }) => ({
              path,
              mode: "100644",
              type: "blob",
              sha,
            })),
          }),
        });
        const tree = (await treeRes.json()) as { sha: string };

        // Create commit
        const commitRes = await fetch(`${ghApi}/git/commits`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            message: "Initial commit from BSCode",
            tree: tree.sha,
          }),
        });
        const commit = (await commitRes.json()) as { sha: string };

        // Create main branch ref
        await fetch(`${ghApi}/git/refs`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ref: "refs/heads/main", sha: commit.sha }),
        });

        return { repoUrl: repo.html_url, repoName: name };
      } finally {
        setPushing(false);
      }
    },
    [token, user]
  );

  return { token, user, pushing, login, logout, pushToGitHub };
}

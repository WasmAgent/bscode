/**
 * Tests for the useGitHub hook.
 *
 * Strategy: stub global fetch + localStorage + window.location/history. The
 * hook has three concerns we pin:
 *   1. Token lifecycle — initial read from localStorage, hydrate from
 *      OAuth fragment, persist on login, clear on logout, drop on user
 *      profile fetch failure.
 *   2. OAuth fragment hydration — token lifted from window.location.hash
 *      AND fragment cleaned from URL (so a refresh/copy-link doesn't leak
 *      the token to a third-party).
 *   3. pushToGitHub — derive repo name from package.json, sanitize bad
 *      chars, surface GitHub API errors.
 *
 * Edge: the hook calls window.location.hash at mount; we must set it
 * BEFORE renderHook so the effect picks it up.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useGitHub } from "./useGitHub";

const realFetch = globalThis.fetch;

function mockFetchOnce(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return Promise.resolve(handler(url, init));
  }) as unknown as typeof globalThis.fetch;
}

function clearFragment() {
  // jsdom doesn't let us assign to location.hash directly in some setups;
  // history.replaceState is the safe path used by the hook itself.
  window.history.replaceState(null, "", window.location.pathname);
}

describe("useGitHub", () => {
  beforeEach(() => {
    localStorage.clear();
    clearFragment();
    globalThis.fetch = realFetch;
  });
  afterEach(() => {
    localStorage.clear();
    clearFragment();
    globalThis.fetch = realFetch;
  });

  it("initial state: token=null, user=null when localStorage is empty", () => {
    mockFetchOnce(() => new Response("{}", { status: 200 }));
    const { result } = renderHook(() => useGitHub());
    expect(result.current.token).toBeNull();
    expect(result.current.user).toBeNull();
    expect(result.current.pushing).toBe(false);
  });

  it("hydrates token from localStorage on mount + fetches the user profile", async () => {
    localStorage.setItem("bscode_github_token", "ghp_existing");
    mockFetchOnce((url) => {
      expect(url).toBe("https://api.github.com/user");
      return new Response(
        JSON.stringify({ login: "alice", avatar_url: "https://a.example/x.png", name: "Alice" }),
        { status: 200 }
      );
    });

    const { result } = renderHook(() => useGitHub());
    expect(result.current.token).toBe("ghp_existing");
    await waitFor(() => expect(result.current.user?.login).toBe("alice"));
    expect(result.current.user?.name).toBe("Alice");
  });

  it("a failed profile fetch wipes the token + localStorage entry", async () => {
    localStorage.setItem("bscode_github_token", "ghp_stale");
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error("invalid token"))
    ) as unknown as typeof globalThis.fetch;

    const { result } = renderHook(() => useGitHub());
    await waitFor(() => expect(result.current.token).toBeNull());
    expect(localStorage.getItem("bscode_github_token")).toBeNull();
  });

  it("hydrates the token from #github-token= fragment after OAuth redirect", async () => {
    // Set the URL fragment BEFORE renderHook so the effect picks it up.
    window.history.replaceState(null, "", "/?dummy#github-token=ghp_FROM_FRAGMENT");
    mockFetchOnce(
      () =>
        new Response(JSON.stringify({ login: "bob", avatar_url: "", name: null }), { status: 200 })
    );

    const { result } = renderHook(() => useGitHub());
    await waitFor(() => expect(result.current.token).toBe("ghp_FROM_FRAGMENT"));
    expect(localStorage.getItem("bscode_github_token")).toBe("ghp_FROM_FRAGMENT");
  });

  it("strips the OAuth fragment from the URL after hydration (copy-link safety)", async () => {
    window.history.replaceState(null, "", "/some/path#github-token=ghp_LEAK_CHECK");
    mockFetchOnce(
      () =>
        new Response(JSON.stringify({ login: "u", avatar_url: "", name: null }), { status: 200 })
    );

    renderHook(() => useGitHub());
    // The hook calls history.replaceState to remove the fragment so a
    // refresh / copy-link doesn't surface the access_token to anything
    // that scrapes window.location.href.
    await waitFor(() => expect(window.location.hash).toBe(""));
    expect(window.location.pathname).toBe("/some/path");
  });

  it("logout clears token + user + localStorage", async () => {
    localStorage.setItem("bscode_github_token", "ghp_x");
    mockFetchOnce(
      () =>
        new Response(JSON.stringify({ login: "u", avatar_url: "", name: null }), { status: 200 })
    );

    const { result } = renderHook(() => useGitHub());
    await waitFor(() => expect(result.current.user?.login).toBe("u"));

    act(() => result.current.logout());
    expect(result.current.token).toBeNull();
    expect(result.current.user).toBeNull();
    expect(localStorage.getItem("bscode_github_token")).toBeNull();
  });

  it("pushToGitHub throws when not authenticated", async () => {
    const { result } = renderHook(() => useGitHub());
    await expect(result.current.pushToGitHub("http://w")).rejects.toThrow(/Not authenticated/);
  });

  it("pushToGitHub throws when there are no workspace files", async () => {
    localStorage.setItem("bscode_github_token", "ghp_x");
    let userFetched = false;
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://api.github.com/user") {
        userFetched = true;
        return Promise.resolve(
          new Response(JSON.stringify({ login: "u", avatar_url: "", name: null }), { status: 200 })
        );
      }
      // Worker /files/bulk returns empty list.
      if (url.endsWith("/files/bulk")) {
        return Promise.resolve(new Response(JSON.stringify({ files: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof globalThis.fetch;

    const { result } = renderHook(() => useGitHub());
    await waitFor(() => expect(result.current.user?.login).toBe("u"));
    expect(userFetched).toBe(true);
    await expect(result.current.pushToGitHub("http://w")).rejects.toThrow(/No files to push/);
  });

  it("pushToGitHub orchestrates blobs → tree → commit → ref and returns the repo URL", async () => {
    localStorage.setItem("bscode_github_token", "ghp_x");
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url === "https://api.github.com/user") {
        return Promise.resolve(
          new Response(JSON.stringify({ login: "u", avatar_url: "", name: null }), { status: 200 })
        );
      }
      if (url.endsWith("/files/bulk")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              files: [
                { path: "package.json", content: '{"name":"my-proj"}' },
                { path: "src/a.ts", content: "export {}" },
              ],
            }),
            { status: 200 }
          )
        );
      }
      if (url === "https://api.github.com/user/repos") {
        return Promise.resolve(
          new Response(
            JSON.stringify({ full_name: "u/my-proj", html_url: "https://github.com/u/my-proj" }),
            { status: 201 }
          )
        );
      }
      if (/\/git\/blobs$/.test(url)) {
        return Promise.resolve(new Response(JSON.stringify({ sha: "blob-sha" }), { status: 201 }));
      }
      if (/\/git\/trees$/.test(url)) {
        return Promise.resolve(new Response(JSON.stringify({ sha: "tree-sha" }), { status: 201 }));
      }
      if (/\/git\/commits$/.test(url)) {
        return Promise.resolve(
          new Response(JSON.stringify({ sha: "commit-sha" }), { status: 201 })
        );
      }
      if (/\/git\/refs$/.test(url)) {
        return Promise.resolve(new Response("{}", { status: 201 }));
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof globalThis.fetch;

    const { result } = renderHook(() => useGitHub());
    await waitFor(() => expect(result.current.user?.login).toBe("u"));

    const out = await result.current.pushToGitHub("http://w");
    expect(out.repoUrl).toBe("https://github.com/u/my-proj");
    expect(out.repoName).toBe("my-proj");

    // Sanity: the orchestration touched every required GitHub endpoint.
    const ghCalls = calls.filter((c) => c.url.startsWith("https://api.github.com/repos/u/my-proj"));
    expect(ghCalls.some((c) => c.url.endsWith("/git/blobs"))).toBe(true);
    expect(ghCalls.some((c) => c.url.endsWith("/git/trees"))).toBe(true);
    expect(ghCalls.some((c) => c.url.endsWith("/git/commits"))).toBe(true);
    expect(ghCalls.some((c) => c.url.endsWith("/git/refs"))).toBe(true);
  });

  it("pushToGitHub sanitises an unsafe package.json name (drops illegal chars)", async () => {
    localStorage.setItem("bscode_github_token", "ghp_x");
    let createdName = "";
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://api.github.com/user") {
        return Promise.resolve(
          new Response(JSON.stringify({ login: "u", avatar_url: "", name: null }), { status: 200 })
        );
      }
      if (url.endsWith("/files/bulk")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              files: [
                {
                  path: "package.json",
                  content: '{"name":"@scope/Bad Name!!"}',
                },
              ],
            }),
            { status: 200 }
          )
        );
      }
      if (url === "https://api.github.com/user/repos") {
        const body = JSON.parse((init?.body as string) ?? "{}") as { name: string };
        createdName = body.name;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              full_name: `u/${body.name}`,
              html_url: `https://github.com/u/${body.name}`,
            }),
            { status: 201 }
          )
        );
      }
      if (/\/git\/blobs$/.test(url)) {
        return Promise.resolve(new Response(JSON.stringify({ sha: "b" }), { status: 201 }));
      }
      if (/\/git\/trees$/.test(url)) {
        return Promise.resolve(new Response(JSON.stringify({ sha: "t" }), { status: 201 }));
      }
      if (/\/git\/commits$/.test(url)) {
        return Promise.resolve(new Response(JSON.stringify({ sha: "c" }), { status: 201 }));
      }
      if (/\/git\/refs$/.test(url)) {
        return Promise.resolve(new Response("{}", { status: 201 }));
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof globalThis.fetch;

    const { result } = renderHook(() => useGitHub());
    await waitFor(() => expect(result.current.user).not.toBeNull());
    await result.current.pushToGitHub("http://w");

    // GitHub allows [a-z0-9-] in repo names; the sanitiser must collapse
    // everything else into "-".
    expect(createdName).toMatch(/^[a-z0-9-]+$/);
    // The "@scope" + space + "!!" all became dashes.
    expect(createdName).toContain("scope");
  });

  it("pushToGitHub falls back to a timestamp name when there's no package.json", async () => {
    localStorage.setItem("bscode_github_token", "ghp_x");
    let createdName = "";
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://api.github.com/user") {
        return Promise.resolve(
          new Response(JSON.stringify({ login: "u", avatar_url: "", name: null }), { status: 200 })
        );
      }
      if (url.endsWith("/files/bulk")) {
        return Promise.resolve(
          new Response(JSON.stringify({ files: [{ path: "src/a.ts", content: "export {}" }] }), {
            status: 200,
          })
        );
      }
      if (url === "https://api.github.com/user/repos") {
        const body = JSON.parse((init?.body as string) ?? "{}") as { name: string };
        createdName = body.name;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              full_name: `u/${body.name}`,
              html_url: `https://github.com/u/${body.name}`,
            }),
            { status: 201 }
          )
        );
      }
      // happy stubs for the rest
      if (/\/git\/blobs$/.test(url)) {
        return Promise.resolve(new Response(JSON.stringify({ sha: "b" }), { status: 201 }));
      }
      if (/\/git\/trees$/.test(url)) {
        return Promise.resolve(new Response(JSON.stringify({ sha: "t" }), { status: 201 }));
      }
      if (/\/git\/commits$/.test(url)) {
        return Promise.resolve(new Response(JSON.stringify({ sha: "c" }), { status: 201 }));
      }
      if (/\/git\/refs$/.test(url)) {
        return Promise.resolve(new Response("{}", { status: 201 }));
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof globalThis.fetch;

    const { result } = renderHook(() => useGitHub());
    await waitFor(() => expect(result.current.user).not.toBeNull());
    await result.current.pushToGitHub("http://w");

    expect(createdName).toMatch(/^bscode-project-[a-z0-9]+$/);
  });

  it("pushToGitHub propagates the GitHub API error message verbatim", async () => {
    localStorage.setItem("bscode_github_token", "ghp_x");
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://api.github.com/user") {
        return Promise.resolve(
          new Response(JSON.stringify({ login: "u", avatar_url: "", name: null }), { status: 200 })
        );
      }
      if (url.endsWith("/files/bulk")) {
        return Promise.resolve(
          new Response(JSON.stringify({ files: [{ path: "a.ts", content: "x" }] }), { status: 200 })
        );
      }
      if (url === "https://api.github.com/user/repos") {
        return Promise.resolve(
          new Response(JSON.stringify({ message: "name already exists on this account" }), {
            status: 422,
          })
        );
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof globalThis.fetch;

    const { result } = renderHook(() => useGitHub());
    await waitFor(() => expect(result.current.user).not.toBeNull());
    await expect(result.current.pushToGitHub("http://w")).rejects.toThrow(/name already exists/);
  });
});

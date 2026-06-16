/**
 * Tests for /api/github/callback — the OAuth code-exchange handler.
 *
 * Pin every branch the route can take:
 *   1. Missing `code` query param → redirect to /#github-error=no_code.
 *   2. Server env vars (GITHUB_CLIENT_ID/SECRET) missing → not_configured.
 *   3. Successful token exchange → redirect to /#github-token=<urlencoded>.
 *   4. Token exchange returns an `error` field → that error is propagated.
 *   5. fetch throws → the error message is propagated to the fragment.
 *   6. The `state` round-tripped to the SPA when supplied — needed for
 *      CSRF defence on the client side.
 *   7. The token NEVER appears in a query string (fragment-only) so it
 *      cannot leak through Referer headers / server logs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const ORIG_ENV = { ...process.env };
const realFetch = globalThis.fetch;

function makeRequest(qs: string): Request {
  return new Request(`http://app.example/api/github/callback${qs}`);
}

function setEnv(over: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else (process.env as Record<string, string>)[k] = v;
  }
}

describe("/api/github/callback GET", () => {
  beforeEach(() => {
    setEnv({ GITHUB_CLIENT_ID: "id-test", GITHUB_CLIENT_SECRET: "secret-test" });
    globalThis.fetch = realFetch;
  });
  afterEach(() => {
    process.env = { ...ORIG_ENV };
    globalThis.fetch = realFetch;
  });

  it("redirects to /#github-error=no_code when `code` is missing", async () => {
    const res = await GET(makeRequest("") as never);
    expect(res.status).toBe(307); // NextResponse.redirect default
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("#github-error=no_code");
  });

  it("redirects to /#github-error=not_configured when env vars are missing", async () => {
    setEnv({ GITHUB_CLIENT_ID: undefined, GITHUB_CLIENT_SECRET: undefined });
    const res = await GET(makeRequest("?code=abc") as never);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("#github-error=not_configured");
  });

  it("redirects with #github-token=<token> on a successful exchange", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ access_token: "ghp_TOKEN_VALUE" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    ) as unknown as typeof globalThis.fetch;

    const res = await GET(makeRequest("?code=abc") as never);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("#github-token=ghp_TOKEN_VALUE");
  });

  it("URL-encodes the token (special chars survive the redirect)", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ access_token: "tok+with/slash=eq" }), { status: 200 })
      )
    ) as unknown as typeof globalThis.fetch;

    const res = await GET(makeRequest("?code=abc") as never);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("#github-token=tok%2Bwith%2Fslash%3Deq");
  });

  it("never leaks the token into the QUERY string — fragment only", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ access_token: "ghp_LEAK_CHECK" }), { status: 200 })
      )
    ) as unknown as typeof globalThis.fetch;

    const res = await GET(makeRequest("?code=abc") as never);
    const loc = res.headers.get("location") ?? "";
    const url = new URL(loc, "http://app.example");
    // Querystring must NOT contain the token (would land in Referer / logs).
    expect(url.search).not.toContain("ghp_LEAK_CHECK");
    // Fragment IS allowed to.
    expect(url.hash).toContain("ghp_LEAK_CHECK");
  });

  it("round-trips ?state= to the SPA via the fragment (CSRF token survives)", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ access_token: "tok" }), { status: 200 }))
    ) as unknown as typeof globalThis.fetch;

    const res = await GET(makeRequest("?code=abc&state=csrf-123") as never);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("&state=csrf-123");
  });

  it("propagates GitHub's `error` field into the fragment", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "bad_verification_code" }), { status: 200 })
      )
    ) as unknown as typeof globalThis.fetch;

    const res = await GET(makeRequest("?code=abc") as never);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("#github-error=bad_verification_code");
  });

  it("falls back to token_exchange_failed when neither token nor error present", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({}), { status: 200 }))
    ) as unknown as typeof globalThis.fetch;

    const res = await GET(makeRequest("?code=abc") as never);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("#github-error=token_exchange_failed");
  });

  it("propagates fetch errors as URL-encoded error messages", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error("ECONNRESET"))
    ) as unknown as typeof globalThis.fetch;

    const res = await GET(makeRequest("?code=abc") as never);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("#github-error=");
    expect(loc).toMatch(/ECONNRESET/);
  });

  it("posts JSON to GitHub's token endpoint with the right shape", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      capturedBody = (init?.body as string) ?? "";
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: "tok" }), { status: 200 })
      );
    }) as unknown as typeof globalThis.fetch;

    await GET(makeRequest("?code=THE_CODE") as never);
    expect(capturedUrl).toBe("https://github.com/login/oauth/access_token");
    const parsed = JSON.parse(capturedBody) as Record<string, string>;
    expect(parsed.client_id).toBe("id-test");
    expect(parsed.client_secret).toBe("secret-test");
    expect(parsed.code).toBe("THE_CODE");
  });
});

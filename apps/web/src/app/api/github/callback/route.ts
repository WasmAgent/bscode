import { type NextRequest, NextResponse } from "next/server";

// Cloudflare Pages requires every non-static route to declare the edge
// runtime — node:vm and the rest of Node's stdlib aren't available on
// the Pages runtime. This route doesn't actually need anything beyond
// fetch + URL parsing, so the switch is free.
export const runtime = "edge";

// GitHub OAuth callback — exchanges authorization code for access token,
// then redirects back to the app with the token in the URL fragment (#).
// The fragment is never sent to the server, so the token stays client-side.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  if (!code) {
    return NextResponse.redirect(new URL("/#github-error=no_code", request.url));
  }

  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return NextResponse.redirect(new URL("/#github-error=not_configured", request.url));
  }

  try {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    });
    const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string };

    if (tokenData.error || !tokenData.access_token) {
      const err = encodeURIComponent(tokenData.error ?? "token_exchange_failed");
      return NextResponse.redirect(new URL(`/#github-error=${err}`, request.url));
    }

    // Pass token back to the SPA via URL fragment — never touches a server log
    const token = encodeURIComponent(tokenData.access_token);
    const stateParam = state ? `&state=${encodeURIComponent(state)}` : "";
    const origin = new URL(request.url).origin;
    return NextResponse.redirect(new URL(`/#github-token=${token}${stateParam}`, origin));
  } catch (err) {
    const msg = encodeURIComponent((err as Error).message);
    return NextResponse.redirect(new URL(`/#github-error=${msg}`, request.url));
  }
}

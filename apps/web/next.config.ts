import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  env: {
    // The default `bun run dev` worker (apps/worker/src/server.node.ts) listens
    // on PORT=8788. Wrangler's `dev:wrangler` uses 8787, but that's a secondary
    // path. Keep this in sync with the per-component fallbacks in apps/web/src.
    NEXT_PUBLIC_WORKER_URL: process.env.NEXT_PUBLIC_WORKER_URL ?? "http://localhost:8788",
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Required for WebContainers (SharedArrayBuffer access)
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          // credentialless (not require-corp) so Monaco CDN resources still load
          { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
        ],
      },
    ];
  },
};

export default nextConfig;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_WORKER_URL: process.env.NEXT_PUBLIC_WORKER_URL ?? "http://localhost:8787",
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

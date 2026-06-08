/**
 * Bun development server.
 * Runs the same Hono app locally without Wrangler/Miniflare.
 * QuickJSKernel WASM works correctly here.
 *
 * Usage:
 *   bun --watch --env-file=.dev.vars src/server.node.ts
 *   # or via package.json:
 *   bun dev
 */
import { createApp } from "./app.js";
import { MemKvStore } from "./platform.js";

const port = Number(process.env.PORT ?? 8788);

const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
  anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN,
  doubaoApiKey: process.env.DOUBAO_API_KEY,
  deepseekApiKey: process.env.DEEPSEEK_API_KEY,
  clientToken: process.env.BSCODE_CLIENT_TOKEN,
  allowedOrigin: process.env.BSCODE_ALLOWED_ORIGIN ?? "*",
  filesKv: new MemKvStore(),
  sessionsKv: new MemKvStore(),
};

const app = createApp(config);

const server = Bun.serve({ fetch: app.fetch, port });

const model = config.anthropicAuthToken
  ? "Anthropic (proxy)"
  : config.anthropicApiKey
    ? "Anthropic"
    : config.doubaoApiKey
      ? "Doubao"
      : "DeepSeek";

console.log(`\n  BSCode Bun server`);
console.log(`  http://localhost:${server.port}\n`);
console.log(`  Agent modes: code (QuickJS WASM) | tool (DAG scheduler)`);
console.log(`  Model provider: ${model}`);
console.log(
  `\n  CLI: node ../../scripts/bscode.mjs --url http://localhost:${server.port} "task"\n`
);

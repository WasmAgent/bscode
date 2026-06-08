/**
 * Node.js development server.
 * Runs the same Hono app locally without Wrangler/Miniflare.
 * QuickJSKernel WASM works correctly here.
 *
 * Usage:
 *   node --env-file=.dev.vars src/server.node.mjs
 *   # or via package.json script:
 *   pnpm dev:node
 */
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { MemKvStore } from "./platform.js";

const port = Number(process.env.PORT ?? 8788);

const config = {
  anthropicApiKey:    process.env.ANTHROPIC_API_KEY,
  anthropicBaseUrl:   process.env.ANTHROPIC_BASE_URL,
  anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN,
  doubaoApiKey:       process.env.DOUBAO_API_KEY,
  deepseekApiKey:     process.env.DEEPSEEK_API_KEY,
  clientToken:        process.env.BSCODE_CLIENT_TOKEN,
  allowedOrigin:      process.env.BSCODE_ALLOWED_ORIGIN ?? "*",
  // In-memory KV stores (data persists only for the lifetime of this process)
  filesKv:    new MemKvStore(),
  sessionsKv: new MemKvStore(),
};

const app = createApp(config);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`\n  BSCode Node.js server`);
  console.log(`  http://localhost:${info.port}\n`);
  console.log(`  Agent modes: code (QuickJS WASM) | tool (DAG scheduler)`);
  const model = config.anthropicAuthToken ? "Anthropic (proxy)" :
                config.anthropicApiKey    ? "Anthropic" :
                config.doubaoApiKey       ? "Doubao" : "DeepSeek";
  console.log(`  Model provider: ${model}`);
  console.log(`\n  CLI test: node ../../scripts/bscode.mjs --url http://localhost:${info.port} "your task"\n`);
});

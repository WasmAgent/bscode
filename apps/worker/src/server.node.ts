/**
 * Bun development server.
 * - FsKvStore: agent-written files land on disk (real filesystem)
 * - enableShell: real Bun.spawn shell execution + git tools
 * - idleTimeout: 0 prevents SSE stream termination during long ops
 *
 * Usage: bun --watch --env-file=.dev.vars src/server.node.ts
 */

import { join } from "node:path";
import { createApp } from "./app.js";
import { FsKvStore, MemKvStore } from "./platform.js";

const port = Number(process.env.PORT ?? 8788);
const workdir = process.env.BSCODE_WORKDIR ?? process.cwd();

const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
  anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN,
  doubaoApiKey: process.env.DOUBAO_API_KEY,
  deepseekApiKey: process.env.DEEPSEEK_API_KEY,
  e2bApiKey: process.env.E2B_API_KEY,
  clientToken: process.env.BSCODE_CLIENT_TOKEN,
  allowedOrigin: process.env.BSCODE_ALLOWED_ORIGIN ?? "*",
  // Real filesystem: agent-written files land in workdir/.bscode-files/
  filesKv: new FsKvStore(join(workdir, ".bscode-files")),
  sessionsKv: new MemKvStore(),
  // Real shell: enables run_command + git tools
  enableShell: true,
  workdir,
};

const app = createApp(config);

const server = Bun.serve({
  fetch: app.fetch,
  port,
  // Disable idle timeout so SSE streams aren't killed during long agent runs
  idleTimeout: 0,
});

const modelProvider = config.anthropicAuthToken
  ? "Anthropic (proxy)"
  : config.anthropicApiKey
    ? "Anthropic"
    : config.doubaoApiKey
      ? "Doubao"
      : "DeepSeek";

console.log(`\n  BSCode Bun server v0.2.0`);
console.log(`  http://localhost:${server.port}\n`);
console.log(`  Workdir  : ${workdir}`);
console.log(`  Files KV : ${join(workdir, ".bscode-files")} (real filesystem)`);
console.log(`  Shell    : enabled (git tools active)`);
console.log(`  Model    : ${modelProvider}`);
console.log(
  `\n  CLI: node ../../scripts/bscode.mjs --url http://localhost:${server.port} "task"\n`
);

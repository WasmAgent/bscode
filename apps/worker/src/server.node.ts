/**
 * Node.js development server — pure node:http, no Bun.serve.
 *
 * Handles CORS preflight synchronously at the Node.js layer so Chrome 148+
 * Private Network Access (PNA) headers are delivered reliably.
 * SSE streaming works because node:http flushes each res.write() immediately.
 *
 * Usage: bun --watch --env-file=.dev.vars src/server.node.ts
 */

import { createServer } from "node:http";
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
  filesKv: new FsKvStore(join(workdir, ".bscode-files")),
  sessionsKv: new MemKvStore(),
  enableShell: true,
  workdir,
};

const app = createApp(config);

// CORS headers including Chrome 148+ Private Network Access requirement
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-Id",
  "Access-Control-Allow-Private-Network": "true",
  "Access-Control-Max-Age": "86400",
};

const server = createServer((req, res) => {
  // Handle OPTIONS preflight synchronously — no async, no await.
  // This ensures Chrome receives CORS headers before its PNA timeout.
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // For all other requests: buffer body, call Hono, stream response back.
  const t0 = Date.now();
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const body = chunks.length > 0 ? Buffer.concat(chunks) : null;
    const url = `http://localhost:${port}${req.url}`;
    const headers = new Headers();
    for (const [key, val] of Object.entries(req.headers)) {
      if (!val) continue;
      if (Array.isArray(val)) val.forEach((v) => headers.append(key, v));
      else headers.set(key, val);
    }

    const webReq = new Request(url, {
      method: req.method,
      headers,
      body: body?.length ? body : undefined,
    });

    app
      .fetch(webReq)
      .then(async (webRes) => {
        // Merge CORS headers into every response
        const resHeaders: Record<string, string> = { ...CORS_HEADERS };
        webRes.headers.forEach((val, key) => {
          resHeaders[key] = val;
        });
        res.writeHead(webRes.status, resHeaders);

        // Log every non-OPTIONS request
        const isSSE = webRes.headers.get("content-type")?.includes("event-stream");
        if (!isSSE) {
          console.log(`${req.method} ${req.url} → ${webRes.status} (${Date.now() - t0}ms)`);
        } else {
          console.log(`${req.method} ${req.url} → SSE stream started`);
        }

        if (!webRes.body) {
          res.end();
          return;
        }

        // Stream body — each write is flushed immediately by node:http
        const reader = webRes.body.getReader();
        const pump = async () => {
          const { done, value } = await reader.read();
          if (done) {
            if (isSSE) console.log(`${req.method} ${req.url} → SSE done (${Date.now() - t0}ms)`);
            res.end();
            return;
          }
          res.write(value, () => { pump(); });
        };
        pump();
      })
      .catch((err) => {
        console.error(`${req.method} ${req.url} → handler error: ${err}`);
        if (!res.headersSent) res.writeHead(500);
        res.end(String(err));
      });
  });
});

server.listen(port, () => {
  const modelProvider = config.anthropicAuthToken
    ? "Anthropic (proxy)"
    : config.anthropicApiKey
      ? "Anthropic"
      : config.doubaoApiKey
        ? "Doubao"
        : "DeepSeek";

  console.log(`\n  BSCode Node server v0.2.0`);
  console.log(`  http://localhost:${port}\n`);
  console.log(`  Workdir  : ${workdir}`);
  console.log(`  Files KV : ${join(workdir, ".bscode-files")} (real filesystem)`);
  console.log(`  Shell    : enabled (git tools active)`);
  console.log(`  Model    : ${modelProvider}`);
  console.log(`\n  CLI: node ../../scripts/bscode.mjs --url http://localhost:${port} "task"\n`);
});


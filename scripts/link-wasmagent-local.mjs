#!/usr/bin/env node
/**
 * Link local wasmagent-js packages into this workspace for development.
 *
 * Usage:
 *   node scripts/link-wasmagent-local.mjs [path-to-wasmagent-js]
 *
 * Default sibling path: ../wasmagent-js
 * This overwrites apps/worker/package.json @wasmagent/* entries with
 * "file:../../.." relative paths so bun resolves them from disk.
 * Run unlink-wasmagent-local.mjs to restore npm version ranges.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "..");
const wasmagentRoot = resolve(repoRoot, process.argv[2] ?? "../wasmagent-js");

const workerPkgPath = resolve(repoRoot, "apps/worker/package.json");
const pkg = JSON.parse(readFileSync(workerPkgPath, "utf8"));

const PACKAGES = [
  "agent-prompts", "core", "kernel-pyodide", "kernel-quickjs", "kernel-remote",
  "mcp-server", "model-anthropic", "model-deepseek", "model-doubao", "model-openai",
  "tools-browser", "tools-rag",
];

let changed = 0;
for (const name of PACKAGES) {
  const key = `@wasmagent/${name}`;
  const localPath = resolve(wasmagentRoot, "packages", name);
  const rel = `file:${localPath}`;
  if (pkg.dependencies[key] !== rel) {
    pkg.dependencies[key] = rel;
    changed++;
  }
}

writeFileSync(workerPkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log(`Linked ${changed} @wasmagent/* packages from ${wasmagentRoot}`);
console.log("Run: bun install");

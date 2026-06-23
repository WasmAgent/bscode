#!/usr/bin/env node
/**
 * Restore apps/worker/package.json @wasmagent/* entries to npm version ranges.
 * Run this before committing or deploying to production.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "..");
const workerPkgPath = resolve(repoRoot, "apps/worker/package.json");
const pkg = JSON.parse(readFileSync(workerPkgPath, "utf8"));

const VERSION = "^0.2.0";
const PACKAGES = [
  "agent-prompts", "core", "kernel-pyodide", "kernel-quickjs", "kernel-remote",
  "mcp-server", "model-anthropic", "model-deepseek", "model-doubao", "model-openai",
  "tools-browser", "tools-rag",
];

let changed = 0;
for (const name of PACKAGES) {
  const key = `@wasmagent/${name}`;
  if (pkg.dependencies[key]?.startsWith("file:")) {
    pkg.dependencies[key] = VERSION;
    changed++;
  }
}

writeFileSync(workerPkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log(`Restored ${changed} @wasmagent/* packages to ${VERSION}`);
console.log("Run: bun install");

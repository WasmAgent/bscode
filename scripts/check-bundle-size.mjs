#!/usr/bin/env node
/**
 * check-bundle-size.mjs — enforce a size budget on the Cloudflare Worker bundle.
 *
 * Cloudflare Workers have a 1 MB compressed / 10 MB uncompressed hard limit.
 * pyodide and other optional heavy deps must NOT be statically bundled into the
 * production Worker. This script guards against accidental bundling.
 *
 * Budget (uncompressed): 6 MB — leaves headroom before the 10 MB hard limit.
 *
 * Usage:
 *   node scripts/check-bundle-size.mjs [--budget-mb 6]
 *
 * The wrangler dry-run build is expected to have already run and placed the
 * output in apps/worker/dist/index.js. Run via:
 *   bun run --filter @bscode/worker build   # triggers `wrangler deploy --dry-run`
 */

import { statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const BUDGET_MB = (() => {
  const idx = process.argv.indexOf("--budget-mb");
  return idx !== -1 ? parseFloat(process.argv[idx + 1]) : 6;
})();
const BUDGET_BYTES = BUDGET_MB * 1024 * 1024;

const BUNDLE_PATH = resolve(ROOT, "apps/worker/dist/index.js");

let stat;
try {
  stat = statSync(BUNDLE_PATH);
} catch {
  console.error(`ERROR: bundle not found at ${BUNDLE_PATH}`);
  console.error("Run: bun run --filter @bscode/worker build");
  process.exit(1);
}

const bytes = stat.size;
const mb = (bytes / 1024 / 1024).toFixed(2);
const budgetMb = BUDGET_MB.toFixed(2);

if (bytes > BUDGET_BYTES) {
  console.error(`✗ Worker bundle size ${mb} MB exceeds ${budgetMb} MB budget`);
  console.error(`  ${BUNDLE_PATH}`);
  console.error(
    "  Likely cause: pyodide, a browser tool, or a model SDK was statically bundled."
  );
  console.error(
    "  Fix: ensure heavy optional deps use dynamic import() inside function bodies."
  );
  process.exit(1);
}

console.log(
  `✓ Worker bundle size ${mb} MB ≤ ${budgetMb} MB budget (${BUNDLE_PATH})`
);

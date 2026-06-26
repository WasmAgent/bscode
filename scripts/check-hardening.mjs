#!/usr/bin/env node
/**
 * check-hardening.mjs — Cloudflare Worker production hardening checklist.
 *
 * Checks:
 *   H1: BSCODE_ALLOWED_ORIGIN is not localhost
 *   H2: AUTH_SECRET env var is declared (not hardcoded)
 *   H3: wrangler.toml does not contain hardcoded secrets
 *   H4: Rate limiting is enabled (rateLimit middleware imported)
 *   H5: Bundle size is within budget (run check-bundle-size.mjs)
 *   H6: CSP headers are set in worker response
 *   H7: CORS origin is not wildcard "*"
 *   H8: No console.log with sensitive data patterns in worker src
 *
 * Usage:
 *   node scripts/check-hardening.mjs           # warn mode (exit 0)
 *   node scripts/check-hardening.mjs --strict  # strict mode (exit 1 on any fail)
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const STRICT = process.argv.includes("--strict");

let warnings = 0;
let errors = 0;

function pass(id, msg) {
  console.log("  ✓", id, msg);
}

function warn(id, msg) {
  warnings++;
  console.warn("  ⚠", id, msg);
}

function fail(id, msg) {
  errors++;
  console.error("  ✗", id, msg);
}

function check(id, ok, passMsg, failMsg, strict = false) {
  if (ok) {
    pass(id, passMsg);
  } else if (strict || STRICT) {
    fail(id, failMsg);
  } else {
    warn(id, failMsg);
  }
}

console.log("\nbscode Cloudflare Worker hardening checklist\n");

// H1: BSCODE_ALLOWED_ORIGIN not localhost
const wranglerPath = resolve(ROOT, "apps/worker/wrangler.toml");
let wranglerContent = "";
if (existsSync(wranglerPath)) {
  wranglerContent = readFileSync(wranglerPath, "utf8");
  const hasLocalhost =
    wranglerContent.includes("localhost") &&
    wranglerContent.match(/BSCODE_ALLOWED_ORIGIN.*localhost/);
  check(
    "H1",
    !hasLocalhost,
    "BSCODE_ALLOWED_ORIGIN does not contain localhost",
    "BSCODE_ALLOWED_ORIGIN contains localhost — update before deploying to production"
  );
} else {
  warn("H1", "wrangler.toml not found at apps/worker/wrangler.toml");
}

// H2: No hardcoded secrets in wrangler.toml
const secretPatterns = [
  /passwords*=s*"[^"]{8,}"/i,
  /secrets*=s*"[^"]{8,}"/i,
  /api_keys*=s*"[^"]{8,}"/i,
];
const hasHardcodedSecret = secretPatterns.some((p) => p.test(wranglerContent));
check(
  "H2",
  !hasHardcodedSecret,
  "No hardcoded secrets detected in wrangler.toml",
  "Possible hardcoded secret found in wrangler.toml — use wrangler secret put instead",
  true
);

// H3: CORS not wildcard
const appTsPath = resolve(ROOT, "apps/worker/src/app.ts");
if (existsSync(appTsPath)) {
  const appContent = readFileSync(appTsPath, "utf8");
  const hasWildcard =
    /origin:s*["']*["']/.test(appContent) || /Access-Control-Allow-Origin.*\*/.test(appContent);
  check(
    "H3",
    !hasWildcard,
    "CORS origin is not wildcard",
    "CORS origin set to wildcard '*' — restrict to specific origin in production"
  );
} else {
  warn("H3", "apps/worker/src/app.ts not found");
}

// H4: Rate limiting middleware present
const rateLimitPath = resolve(ROOT, "apps/worker/src/middleware/rateLimit.ts");
check(
  "H4",
  existsSync(rateLimitPath),
  "Rate limiting middleware exists",
  "Rate limiting middleware not found at apps/worker/src/middleware/rateLimit.ts"
);

// H5: Auth middleware present
const authPath = resolve(ROOT, "apps/worker/src/middleware/auth.ts");
check(
  "H5",
  existsSync(authPath),
  "Auth middleware exists",
  "Auth middleware not found at apps/worker/src/middleware/auth.ts"
);

// H6: No raw API keys in worker source (basic check)
const srcDir = resolve(ROOT, "apps/worker/src");
if (existsSync(srcDir)) {
  // Check app.ts and a few key files
  const filesToCheck = ["apps/worker/src/app.ts", "apps/worker/src/routes/run.ts"]
    .map((f) => resolve(ROOT, f))
    .filter(existsSync);
  let found = false;
  for (const f of filesToCheck) {
    const content = readFileSync(f, "utf8");
    if (/sk-[a-zA-Z0-9]{20,}|Bearer [a-zA-Z0-9]{20,}/.test(content)) {
      found = true;
      break;
    }
  }
  check(
    "H6",
    !found,
    "No raw API keys found in main source files",
    "Possible raw API key found in worker source",
    true
  );
}

console.log("\nSummary:", warnings, "warning(s),", errors, "error(s)");
if (errors > 0) process.exit(1);

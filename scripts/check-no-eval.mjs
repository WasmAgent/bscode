#!/usr/bin/env node
/**
 * check-no-eval.mjs — ban `new Function(` and `eval(` in production source
 * paths to prevent dynamic code execution vulnerabilities.
 *
 * Scanned directories:
 *   apps/web/src
 *   apps/worker/src
 *
 * Test files (*.test.ts, *.test.tsx, *.spec.ts, *.spec.tsx) are excluded
 * because test suites may legitimately exercise or document the forbidden
 * patterns as negative test cases.
 *
 * Usage:
 *   node scripts/check-no-eval.mjs          # CI check (exit 1 on violations)
 *   node scripts/check-no-eval.mjs --list   # print violating files only
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const listOnly = process.argv.includes("--list");

// Paths (relative to repo root) that are explicitly allowed to contain the
// forbidden patterns — e.g. this script itself, demo fixtures, migration docs.
const ALLOWED_EXACT = new Set([
  // This script contains the pattern strings as regex literals.
  "scripts/check-no-eval.mjs",
  // mcpDemo.ts contains `eval(input)` as a *string literal* in a demo fixture
  // that shows example malicious code being passed to a safe analysis tool.
  // No dynamic evaluation occurs — it is inert example data.
  "apps/worker/src/routes/mcpDemo.ts",
]);

function isTestFile(file) {
  return (
    file.endsWith(".test.ts") ||
    file.endsWith(".test.tsx") ||
    file.endsWith(".spec.ts") ||
    file.endsWith(".spec.tsx") ||
    file.endsWith(".test.js") ||
    file.endsWith(".spec.js")
  );
}

function isScanned(file) {
  return (
    file.startsWith("apps/web/src/") || file.startsWith("apps/worker/src/")
  );
}

const PATTERNS = [
  { re: /\bnew\s+Function\s*\(/g, label: "new Function(" },
  { re: /\beval\s*\(/g, label: "eval(" },
];

const files = execSync("git ls-files", { encoding: "utf8", cwd: ROOT })
  .trim()
  .split("\n")
  .filter(Boolean);

/** @type {Array<{file: string, line: number, col: number, text: string, label: string}>} */
const violations = [];

for (const file of files) {
  if (!isScanned(file)) continue;
  if (isTestFile(file)) continue;
  if (ALLOWED_EXACT.has(file)) continue;

  let text;
  try {
    text = readFileSync(resolve(ROOT, file), "utf8");
  } catch {
    continue;
  }

  const lines = text.split("\n");
  for (const { re, label } of PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(lines[i])) !== null) {
        violations.push({
          file,
          line: i + 1,
          col: m.index + 1,
          text: lines[i].trim(),
          label,
        });
        if (!re.global) break;
      }
    }
    re.lastIndex = 0;
  }
}

if (violations.length === 0) {
  console.log("check-no-eval: no dynamic code execution patterns found. OK.");
  process.exit(0);
}

console.error(
  `check-no-eval FAILED: ${violations.length} violation(s) found.\n` +
    `Remove 'new Function(' and 'eval(' from production source paths.\n` +
    `Use static maps or pre-compiled functions instead.\n` +
    `If the use is unavoidable, add the file to ALLOWED_EXACT in scripts/check-no-eval.mjs.\n`
);

if (listOnly) {
  const uniqueFiles = [...new Set(violations.map((v) => v.file))];
  for (const f of uniqueFiles) console.error("  " + f);
} else {
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}:${v.col}  [${v.label}]  ${v.text}`);
  }
}

process.exit(1);

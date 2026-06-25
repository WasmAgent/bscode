#!/usr/bin/env node
/**
 * check-branding.mjs — prevent old brand strings from creeping back into
 * tracked source files.
 *
 * Forbidden brands: agentkit (all variants), byteslim, telleroutlook
 *
 * Usage:
 *   node scripts/check-branding.mjs         # CI check (exit 1 on violations)
 *   node scripts/check-branding.mjs --list  # same, but only file names
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const listOnly = process.argv.includes("--list");

// Files that are explicitly allowed to mention the forbidden strings.
const ALLOWED_EXACT = new Set([
  "bun.lock",
  // Migration guide for users upgrading from the old brand — mentions it by design.
  "docs/migration-from-agentkit.md",
  // This script itself contains the patterns as regex literals — self-referential.
  "scripts/check-branding.mjs",
  // Guard test that asserts the old brand does NOT appear in prompts — mentions
  // "@agentkit-js" as the string it is testing against.
  "apps/worker/src/integration.test.ts",
  // README and docs link to evomerge-framework which is currently hosted under telleroutlook.
  // These are ecosystem references, not old brand reintroductions.
  // TODO: move evomerge-framework to WasmAgent org to remove these exceptions.
  "README.md",
  "docs/DATA-GOVERNANCE.md",
  "docs/GOVERNANCE.md",
]);

function isAllowed(file) {
  if (ALLOWED_EXACT.has(file)) return true;
  // Historical changelogs capture old package names verbatim.
  if (file === "CHANGELOG.md" || file.endsWith("/CHANGELOG.md")) return true;
  return false;
}

// Patterns that must not appear in any non-allowlisted tracked file.
const PATTERNS = [
  { re: /@agentkit-js\//g,    label: "@agentkit-js/ import/path" },
  { re: /\bagentkit[-_]js\b/gi, label: "agentkit-js brand string" },
  { re: /\bagentkit[-_]core\b/gi, label: "agentkit-core brand string" },
  { re: /\bagentkit\b/gi,     label: "agentkit brand string" },
  { re: /\bbyteslim\b/gi,     label: "byteslim brand string" },
  { re: /\btelleroutlook\b/gi, label: "telleroutlook brand string" },
];

const files = execSync("git ls-files", { encoding: "utf8", cwd: process.cwd() })
  .trim()
  .split("\n")
  .filter(Boolean);

/** @type {Array<{file: string, line: number, col: number, text: string, label: string}>} */
const violations = [];

for (const file of files) {
  if (isAllowed(file)) continue;
  // Skip binary-ish and generated files.
  if (file.startsWith("node_modules/")) continue;
  if (file.includes("/dist/") || file.startsWith("dist/")) continue;
  if (file.includes("/.next/") || file.startsWith(".next/")) continue;
  if (
    file.endsWith(".lock") ||
    file.endsWith(".wasm") ||
    file.endsWith(".png")
  )
    continue;

  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // unreadable (binary, etc.)
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
  console.log("Branding check passed.");
  process.exit(0);
}

console.error(
  `Branding check FAILED: ${violations.length} violation(s).\n` +
    `Replace old brand names with @wasmagent/* / wasmagent equivalents.\n` +
    `If the mention is intentional, add the file to ALLOWED_EXACT in scripts/check-branding.mjs.\n`
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

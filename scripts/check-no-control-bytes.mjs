#!/usr/bin/env node
/**
 * check-no-control-bytes.mjs
 *
 * Scan apps/**\/*.{ts,tsx,js,mjs} for NUL (0x00) and other disallowed
 * C0 control bytes (excluding the legitimate tab \x09 / LF \x0a /
 * CR \x0d) inside source files.
 *
 * Why this exists: a NUL byte slipped into a regex literal in the
 * wasmagent-js sibling repo on 2026-06-26, surviving git commit and
 * `bun test` but breaking awk/grep/file reporting. The same class of
 * bug can land here.
 *
 * Run by:
 *   - .githooks/pre-push (mandatory before push)
 *   - CI (.github/workflows/*)
 *
 * Exit 0 = clean, exit 1 = at least one offending file.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const TARGETS = ["apps", "scripts", "packages"];
const EXT_REGEX = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const IGNORE_DIR_REGEX = /\/(node_modules|dist|\.turbo|\.next|coverage|vendor)\//;

// Disallowed C0 control bytes: 0x00–0x1F except \t \n \r, plus 0x7F (DEL).
const BAD_BYTES = new Set(Array.from({ length: 0x20 }, (_, i) => i));
BAD_BYTES.delete(0x09);
BAD_BYTES.delete(0x0a);
BAD_BYTES.delete(0x0d);
BAD_BYTES.add(0x7f);

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (IGNORE_DIR_REGEX.test(`${full}/`)) continue;
    if (ent.isDirectory()) {
      yield* walk(full);
    } else if (ent.isFile() && EXT_REGEX.test(ent.name)) {
      yield full;
    }
  }
}

function describeByte(b) {
  if (b === 0x00) return "NUL (\\x00)";
  if (b === 0x07) return "BEL (\\x07)";
  if (b === 0x08) return "BS (\\x08)";
  if (b === 0x0b) return "VT (\\x0b)";
  if (b === 0x0c) return "FF (\\x0c)";
  if (b === 0x1b) return "ESC (\\x1b)";
  if (b === 0x7f) return "DEL (\\x7f)";
  return `\\x${b.toString(16).padStart(2, "0")}`;
}

function lineColOf(buf, offset) {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset; i++) {
    if (buf[i] === 0x0a) {
      line++;
      col = 1;
    } else {
      col++;
    }
  }
  return { line, col };
}

let errors = 0;
let scanned = 0;

for (const target of TARGETS) {
  for await (const file of walk(join(ROOT, target))) {
    scanned++;
    const data = await readFile(file);
    for (let i = 0; i < data.length; i++) {
      if (BAD_BYTES.has(data[i])) {
        const { line, col } = lineColOf(data, i);
        const rel = relative(ROOT, file);
        console.error(
          `${rel}:${line}:${col}  ${describeByte(data[i])} byte at offset ${i}`
        );
        errors++;
        break;
      }
    }
  }
}

if (errors > 0) {
  console.error(`\n✗ ${errors} file(s) contain disallowed control bytes.`);
  console.error("  Use \\uXXXX or \\xXX escape sequences in regex literals.");
  process.exit(1);
}

console.log(`✓ No disallowed control bytes in ${scanned} source files.`);

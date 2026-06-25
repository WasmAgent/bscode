#!/usr/bin/env node
/**
 * loop:smoke — end-to-end closed-loop smoke test
 *
 * Runs a minimal coding task through bscode, exports the rollout as
 * rollout-wire/v1 JSONL, validates it with the trace-pipeline evomerge
 * package, and prints the resulting manifest.
 *
 * Prerequisites:
 *   1. bscode worker running:  bun dev:worker  (default http://localhost:8787)
 *   2. trace-pipeline installed:  pip install -e /path/to/trace-pipeline
 *      OR:  pip install evomerge  (when published)
 *
 * Usage:
 *   node scripts/loop-smoke.mjs
 *   node scripts/loop-smoke.mjs --url http://localhost:8787
 *   node scripts/loop-smoke.mjs --trace-pipeline /path/to/trace-pipeline
 *   node scripts/loop-smoke.mjs --python python3
 *
 * Exit codes:
 *   0  all steps passed
 *   1  a step failed (message printed to stderr)
 */

import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    url: { type: "string", default: "http://localhost:8787" },
    python: { type: "string", default: "python" },
    "trace-pipeline": { type: "string", default: "" },
    task: { type: "string", default: "Write a JS function that returns the sum of an array of numbers." },
  },
  strict: false,
});

const WORKER_URL = values.url;
const PYTHON = values.python;
const TRACE_PIPELINE = values["trace-pipeline"];
const TASK = values.task;

// Use a fixed prefix so the session is isolated from other smoke runs
const SESSION_ID = `smoke-${Date.now()}`;

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
};

function step(n, label) {
  process.stdout.write(`\n${c.bold}[${n}]${c.reset} ${label} ... `);
}
function ok(detail = "") {
  process.stdout.write(`${c.green}OK${c.reset}${detail ? "  " + c.dim + detail + c.reset : ""}\n`);
}
function fail(msg) {
  process.stdout.write(`${c.red}FAIL${c.reset}\n`);
  console.error(`${c.red}Error:${c.reset} ${msg}`);
  process.exit(1);
}

console.log(`\n${c.bold}${c.cyan}bscode loop:smoke${c.reset}`);
console.log(`${c.dim}worker  : ${WORKER_URL}${c.reset}`);
console.log(`${c.dim}session : ${SESSION_ID}${c.reset}`);
console.log(`${c.dim}task    : ${TASK}${c.reset}\n`);

// ── Step 1: ping worker ──────────────────────────────────────────────────────
step(1, "Ping worker");
try {
  const r = await fetch(`${WORKER_URL}/health`);
  if (!r.ok && r.status !== 404) fail(`HTTP ${r.status}`);
  ok();
} catch (e) {
  fail(`Cannot reach ${WORKER_URL} — is the worker running? (bun dev:worker)\n  ${e.message}`);
}

// ── Step 2: run coding task ──────────────────────────────────────────────────
step(2, "POST /run — submit task and wait for completion");
let finalAnswer = null;
try {
  const res = await fetch(`${WORKER_URL}/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Id": SESSION_ID,
    },
    body: JSON.stringify({
      task: TASK,
      agentMode: "code",
      modelId: "claude-haiku-4-5-20251001",
      maxSteps: 6,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    fail(`HTTP ${res.status}: ${body}`);
  }

  // Consume SSE stream
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (raw === "[DONE]") break;
      try {
        const ev = JSON.parse(raw);
        if (ev.event === "final_answer") finalAnswer = ev.data?.answer ?? "";
      } catch { /* ignore parse errors */ }
    }
  }
  ok(finalAnswer ? `answer: "${finalAnswer.slice(0, 60).replace(/\n/g, " ")}..."` : "(no final_answer event)");
} catch (e) {
  fail(e.message);
}

// ── Step 3: export rollout JSONL ─────────────────────────────────────────────
step(3, "GET /rollouts/export — export session as rollout-wire/v1 JSONL");
let jsonlPath;
const outDir = mkdtempSync(join(tmpdir(), "loop-smoke-"));
jsonlPath = join(outDir, "rollout.jsonl");

try {
  const res = await fetch(
    `${WORKER_URL}/rollouts/export?include_unknown=true`,
    { headers: { "X-Session-Id": SESSION_ID } },
  );
  if (!res.ok) fail(`HTTP ${res.status}: ${await res.text()}`);
  const body = await res.text();
  if (!body.trim()) fail("Empty JSONL — no jobs found for session. Did the task complete?");
  writeFileSync(jsonlPath, body);
  const lines = body.trim().split("\n").filter(Boolean);
  ok(`${lines.length} record(s) → ${jsonlPath}`);
} catch (e) {
  if (e.message.startsWith("HTTP") || e.message.startsWith("Empty")) fail(e.message);
  fail(e.message);
}

// ── Step 4: validate with evomerge ──────────────────────────────────────────
step(4, "python -m evomerge validate — schema + contamination check");
const evomergePythonpath = TRACE_PIPELINE ? `PYTHONPATH=${TRACE_PIPELINE}` : "";
try {
  const cmd = `${evomergePythonpath ? evomergePythonpath + " " : ""}${PYTHON} -m evomerge validate --input "${jsonlPath}"`;
  execSync(cmd, { stdio: "pipe" });
  ok();
} catch (e) {
  const stderr = e.stderr?.toString().trim() ?? e.message;
  fail(`evomerge validate failed:\n${stderr}\n\nMake sure trace-pipeline is installed:\n  pip install -e /path/to/trace-pipeline`);
}

// ── Step 5: export SFT/DPO via evomerge ─────────────────────────────────────
step(5, "python -m evomerge export — rollout → SFT / DPO / manifest");
const exportDir = join(outDir, "export");
try {
  const cmd = `${evomergePythonpath ? evomergePythonpath + " " : ""}${PYTHON} -m evomerge export --rollout "${jsonlPath}" --out-dir "${exportDir}" --include-failing`;
  execSync(cmd, { stdio: "pipe" });
  ok();
} catch (e) {
  const stderr = e.stderr?.toString().trim() ?? e.message;
  fail(`evomerge export failed:\n${stderr}`);
}

// ── Step 6: print manifest ───────────────────────────────────────────────────
step(6, "Read manifest.json");
const manifestPath = join(exportDir, "manifest.json");
try {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  ok();
  console.log(`\n${c.bold}manifest.json:${c.reset}`);
  console.log(JSON.stringify(manifest, null, 2));
} catch (e) {
  fail(`Cannot read ${manifestPath}: ${e.message}`);
}

console.log(`\n${c.bold}${c.green}All steps passed.${c.reset}  Output: ${outDir}\n`);

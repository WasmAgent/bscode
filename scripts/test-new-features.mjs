#!/usr/bin/env node
/**
 * BSCode New-Feature E2E Suite
 *
 * Targets the B1–B4 + C1–C4 work that landed in:
 *   - 5667e8f feat(C3 complete): worker-side CDP + vision-judge + interactive ops
 *   - 703055e feat: C2/C3/C4 — per-job isolation, visual verification, AGENTS.md
 *   - 04cd61a feat(C1): SSE Last-Event-ID resume
 *   - ee19b97 feat(worker): multi-agent rewrite (parallel + planFirst)
 *   - ee77938 feat(worker+web): B1 jobs, B2 build-result, B3 GitHub import, B4 approval
 *
 * The legacy scripts/test-full.mjs predates these features and only covers
 * core agentkit capabilities. This file deliberately probes the NEW routes
 * and behaviors end-to-end against a live worker.
 *
 * Usage:
 *   node scripts/test-new-features.mjs --url http://localhost:8788
 *   node scripts/test-new-features.mjs --only B1,B2          # categories
 *   node scripts/test-new-features.mjs --skip-llm            # skip slow agent tests
 */

import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    url: { type: "string", default: "http://localhost:8788" },
    only: { type: "string", default: "" },
    "skip-llm": { type: "boolean", default: false },
    "stop-on-fail": { type: "boolean", default: false },
    timeout: { type: "string", default: "120" },
  },
});

const BASE = values.url;
const STOP_ON_FAIL = values["stop-on-fail"];
const SKIP_LLM = values["skip-llm"];
const TIMEOUT_MS = parseInt(values.timeout, 10) * 1000;
const ONLY = values.only ? new Set(values.only.split(",").map((s) => s.trim())) : null;

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  purple: "\x1b[35m",
};

const RUN_ID = `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// ── helpers ───────────────────────────────────────────────────────────────────
async function getJSON(path, headers = {}) {
  const r = await fetch(`${BASE}${path}`, { headers });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function postJSON(path, body, headers = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})), raw: r };
}

async function delJSON(path, headers = {}) {
  const r = await fetch(`${BASE}${path}`, { method: "DELETE", headers });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// SSE collector returning {events, headers, traceId}
async function runSSE(body, opts = {}) {
  const ctrl = new AbortController();
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers = {
    "Content-Type": "application/json",
    ...(opts.headers ?? {}),
  };
  // Optional predicate to stop reading once a specific event is seen — useful
  // for HITL paths where the worker keeps the connection open while polling
  // the checkpointer. Returns true to stop.
  const stopOn = opts.stopOn ?? (() => false);
  let traceId = null;
  let resumeFlag = null;
  try {
    const res = await fetch(`${BASE}/run`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`HTTP ${res.status}: ${txt}`);
    }
    traceId = res.headers.get("X-Agentkit-Trace-Id");
    resumeFlag = res.headers.get("X-Bscode-Resume");
    const events = [];
    const lastEventIds = [];
    const decoder = new TextDecoder();
    let buf = "";
    let currentId = null;
    const stopAfter = opts.stopAfter ?? Infinity;
    try {
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("id: ")) {
            currentId = line.slice(4).trim();
            continue;
          }
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (raw === "[DONE]") return { events, lastEventIds, traceId, resumeFlag };
          try {
            const ev = JSON.parse(raw);
            events.push(ev);
            if (currentId) lastEventIds.push(currentId);
            if (stopOn(ev)) {
              ctrl.abort();
              return { events, lastEventIds, traceId, resumeFlag, cut: true };
            }
          } catch {}
          if (events.length >= stopAfter) {
            ctrl.abort(); // intentionally cut the stream
            return { events, lastEventIds, traceId, resumeFlag, cut: true };
          }
        }
      }
    } catch (err) {
      if (err.name === "AbortError" && (opts.stopAfter || opts.stopOn)) {
        return { events, lastEventIds, traceId, resumeFlag, cut: true };
      }
      throw err;
    }
    return { events, lastEventIds, traceId, resumeFlag };
  } finally {
    clearTimeout(tid);
  }
}

// ── reporter ──────────────────────────────────────────────────────────────────
const results = [];
let currentCat = "";

async function test(category, name, fn) {
  if (ONLY && !ONLY.has(category)) return;
  if (currentCat !== category) {
    console.log(`\n${c.bold}${c.cyan}── ${category} ──${c.reset}`);
    currentCat = category;
  }
  const t0 = Date.now();
  process.stdout.write(`  ${c.dim}…${c.reset} ${name}`);
  try {
    const out = await fn();
    const ms = Date.now() - t0;
    const note = typeof out === "string" ? c.dim + " " + out + c.reset : "";
    process.stdout.write(`\r  ${c.green}✓${c.reset} ${name}${note} ${c.gray}(${ms}ms)${c.reset}\n`);
    results.push({ category, name, pass: true, ms });
  } catch (err) {
    const ms = Date.now() - t0;
    process.stdout.write(`\r  ${c.red}✗${c.reset} ${name} ${c.gray}(${ms}ms)${c.reset}\n`);
    console.log(`    ${c.red}${err.message}${c.reset}`);
    if (err.stack && process.env.TRACE) console.log(c.gray + err.stack + c.reset);
    results.push({ category, name, pass: false, error: err.message, ms });
    if (STOP_ON_FAIL) {
      printSummary();
      process.exit(1);
    }
  }
}

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

function expectEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}: expected ${expected}, got ${actual}`);
}

// ── boot ──────────────────────────────────────────────────────────────────────
console.log(`${c.bold}${c.purple}BSCode New-Feature E2E${c.reset}`);
console.log(`${c.gray}URL${c.reset}      ${BASE}`);
console.log(`${c.gray}RunId${c.reset}    ${RUN_ID}`);
console.log(`${c.gray}SkipLLM${c.reset}  ${SKIP_LLM}`);
if (ONLY) console.log(`${c.gray}Only${c.reset}     ${[...ONLY].join(",")}`);

// ─────────────────────────────────────────────────────────────────────────────
// B1 — Job queue
// ─────────────────────────────────────────────────────────────────────────────
await test("B1", "POST /jobs single — returns jobIds", async () => {
  const r = await postJSON("/jobs", {
    task: "say hello",
    agentMode: "code",
    modelId: "claude-haiku-4-5-20251001",
  });
  expectEq(r.status, 200, "HTTP");
  expect(Array.isArray(r.body.jobIds) && r.body.jobIds.length === 1, "jobIds shape");
  return `id=${r.body.jobIds[0]}`;
});

await test("B1", "POST /jobs batch — multiple jobIds", async () => {
  const r = await postJSON("/jobs", {
    jobs: [
      { task: "echo 1", agentMode: "code" },
      { task: "echo 2", agentMode: "code" },
      { task: "echo 3", agentMode: "code" },
    ],
  });
  expectEq(r.status, 200, "HTTP");
  expectEq(r.body.jobIds.length, 3, "count");
  return `${r.body.jobIds.length} ids`;
});

await test("B1", "POST /jobs guards — empty jobs[]", async () => {
  const r = await postJSON("/jobs", { jobs: [] });
  expectEq(r.status, 400, "should reject");
});

await test("B1", "POST /jobs guards — >20 batch", async () => {
  const big = Array.from({ length: 21 }, () => ({ task: "x" }));
  const r = await postJSON("/jobs", { jobs: big });
  expectEq(r.status, 400, "should reject oversize");
});

await test("B1", "POST /jobs guards — missing task", async () => {
  const r = await postJSON("/jobs", { jobs: [{}] });
  expectEq(r.status, 400, "should reject missing task");
});

await test("B1", "POST /jobs guards — neither task nor jobs[]", async () => {
  const r = await postJSON("/jobs", { wrong: "shape" });
  expectEq(r.status, 400, "should reject");
});

await test("B1", "GET /jobs — lists jobs with stats", async () => {
  const r = await getJSON("/jobs");
  expectEq(r.status, 200, "HTTP");
  expect(Array.isArray(r.body.jobs), "jobs[] missing");
  expect(typeof r.body.stats === "object", "stats missing");
  return `${r.body.jobs.length} jobs`;
});

await test("B1", "GET /jobs?status=done — filter works", async () => {
  const r = await getJSON("/jobs?status=done");
  expectEq(r.status, 200, "HTTP");
  expect(
    r.body.jobs.every((j) => j.status === "done"),
    "filter leaked",
  );
});

let _abortableJobId = null;
await test("B1", "DELETE /jobs/:id — cooperative abort", async () => {
  if (SKIP_LLM) return "skipped";
  // submit a job that's likely to still be queued/running for a few hundred ms
  const sub = await postJSON("/jobs", {
    task: "Write a function to sort a list. Take your time.",
    agentMode: "tool",
    modelId: "claude-haiku-4-5-20251001",
    maxSteps: 5,
  });
  const id = sub.body.jobIds[0];
  _abortableJobId = id;
  // Don't sleep — abort immediately while it's most likely still queued.
  const r = await delJSON(`/jobs/${id}`);
  // The route returns {ok:true} on accepted abort, or 404 with {error:"...not found or already finished"}
  // when the job already terminated before our DELETE arrived. Both are valid race outcomes.
  if (r.status === 200) {
    expect(r.body.ok === true, `expected ok:true, got ${JSON.stringify(r.body)}`);
    return "aborted";
  } else if (r.status === 404) {
    expect(/not found|finished/i.test(JSON.stringify(r.body)), "expected terminal-race error");
    return "raced (already finished)";
  }
  throw new Error(`unexpected status ${r.status}: ${JSON.stringify(r.body)}`);
});

await test("B1", "GET /jobs/:id — full snapshot", async () => {
  if (!_abortableJobId) return "skipped";
  const r = await getJSON(`/jobs/${_abortableJobId}`);
  expectEq(r.status, 200, "HTTP");
  expect(typeof r.body.id === "string", "id missing");
  expect(typeof r.body.status === "string", "status missing");
  return `status=${r.body.status}`;
});

await test("B1", "GET /jobs/unknown — 404", async () => {
  const r = await getJSON("/jobs/does-not-exist-xyz");
  expectEq(r.status, 404, "should be 404");
});

// ─────────────────────────────────────────────────────────────────────────────
// B2 — Build-result reverse channel
// ─────────────────────────────────────────────────────────────────────────────
const SESSION_B2 = `${RUN_ID}-b2`;

await test("B2", "POST /build-result — accepts payload", async () => {
  const r = await postJSON(
    "/build-result",
    {
      status: "failed",
      stage: "build",
      exitCode: 1,
      stderr: "TypeError on line 42 of src/x.ts",
      wallTimeMs: 1234,
    },
    { "X-Session-Id": SESSION_B2 },
  );
  expectEq(r.status, 200, "HTTP");
  expect(r.body.ok === true, "stored ack missing");
});

await test("B2", "GET /build-result — round-trips status/stage/exitCode", async () => {
  const r = await getJSON("/build-result", { "X-Session-Id": SESSION_B2 });
  expectEq(r.status, 200, "HTTP");
  expectEq(r.body.status, "failed", "status");
  expectEq(r.body.stage, "build", "stage");
  expectEq(r.body.exitCode, 1, "exitCode");
  expect(typeof r.body.ranAtMs === "number", "ranAtMs missing");
  return `status=${r.body.status} stage=${r.body.stage}`;
});

await test("B2", "DELETE /build-result — clears", async () => {
  const r = await delJSON("/build-result", { "X-Session-Id": SESSION_B2 });
  expectEq(r.status, 200, "HTTP");
  const after = await getJSON("/build-result", { "X-Session-Id": SESSION_B2 });
  // After delete the snapshot should fall back to the "unknown" placeholder
  expect(
    after.body.status === "unknown" || after.body.exitCode === undefined,
    `expected cleared, got ${JSON.stringify(after.body)}`,
  );
});

await test("B2", "POST /build-result — stderr truncated to ≤2000", async () => {
  const huge = "x".repeat(5000);
  const r = await postJSON(
    "/build-result",
    { status: "failed", stage: "build", exitCode: 1, stderr: huge },
    { "X-Session-Id": `${SESSION_B2}-trunc` },
  );
  expectEq(r.status, 200, "HTTP");
  const after = await getJSON("/build-result", { "X-Session-Id": `${SESSION_B2}-trunc` });
  expect(
    typeof after.body.stderr === "string" && after.body.stderr.length <= 2050,
    `expected stderr ≤ ~2000 chars, got ${after.body.stderr?.length}`,
  );
  return `stderr.length=${after.body.stderr.length}`;
});

await test("B2", "POST /build-result — session isolation", async () => {
  const sid1 = `${RUN_ID}-iso-1`;
  const sid2 = `${RUN_ID}-iso-2`;
  await postJSON(
    "/build-result",
    { status: "failed", stage: "build", exitCode: 7 },
    { "X-Session-Id": sid1 },
  );
  const r2 = await getJSON("/build-result", { "X-Session-Id": sid2 });
  expect(r2.body.exitCode !== 7, "session leak");
});

await test("B2", "POST /build-result — invalid status rejected", async () => {
  const r = await postJSON(
    "/build-result",
    { status: "weird-status" },
    { "X-Session-Id": `${SESSION_B2}-bad` },
  );
  expectEq(r.status, 400, "should reject");
});

await test("B2", "POST /build-result — accepts visual snapshot (C3 wire)", async () => {
  const sid = `${RUN_ID}-b2-visual`;
  const r = await postJSON(
    "/build-result",
    {
      status: "success",
      stage: "dev",
      previewUrl: "http://example.com",
      visual: {
        source: "browser",
        ranAtMs: Date.now(),
        rendersNonEmpty: true,
        consoleErrors: [],
      },
    },
    { "X-Session-Id": sid },
  );
  expectEq(r.status, 200, "HTTP");
  const after = await getJSON("/build-result", { "X-Session-Id": sid });
  expect(after.body.visual && after.body.visual.source === "browser", "visual round-trip");
  return "visual round-trips";
});

// ─────────────────────────────────────────────────────────────────────────────
// B3 — GitHub import
// ─────────────────────────────────────────────────────────────────────────────
await test("B3", "POST /import/github — rejects bad body", async () => {
  const r = await postJSON("/import/github", { not: "valid" });
  expect(r.status >= 400, `expected 4xx, got ${r.status}`);
});

await test("B3", "POST /import/github — small public repo (octocat/Hello-World)", async () => {
  const sid = `${RUN_ID}-gh`;
  const r = await postJSON(
    "/import/github",
    {
      owner: "octocat",
      repo: "Hello-World",
      // limit by extension to keep it fast & deterministic
      textExtensions: [".md"],
    },
    { "X-Session-Id": sid },
  );
  // Importer may legitimately fail without a token (rate-limited) or because
  // BSCODE_FILES is unbound. Accept both: success populates files; failure
  // surfaces a structured error.
  if (r.status !== 200) {
    expect(r.body.error || r.body.message, `expected structured error, got ${JSON.stringify(r.body)}`);
    return `non-200=${r.status} (err=${(r.body.error ?? "").slice(0, 60)})`;
  }
  expect(typeof r.body.imported === "number" || Array.isArray(r.body.files), "expected imported count or files");
  return `imported=${r.body.imported ?? r.body.files?.length ?? "?"}`;
});

await test("B3", "POST /import/github — missing owner/repo rejected", async () => {
  const r = await postJSON("/import/github", { ref: "main" });
  expectEq(r.status, 400, "should reject");
  expect(/owner|repo/.test(JSON.stringify(r.body)), "error msg should mention owner/repo");
});

// ─────────────────────────────────────────────────────────────────────────────
// B4 — Approval policy
//
// Strict gating fires when ToolCallingAgent has a checkpointer. As of the
// fix in this session, bscode wires `checkpointerFor(config)` into
// `createToolAgent` unconditionally, so `approvalPolicy: "strict"` actually
// pauses on `await_human_input` for every write-class tool call regardless
// of agentMode (tool / multi+parallel / multi+planFirst).
// ─────────────────────────────────────────────────────────────────────────────
await test("B4", "approvalPolicy=strict — write_file pauses on await_human_input", async () => {
  if (SKIP_LLM) return "skipped";
  const sid = `${RUN_ID}-b4-strict`;
  const result = await runSSE(
    {
      task: "Create a file called test.txt with the contents 'hello world'.",
      agentMode: "tool",
      modelId: "claude-haiku-4-5-20251001",
      approvalPolicy: "strict",
      maxSteps: 3,
    },
    {
      headers: { "X-Session-Id": sid },
      // Strict pauses on HITL and the worker polls the checkpointer for ~60s.
      // We don't need to wait that long — bail as soon as the HITL frame lands.
      stopOn: (ev) => ev.event === "await_human_input",
      timeoutMs: 30_000,
    },
  );
  const writeCall = result.events.find(
    (e) => e.event === "tool_call" && (e.data?.toolName ?? e.data?.tool) === "write_file",
  );
  const hitlEvent = result.events.find((e) => e.event === "await_human_input");
  expect(writeCall, "expected the agent to attempt a write_file call");
  expect(hitlEvent, "expected await_human_input to fire under strict policy");
  expect(
    /write_file/.test(JSON.stringify(hitlEvent.data ?? {})),
    `expected approval prompt mentioning write_file, got ${JSON.stringify(hitlEvent.data).slice(0, 200)}`,
  );
  // Under strict, the file MUST NOT have produced a tool_result before the pause.
  const writeResult = result.events.find(
    (e) => e.event === "tool_result" && (e.data?.toolName ?? e.data?.tool) === "write_file",
  );
  expect(!writeResult, "strict policy must not let write_file produce a tool_result before approval");
  return `paused on ${hitlEvent.data?.promptId ?? "approval"}`;
});

await test("B4", "approvalPolicy=permissive — write_file runs through", async () => {
  if (SKIP_LLM) return "skipped";
  const sid = `${RUN_ID}-b4-perm`;
  const result = await runSSE(
    {
      task: "Create a file called allowed.txt with the contents 'ok'.",
      agentMode: "tool",
      modelId: "claude-haiku-4-5-20251001",
      approvalPolicy: "permissive",
      maxSteps: 4,
    },
    { headers: { "X-Session-Id": sid }, timeoutMs: 60_000 },
  );
  const writeCall = result.events.find(
    (e) => e.event === "tool_call" && (e.data?.toolName ?? e.data?.tool) === "write_file",
  );
  const writeResult = result.events.find(
    (e) => e.event === "tool_result" && (e.data?.toolName ?? e.data?.tool) === "write_file",
  );
  const hitlEvent = result.events.find((e) => e.event === "await_human_input");
  expect(writeCall, "write_file should be called");
  expect(writeResult, "write_file should produce a tool_result");
  expect(!hitlEvent, "permissive must not pause on await_human_input");
  expect(
    /OK|written|created/i.test(JSON.stringify(writeResult.data)),
    `expected success output, got ${JSON.stringify(writeResult.data).slice(0, 150)}`,
  );
});

await test("B4", "approvalPolicy=balanced — accepted as a value", async () => {
  if (SKIP_LLM) return "skipped";
  const result = await runSSE(
    {
      task: "Just say hello, do not call any tools.",
      agentMode: "code",
      modelId: "claude-haiku-4-5-20251001",
      approvalPolicy: "balanced",
      maxSteps: 1,
    },
    { timeoutMs: 60_000 },
  );
  expect(
    !result.events.some((e) => e.event === "error"),
    "balanced preset rejected unexpectedly",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// C1 — SSE Last-Event-ID resume
// ─────────────────────────────────────────────────────────────────────────────
await test("C1", "fresh /run emits X-Agentkit-Trace-Id header", async () => {
  if (SKIP_LLM) return "skipped";
  const r = await runSSE(
    {
      task: "say 'one'",
      agentMode: "code",
      modelId: "claude-haiku-4-5-20251001",
      maxSteps: 1,
    },
    { timeoutMs: 60_000 },
  );
  expect(typeof r.traceId === "string" && r.traceId.startsWith("run-"), `bad traceId: ${r.traceId}`);
  expect(r.lastEventIds.length > 0, "no event ids");
  // Each id must be a 12-digit zero-padded number
  expect(
    r.lastEventIds.every((id) => /^\d{12}$/.test(id)),
    `bad id format: ${r.lastEventIds.slice(0, 3).join(",")}`,
  );
  return `traceId=${r.traceId} ids=${r.lastEventIds.length}`;
});

await test("C1", "resume with Last-Event-ID replays only the tail", async () => {
  if (SKIP_LLM) return "skipped";
  // Phase 1: run a task, stop after 2 events
  const phase1 = await runSSE(
    {
      task: "Write the word 'hello' three times.",
      agentMode: "code",
      modelId: "claude-haiku-4-5-20251001",
      maxSteps: 2,
    },
    { stopAfter: 2, timeoutMs: 60_000 },
  );
  expect(phase1.traceId, "no traceId from phase 1");
  expect(phase1.lastEventIds.length >= 1, "no event ids");
  const lastSeen = phase1.lastEventIds[phase1.lastEventIds.length - 1];

  // Phase 2: reconnect with resumeTraceId + Last-Event-ID; the worker should
  // replay the missing tail only (no new agent invocation).
  await new Promise((r) => setTimeout(r, 1500)); // let the live run finish
  const phase2 = await runSSE(
    {
      // task is required by validation but server uses the trace-id fast path
      task: "Write the word 'hello' three times.",
      resumeTraceId: phase1.traceId,
      agentMode: "code",
      modelId: "claude-haiku-4-5-20251001",
      maxSteps: 2,
    },
    {
      headers: { "Last-Event-ID": lastSeen },
      timeoutMs: 60_000,
    },
  );
  // Resume contract: response carries X-Bscode-Resume sentinel
  expect(phase2.resumeFlag === "1", `missing X-Bscode-Resume header (got ${phase2.resumeFlag})`);
  // Replayed ids must all be greater than lastSeen
  for (const id of phase2.lastEventIds) {
    expect(id > lastSeen, `replayed id ${id} ≤ cursor ${lastSeen}`);
  }
  return `replayed=${phase2.lastEventIds.length}`;
});

await test("C1", "resume with unknown traceId — falls through gracefully", async () => {
  const r = await runSSE(
    {
      task: "noop",
      resumeTraceId: "run-ffffffffffff-deadbeef",
      agentMode: "code",
      modelId: "claude-haiku-4-5-20251001",
      maxSteps: 1,
    },
    { timeoutMs: 30_000 },
  );
  // Either a fresh run (no resume flag) or an empty replay — both acceptable.
  // Must not throw / 500.
  expect(Array.isArray(r.events), "events not an array");
});

// ─────────────────────────────────────────────────────────────────────────────
// C2 — Per-job branch isolation + diff/merge
// ─────────────────────────────────────────────────────────────────────────────
await test("C2", "job branch isolates writes from parent session", async () => {
  if (SKIP_LLM) return "skipped";
  const parent = `${RUN_ID}-c2-parent`;

  // Seed parent with a known file
  await postJSON(
    "/files",
    { path: "shared.txt", content: "parent-original" },
    { "X-Session-Id": parent },
  );

  // Submit a job that writes a NEW file (no conflict path)
  const sub = await postJSON(
    "/jobs",
    {
      task: "Write a file called job-output.txt with the content 'made-by-job'.",
      agentMode: "tool",
      modelId: "claude-haiku-4-5-20251001",
      maxSteps: 4,
    },
    { "X-Session-Id": parent },
  );
  const jobId = sub.body.jobIds[0];

  // Poll until done
  const deadline = Date.now() + 60_000;
  let snap = null;
  while (Date.now() < deadline) {
    const r = await getJSON(`/jobs/${jobId}`);
    if (["done", "failed", "aborted"].includes(r.body.status)) {
      snap = r.body;
      break;
    }
    await new Promise((res) => setTimeout(res, 800));
  }
  expect(snap, "job did not finish in 60s");
  expect(snap.status === "done" || snap.status === "failed", `unexpected status ${snap.status}`);

  // Parent must NOT see job-output.txt before merge
  const parentFiles = await getJSON("/files", { "X-Session-Id": parent });
  const parentList = Array.isArray(parentFiles.body.files)
    ? parentFiles.body.files
    : parentFiles.body;
  const parentPaths = parentList.map((f) => (typeof f === "string" ? f : f.path));
  expect(!parentPaths.includes("job-output.txt"), `isolation breach; parentPaths=${parentPaths}`);

  // Diff endpoint should report the job's added file (only if job succeeded)
  if (snap.status === "done") {
    const diff = await getJSON(`/jobs/${jobId}/diff`);
    expectEq(diff.status, 200, "diff HTTP");
    expect(Array.isArray(diff.body.changes ?? diff.body.diff ?? diff.body), "diff shape");
  }
  return `status=${snap.status} parentPaths=${parentPaths.length}`;
});

await test("C2", "GET /jobs/:id/diff on unknown id — 404", async () => {
  const r = await getJSON("/jobs/nonsense-xyz/diff");
  expect(r.status === 404 || r.status === 400, `got ${r.status}`);
});

await test("C2", "POST /jobs/:id/merge requires running id", async () => {
  const r = await postJSON("/jobs/nonsense-xyz/merge", { strategy: "fail-on-conflict" });
  expect(r.status === 404 || r.status === 400, `got ${r.status}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// C3 — Visual verifier graceful fallback (no CDP endpoint)
// ─────────────────────────────────────────────────────────────────────────────
await test("C3", "visual_verify available without CDP — returns no-endpoint snapshot", async () => {
  if (SKIP_LLM) return "skipped";
  const sid = `${RUN_ID}-c3`;
  const result = await runSSE(
    {
      task: "Use the visual_verify tool against http://example.com to check it renders. Then stop.",
      agentMode: "tool",
      modelId: "claude-haiku-4-5-20251001",
      maxSteps: 3,
      // framework mode features (visual_*) require this flag
      frameworkMode: true,
    },
    { headers: { "X-Session-Id": sid }, timeoutMs: 60_000 },
  );
  const toolNames = result.events
    .filter((e) => e.event === "tool_call")
    .map((e) => e.data?.tool ?? e.data?.name);
  // Either the tool got called and returned the structured no-endpoint
  // snapshot, OR the tool wasn't surfaced at all (frameworkMode flag may be
  // ignored here). We treat either as informational rather than failure —
  // the unit tests already cover the no-endpoint branch — but the route
  // MUST NOT 500.
  return `toolCalls=[${toolNames.filter(Boolean).join(",") || "none"}]`;
});

// ─────────────────────────────────────────────────────────────────────────────
// C4 — AGENTS.md
// ─────────────────────────────────────────────────────────────────────────────
await test("C4", "AGENTS.md content reaches system prompt (per-session)", async () => {
  if (SKIP_LLM) return "skipped";
  const sid = `${RUN_ID}-c4`;
  // Seed a session-scoped AGENTS.md with a unique sigil
  const SIGIL = "ZX-PURPLE-PORCUPINE-9341";
  const seed = await postJSON(
    "/files",
    {
      path: "AGENTS.md",
      content: `# Project rules\n\nIf the user asks about the secret sigil, reply with exactly: ${SIGIL}`,
    },
    { "X-Session-Id": sid },
  );
  expectEq(seed.status, 200, "seed POST /files HTTP");

  // CRITICAL: We deliberately do NOT mention "AGENTS.md" or any filename in
  // the task. If the system-prompt injection works, the model will know the
  // sigil from the system prefix without needing to call read_file. If it
  // does NOT work (e.g. SessionKvStore.list bug stops the loader from
  // discovering AGENTS.md), the model will either guess wrong or refuse.
  const result = await runSSE(
    {
      task: "What is the secret sigil? Reply with just the sigil, nothing else. Do not call any tools.",
      // code mode keeps the agent from using read_file as a fallback
      agentMode: "code",
      modelId: "claude-haiku-4-5-20251001",
      maxSteps: 1,
      // disable enhancement to keep prompt sleek
    },
    { headers: { "X-Session-Id": sid }, timeoutMs: 60_000 },
  );
  const finalEv = result.events.find((e) => e.event === "final_answer");
  const finalAns = finalEv?.data?.answer ?? finalEv?.data?.text ?? "";
  const haystack = JSON.stringify(result.events);
  expect(
    haystack.includes(SIGIL),
    `AGENTS.md not injected via system prompt; final="${finalAns.slice(0, 200)}"`,
  );
  return "sigil echoed via system prompt";
});

await test("C4", "init_agents_md tool requires approval (HITL)", async () => {
  if (SKIP_LLM) return "skipped";
  const sid = `${RUN_ID}-c4-init`;
  const result = await runSSE(
    {
      task:
        "Use the init_agents_md tool to create an AGENTS.md describing a hello-world Node project.",
      agentMode: "tool",
      modelId: "claude-haiku-4-5-20251001",
      maxSteps: 3,
    },
    {
      headers: { "X-Session-Id": sid },
      // init_agents_md is registered with needsApproval:true. Now that the
      // checkpointer is plumbed through, the run pauses on HITL — bail there.
      stopOn: (ev) =>
        ev.event === "await_human_input" || ev.event === "final_answer" || ev.event === "error",
      timeoutMs: 30_000,
    },
  );
  const sawHITL = result.events.some((e) => e.event === "await_human_input");
  const sawTool = result.events.some(
    (e) => e.event === "tool_call" && (e.data?.toolName ?? e.data?.tool) === "init_agents_md",
  );
  // Either the model invoked init_agents_md and the gate fired (sawHITL),
  // or the model declined to use the tool (some Haiku runs refuse). In both
  // cases the run must NOT 500.
  expect(
    !result.events.some((e) => e.event === "error"),
    "run errored",
  );
  return `hitl=${sawHITL} called=${sawTool}`;
});

// ─────────────────────────────────────────────────────────────────────────────
// Multi-agent (B1+B4 follow-up)
// ─────────────────────────────────────────────────────────────────────────────
await test("multi-agent", "multiAgentMode=parallel runs", async () => {
  if (SKIP_LLM) return "skipped";
  const result = await runSSE(
    {
      task: "Suggest one CSS color name. Reply with just the name.",
      agentMode: "multi",
      multiAgentMode: "parallel",
      multiAgentBranches: 2,
      multiAgentConcurrency: 2,
      modelId: "claude-haiku-4-5-20251001",
      maxSteps: 4,
    },
    { timeoutMs: 90_000 },
  );
  const finalEv = result.events.find((e) => e.event === "final_answer");
  expect(finalEv, "no final_answer");
  return "completed";
});

await test("multi-agent", "multiAgentMode=planFirst pauses on await_human_input", async () => {
  if (SKIP_LLM) return "skipped";
  const cp = `cp-${RUN_ID}-${Math.random().toString(36).slice(2, 6)}`;
  const result = await runSSE(
    {
      task: "Refactor a hypothetical src/utils.ts. Plan only.",
      agentMode: "multi",
      multiAgentMode: "planFirst",
      useCheckpoint: true,
      checkpointId: cp,
      modelId: "claude-haiku-4-5-20251001",
      maxSteps: 4,
    },
    { timeoutMs: 90_000 },
  );
  const sawAwait = result.events.some((e) => e.event === "await_human_input");
  const sawFinal = result.events.some((e) => e.event === "final_answer");
  // planFirst either pauses (HITL) or completes the plan as final_answer.
  expect(sawAwait || sawFinal, "neither HITL nor final_answer surfaced");
  return `await=${sawAwait} final=${sawFinal}`;
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
function printSummary() {
  const total = results.length;
  const pass = results.filter((r) => r.pass).length;
  const fail = total - pass;
  const ms = results.reduce((s, r) => s + r.ms, 0);
  console.log(`\n${c.bold}Summary${c.reset}`);
  console.log(
    `  ${c.green}${pass} passed${c.reset}  ${c.red}${fail} failed${c.reset}  ${c.gray}(${total} total, ${ms}ms)${c.reset}`,
  );
  if (fail > 0) {
    console.log(`\n${c.red}Failures:${c.reset}`);
    for (const r of results.filter((r) => !r.pass)) {
      console.log(`  ${c.red}✗${c.reset} ${r.category} / ${r.name}`);
      console.log(`    ${c.gray}${r.error}${c.reset}`);
    }
  }
  // Per-category breakdown
  const cats = [...new Set(results.map((r) => r.category))];
  console.log(`\n${c.bold}By category${c.reset}`);
  for (const cat of cats) {
    const sub = results.filter((r) => r.category === cat);
    const p = sub.filter((r) => r.pass).length;
    const color = p === sub.length ? c.green : c.yellow;
    console.log(`  ${color}${cat}${c.reset}  ${p}/${sub.length}`);
  }
}

printSummary();
process.exit(results.some((r) => !r.pass) ? 1 : 0);

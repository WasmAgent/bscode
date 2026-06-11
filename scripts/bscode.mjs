#!/usr/bin/env node

/**
 * BSCode CLI — direct test client for the bscode worker.
 *
 * Usage:
 *   node scripts/bscode.mjs "your task here"
 *   node scripts/bscode.mjs --mode tool --model claude-haiku-4-5-20251001 "list files and summarize"
 *   node scripts/bscode.mjs --steps 5 --url http://localhost:8787 "write a quicksort"
 *
 * Flags:
 *   --mode  code|tool      Agent mode (default: code)
 *   --model <modelId>      Model ID (default: claude-sonnet-4-6)
 *   --steps <n>            Max steps (default: 10)
 *   --url   <url>          Worker URL (default: http://localhost:8787)
 *   --events               Show raw AgentEvent stream instead of pretty output
 *   --json                 Print full JSON events (implies --events)
 *   --trace                Show error stack traces
 *   --resume-after <n>     C1 demo: drop the SSE stream after N events,
 *                          then immediately reconnect with the persisted
 *                          trace id + Last-Event-ID header. Proves the
 *                          worker resumed where the client left off.
 */

import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    mode: { type: "string", default: "code" },
    model: { type: "string", default: "claude-sonnet-4-6" },
    steps: { type: "string", default: "10" },
    url: { type: "string", default: "http://localhost:8787" },
    events: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    trace: { type: "boolean", default: false },
    "resume-after": { type: "string" },
  },
  allowPositionals: true,
  strict: false,
});

const task = positionals.join(" ").trim();
if (!task) {
  console.error('Usage: node scripts/bscode.mjs "your task here"');
  process.exit(1);
}

const workerUrl = values.url;
const agentMode = values.mode;
const modelId = values.model;
const maxSteps = parseInt(values.steps, 10);
const showRaw = values.events || values.json;
const showTrace = values.trace;
const showJson = values.json;
const resumeAfter = values["resume-after"] ? parseInt(values["resume-after"], 10) : null;

// ANSI colors
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  purple: "\x1b[35m",
  gray: "\x1b[90m",
};

console.log(`\n${c.bold}${c.blue}BSCode CLI${c.reset}`);
console.log(`${c.gray}Task   : ${c.reset}${task}`);
console.log(
  `${c.gray}Mode   : ${c.reset}${agentMode}  ${c.gray}Model  : ${c.reset}${modelId}  ${c.gray}Steps  : ${c.reset}${maxSteps}`
);
console.log(`${c.gray}Worker : ${c.reset}${workerUrl}\n`);
console.log("─".repeat(60));

// Token accounting
let inputTokens = 0,
  outputTokens = 0,
  cacheTokens = 0,
  calls = 0;
let stepCount = 0;
let finalAnswer = null;

let traceId = null;
let lastEventId = null;
let eventsConsumed = 0;
let resumeTriggered = false;

// streamEvents — pump SSE frames from `res` into the same display +
// accounting code we used in the original loop. Stops early if
// `--resume-after N` is set and we have already consumed N events
// (returns "drop"); otherwise returns "complete".
async function streamEvents(res) {
  const decoder = new TextDecoder();
  let buffer = "";
  let pendingId = null;
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("id: ")) {
        pendingId = line.slice(4).trim();
        continue;
      }
      if (line === "") {
        // SSE event boundary — commit the high-water mark.
        if (pendingId) {
          lastEventId = pendingId;
          pendingId = null;
        }
        continue;
      }
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (raw === "[DONE]") return "complete";

      let ev;
      try {
        ev = JSON.parse(raw);
      } catch {
        continue;
      }

      if (showJson) {
        console.log(JSON.stringify(ev, null, 2));
      } else if (showRaw) {
        printRawEvent(ev);
      } else {
        prettyPrintEvent(ev);
      }

      // Accumulate token stats
      if (ev.event === "model_done") {
        inputTokens += ev.data?.inputTokens ?? 0;
        outputTokens += ev.data?.outputTokens ?? 0;
        cacheTokens += ev.data?.cacheReadTokens ?? 0;
        calls++;
      }
      if (ev.event === "step_start") stepCount = ev.data?.step ?? stepCount;
      if (ev.event === "final_answer") finalAnswer = ev.data?.answer;

      eventsConsumed++;
      if (resumeAfter && !resumeTriggered && eventsConsumed >= resumeAfter) {
        return "drop";
      }
    }
  }
  return "complete";
}

async function postRun(extraBody = {}, extraHeaders = {}) {
  return fetch(`${workerUrl}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify({ task, agentMode, modelId, maxSteps, ...extraBody }),
  });
}

// First connection.
let res;
try {
  res = await postRun();
} catch (_err) {
  console.error(`\n${c.red}Connection refused: ${workerUrl}${c.reset}`);
  console.error(`${c.dim}Make sure the worker is running: pnpm dev:worker${c.reset}\n`);
  process.exit(1);
}

if (!res.ok) {
  const body = await res.text();
  console.error(`${c.red}HTTP ${res.status}:${c.reset} ${body}`);
  process.exit(1);
}

// Capture the trace id so we can resume against it.
traceId = res.headers.get("X-Agentkit-Trace-Id");

let outcome = await streamEvents(res);

// C1 demo: simulate a network drop, reconnect with Last-Event-ID.
if (outcome === "drop" && traceId) {
  resumeTriggered = true;
  console.log(
    `\n${c.gray}── ${c.yellow}simulated disconnect${c.gray} after ${eventsConsumed} events (last id=${lastEventId}); reconnecting with resumeTraceId=${traceId} ──${c.reset}\n`,
  );
  // Fully drain/abort the previous response body to free the socket.
  try {
    await res.body?.cancel?.();
  } catch {
    /* ignore */
  }
  const res2 = await postRun(
    { resumeTraceId: traceId },
    lastEventId ? { "Last-Event-ID": lastEventId } : {},
  );
  if (!res2.ok) {
    const body = await res2.text();
    console.error(`${c.red}Resume HTTP ${res2.status}:${c.reset} ${body}`);
    process.exit(1);
  }
  if (res2.headers.get("X-Bscode-Resume") === "1") {
    console.log(`${c.gray}(server accepted resume — replay-only mode)${c.reset}`);
  }
  outcome = await streamEvents(res2);
}

// Summary
console.log("\n" + "─".repeat(60));
if (finalAnswer !== null) {
  console.log(`${c.bold}${c.green}Final Answer:${c.reset}`);
  console.log(typeof finalAnswer === "string" ? finalAnswer : JSON.stringify(finalAnswer, null, 2));
}

if (calls > 0) {
  const total = inputTokens + cacheTokens;
  const hitRate = total > 0 ? Math.round((cacheTokens / total) * 100) : 0;
  console.log(`\n${c.gray}─── Token Usage ─────────────────────────${c.reset}`);
  console.log(
    `  ${c.dim}Model calls${c.reset}   ${calls}          ${c.dim}Steps${c.reset}  ${stepCount}`
  );
  console.log(`  ${c.dim}Input${c.reset}         ${inputTokens.toLocaleString()} tokens`);
  console.log(`  ${c.dim}Output${c.reset}        ${outputTokens.toLocaleString()} tokens`);
  console.log(
    `  ${c.dim}Cache read${c.reset}    ${cacheTokens.toLocaleString()} tokens  (hit rate ${hitRate}%)`
  );
  const cost = ((inputTokens * 3 + outputTokens * 15) / 1_000_000).toFixed(5);
  console.log(`  ${c.dim}Est. cost${c.reset}     ~$${cost} USD`);
}
console.log();

function prettyPrintEvent(ev) {
  const d = ev.data ?? {};
  switch (ev.event) {
    case "run_start":
      console.log(`\n${c.blue}▶${c.reset} ${c.bold}Agent started${c.reset}`);
      break;
    case "step_start":
      console.log(`\n${c.gray}── Step ${d.step} ──────────────────────────${c.reset}`);
      break;
    case "thinking_delta":
      process.stdout.write(
        `${c.purple}·${c.reset} ${c.dim}${String(d.delta ?? "").slice(0, 100)}${c.reset}\n`
      );
      break;
    case "planning":
      console.log(
        `\n${c.purple}PLAN${c.reset} ${c.dim}${String(d.plan ?? "").slice(0, 200)}${c.reset}`
      );
      break;
    case "tool_call":
      console.log(
        `  ${c.yellow}→${c.reset} ${c.bold}${d.toolName}${c.reset}(${JSON.stringify(d.args ?? {}).slice(0, 100)})`
      );
      break;
    case "tool_result": {
      const out = JSON.stringify(d.output ?? "").slice(0, 120);
      const errMark = d.error ? `${c.red} [ERROR]${c.reset}` : "";
      console.log(`  ${c.green}←${c.reset} ${d.toolName}${errMark}: ${c.dim}${out}${c.reset}`);
      break;
    }
    case "model_start":
      process.stdout.write(`  ${c.gray}⚙ ${d.modelId}…${c.reset}`);
      break;
    case "model_done":
      process.stdout.write(
        ` ${c.gray}done (in:${d.inputTokens ?? 0} out:${d.outputTokens ?? 0} cache:${d.cacheReadTokens ?? 0})${c.reset}\n`
      );
      break;
    case "final_answer":
      // Printed in summary
      break;
    case "error":
      console.log(`  ${c.red}✗ ERROR: ${d.error}${c.reset}`);
      if (showTrace && d.stack) console.log(`${c.dim}${d.stack}${c.reset}`);
      break;
    default:
    // skip status/guardrail etc.
  }
}

function printRawEvent(ev) {
  const colors = {
    run_start: c.blue,
    step_start: c.gray,
    thinking_delta: c.purple,
    planning: c.purple,
    tool_call: c.yellow,
    tool_result: c.green,
    model_start: c.gray,
    model_done: c.gray,
    final_answer: c.green,
    error: c.red,
  };
  const col = colors[ev.event] ?? c.reset;
  const data = JSON.stringify(ev.data ?? {}).slice(0, 120);
  console.log(`${col}${ev.event.padEnd(16)}${c.reset} ${c.dim}${data}${c.reset}`);
}

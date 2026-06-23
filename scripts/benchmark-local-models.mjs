#!/usr/bin/env node
/**
 * Multi-model × multi-scenario benchmark — bscode-realistic local-LLM workloads.
 *
 * Measures both **quality** (did the model do the right thing?) and **speed**
 * (load time, first-token latency, tokens/sec, total wall) across the
 * small-model bracket. Targets the kind of tasks bscode actually pushes
 * through its agent loop: file-tool routing, code generation, multi-tool
 * choice, structured JSON output, error recovery.
 *
 * Output:
 *   - markdown report (default to stdout, --out <path> writes file)
 *   - exits 0 always (this is a measurement, not a gate)
 *
 * Usage:
 *   node scripts/benchmark-local-models.mjs [--out report.md] [--limit N]
 *   node scripts/benchmark-local-models.mjs --models qwen0.5,qwen1.7
 *   node scripts/benchmark-local-models.mjs --quick    # 3 scenarios only
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const localPath = resolve(here, "../../agentkit-js/packages/model-local/dist/index.js");
const { LocalModel } = await import(localPath);

// ── Models under test ────────────────────────────────────────────────────────

const MODELS = {
  "qwen2.5-0.5b": {
    label: "Qwen2.5-0.5B q4_0",
    sizeBytes: 397_807_936,
    path: process.env.MODEL_QWEN2_5_0_5B ?? "",
  },
  "evo-qwen3-1.7b-q3km": {
    label: "evo-Qwen3-1.7B q3_k_m",
    sizeBytes: 939_538_272,
    path: process.env.MODEL_EVO_QWEN3_1_7B ?? "",
  },
  "evomerge-qwen2.5-1.5b": {
    label: "evomerge-Qwen2.5-1.5B",
    sizeBytes: 1_646_572_512,
    path: process.env.MODEL_EVOMERGE_QWEN2_5_1_5B ?? "",
  },
};

// ── Scenarios — bscode-realistic, increasing difficulty ──────────────────────

const TOOLS = {
  fileTool: [
    {
      name: "list_files",
      description: "List files in a directory",
      input_schema: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string", description: "directory path" },
          pattern: { type: "string", description: "optional glob pattern" },
        },
      },
    },
    {
      name: "read_file",
      description: "Read the contents of a file",
      input_schema: {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" } },
      },
    },
    {
      name: "write_file",
      description: "Write text contents to a file",
      input_schema: {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
      },
    },
    {
      name: "run_command",
      description: "Execute a shell command and return its output",
      input_schema: {
        type: "object",
        required: ["cmd"],
        properties: { cmd: { type: "string" } },
      },
    },
  ],
};

const SCENARIOS = [
  {
    id: "S1-tool-pick-trivial",
    name: "Trivial tool pick",
    desc: "1 obvious tool match",
    prompt: "Add 12 and 30 using the calc tool.",
    tools: [
      {
        name: "calc",
        description: "Add two integers",
        input_schema: {
          type: "object",
          required: ["a", "b"],
          properties: { a: { type: "integer" }, b: { type: "integer" } },
        },
      },
    ],
    check: (r) =>
      r.toolCall?.name === "calc" &&
      r.toolCall.input?.a === 12 &&
      r.toolCall.input?.b === 30,
  },
  {
    id: "S2-tool-pick-among-4",
    name: "Pick among 4 tools",
    desc: "Choose `list_files` from a 4-tool fleet",
    prompt: "List all files in /workspace/src",
    tools: TOOLS.fileTool,
    check: (r) =>
      r.toolCall?.name === "list_files" &&
      typeof r.toolCall.input?.path === "string" &&
      /workspace.*src/.test(r.toolCall.input.path),
  },
  {
    id: "S3-tool-pick-write",
    name: "Pick `write_file` with content",
    desc: "Multi-arg tool call with non-trivial string payload",
    prompt:
      "Write the string 'console.log(\"hello\")' into the file /workspace/hello.js",
    tools: TOOLS.fileTool,
    check: (r) =>
      r.toolCall?.name === "write_file" &&
      typeof r.toolCall.input?.path === "string" &&
      r.toolCall.input.path.includes("hello.js") &&
      typeof r.toolCall.input?.content === "string" &&
      r.toolCall.input.content.includes("hello"),
  },
  {
    id: "S4-tool-pick-shell",
    name: "Shell command construction",
    desc: "Pick `run_command` and synthesise an actual shell invocation",
    prompt: "Show the git status of the current repository.",
    tools: TOOLS.fileTool,
    check: (r) =>
      r.toolCall?.name === "run_command" &&
      typeof r.toolCall.input?.cmd === "string" &&
      /git\s+status/.test(r.toolCall.input.cmd),
  },
  {
    id: "S5-structured-json",
    name: "Structured JSON output",
    desc: "responseFormat = json_schema, no tools",
    prompt:
      "Extract person info from: 'Alice Chen is 32 years old and lives in Shanghai.'. " +
      "Return only JSON.",
    tools: [],
    responseFormat: {
      type: "json_schema",
      schema: {
        type: "object",
        required: ["name", "age", "city"],
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          age: { type: "integer" },
          city: { type: "string" },
        },
      },
    },
    check: (r) => {
      try {
        const obj = JSON.parse(r.text);
        return (
          /alice/i.test(obj.name) && obj.age === 32 && /shanghai/i.test(obj.city)
        );
      } catch {
        return false;
      }
    },
  },
  {
    id: "S6-zh-tool-pick",
    name: "Chinese tool pick",
    desc: "中文 prompt → English tool call",
    prompt: "请帮我列出 /workspace 目录下的所有文件。",
    tools: TOOLS.fileTool,
    check: (r) =>
      r.toolCall?.name === "list_files" &&
      typeof r.toolCall.input?.path === "string" &&
      r.toolCall.input.path.includes("workspace"),
  },
  {
    id: "S7-no-tool-fits",
    name: "No tool fits → final_answer",
    desc: "Reject tool calls when nothing matches",
    prompt:
      "What is the capital of France? Just answer; don't call any tool.",
    tools: TOOLS.fileTool,
    check: (r) =>
      // No tool call AND text mentions Paris.
      r.toolCall == null && /paris/i.test(r.text),
  },
];

// ── Runner ──────────────────────────────────────────────────────────────────

async function runScenario(model, scenario, tier) {
  const messages = [{ role: "user", content: scenario.prompt }];
  const opts = { maxTokens: 256 };
  if (scenario.tools.length > 0) opts.tools = scenario.tools;
  if (scenario.responseFormat) opts.responseFormat = scenario.responseFormat;

  const tStart = Date.now();
  let firstChunkAt = null;
  let toolCall = null;
  let text = "";
  let stopReason = "";
  let usage = null;
  let error = null;

  try {
    for await (const ev of model.generate(messages, opts)) {
      if (ev.type === "text_delta") {
        if (firstChunkAt == null) firstChunkAt = Date.now();
        text += ev.delta ?? "";
      } else if (ev.type === "tool_call") {
        if (firstChunkAt == null) firstChunkAt = Date.now();
        toolCall = ev.toolCall;
      } else if (ev.type === "stop") {
        stopReason = ev.stopReason ?? "";
      } else if (ev.type === "usage") {
        usage = ev.usage;
      }
    }
  } catch (e) {
    error = e?.message ?? String(e);
  }
  const tEnd = Date.now();

  const result = {
    toolCall,
    text,
    stopReason,
    usage,
    error,
    wallMs: tEnd - tStart,
    firstChunkMs: firstChunkAt != null ? firstChunkAt - tStart : null,
    tokensPerSec:
      usage?.outputTokens && tEnd > tStart
        ? Math.round((usage.outputTokens * 1000) / (tEnd - tStart))
        : null,
  };
  result.passed = !error && scenario.check(result);
  return result;
}

async function benchmarkModel(modelKey, scenarios) {
  const cfg = MODELS[modelKey];
  console.error(`\n=== ${cfg.label} (${(cfg.sizeBytes / 1e6).toFixed(0)} MB) ===`);

  const model = new LocalModel({
    source: { path: cfg.path },
    contextSize: 4096,
    threads: 4,
    temperature: 0.2,
  });

  const tLoad0 = Date.now();
  let loadError = null;
  try {
    await model.load();
  } catch (e) {
    loadError = e?.message ?? String(e);
  }
  const loadMs = Date.now() - tLoad0;
  console.error(`  Loaded in ${loadMs} ms${loadError ? ` (ERROR: ${loadError})` : ""}`);

  const results = {};
  if (loadError) {
    for (const s of scenarios) {
      results[s.id] = { passed: false, error: `load failed: ${loadError}` };
    }
    return { modelKey, cfg, loadMs, results };
  }

  for (const scenario of scenarios) {
    process.stderr.write(`  [${scenario.id}] ${scenario.name} ... `);
    const r = await runScenario(model, scenario);
    process.stderr.write(`${r.passed ? "PASS" : "FAIL"} (${r.wallMs}ms)\n`);
    results[scenario.id] = r;
  }
  return { modelKey, cfg, loadMs, results };
}

// ── Report ──────────────────────────────────────────────────────────────────

function fmtPct(n, total) {
  if (total === 0) return "—";
  return `${n}/${total} (${((n / total) * 100).toFixed(0)}%)`;
}

function renderReport(allResults, scenarios) {
  const lines = [];
  lines.push("# Local-Model Benchmark — bscode scenarios (real machine)");
  lines.push("");
  lines.push("Apple Silicon Metal · `node-llama-cpp@3.18.x` · `@wasmagent/model-local`");
  lines.push("");

  // Summary table
  lines.push("## Summary");
  lines.push("");
  lines.push(
    "| Model | Size | Load (ms) | Pass rate | Avg wall (ms) | Avg first-chunk (ms) | Avg t/s |"
  );
  lines.push("|---|---|---|---|---|---|---|");
  for (const r of allResults) {
    const passed = scenarios.filter((s) => r.results[s.id]?.passed).length;
    const wallMs = scenarios
      .map((s) => r.results[s.id]?.wallMs)
      .filter((x) => x != null);
    const fcMs = scenarios
      .map((s) => r.results[s.id]?.firstChunkMs)
      .filter((x) => x != null);
    const tps = scenarios
      .map((s) => r.results[s.id]?.tokensPerSec)
      .filter((x) => x != null);
    const avg = (xs) =>
      xs.length === 0 ? "—" : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
    lines.push(
      `| ${r.cfg.label} | ${(r.cfg.sizeBytes / 1e6).toFixed(0)} MB | ${r.loadMs} | ${fmtPct(passed, scenarios.length)} | ${avg(wallMs)} | ${avg(fcMs)} | ${avg(tps)} |`
    );
  }
  lines.push("");

  // Per-scenario breakdown
  lines.push("## Per-scenario results");
  lines.push("");
  for (const s of scenarios) {
    lines.push(`### ${s.id} — ${s.name}`);
    lines.push("");
    lines.push(`> ${s.desc}`);
    lines.push("");
    lines.push("| Model | Pass | Wall (ms) | First-chunk (ms) | t/s | Output |");
    lines.push("|---|---|---|---|---|---|");
    for (const r of allResults) {
      const sr = r.results[s.id];
      if (!sr) {
        lines.push(`| ${r.cfg.label} | — | — | — | — | (no result) |`);
        continue;
      }
      const out = sr.toolCall
        ? `\`${sr.toolCall.name}(${JSON.stringify(sr.toolCall.input).slice(0, 60)})\``
        : sr.text
          ? `\`${sr.text.slice(0, 60).replace(/\n/g, "\\n").replace(/\|/g, "\\|")}\``
          : sr.error
            ? `error: ${sr.error.slice(0, 60)}`
            : "(empty)";
      lines.push(
        `| ${r.cfg.label} | ${sr.passed ? "✓" : "✗"} | ${sr.wallMs ?? "—"} | ${sr.firstChunkMs ?? "—"} | ${sr.tokensPerSec ?? "—"} | ${out} |`
      );
    }
    lines.push("");
  }

  // Notes
  lines.push("## Notes");
  lines.push("");
  lines.push(
    "- All models run with the same `LocalModel` config: `contextSize=4096`, `threads=4`, `temperature=0.2`."
  );
  lines.push(
    "- Grammar-constrained tool calling enabled (default). Single retry on token-budget truncation."
  );
  lines.push(
    "- `t/s` = output tokens / wall seconds. Approximate — usage tokens are estimated by the framework, not pulled from the engine."
  );
  lines.push(
    "- bscode tool shapes mirror the worker's actual tool fleet (file/read/write/run-command)."
  );
  return lines.join("\n");
}

// ── Main ────────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    out: { type: "string" },
    models: { type: "string" },
    limit: { type: "string" },
    quick: { type: "boolean", default: false },
  },
});

const modelKeys = values.models
  ? values.models.split(",").map((s) => s.trim())
  : Object.keys(MODELS);

let scenarios = SCENARIOS;
if (values.quick) scenarios = SCENARIOS.slice(0, 3);
if (values.limit) scenarios = scenarios.slice(0, Number(values.limit));

console.error(
  `[bench] ${modelKeys.length} model(s) × ${scenarios.length} scenario(s)`
);

const allResults = [];
for (const k of modelKeys) {
  if (!MODELS[k]) {
    console.error(`[bench] Unknown model key: ${k}, skipping`);
    continue;
  }
  allResults.push(await benchmarkModel(k, scenarios));
}

const report = renderReport(allResults, scenarios);
if (values.out) {
  writeFileSync(values.out, report, "utf8");
  console.error(`\n[bench] Report → ${values.out}`);
} else {
  process.stdout.write(report);
}

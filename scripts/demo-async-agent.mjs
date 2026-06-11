#!/usr/bin/env node
/**
 * Async-agent end-to-end demo (G1)
 * --------------------------------
 * Drives the bscode worker through the headline async-agent flow:
 *
 *   1. Submit a /jobs entry that imports a small public GitHub repo
 *   2. Inside the same job, ask the agent to make a small documentation tweak
 *   3. Watch the job stream events while it runs (SSE)
 *   4. When the job finishes, show the diff and (optionally) request a PR
 *
 * The PR step is **dry-run by default** — the script prints the inputs that
 * would be sent to `create_github_pr` instead of actually opening one.
 * Pass --pr to flip the flag (you'll need GITHUB_TOKEN).
 *
 * Usage:
 *   pnpm dev:worker                          # in another terminal
 *   node scripts/demo-async-agent.mjs        # dry-run
 *   node scripts/demo-async-agent.mjs --pr   # actually open a PR
 *
 * Options:
 *   --url <http://...>   Worker base URL (default: http://localhost:8787)
 *   --owner <user>       Repo owner to import (default: octocat)
 *   --repo <name>        Repo name to import (default: Hello-World)
 *   --task <prompt>      Agent task (default: clean up the README)
 *   --pr                 Actually open a PR via create_github_pr
 *   --timeout <ms>       Per-step timeout (default: 60_000)
 */

import { parseArgs } from "node:util";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    url: { type: "string", default: "http://localhost:8787" },
    owner: { type: "string", default: "octocat" },
    repo: { type: "string", default: "Hello-World" },
    task: {
      type: "string",
      default:
        "Read README.md and propose a one-sentence improvement to make it clearer for first-time visitors. Write the new content via write_file.",
    },
    pr: { type: "boolean", default: false },
    timeout: { type: "string", default: "60000" },
  },
});

const BASE = values.url.replace(/\/$/, "");
const SESSION = `demo-async-${Date.now()}`;
const TIMEOUT_MS = Number(values.timeout);

const c = {
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

const step = (n, msg) => console.log(`\n${c.cyan(`[${n}]`)} ${msg}`);
const ok = (msg) => console.log(`  ${c.green("✓")} ${msg}`);
const warn = (msg) => console.log(`  ${c.yellow("⚠")} ${msg}`);
const fail = (msg) => {
  console.log(`  ${c.red("✗")} ${msg}`);
  process.exit(1);
};

async function getJSON(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { "X-Session-Id": SESSION } });
  if (!res.ok) fail(`GET ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function postJSON(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Session-Id": SESSION },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) fail(`POST ${path} → ${res.status} ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`);
  return parsed;
}

// 1. Health check
step(1, "Worker health check");
try {
  const health = await getJSON("/health");
  ok(`worker reachable — ${health.status ?? "ok"}`);
} catch (e) {
  fail(`worker not reachable at ${BASE} — start it with \`pnpm dev:worker\`. (${e.message})`);
}

// 2. Import the repo
step(2, `Import https://github.com/${values.owner}/${values.repo}`);
const imported = await postJSON("/import/github", {
  owner: values.owner,
  repo: values.repo,
  textExtensions: [".md", ".txt"], // keep tiny
});
if (typeof imported === "object" && "imported" in imported) {
  ok(`imported ${imported.imported} files`);
  if (imported.error) warn(`partial: ${imported.error}`);
} else {
  warn(`unexpected response shape: ${JSON.stringify(imported).slice(0, 80)}`);
}

// 3. Submit an async job that runs the agent
step(3, "Submit async agent job");
const submitted = await postJSON("/jobs", {
  task: values.task,
  mode: "tool",
  approvalPolicy: "balanced",
});
const jobId = submitted?.id ?? submitted?.jobId;
if (!jobId) fail(`no job id in response: ${JSON.stringify(submitted)}`);
ok(`job submitted — id=${jobId}`);

// 4. Poll until the job reaches a terminal state
step(4, "Wait for the job to finish (polling /jobs/:id)");
const t0 = Date.now();
let lastSeq = -1;
let job;
while (true) {
  if (Date.now() - t0 > TIMEOUT_MS) fail(`job ${jobId} timed out after ${TIMEOUT_MS}ms`);
  job = await getJSON(`/jobs/${jobId}`);
  if (job.eventCount !== lastSeq) {
    lastSeq = job.eventCount;
    console.log(c.dim(`    status=${job.status}  events=${job.eventCount}`));
  }
  if (["done", "failed", "aborted"].includes(job.status)) break;
  await new Promise((r) => setTimeout(r, 1000));
}

if (job.status === "done") {
  ok(`job ${jobId} done in ${Date.now() - t0}ms (${job.eventCount} events)`);
  if (job.finalAnswer) console.log(`    final: ${c.dim(String(job.finalAnswer).slice(0, 200))}`);
} else {
  fail(`job ended with status=${job.status} error=${job.error ?? "(none)"}`);
}

// 5. Show the per-job diff
step(5, "Inspect the per-job diff");
const diff = await getJSON(`/jobs/${jobId}/diff`);
const changed = diff.files ?? diff.changed ?? [];
if (Array.isArray(changed) && changed.length > 0) {
  ok(`${changed.length} file(s) changed`);
  for (const f of changed.slice(0, 5)) {
    console.log(`    ${c.dim("·")} ${typeof f === "string" ? f : f.path ?? JSON.stringify(f)}`);
  }
} else {
  warn(`no files changed — agent may have answered without writes (final: ${job.finalAnswer ?? "?"})`);
}

// 6. PR step — dry-run unless --pr
step(6, values.pr ? "Open a real PR via create_github_pr" : "PR step (dry-run)");
const prInputs = {
  owner: values.owner,
  repo: values.repo,
  base: "main",
  branch: `bscode/demo-${jobId}`,
  commitMessage: "docs: clarify README opener (bscode async-agent demo)",
  prTitle: "docs: README clarification (demo)",
  prBody: `Generated by the bscode async-agent demo. job=${jobId}, session=${SESSION}.`,
};
if (!values.pr) {
  console.log(c.dim("    Would POST /jobs/${jobId}/merge then create_github_pr with:"));
  console.log(c.dim(`    ${JSON.stringify(prInputs, null, 2).split("\n").join("\n    ")}`));
  ok("dry-run complete — pass --pr to actually open a PR (needs GITHUB_TOKEN)");
} else {
  if (!process.env.GITHUB_TOKEN) fail("--pr requires GITHUB_TOKEN in the environment");
  // Real PRs are gated by approval policy; the create_github_pr tool runs through
  // the agent loop. For the demo we surface the inputs and let the user follow up
  // through the worker's HITL UI.
  warn("Real PR creation is HITL-gated. Open the JobsPanel and approve the create_github_pr step,");
  warn("or curl POST /run with `tools=[\"create_github_pr\"]` and the inputs above.");
}

console.log(`\n${c.green("✓")} demo finished — session ${c.cyan(SESSION)}`);

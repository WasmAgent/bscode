/**
 * test-aep-roundtrip.ts — placeholder script for CI AEP roundtrip validation.
 *
 * What this script will do once trace-pipeline validate-aep is available:
 *
 * 1. Run a synthetic coding job via the bscode worker (or use the shared fixture).
 * 2. Export the AEP record from the job's rollout via buildAEPEvidence().
 * 3. Write the record to a temp JSONL file.
 * 4. Call `npx @wasmagent/trace-pipeline validate-aep <file>` and assert exit code 0.
 *
 * Cross-repo CI dependency: this script requires @wasmagent/trace-pipeline to be
 * installed. Until that package is published, the validation step is skipped and
 * the script exits 0 (allowing CI to pass without blocking on the cross-repo dep).
 *
 * Usage:
 *   bun apps/worker/scripts/test-aep-roundtrip.ts
 *   BSCODE_AEP_SEED=<64-char-hex> bun apps/worker/scripts/test-aep-roundtrip.ts
 */

import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAEPEvidence } from "../src/trajectoryExport.js";

const FIXTURE_PATH = join(import.meta.dir, "../src/__fixtures__/aep-shared.jsonl");

async function main() {
  console.log("[test-aep-roundtrip] Starting AEP roundtrip validation...");

  // ── Step 1: Generate an AEP record from synthetic tool calls ────────────────
  const toolCalls = [
    {
      event: "tool_call" as const,
      data: { name: "read_file", args: {} },
      timestamp_ms: 1700000001000,
    },
    { event: "tool_result" as const, data: { content: "ok" }, timestamp_ms: 1700000001100 },
    {
      event: "tool_call" as const,
      data: { name: "bash", args: { cmd: "npm test" } },
      timestamp_ms: 1700000002000,
    },
    { event: "tool_result" as const, data: { exit_code: 0 }, timestamp_ms: 1700000002500 },
  ];

  const record = await buildAEPEvidence({
    run_id: `roundtrip-${Date.now()}`,
    model_id: "test-model-v1",
    tool_calls: toolCalls,
    objective_passed: true,
    input_refs: [{ uri: "task://roundtrip-task", taint_labels: [] }],
    output_refs: [{ uri: "file://dist/output.js" }],
  });

  // ── Step 2: Validate structure ────────────────────────────────────────────────
  if (record.schema_version !== "aep/v0.2") {
    console.error("[test-aep-roundtrip] FAIL: schema_version is not aep/v0.2");
    process.exit(1);
  }
  if (!record.signature || record.signature.sig === "UNSIGNED_PLACEHOLDER") {
    console.error("[test-aep-roundtrip] FAIL: record is unsigned");
    process.exit(1);
  }
  if (record.actions.length === 0) {
    console.error("[test-aep-roundtrip] FAIL: actions[] is empty");
    process.exit(1);
  }
  if (record.verifier_results.length === 0) {
    console.error("[test-aep-roundtrip] FAIL: verifier_results[] is empty");
    process.exit(1);
  }
  console.log(
    `[test-aep-roundtrip] Generated record: run_id=${record.run_id}, ` +
      `actions=${record.actions.length}, ` +
      `verifiers=${record.verifier_results.length}, ` +
      `cap_decisions=${record.capability_decisions.length}`
  );

  // ── Step 3: Write to temp JSONL ───────────────────────────────────────────────
  const tmpFile = join(tmpdir(), `aep-roundtrip-${Date.now()}.jsonl`);
  writeFileSync(tmpFile, JSON.stringify(record) + "\n", "utf-8");
  console.log(`[test-aep-roundtrip] Written to ${tmpFile}`);

  // ── Step 4: Validate against shared fixture ───────────────────────────────────
  if (existsSync(FIXTURE_PATH)) {
    const fixtureContent = await import(FIXTURE_PATH, { with: { type: "text" } }).catch(() => null);
    if (fixtureContent) {
      console.log(`[test-aep-roundtrip] Shared fixture exists at ${FIXTURE_PATH}`);
      // The fixture uses created_at_ms=1700000000000 and DEV_SEED — parse and
      // verify the signature field is present and non-placeholder.
      const fixtureLine = (fixtureContent as { default: string }).default.trim().split("\n")[0];
      const fixtureRecord = JSON.parse(fixtureLine);
      if (
        fixtureRecord.schema_version !== "aep/v0.2" ||
        !fixtureRecord.signature ||
        fixtureRecord.signature.sig === "UNSIGNED_PLACEHOLDER"
      ) {
        console.error("[test-aep-roundtrip] FAIL: shared fixture is malformed");
        process.exit(1);
      }
      console.log("[test-aep-roundtrip] Shared fixture validated OK.");
    }
  }

  // ── Step 5: Call trace-pipeline validate-aep (if available) ─────────────────
  // TODO: Once @wasmagent/trace-pipeline is published, enable this block:
  //
  // import { spawnSync } from "node:child_process";
  // const result = spawnSync(
  //   "npx",
  //   ["@wasmagent/trace-pipeline", "validate-aep", tmpFile],
  //   { stdio: "inherit" }
  // );
  // if (result.status !== 0) {
  //   console.error("[test-aep-roundtrip] FAIL: validate-aep returned non-zero");
  //   process.exit(1);
  // }
  console.log(
    "[test-aep-roundtrip] SKIP: validate-aep step requires @wasmagent/trace-pipeline (not yet published)"
  );

  console.log("[test-aep-roundtrip] PASS");
}

main().catch((err) => {
  console.error("[test-aep-roundtrip] ERROR:", err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * check-rollout-schema.mjs — validate bscode fixture rollouts conform to
 * the rollout-wire/v1 schema from wasmagent-js.
 *
 * Reads fixtures/data-loop/rollout-branches.v1.jsonl and verifies each record
 * has all required fields with correct types. This is a local smoke test that
 * runs in CI without needing to clone wasmagent-js — it mirrors the key
 * constraints from rollout-wire.schema.json directly.
 *
 * Usage:
 *   node scripts/check-rollout-schema.mjs [--fixture path/to/file.jsonl]
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const idxF = process.argv.indexOf("--fixture");
const FIXTURE_PATH =
  idxF !== -1
    ? resolve(process.argv[idxF + 1])
    : resolve(ROOT, "fixtures/data-loop/rollout-branches.v1.jsonl");

// Required fields from rollout-wire.schema.json § RolloutBranchRecord
const REQUIRED_FIELDS = [
  "rollout_id",
  "task",
  "branch_index",
  "temperature",
  "session_id",
  "tool_call_sequence",
  "final_answer",
];

const VALID_OBJECTIVE_STATUS = ["pass", "fail", "unknown"];

const errors = [];
let count = 0;

let lines;
try {
  lines = readFileSync(FIXTURE_PATH, "utf8").split("\n").filter(Boolean);
} catch {
  console.error(`ERROR: fixture not found at ${FIXTURE_PATH}`);
  process.exit(1);
}

for (const [i, line] of lines.entries()) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    errors.push(`line ${i + 1}: invalid JSON`);
    continue;
  }
  count++;

  for (const field of REQUIRED_FIELDS) {
    if (record[field] === undefined || record[field] === null) {
      errors.push(`line ${i + 1} (rollout_id=${record.rollout_id}): missing required field '${field}'`);
    }
  }

  if (
    record.objective_score !== undefined &&
    record.objective_score !== 0 &&
    record.objective_score !== 1
  ) {
    errors.push(
      `line ${i + 1}: objective_score must be 0 or 1, got ${record.objective_score}`
    );
  }

  if (
    record.objective_status !== undefined &&
    !VALID_OBJECTIVE_STATUS.includes(record.objective_status)
  ) {
    errors.push(
      `line ${i + 1}: objective_status must be one of ${VALID_OBJECTIVE_STATUS.join("|")}, got '${record.objective_status}'`
    );
  }

  if (
    record.tool_call_sequence !== undefined &&
    !Array.isArray(record.tool_call_sequence)
  ) {
    errors.push(`line ${i + 1}: tool_call_sequence must be an array`);
  }
}

if (errors.length > 0) {
  console.error(`✗ rollout-wire/v1 schema violations in ${FIXTURE_PATH}:`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

console.log(
  `✓ ${count} records in ${FIXTURE_PATH} conform to rollout-wire/v1`
);

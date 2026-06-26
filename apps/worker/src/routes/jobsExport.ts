/**
 * GET /jobs/export        — batch JSONL export of completed job trajectories
 * GET /jobs/export/dataset-card — Markdown dataset card for the export
 *
 * Reads up to 100 recent job IDs from KV key "job-index" (JSON array),
 * fetches each rollout record from KV key "rollout:<jobId>", and streams
 * the results as newline-delimited JSON (application/x-ndjson).
 *
 * Supported query params:
 *   ?format=rollout-wire  (default) — raw RolloutWireRecord objects
 *   ?format=aep           — only records that contain an aep_evidence bundle
 */

import type { Hono } from "hono";
import type { AppConfig } from "../platform.js";
import type { RolloutWireRecord } from "../trajectoryExport.js";

const MAX_EXPORT_JOBS = 100;

export function mountJobsExportRoutes(app: Hono, config: AppConfig): void {
  // ── GET /jobs/export ──────────────────────────────────────────────────────
  app.get("/jobs/export", async (c) => {
    const kv = config.sessionsKv;
    if (!kv) {
      return c.json({ error: "sessionsKv not bound on this worker" }, 503);
    }

    const format = (c.req.query("format") ?? "rollout-wire") as "rollout-wire" | "aep";
    if (format !== "rollout-wire" && format !== "aep") {
      return c.json({ error: "Invalid format. Use 'rollout-wire' or 'aep'." }, 400);
    }

    // Load the job index (JSON array of job ID strings).
    let jobIds: string[] = [];
    try {
      const raw = await kv.get("job-index");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          jobIds = parsed.slice(-MAX_EXPORT_JOBS) as string[];
        }
      }
    } catch {
      return c.json({ error: "Failed to read job-index from KV" }, 500);
    }

    // Fetch each rollout record, collecting valid ones.
    const lines: string[] = [];
    await Promise.all(
      jobIds.map(async (jobId) => {
        try {
          const raw = await kv.get(`rollout:${jobId}`);
          if (!raw) return;
          const record = JSON.parse(raw) as RolloutWireRecord;
          if (format === "aep" && !record.aep_evidence) return;
          lines.push(JSON.stringify(record));
        } catch {
          // Skip malformed records silently — one bad record must not abort
          // the entire export.
        }
      })
    );

    const body = lines.join("\n");
    const count = lines.length;

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson",
        "Content-Disposition": 'attachment; filename="bscode-export.jsonl"',
        "X-Export-Count": String(count),
        "Cache-Control": "no-store",
      },
    });
  });

  // ── GET /jobs/export/dataset-card ─────────────────────────────────────────
  app.get("/jobs/export/dataset-card", (_c) => {
    const card = generateDatasetCard();
    return new Response(card, {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": 'inline; filename="dataset-card.md"',
        "Cache-Control": "no-store",
      },
    });
  });
}

// ── Dataset card generator ────────────────────────────────────────────────────

function generateDatasetCard(): string {
  const now = new Date().toISOString();
  return `---
annotations_creators:
  - machine-generated
language_creators:
  - machine-generated
license: apache-2.0
task_categories:
  - text-generation
  - reinforcement-learning-from-human-feedback
task_ids:
  - code-generation
pretty_name: bscode Rollout Export
---

# bscode Rollout Export

**Generated at:** ${now}

## Dataset Description

This dataset contains completed job trajectories exported from a bscode worker.
Each record is a \`RolloutWireRecord\` (schema version \`rollout-wire/v1\`) that
captures a full agent execution: the task prompt, tool-call sequence, final answer,
build result, and objective pass/fail score.

Records are suitable for use with:

- [WasmAgent RolloutRanker](https://github.com/WasmAgent/wasmagent-js) (ranking / RLAIF)
- [evomerge datafactory](https://github.com/WasmAgent/evomerge) (SFT / DPO training)

## Export Endpoint

\`\`\`
GET /jobs/export?format=rollout-wire   # default — all completed records
GET /jobs/export?format=aep            # only records with AEP evidence bundles
\`\`\`

Response format: \`application/x-ndjson\` (newline-delimited JSON, one record per line).

The \`X-Export-Count\` response header contains the total number of exported records.

## Schema

Each line is a JSON object conforming to \`rollout-wire/v1\`. Key fields:

| Field | Type | Description |
|---|---|---|
| \`schema_version\` | \`"rollout-wire/v1"\` | Schema identifier |
| \`rollout_id\` | string | Unique rollout identifier |
| \`task\` | string | Agent task prompt (PII-redacted) |
| \`tool_call_sequence\` | ToolCallEvent[] | Ordered list of tool calls and results |
| \`final_answer\` | string | Agent final answer (PII-redacted) |
| \`build_result\` | object \\| null | Build outcome snapshot |
| \`objective_score\` | 0 \\| 1 | Binary pass/fail score |
| \`objective_status\` | \`"pass"\` \\| \`"fail"\` \\| \`"unknown"\` | Human-readable status |
| \`aep_evidence\` | object \\| undefined | AEP capability decision bundle (optional) |
| \`provenance\` | object | Source, session, job ID, export timestamp |

## Privacy

All records are processed through PII redaction before storage. Email addresses,
API keys (sk-/pk-/api- prefixed tokens), and JWT tokens are replaced with safe
placeholders (\`[EMAIL]\`, \`[REDACTED_KEY]\`, \`[JWT]\`).
`;
}

# bscode Data Governance

> **Audience**: users running bscode, operators deploying it, and downstream
> consumers of training data.
>
> This document covers consent, data modes, redaction, retention, deletion,
> and export. For the technical wire format and pipeline contract, see
> [`GOVERNANCE.md`](./GOVERNANCE.md).

---

## Data collection modes

bscode operates in three explicit modes. **No data leaves Demo Mode.**
Mode must be explicitly selected by the session operator.

| Mode | What is stored | Sent to training pipeline? |
|---|---|---|
| **Demo Mode** (default) | Nothing persisted beyond the active session | No |
| **Evidence Mode** | Objective signals only: build pass/fail, visual diff score, job metadata | No — audit only |
| **Training Data Mode** | Full `rollout-wire/v1` trace + `ComplianceEvalRecord` JSONL | Yes — only on explicit export action |

Switching to Training Data Mode requires an affirmative action in the UI or
API; it is never set by default, never inferred from usage, and never
activated by a server-side flag without operator consent.

---

## Consent

Training Data Mode requires explicit opt-in at two levels:

1. **Operator** — the person deploying bscode sets `TRAINING_DATA_MODE=true`
   in the worker environment. This enables the export endpoint but does not
   activate collection.
2. **Session user** — each export is triggered by an explicit API call or
   UI action (`POST /rollouts/export` or the "Export for training" button).
   Passive browsing and job execution never silently enqueue data.

No consent signal is inferred from task completion, session length, or
build success rate.

---

## What is and is not collected

### Collected in Training Data Mode

- Agent tool call sequences (tool name, arguments, result)
- Final answer text
- Build result (pass/fail/exit code, stdout truncated to 4 kB)
- Visual verifier score (pixel diff, layout hash)
- Compliance verifier output (pass/fail per constraint class)
- Job metadata (task id, timestamp, model id, kernel tier)

### Never collected

- API keys, environment variables, secrets in any form
- Filesystem paths outside the sandbox
- Browser cookies, localStorage, auth tokens
- Content of files not touched by the agent during the task
- User PII (name, email, IP address are not stored in rollout records)

---

## Redaction

Before any export, the pipeline applies:

1. **Secret scanner**: regex patterns for common API key formats
   (`sk-...`, `ghp_...`, `AKIA...`, etc.). Any match causes the record
   to be dropped entirely — not masked, dropped.
2. **Path normalisation**: absolute filesystem paths are replaced with
   relative paths or `<path>` placeholders.
3. **Stdout truncation**: build stdout is truncated to 4 kB per step.
   Full stdout is not stored.

Redaction is applied in the worker before the JSONL is written to KV.
It is not a post-processing step.

---

## Retention

| Data class | Retention |
|---|---|
| Demo Mode session data | Cleared at session end (KV TTL: 1 hour) |
| Evidence Mode records | 30 days by default; configurable via `EVIDENCE_RETENTION_DAYS` |
| Training Data Mode records | Until explicit delete request or operator purge |

Operators can change Evidence Mode retention by setting
`EVIDENCE_RETENTION_DAYS` in the worker environment. Setting it to `0`
disables Evidence Mode persistence entirely.

---

## Deletion and export

### Delete a single job record

```bash
curl -X DELETE https://<worker>/jobs/<job-id>/rollout \
  -H "X-Session-Id: <session>"
```

Returns `204` on success. The KV record is hard-deleted within 60 seconds
(Cloudflare KV eventual consistency window).

### Delete all records for a session

```bash
curl -X DELETE https://<worker>/rollouts \
  -H "X-Session-Id: <session>"
```

### Export your data

```bash
curl https://<worker>/rollouts/export \
  -H "X-Session-Id: <session>" \
  -o my-rollouts.jsonl
```

The export endpoint streams `rollout-wire/v1` JSONL. The response includes
a `X-Record-Count` header with the number of records.

---

## Downstream use (evomerge-framework)

Records exported from bscode are processed by
[evomerge-framework](https://github.com/telleroutlook/evomerge-framework)
before any training use. The pipeline applies:

- **Schema validation**: records that do not conform to `rollout-wire/v1`
  are rejected at ingest.
- **Contamination check**: 8-gram Jaccard similarity against the eval set;
  flagged records are excluded from all training splits.
- **Quality gate**: records with `objective_status = "unknown"` are
  excluded from DPO pairs.
- **Dataset card**: every training export produces a `DATASET_CARD.md`
  documenting provenance, contamination rate, seed, and record counts.

---

## Security contact

To report a data handling concern, file a private report via the
[SECURITY.md](../SECURITY.md) process. Do not file a public issue.

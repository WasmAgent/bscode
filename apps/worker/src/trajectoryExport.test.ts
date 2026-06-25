import { describe, expect, it } from "bun:test";
import { buildEvidenceManifest, buildRolloutRecord, redactPii, toJsonl, validateRolloutRecord } from "./trajectoryExport.js";

describe("buildRolloutRecord", () => {
  it("sets objective_score=1 when build succeeded", () => {
    const rec = buildRolloutRecord({
      jobId: "job-abc12345",
      jobSpec: { task: "add a button" } as never,
      sessionId: "session-12345678",
      branchIndex: 0,
      buildResult: { status: "success", ranAtMs: Date.now() },
    });
    expect(rec.objective_score).toBe(1);
    expect(rec.objective_status).toBe("pass");
    expect(rec.schema_version).toBe("rollout-wire/v1");
    expect(rec.rollout_id).toBe("job-abc12345");
    expect(rec.task).toBe("add a button");
  });

  it("sets objective_score=0 when build failed", () => {
    const rec = buildRolloutRecord({
      jobId: "job-abc12345",
      jobSpec: { task: "add a button" } as never,
      sessionId: "session-12345678",
      branchIndex: 1,
      buildResult: { status: "failed", ranAtMs: Date.now() },
    });
    expect(rec.objective_score).toBe(0);
    expect(rec.objective_status).toBe("fail");
    expect(rec.total_score).toBe(0);
  });

  it("sets objective_score=0 and objective_status=unknown when no build result", () => {
    const rec = buildRolloutRecord({
      jobId: "job-abc12345",
      jobSpec: { task: "x" } as never,
      sessionId: "session-12345678",
      branchIndex: 0,
      buildResult: null,
    });
    // unknown = no build triggered; objective_score stays 0 (not 0.5)
    // so the record doesn't pollute DPO pairs but is identifiable by status.
    expect(rec.objective_score).toBe(0);
    expect(rec.objective_status).toBe("unknown");
  });

  it("includes provenance metadata fields", () => {
    const rec = buildRolloutRecord({
      jobId: "job-abc12345",
      jobSpec: { task: "add a button" } as never,
      sessionId: "session-12345678",
      branchIndex: 0,
      buildResult: null,
    });
    expect(rec.provenance.source).toBe("bscode");
    expect(rec.provenance.schema_version).toBe("rollout-wire/v1");
    expect(rec.provenance.evidence_source).toBe("client_reported");
    expect(rec.provenance.redaction_version).toBe("bscode/pii-redact/v1");
  });
});

describe("validateRolloutRecord", () => {
  const basePass = () =>
    buildRolloutRecord({
      jobId: "job-abc12345",
      jobSpec: { task: "add a button" } as never,
      sessionId: "session-12345678",
      branchIndex: 0,
      buildResult: { status: "success", ranAtMs: Date.now() },
    });

  const baseFail = () =>
    buildRolloutRecord({
      jobId: "job-abc12345",
      jobSpec: { task: "add a button" } as never,
      sessionId: "session-12345678",
      branchIndex: 1,
      buildResult: { status: "failed", ranAtMs: Date.now() },
    });

  const baseUnknown = () =>
    buildRolloutRecord({
      jobId: "job-abc12345",
      jobSpec: { task: "add a button" } as never,
      sessionId: "session-12345678",
      branchIndex: 0,
      buildResult: null,
    });

  it("does not throw for a valid pass record", () => {
    expect(() => validateRolloutRecord(basePass())).not.toThrow();
  });

  it("does not throw for a valid fail record", () => {
    expect(() => validateRolloutRecord(baseFail())).not.toThrow();
  });

  it("does not throw for a valid unknown record", () => {
    expect(() => validateRolloutRecord(baseUnknown())).not.toThrow();
  });

  it("throws when objective_score is not 0 or 1", () => {
    const rec = { ...baseUnknown(), objective_score: 0.5 as never };
    expect(() => validateRolloutRecord(rec)).toThrow("[rollout-export] invalid record");
  });

  it("throws when objective_status=unknown but build_result is not null", () => {
    const rec = {
      ...baseFail(),
      objective_status: "unknown" as never,
    };
    expect(() => validateRolloutRecord(rec)).toThrow("[rollout-export] invalid record");
  });

  it("throws when schema_version is wrong", () => {
    const rec = { ...basePass(), schema_version: "rollout-wire/v0" as never };
    expect(() => validateRolloutRecord(rec)).toThrow("[rollout-export] invalid record");
  });

  it("throws when rollout_id is empty", () => {
    const rec = { ...basePass(), rollout_id: "" };
    expect(() => validateRolloutRecord(rec)).toThrow("[rollout-export] invalid record");
  });
});

describe("toJsonl", () => {
  it("produces one JSON object per line", () => {
    const rec = buildRolloutRecord({
      jobId: "job-abc12345",
      jobSpec: { task: "t" } as never,
      sessionId: "session-12345678",
      branchIndex: 0,
      buildResult: null,
    });
    const jsonl = toJsonl([rec]);
    const lines = jsonl.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.schema_version).toBe("rollout-wire/v1");
  });

  it("produces N lines for N records", () => {
    const recs = [0, 1, 2].map((i) =>
      buildRolloutRecord({
        jobId: `job-abc1234${i}`,
        jobSpec: { task: "t" } as never,
        sessionId: "session-12345678",
        branchIndex: i,
        buildResult: null,
      }),
    );
    const lines = toJsonl(recs).trim().split("\n");
    expect(lines).toHaveLength(3);
  });

  it("redacts email in final_answer before serialization", () => {
    const rec = buildRolloutRecord({
      jobId: "job-abc12345",
      jobSpec: { task: "t" } as never,
      sessionId: "session-12345678",
      branchIndex: 0,
      buildResult: null,
      finalAnswer: "Contact user@example.com for details",
    });
    const jsonl = toJsonl([rec]);
    expect(jsonl).not.toContain("user@example.com");
    expect(jsonl).toContain("[EMAIL]");
  });

  it("redacts email in task field", () => {
    const rec = buildRolloutRecord({
      jobId: "job-abc12345",
      jobSpec: { task: "send results to admin@example.com" } as never,
      sessionId: "session-12345678",
      branchIndex: 0,
      buildResult: null,
    });
    const jsonl = toJsonl([rec]);
    expect(jsonl).not.toContain("admin@example.com");
    expect(jsonl).toContain("[EMAIL]");
  });

  it("redacts email in build_result.stderr", () => {
    const rec = buildRolloutRecord({
      jobId: "job-abc12345",
      jobSpec: { task: "t" } as never,
      sessionId: "session-12345678",
      branchIndex: 0,
      buildResult: {
        status: "failed",
        ranAtMs: Date.now(),
        stderr: "Error: failed to contact dev@example.com",
      },
    });
    const jsonl = toJsonl([rec]);
    expect(jsonl).not.toContain("dev@example.com");
    expect(jsonl).toContain("[EMAIL]");
  });

  it("redacts email in tool_call_sequence data", () => {
    const rec = buildRolloutRecord({
      jobId: "job-abc12345",
      jobSpec: { task: "t" } as never,
      sessionId: "session-12345678",
      branchIndex: 0,
      buildResult: null,
      toolCallSequence: [
        { event: "tool_call", data: { args: { email: "user@example.com" } } },
      ],
    });
    const jsonl = toJsonl([rec]);
    expect(jsonl).not.toContain("user@example.com");
  });
});

describe("redactPii", () => {
  it("redacts email addresses", () => {
    expect(redactPii("send to user@example.com now")).toBe("send to [EMAIL] now");
  });

  it("redacts API keys with sk- prefix", () => {
    expect(redactPii("token: sk-abcdefghijklmnopqrstu")).toBe("token: [REDACTED_KEY]");
  });

  it("redacts JWT tokens", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const result = redactPii(`Bearer ${jwt}`);
    expect(result).toBe("Bearer [JWT]");
  });

  it("does not modify clean text", () => {
    const clean = "The agent completed the task successfully.";
    expect(redactPii(clean)).toBe(clean);
  });
});

describe("buildEvidenceManifest", () => {
  it("returns evidence-manifest/v1 schema version", async () => {
    const rec = buildRolloutRecord({
      jobId: "job-abc12345",
      jobSpec: { task: "t" } as never,
      sessionId: "session-12345678",
      branchIndex: 0,
      buildResult: null,
    });
    const manifest = await buildEvidenceManifest([rec], "session-12345678");
    expect(manifest.schema_version).toBe("evidence-manifest/v1");
    expect(manifest.n_records).toBe(1);
    expect(manifest.session_id).toBe("session-12345678");
    expect(manifest.evidence_source).toBe("client_reported");
    expect(manifest.redaction_version).toBe("bscode/pii-redact/v1");
  });

  it("content_hash is a 64-char hex string", async () => {
    const rec = buildRolloutRecord({
      jobId: "job-abc12345",
      jobSpec: { task: "t" } as never,
      sessionId: "session-12345678",
      branchIndex: 0,
      buildResult: null,
    });
    const manifest = await buildEvidenceManifest([rec], "session-12345678");
    expect(manifest.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("content_hash changes when record content changes", async () => {
    const rec1 = buildRolloutRecord({
      jobId: "job-abc12345",
      jobSpec: { task: "task one" } as never,
      sessionId: "session-12345678",
      branchIndex: 0,
      buildResult: null,
    });
    const rec2 = buildRolloutRecord({
      jobId: "job-abc12345",
      jobSpec: { task: "task two" } as never,
      sessionId: "session-12345678",
      branchIndex: 0,
      buildResult: null,
    });
    const m1 = await buildEvidenceManifest([rec1], "session-12345678");
    const m2 = await buildEvidenceManifest([rec2], "session-12345678");
    expect(m1.content_hash).not.toBe(m2.content_hash);
  });

  it("objective_score_summary counts pass/fail/unknown correctly", async () => {
    const pass = buildRolloutRecord({
      jobId: "job-pass",
      jobSpec: { task: "t" } as never,
      sessionId: "s",
      branchIndex: 0,
      buildResult: { status: "success", ranAtMs: Date.now() },
    });
    const fail = buildRolloutRecord({
      jobId: "job-fail",
      jobSpec: { task: "t" } as never,
      sessionId: "s",
      branchIndex: 1,
      buildResult: { status: "failed", ranAtMs: Date.now() },
    });
    const unknown = buildRolloutRecord({
      jobId: "job-unk",
      jobSpec: { task: "t" } as never,
      sessionId: "s",
      branchIndex: 2,
      buildResult: null,
    });
    const manifest = await buildEvidenceManifest([pass, fail, unknown], "s");
    expect(manifest.objective_score_summary.n_pass).toBe(1);
    expect(manifest.objective_score_summary.n_fail).toBe(1);
    expect(manifest.objective_score_summary.n_unknown).toBe(1);
  });
});

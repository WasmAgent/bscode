import { describe, expect, it } from "bun:test";
import { buildRolloutRecord, toJsonl } from "./trajectoryExport.js";

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
    expect(rec.total_score).toBe(0);
  });

  it("sets objective_score=0 when no build result", () => {
    const rec = buildRolloutRecord({
      jobId: "job-abc12345",
      jobSpec: { task: "x" } as never,
      sessionId: "session-12345678",
      branchIndex: 0,
      buildResult: null,
    });
    expect(rec.objective_score).toBe(0);
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
});

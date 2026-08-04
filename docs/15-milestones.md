# Milestones

## Milestone 1 — Core WASM Sandbox & Evidence Export Baseline

- [ ] Implement end-to-end sandbox execution pipeline in `src/sandbox/wasm_runner.ts` verified by `npm test -- --grep "wasm-sandbox"`
- [ ] Stabilize evidence collection schema in `src/evidence/export.ts` passing `npm run check:schema`
- [ ] Deploy reference workload to Cloudflare Workers via `wrangler deploy` with health endpoint returning 200 OK status
- [ ] Integrate bench-v0 task runner in `src/bench/v0_runner.ts` executing baseline test suite via `bscode-bench run --suite bench-v0`
- [ ] Add durable checkpoint persistence in `src/durable/checkpoint.ts` verified by passing tests in `tests/checkpoint.test.ts`

## Milestone 2 — Visual Verifier & Multi-Agent Fan-Out

- [ ] Implement visual verification engine in `src/verifier/visual.ts` capturing DOM diff snapshots during task runs
- [ ] Build multi-agent fan-out dispatcher in `src/agent/fanout.ts` enabling parallel worker execution
- [ ] Add trace exporter integration for trace-pipeline in `src/trace/exporter.ts` validated with `bscode-trace validate`
- [ ] Create Golden Path integration test harness in `tests/golden_path.test.ts` passing automated CI runs
- [ ] Add telemetry and rollout trace logging in `src/telemetry/logger.ts` verified by `npm test -- --grep "telemetry"`

## Milestone 3 — AEP Evidence Generation & Model Training Pipeline Linkage

- [ ] Implement AEP evidence packager in `src/aep/evidence_packager.ts` verified by `npm test -- --grep "aep-export"`
- [ ] Integrate automated bench-v0 evaluation reporter in `src/bench/reporter.ts` producing JSON reports via `bscode-bench report`
- [ ] Add durable state recovery mechanism for multi-agent workflows in `src/durable/recovery.ts` tested against worker preemption
- [ ] Establish automated artifact upload pipeline to trace-pipeline backend endpoint with retry logic in `src/trace/upload.ts`
- [ ] Implement CLI benchmark suite command `bscode run-eval --task-set bench-v0 --export-traces` returning zero exit code
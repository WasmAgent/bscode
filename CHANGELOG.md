# Changelog

All notable changes to bscode.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased] — 2026-06-25

### Added

- **AEP evidence bundle** (`apps/worker/src/trajectoryExport.ts`). `AEPEvidenceBundle` and
  `AEPCapabilityDecision` types added. `RolloutWireRecord` gains optional `aep_evidence?` field.
  New `buildAEPEvidence()` function builds a `aep/v0.1` evidence bundle from a completed rollout,
  classifying state-changing tool calls via `STATE_CHANGING_TOOLS` set. Consumed by trace-pipeline
  `validate-aep` command before training export. — MCP Firewall attack demo. Five attack scenarios
  (`prompt-injection`, `exfiltration`, `rug-pull`, `taint-passthrough`, `sampling-abuse`).
  `GET /mcp-demo` lists scenarios; `POST /mcp-demo/:id` returns a JSON comparison of
  unprotected vs protected invocation, using `@wasmagent/mcp-server`'s snapshot/rug-pull primitives.

- **bscode-bench** — 22 benchmark task manifests (`bench-task/v1` schema) in `fixtures/bench/tasks/`.
  Five categories: build repair, API correctness, security/policy, Cloudflare-specific,
  multi-step long-horizon. Each manifest specifies `user_query`, verifiers, and admission settings.

- **`docs/DATA-GOVERNANCE.md`** — User-facing data governance doc covering consent (two-level:
  operator + session user), collected vs never-collected data, redaction pipeline, retention policy
  (`EVIDENCE_RETENTION_DAYS`), deletion and export APIs, downstream evomerge pipeline.

- **CI**: Pinned `bun-version` to `1.3.14` (was `latest`) in both `ci` and `nightly-npm-install` jobs.
  Added `schedule` (02:00 UTC daily), `workflow_dispatch`, and `repository_dispatch` (type:
  `wasmagent-js-updated`) triggers so `nightly-npm-install` actually fires.

- **10 web test files**: Added `afterEach(cleanup)` from `@testing-library/react` to prevent
  DOM accumulation across tests (`DiffViewer`, `DifferentiatorBand`, `FileTree`, `FrameworkApiMap`,
  `IsolationDemoModal`, `JobsPanel`, `ModelManager`, `SettingsDrawer`, `Terminal`, `TurnBlock`).

### Fixed

- `docs/GOVERNANCE.md` — Corrected stale `WasmAgent/evomerge` reference to
  `telleroutlook/evomerge-framework`.

[Unreleased]: https://github.com/WasmAgent/bscode/compare/HEAD

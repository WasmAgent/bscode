# Multi-Agent Modes (B1 + B4 follow-up)

> bscode's `agentMode: "multi"` no longer means "Phase 1 + Phase 2
> serially." It now picks one of two parallel-friendly shapes:
>
>   - `parallel` (default) — fork-join draft → reviewer with full tools.
>   - `planFirst`           — planner → human approval → executor.
>
> The old serial layout has been removed entirely; there's no
> "compatibility mode." Zero technical debt was the target.

## parallel

```bash
curl -X POST http://localhost:8788/run \
  -H 'Content-Type: application/json' \
  -d '{
    "task": "Build a small React counter app",
    "agentMode": "multi",
    "multiAgentMode": "parallel",
    "multiAgentBranches": 3,
    "multiAgentConcurrency": 2,
    "modelId": "claude-sonnet-4-6"
  }'
```

Stage 1 forks the task into 3 independent draft branches via
`@wasmagent/core`'s `ParallelForkJoinRunner`; the synthesised draft is
threaded into Stage 2, where a `createToolAgent` reviews/refines with
the full tool set. The wall-clock cost is roughly
`max(branch_time) + review_time` instead of the old
`branch_time × N + review_time` serialisation.

Defaults: `branches=3`, `concurrency=2`, `aggregation="summary"`. All
overridable per call.

## planFirst

```bash
# Step 1 — submit a planFirst run. Save the checkpointId you pass in.
CP=demo-plan-$RANDOM
curl -N -X POST http://localhost:8788/run \
  -H 'Content-Type: application/json' \
  -d "{
    \"task\": \"Refactor src/utils.ts to drop lodash\",
    \"agentMode\": \"multi\",
    \"multiAgentMode\": \"planFirst\",
    \"useCheckpoint\": true,
    \"checkpointId\": \"$CP\"
  }"
```

The SSE stream emits:

```
event: status   data: { phase: "plan_ready", plan: "1. read_file ...", step: 1 }
event: await_human_input
data: { promptId: "approve-plan", prompt: "Approve this plan?\n\n1. ..." }
```

…and stops. The agent is paused; the snapshot is in
`BSCODE_CHECKPOINTS` (or in-memory in dev) under traceId
`planfirst-<checkpointId>-<ts>`.

```bash
# Step 2 — approve (or amend) the plan and resume.
curl -N -X POST http://localhost:8788/run \
  -H 'Content-Type: application/json' \
  -d "{
    \"task\": \"\",
    \"agentMode\": \"multi\",
    \"multiAgentMode\": \"planFirst\",
    \"checkpointId\": \"$CP\",
    \"humanResponse\": { \"promptId\": \"approve-plan\", \"response\": \"yes\" }
  }"
```

The resume path:
1. Loads the snapshot for `checkpointId`.
2. Strips the `Approve this plan?\n\n` preamble to recover the plan body.
3. Records the response under the snapshot's `humanResponse`.
4. Calls `runPlanFirstExecution()` — a `createToolAgent` that gets the
   original task + approved plan as a single executor brief, with the
   full tool set.

If the user passes anything other than `"yes"` (case-insensitive) as
the response, the executor's brief includes the response verbatim as
"User feedback on the plan:" so the agent can act on amendments.

## Why this shape

- **parallel** matches Codex cloud's "draft, then act" pattern. Three
  cheap drafts diverge on approach; the reviewer picks the best one
  and runs with it. Higher coverage of the solution space than a
  single-shot draft, lower wall-clock than full self-consistency.
- **planFirst** is the Amazon Kiro / "spec-driven" pattern. The
  expensive step (the actual edits) only fires after a human has
  signed off on the plan — important when the agent might touch ten
  files or run a destructive command.

Both modes compose with B4's `approvalPolicy`. planFirst gates the
plan; the policy gates each individual write tool inside the plan
execution. Defence in depth.

## Reference

- `apps/worker/src/agents/multi-agent.ts` — implementation
- `apps/worker/src/agents/multi-agent.test.ts` — 6 unit tests cover
  parallel emit pattern, planFirst await_human_input contract,
  custom promptId, and runPlanFirstExecution.
- `apps/worker/src/app.test.ts` "planFirst resume (B4)" — 2 route tests
  cover the resume happy path and the missing-snapshot error shape.
- @wasmagent/core: `ParallelForkJoinRunner`, `CheckpointableRun`,
  `applyHumanResponse` — primitives B1+B4 are built on.

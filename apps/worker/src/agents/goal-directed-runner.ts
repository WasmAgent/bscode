/**
 * goal-directed-runner — bscode product wiring around agentkit-js's
 * generic `GoalDirectedAgent`.
 *
 * The product side does three things only:
 *   1. Adapts bscode's `KvStore` (where the worker stores `file:<path>`
 *      entries) into the generic `WorkspaceReader` agentkit's verifiers
 *      expect.
 *   2. Snapshots the scout — tool list, top-level workspace files,
 *      memory hints — from the in-process state.
 *   3. Picks a synthesis + judge model. By default we reuse the executor
 *      model; operators can wire haiku for synth and a stronger judge.
 *
 * Everything else (criteria synthesis prompt, verifier protocol, judge
 * adversarial defaults) lives in agentkit-js core so other consumers
 * pick up the same behaviour without re-implementing it.
 */

import type { Model, ToolDefinition } from "@agentkit-js/core";
import { GoalDirectedAgent, type WorkspaceReader } from "@agentkit-js/core";
import type { KvStore } from "../types.js";

/** Build a WorkspaceReader against bscode's `file:<path>` KV layout. */
export function kvWorkspaceReader(kv: KvStore): WorkspaceReader {
  return {
    async fileExists(path) {
      const v = await kv.get(`file:${path}`);
      return v !== null;
    },
    async readFile(path) {
      const v = await kv.get(`file:${path}`);
      if (v === null) throw new Error(`ENOENT: ${path}`);
      return v;
    },
    async fileSize(path) {
      const v = await kv.get(`file:${path}`);
      if (v === null) throw new Error(`ENOENT: ${path}`);
      // Byte length under UTF-8. Encoding inside the kv adapter rather
      // than at every verifier call keeps `file_size_min` honest about
      // what's actually stored.
      return new TextEncoder().encode(v).length;
    },
  };
}

/**
 * Snapshot the top-level workspace entries from a bscode KV. Returns at
 * most `limit` paths (default 60) — enough to ground criteria synthesis,
 * not so many that the synth prompt gets bloated.
 */
export async function snapshotWorkspaceEntries(kv: KvStore, limit = 60): Promise<string[]> {
  const out: string[] = [];
  try {
    const result = await kv.list({ prefix: "file:" });
    for (const k of result.keys) {
      const path = k.name.startsWith("file:") ? k.name.slice("file:".length) : k.name;
      out.push(path);
      if (out.length >= limit) break;
    }
  } catch {
    // Listing failures are not fatal here — we degrade gracefully to an
    // empty workspace snapshot. Synthesis still runs (without grounding).
  }
  return out;
}

export interface GoalDirectedRunnerOpts {
  task: string;
  model: Model;
  /** Cheaper model for criteria synthesis. Defaults to `model`. */
  synthModel?: Model;
  /** Independent grader model. Defaults to `model`. */
  judgeModel?: Model;
  tools: ToolDefinition[];
  filesKv?: KvStore;
  /** Surface user/project memory hints (≤ a few hundred chars). */
  memoryHints?: string;
  maxIterations?: number;
  maxStepsPerIteration?: number;
  tokenBudget?: number;
  judgeSamples?: number;
  judgeRequireMajority?: boolean;
}

/**
 * Construct a configured `GoalDirectedAgent` from bscode-side runtime
 * state and return its event stream. Caller is responsible for routing
 * the stream into the SSE response handler the rest of `/run` already
 * uses.
 *
 * No filesKv? We still run — the verifier pipeline reports `does not
 * exist` on every file-bound criterion, which surfaces as an
 * actionable hint ("storage backend isn't bound") rather than a silent
 * pass. Better than crashing the run.
 */
export async function runGoalDirected(opts: GoalDirectedRunnerOpts) {
  const ws: WorkspaceReader = opts.filesKv
    ? kvWorkspaceReader(opts.filesKv)
    : {
        async fileExists() {
          return false;
        },
        async readFile(path) {
          throw new Error(`ENOENT: ${path} (no filesKv bound)`);
        },
        async fileSize(path) {
          throw new Error(`ENOENT: ${path} (no filesKv bound)`);
        },
      };

  const workspaceEntries = opts.filesKv ? await snapshotWorkspaceEntries(opts.filesKv) : [];

  const agent = new GoalDirectedAgent({
    model: opts.model,
    ...(opts.synthModel ? { synthModel: opts.synthModel } : {}),
    ...(opts.judgeModel ? { judgeModel: opts.judgeModel } : {}),
    tools: opts.tools,
    workspaceReader: ws,
    scout: {
      tools: opts.tools.map((t) => ({
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
      })),
      workspaceEntries,
      ...(opts.memoryHints ? { memoryHints: opts.memoryHints } : {}),
    },
    ...(opts.maxIterations ? { maxIterations: opts.maxIterations } : {}),
    ...(opts.maxStepsPerIteration ? { maxStepsPerIteration: opts.maxStepsPerIteration } : {}),
    ...(opts.tokenBudget ? { tokenBudget: opts.tokenBudget } : {}),
    ...(opts.judgeSamples ? { judgeSamples: opts.judgeSamples } : {}),
    ...(opts.judgeRequireMajority !== undefined
      ? { judgeRequireMajority: opts.judgeRequireMajority }
      : {}),
  });

  return agent.run(opts.task);
}

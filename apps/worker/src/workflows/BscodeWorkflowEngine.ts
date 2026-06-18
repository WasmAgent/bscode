/**
 * bscode workflows — declarative cross-job DAGs on top of wasmagent's
 * LocalWorkflowEngine.
 *
 * Why: bscode's existing JobQueue runs jobs in parallel up to a concurrency
 * cap, but jobs are independent fire-and-forget — there's no native way to
 * say "after job A finishes, run job B with A's output". This module bridges
 * that gap by mapping each job in a workflow to a registered tool, then
 * letting LocalWorkflowEngine handle dependency-driven scheduling, retries,
 * persistence, sleep, waitForEvent, and resume-after-crash.
 *
 * The four guarantees wasmagent's WorkflowEngine offers — observable,
 * terminable, resumable, clear errors — apply to bscode workflows too.
 */

import {
  KvWorkflowStateStore,
  LocalWorkflowEngine,
  MemoryKvBackend,
  type ToolDefinition,
  ToolRegistry,
  type WorkflowDefinition,
  type WorkflowRunHandle,
  type WorkflowStateStore,
} from "@wasmagent/core";
import { z } from "zod";

/** A bscode-flavoured "step" that wraps a job-like action into a workflow tool. */
export interface BscodeWorkflowStep {
  /** Step id (unique within the workflow). */
  id: string;
  /** Display label. */
  name?: string;
  /** Step ids that must complete before this one starts. */
  dependsOn?: string[];
  /** The action to run for this step. Receives resolved args (with $<refId> substituted). */
  run: (args: Record<string, unknown>, ctx: { stepId: string }) => Promise<unknown>;
  /** Args literal — supports `$<refId>` references to upstream step outputs. */
  args?: Record<string, unknown>;
  /** Resource pool claims; only meaningful when steps run in parallel. */
  resourceClaims?: { key: string; weight?: number }[];
  /** Retry policy. */
  retries?: { limit: number; delayMs?: number; backoff?: "constant" | "linear" | "exponential" };
  /** Per-attempt timeout in ms. */
  timeoutMs?: number;
  /** Whether the step is safe to retry. Default: true. */
  idempotent?: boolean;
}

export interface BscodeWorkflow {
  id: string;
  name?: string;
  steps: BscodeWorkflowStep[];
}

/**
 * Translate a BscodeWorkflow into a WorkflowDefinition + ToolRegistry pair
 * the wasmagent engine can consume directly.
 */
function buildEngineInputs(wf: BscodeWorkflow): {
  def: WorkflowDefinition;
  tools: ToolRegistry;
} {
  const tools = new ToolRegistry();
  for (const step of wf.steps) {
    const stepRef = step;
    tools.register({
      name: `bscode:${wf.id}:${step.id}`,
      description: step.name ?? step.id,
      inputSchema: z.record(z.unknown()),
      outputSchema: z.unknown(),
      readOnly: false,
      idempotent: step.idempotent ?? true,
      forward: async (args: Record<string, unknown>) => stepRef.run(args, { stepId: stepRef.id }),
    } as ToolDefinition);
  }
  const def: WorkflowDefinition = {
    id: wf.id,
    ...(wf.name ? { name: wf.name } : {}),
    steps: wf.steps.map((s) => ({
      id: s.id,
      toolName: `bscode:${wf.id}:${s.id}`,
      args: s.args ?? {},
      dependsOn: s.dependsOn ?? [],
      readOnly: false,
      idempotent: s.idempotent ?? true,
      ...(s.resourceClaims ? { resourceClaims: s.resourceClaims } : {}),
      ...(s.retries ? { retries: s.retries } : {}),
      ...(s.timeoutMs ? { timeoutMs: s.timeoutMs } : {}),
    })),
  };
  return { def, tools };
}

export interface BscodeWorkflowEngineOptions {
  /** Persistence layer. Defaults to in-memory; pass a KvWorkflowStateStore
   *  backed by a CF KV / DO / Redis backend for crash-resume. */
  store?: WorkflowStateStore;
}

/**
 * The engine bscode wires up to expose `/workflows` (or simply use it from
 * worker handlers / cron). Implements the four contracts identically to
 * wasmagent LocalWorkflowEngine — bscode does not invent new semantics.
 */
export class BscodeWorkflowEngine {
  readonly #store: WorkflowStateStore;
  /** Map workflow.id → engine instance (each engine binds to its tool registry). */
  readonly #engines = new Map<string, LocalWorkflowEngine>();
  /** Map workflow.id → definition built once at registration. */
  readonly #defs = new Map<string, WorkflowDefinition>();

  constructor(opts: BscodeWorkflowEngineOptions = {}) {
    this.#store = opts.store ?? new KvWorkflowStateStore(new MemoryKvBackend());
  }

  /** Register a workflow. Subsequent start() / resume() calls reference it by id. */
  register(wf: BscodeWorkflow): void {
    if (this.#engines.has(wf.id)) {
      throw new Error(`workflow already registered: ${wf.id}`);
    }
    const { def, tools } = buildEngineInputs(wf);
    this.#defs.set(wf.id, def);
    this.#engines.set(wf.id, new LocalWorkflowEngine({ tools, store: this.#store }));
  }

  /** Start a registered workflow. Returns a WorkflowRunHandle for observability. */
  async start(
    workflowId: string,
    opts: { runId?: string; params?: unknown } = {}
  ): Promise<WorkflowRunHandle> {
    const engine = this.#mustGetEngine(workflowId);
    const def = this.#mustGetDef(workflowId);
    return engine.start(def, opts);
  }

  /** Resume a previously-started run by id (works after process crashes). */
  async resume(workflowId: string, runId: string): Promise<WorkflowRunHandle> {
    const engine = this.#mustGetEngine(workflowId);
    return engine.resume(runId);
  }

  /** Push an external event to a run (unblocks $waitForEvent steps). */
  async sendEvent(
    workflowId: string,
    runId: string,
    type: string,
    payload: unknown
  ): Promise<void> {
    const engine = this.#mustGetEngine(workflowId);
    await engine.sendEvent(runId, type, payload);
  }

  #mustGetEngine(workflowId: string): LocalWorkflowEngine {
    const engine = this.#engines.get(workflowId);
    if (!engine) {
      throw new Error(`workflow not registered: ${workflowId}`);
    }
    return engine;
  }

  #mustGetDef(workflowId: string): WorkflowDefinition {
    const def = this.#defs.get(workflowId);
    if (!def) {
      throw new Error(`workflow not registered: ${workflowId}`);
    }
    return def;
  }
}

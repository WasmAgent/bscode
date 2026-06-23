import type { AgentEvent, Model, ModelMessage, ToolDefinition } from "@wasmagent/core";
import type { Scorer } from "@wasmagent/core/beta";
import {
  CheckpointableRun,
  createMemoryTool,
  EventLog,
  FallbackModel,
  forbiddenPhrases,
  formatSseFrame,
  InMemoryCheckpointer,
  KvCheckpointer,
  MapKvBackend,
  maxInputLength,
  ProgrammaticOrchestrator,
  ToolRegistry,
} from "@wasmagent/core";
import {
  BudgetForcingRunner,
  exactMatch,
  FileTreeManager,
  finalAnswerLength,
  makeKvAgentsMdLoader,
  type ParallelForkJoinRunner,
  ProjectInstructions,
  ReflectRefineRunner,
  runEval,
  SelfConsistencyRunner,
  toolCallAccuracy,
  trajectoryValidity,
} from "@wasmagent/core/beta";
import { InMemorySpanExporter, OtelBridge, withOtel } from "@wasmagent/core/experimental";
import type { Hono } from "hono";
import { createCodeAgent } from "../agents/code-agent.js";
import { type MultiAgentMode, multiAgentRun, runPlanFirstExecution } from "../agents/multi-agent.js";
import { createToolAgent } from "../agents/tool-agent.js";
import { getBuildResult } from "../build-results.js";
import { resolveModelFromRegistry } from "../models/registry.js";
import type { AppConfig, KvStore } from "../platform.js";
import { SessionKvStore } from "../platform.js";
import {
  ApprovalPolicy,
  type ApprovalPolicyOptions,
  applyApprovalPolicy,
  PolicyPresets,
} from "../policies/approvalPolicy.js";
import {
  createDeleteFileTool,
  createGitHubPrTool,
  createInitAgentsMdTool,
  createListFilesTool,
  createListFileVersionsTool,
  createPatchFileTool,
  createReadBuildResultTool,
  createReadFileTool,
  createRenameFileTool,
  createRevertFileTool,
  createRunCommandTool,
  createSearchCodeTool,
  createSemanticIndexer,
  createSemanticSearchTool,
  createVisualInteractTool,
  createVisualVerifyTool,
  createWriteFileTool,
  type SemanticIndexer,
} from "../tools/index.js";
import { createGitTools, createShellRunner } from "../tools/shell.js";
import { createWebSearchTool } from "../tools/web-search.js";

const SESSION_TTL = 3600;
const MAX_TASK_BYTES = 10_240;
const MAX_STEPS_CAP = 30;
const MAX_KV_EVENTS = 500;

// In-process shared state (resets on server restart)
const globalMemoryBackend = new MapKvBackend();

// ── RunBody ────────────────────────────────────────────────────────────────────

export interface RunBody {
  task: string;
  agentMode?: "code" | "tool" | "multi" | "ptc" | "goalDirected";
  modelId?: string;
  modelIds?: string[];
  maxSteps?: number;
  codeLanguage?: "js" | "python" | "node";
  enhancement?: string;
  planningInterval?: number;
  guardrails?: {
    maxInputChars?: number;
    forbiddenOutputPhrases?: string[];
    deniedTools?: string[];
  };
  useMemory?: boolean;
  useCheckpoint?: boolean;
  checkpointId?: string;
  projectContext?: boolean;
  useOtel?: boolean;
  /** Framework mode — activates framework-aware system prompt in ToolAgent */
  framework?: "react" | "vue" | "svelte" | "vanilla" | null;

  // ── B4 — Approval policy ────────────────────────────────────────────────────
  /**
   * Per-call approval policy for write tools. Accepts:
   *   - "permissive" / "balanced" / "strict" — preset name; OR
   *   - an ApprovalPolicyOptions literal — custom rules
   * Defaults to "permissive" (no rule overrides), preserving the legacy
   * behaviour where only `create_github_pr` was HITL-gated.
   */
  approvalPolicy?: "permissive" | "balanced" | "strict" | ApprovalPolicyOptions;

  // ── B1+B4 — Multi-agent shape ───────────────────────────────────────────
  /**
   * When agentMode === "multi", controls the runner shape:
   *   - "parallel"  (default) — fork-join draft → reviewer with full tools.
   *   - "planFirst" — planner → await_human_input → executor with full tools.
   * The planFirst flow PAUSES the run; the client resumes by re-POSTing
   * /run with humanResponse + the original checkpointId.
   */
  multiAgentMode?: MultiAgentMode;
  /** Number of fork-join branches in parallel mode (default 3). */
  multiAgentBranches?: number;
  /** Concurrency cap for the fork-join (default 2). */
  multiAgentConcurrency?: number;

  // ── B4 — humanResponse resume payload (planFirst) ───────────────────────
  /**
   * Approval / amendment text from the user, posted on the SECOND /run
   * call when resuming a planFirst run. Must be paired with the original
   * checkpointId so the worker can locate the snapshot and apply the
   * response before kicking off the executor stage.
   */
  humanResponse?: { promptId: string; response: string };

  // ── Enhancement policy (replaces flat "enhancement" string for new features) ──
  /** Inline enhancement policy — configures runners with custom parameters */
  enhancementPolicy?: import("@wasmagent/core").EnhancementPolicy;

  // ── Stop conditions (new) ────────────────────────────────────────────────────
  /** Stop condition descriptors: "noProgress", "stepCount:<n>", "costBudget:<maxUSD>" */
  stopConditions?: string[];

  // ── Prompt-cache tuning (new) ────────────────────────────────────────────────
  /** Seal a B2 cache breakpoint every N action steps (default: 5) */
  chunkSizeSteps?: number;
  /** Cache TTL for the system prompt prefix (default: "1h") */
  systemPrefixTtl?: "5m" | "1h";

  // ── Scheduler override (new) ─────────────────────────────────────────────────
  scheduler?: "dag" | "parallel";

  // ── Conversation context (new) ───────────────────────────────────────────────
  /** Previous turns to inject as context — enables multi-turn conversation */
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;

  // ── Resource budget (new) ────────────────────────────────────────────────────
  /** Maximum total tokens (input+output) before agent stops automatically */
  maxBudgetTokens?: number;
  /** Maximum wall-clock milliseconds before agent stops */
  maxDurationMs?: number;

  // ── Auto-compact (new) ────────────────────────────────────────────────────────
  /** Auto-compact history when context exceeds this many tokens (default: off) */
  autoCompactThreshold?: number;

  // ── Structured output schema (v0/Lovable pattern) ─────────────────────────────
  /**
   * Zod schema descriptor for structured output validation.
   * When set, ToolCallingAgent validates final_answer against this schema and
   * retries up to outputSchemaRetries times on mismatch.
   * Pass as a JSON Schema object: {"type":"object","properties":{"name":{"type":"string"}}}
   */
  outputJsonSchema?: Record<string, unknown>;
  outputSchemaRetries?: number;

  // ── C1 — SSE Last-Event-ID resume ─────────────────────────────────────────
  /**
   * Trace id from a previous /run response (header `X-Agentkit-Trace-Id`).
   * When set together with the `Last-Event-ID` request header, the worker
   * skips starting a new agent and instead replays the persisted EventLog
   * for that trace, delivering only entries with id > Last-Event-ID. This
   * lets a client survive a worker recycle, a network blip, or a tab
   * reload mid-run without losing events or duplicating them.
   *
   * Requires `checkpointsKv` to be bound — otherwise the worker has no
   * place to read the persisted log from and falls back to a fresh run.
   */
  resumeTraceId?: string;

  // ── 2026-06-18 — Goal-directed loop (agentMode: "goalDirected") ─────────
  /**
   * Cap on goal-loop iterations when `agentMode === "goalDirected"`. Each
   * iteration runs one full ToolCallingAgent then re-evaluates the
   * synthesised criteria. Defaults to 5 (set by `GoalDirectedAgent`
   * itself). Total work ≤ maxIterations × maxSteps.
   */
  maxIterations?: number;
}

// ── Deps ───────────────────────────────────────────────────────────────────────

export interface RunRoutesDeps {
  sessionIdOf(
    c: { req: { header: (n: string) => string | undefined } },
    config?: AppConfig
  ): string;
  resolveFilesKv(sessionId: string | undefined, config: AppConfig): KvStore | undefined;
  sessionFileTrees: Map<string, FileTreeManager>;
  indexerFor(c: { req: { header: (n: string) => string | undefined } }): SemanticIndexer;
  recordError(message: string, stack?: string, traceId?: string): void;
  fileTreeFor(
    c: { req: { header: (n: string) => string | undefined } },
    config: AppConfig
  ): FileTreeManager;
  checkpointerFor(config: AppConfig): InMemoryCheckpointer | KvCheckpointer;
  adaptKvStoreToBackend(store: KvStore): {
    get: (key: string) => Promise<string | null>;
    put: (key: string, value: string) => Promise<void>;
    delete: (key: string) => Promise<void>;
    list: (prefix: string) => Promise<string[]>;
  };
}

// ── Mount ──────────────────────────────────────────────────────────────────────

export function mountRunRoutes(app: Hono, config: AppConfig, deps: RunRoutesDeps): void {
  const {
    sessionIdOf,
    resolveFilesKv,
    sessionFileTrees,
    indexerFor,
    recordError,
    fileTreeFor,
    checkpointerFor,
    adaptKvStoreToBackend,
  } = deps;

  // ── POST /run ─────────────────────────────────────────────────────────────
  app.post("/run", async (c) => {
    // Parse and validate synchronously-readable fields first.
    let body: RunBody;
    try {
      body = await c.req.json<RunBody>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const { task } = body;
    if (!task || typeof task !== "string") return c.json({ error: "task is required" }, 400);
    if (new TextEncoder().encode(task).byteLength > MAX_TASK_BYTES)
      return c.json({ error: `task must be under ${MAX_TASK_BYTES} bytes` }, 400);

    if (
      !config.anthropicApiKey &&
      !config.anthropicAuthToken &&
      !config.doubaoApiKey &&
      !config.deepseekApiKey
    )
      return c.json({ error: "No API key configured" }, 500);

    const sessionId = c.req.header("X-Session-Id");
    const {
      agentMode = "code",
      modelId,
      modelIds,
      maxSteps = 10,
      codeLanguage = "js",
      enhancement,
      planningInterval,
      guardrails,
      useMemory = false,
      useCheckpoint = false,
      checkpointId,
      projectContext = false,
      useOtel = false,
    } = body;

    // ── C1 — SSE resume fast-path ─────────────────────────────────────────
    // When the client supplies a `resumeTraceId` (last response's
    // X-Agentkit-Trace-Id) AND a `Last-Event-ID` header AND we have a
    // persistence backend, we *only* replay the missing tail. We never
    // start a second agent for the same trace — that would burn tokens
    // and produce duplicate side-effects (file writes, PR pushes, …).
    //
    // If `checkpointsKv` is unbound the resume signal is silently
    // ignored and the request falls through to a fresh run; the client
    // already learned its previous events, so the cost is at most one
    // duplicate run, never event loss.
    const resumeTraceId = body.resumeTraceId;
    const lastEventIdHeader = c.req.header("Last-Event-ID");
    if (resumeTraceId && config.checkpointsKv) {
      return streamResumeReplay(
        adaptKvStoreToBackend(config.checkpointsKv),
        resumeTraceId,
        lastEventIdHeader ?? null,
        config,
        c.req.header("Origin")
      );
    }

    // ── Input validation ─────────────────────────────────────────────────────
    // Validate `agentMode` and `modelId` upfront so callers get a synchronous
    // 400 instead of a streaming-then-failing SSE. The model gateway returns
    // INVALID_MODEL several seconds in, which paints "Done" briefly in the UI
    // before the error event arrives — ugly. Catch unknown values here.
    //
    // Valid agentModes are the four documented in the RunBody type at the
    // bottom of this file. "framework" is NOT a separate mode here — the
    // framework field on the body is what selects scaffolding inside "tool".
    const VALID_MODES = new Set(["code", "tool", "multi", "ptc", "goalDirected"]);
    if (agentMode && !VALID_MODES.has(agentMode)) {
      return c.json({ error: `agentMode must be one of: ${[...VALID_MODES].join(", ")}` }, 400);
    }
    if (
      modelId !== undefined &&
      (typeof modelId !== "string" || modelId.length === 0 || modelId.length > 200)
    ) {
      return c.json({ error: "modelId must be a non-empty string under 200 chars" }, 400);
    }

    const clampedSteps = Math.min(maxSteps, MAX_STEPS_CAP);

    // ── Session cache pre-check (fast path, avoids spawning agent) ──────────
    // Only attempt when sessionsKv is available — resolve modelId for hash.
    const sessionsKv = sessionId
      ? config.sessionsKv
        ? new SessionKvStore(config.sessionsKv, sessionId)
        : config.sessionsKv
      : config.sessionsKv;

    if (sessionsKv) {
      // Resolve model just enough to compute the cache key (no expensive init).
      const store = getModelStore(config);
      const primaryModelForHash = await resolveModelFromRegistry(modelId, config, store);
      const resolvedModelId = primaryModelForHash
        ? getModelId(primaryModelForHash)
        : (modelId ?? "unknown");
      const kvKey = await contentHash({
        task,
        agentMode,
        maxSteps: clampedSteps,
        modelId: resolvedModelId,
        enhancement,
        ...((body as unknown as Record<string, unknown>)._testRunId
          ? { _r: (body as unknown as Record<string, unknown>)._testRunId }
          : {}),
      });
      const cached = await sessionsKv.get(kvKey);
      if (cached) return streamCachedEvents(cached);
    }

    // ── Live run: return SSE Response immediately, pump agent async ──────────
    // This avoids the Bun bug where awaiting inside a Hono handler before
    // returning a streaming Response causes Chrome fetch to get ERR_FAILED.
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // C1 — Per-run trace id surfaces in the response header so the client
    // can echo it back as `resumeTraceId` if the connection drops. It is
    // also used as the EventLog key when checkpointsKv is bound.
    const runTraceId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const eventLog = config.checkpointsKv
      ? new EventLog(adaptKvStoreToBackend(config.checkpointsKv))
      : null;

    (async () => {
      // Flush headers + first byte immediately so Chrome doesn't time out.
      await writer.write(encoder.encode(": connected\n\n"));

      try {
        const store = getModelStore(config);
        const primaryModel = await resolveModelFromRegistry(modelId, config, store);
        if (!primaryModel) {
          await writer.write(
            encoder.encode(
              `data: ${JSON.stringify({ event: "error", data: { error: "Model not available — check API keys or add via /models/custom" } })}\n\n`
            )
          );
          await writer.write(encoder.encode("data: [DONE]\n\n"));
          await writer.close();
          return;
        }

        let model: Model = primaryModel;
        if (modelIds && modelIds.length > 1) {
          const additionalModels: Model[] = [];
          for (const mid of modelIds) {
            if (mid === modelId) continue;
            const m = await resolveModelFromRegistry(mid, config, store);
            if (m) additionalModels.push(m);
          }
          if (additionalModels.length > 0) {
            model = new FallbackModel([primaryModel, ...additionalModels]);
          }
        }

        const filesKv = resolveFilesKv(sessionId, config);

        let finalTask = task;
        if (projectContext) {
          // Use the per-session FileTreeManager (richer than KV listing — has hashes for conflict detection).
          const sessionTree = sessionFileTrees.get(sessionId ?? "default");
          const fileTree =
            sessionTree && sessionTree.size > 0
              ? sessionTree.formatForPrompt(60)
              : await buildProjectFileTree(filesKv);
          const ctxParts: string[] = ["## Project Files\n" + fileTree];

          // Relevance filtering: include content of files that match task keywords
          // (avoids sending the full workspace to the model for large projects)
          if (filesKv) {
            const relevantFiles = await getRelevantFileContents(filesKv, task, 5, sessionId, sessionFileTrees);
            if (relevantFiles.length > 0) {
              ctxParts.push(
                "## Relevant File Contents\n" +
                  relevantFiles
                    .map((f) => `### ${f.path}\n\`\`\`\n${f.content.slice(0, 800)}\n\`\`\``)
                    .join("\n\n")
              );
            }
          }

          const shell = createShellRunner(config);
          if (shell) {
            const [status, readme, pkg] = await Promise.all([
              shell(["git", "status", "--short"]).catch(() => "(not a git repo)"),
              filesKv?.get("file:README.md") ?? Promise.resolve(null),
              filesKv?.get("file:package.json") ?? Promise.resolve(null),
            ]);
            ctxParts.push(`Git status:\n${status}`);
            if (readme) ctxParts.push(`README:\n${readme.slice(0, 1000)}`);
            if (pkg) ctxParts.push(`package.json:\n${pkg.slice(0, 500)}`);
          }
          finalTask = `${ctxParts.join("\n\n")}\n\n---\n\n${task}`;
        }

        const tools = buildTools(
          filesKv,
          useMemory,
          config,
          [
            ...(guardrails?.deniedTools ?? []),
            // Framework mode: block run_command and git tools — WebContainers handles execution
            ...(body.framework
              ? ["run_command", "git_status", "git_diff", "git_log", "git_commit", "git_checkout"]
              : []),
          ],
          fileTreeFor(c, config),
          indexerFor(c),
          sessionId,
          Boolean(body.framework)
        );
        // B4 — wrap write tools with the configured approval policy.
        const approvalPolicy = resolveApprovalPolicy(body.approvalPolicy);
        const policedTools = approvalPolicy ? applyApprovalPolicy(approvalPolicy, tools) : tools;
        const inputGuardrails = buildInputGuardrails(guardrails);
        const outputGuardrails = buildOutputGuardrails(guardrails);
        // Merge resource budget from request into enhancementPolicy
        const mergedPolicy = {
          ...body.enhancementPolicy,
          ...(body.maxBudgetTokens || body.maxDurationMs
            ? {
                budget: {
                  ...body.enhancementPolicy?.budget,
                  ...(body.maxBudgetTokens ? { maxTokens: body.maxBudgetTokens } : {}),
                  ...(body.maxDurationMs ? { maxDurationMs: body.maxDurationMs } : {}),
                },
              }
            : {}),
        };

        const agentExtras = {
          maxSteps: clampedSteps,
          planningInterval,
          inputGuardrails,
          outputGuardrails,
          framework: body.framework,
          // Enhancement policy with merged resource budget
          enhancementPolicy: Object.keys(mergedPolicy).length > 0 ? mergedPolicy : undefined,
          stopConditions: body.stopConditions,
          chunkSizeSteps: body.chunkSizeSteps,
          systemPrefixTtl: body.systemPrefixTtl,
          scheduler: body.scheduler,
          outputSchemaRetries: body.outputSchemaRetries,
          // C4 — load AGENTS.md (and any nested files) from the workspace and
          // append to the system prompt. We use the wasmagent KV loader on
          // a thin adapter over the per-session files KV; the resolver caches
          // the catalogue, so the cost is one list per /run.
          projectInstructions: filesKv ? await loadProjectInstructions(filesKv, adaptKvStoreToBackend) : "",
          // B4 — always wire a checkpointer so write-class tools whose
          // `needsApproval` evaluates true actually pause for HITL. Without
          // this, agentkit-core silently skips the gate (see the
          // `if (this.#checkpointer)` guard in core/ToolCallingAgent.ts).
          // checkpointerFor(config) is cached per-config and falls back to
          // InMemoryCheckpointer when no KV is bound — strict-policy gating
          // works in any deployment shape.
          checkpointer: checkpointerFor(config),
        };

        let agentRun: AsyncGenerator<AgentEvent>;

        // ── Enhancement runner selection ──────────────────────────────────────
        // Support both legacy flat "enhancement" string and new enhancementPolicy object.
        // enhancementPolicy takes precedence when both are provided.
        const policy = body.enhancementPolicy;
        const useParallelFork = policy?.parallelForkJoin?.enabled;
        const useSelfConsistency =
          policy?.selfConsistency?.enabled ?? enhancement === "self-consistency";
        const useReflectRefine = policy?.reflectRefine?.enabled ?? enhancement === "reflect-refine";
        const useBudgetForcing = policy?.budgetForcing?.enabled ?? enhancement === "budget-forcing";

        if (useSelfConsistency) {
          const n = policy?.selfConsistency?.n ?? 3;
          const threshold = policy?.selfConsistency?.earlyStopThreshold ?? 0.67;
          agentRun = enhancedAgentRun(
            model,
            new SelfConsistencyRunner({ n, earlyStopThreshold: threshold }),
            finalTask
          );
        } else if (useReflectRefine) {
          const maxCycles = policy?.reflectRefine?.maxCycles ?? 2;
          agentRun = enhancedAgentRun(model, new ReflectRefineRunner({ maxCycles }), finalTask);
        } else if (useBudgetForcing) {
          agentRun = enhancedAgentRun(
            model,
            new BudgetForcingRunner({ maxWaitRounds: 2 }),
            finalTask
          );
        } else if (useParallelFork) {
          const { ParallelForkJoinRunner } = await import("@wasmagent/core/beta");
          const branches = policy?.parallelForkJoin?.branches ?? 3;
          const concurrency = policy?.parallelForkJoin?.concurrency ?? 2;
          const aggregation = policy?.parallelForkJoin?.aggregation ?? "summary";
          agentRun = enhancedAgentRun(
            model,
            new ParallelForkJoinRunner({ branches, concurrency, aggregation }),
            finalTask
          );
        } else if (agentMode === "multi") {
          // B4 resume path — when the client posts a humanResponse + checkpointId
          // we treat this as the second half of a planFirst flow: restore the
          // snapshot, extract the plan from the persisted prompt, run the
          // executor stage with full tools.
          if (body.humanResponse && body.checkpointId) {
            const cpId = body.checkpointId;
            const cp = checkpointerFor(config);
            const snapshot = await cp.load(cpId);
            if (!snapshot) {
              throw new Error(`planFirst resume: no snapshot for checkpointId=${cpId}`);
            }
            if (!snapshot.pendingHumanInput) {
              throw new Error(`planFirst resume: snapshot has no pending human input`);
            }
            // Persist the response so future audits can see what the user said.
            await cp.respond(cpId, body.humanResponse.promptId, body.humanResponse.response);
            // The prompt body is `Approve this plan?\n\n<planText>` — strip the prefix.
            const promptText = snapshot.pendingHumanInput.prompt;
            const planText = promptText.replace(/^Approve this plan\?\s*\n+/i, "").trim();
            agentRun = runPlanFirstExecution(
              model,
              policedTools,
              snapshot.task,
              planText,
              body.humanResponse.response,
              { maxSteps: agentExtras.maxSteps, checkpointer: agentExtras.checkpointer }
            );
          } else {
            const multiAgentExtras: Parameters<typeof multiAgentRun>[3] = {
              maxSteps: agentExtras.maxSteps,
              // B4 — pass the checkpointer through so any inner createToolAgent
              // (reviewer / executor) gates write tools whose needsApproval fires.
              checkpointer: agentExtras.checkpointer,
              ...(body.multiAgentMode ? { mode: body.multiAgentMode } : {}),
              ...(body.multiAgentBranches !== undefined
                ? { branches: body.multiAgentBranches }
                : {}),
              ...(body.multiAgentConcurrency !== undefined
                ? { concurrency: body.multiAgentConcurrency }
                : {}),
            };
            const baseRun = multiAgentRun(model, policedTools, finalTask, multiAgentExtras);
            // planFirst suspends mid-stream via await_human_input — wrap with
            // CheckpointableRun so the snapshot lands in KV before the
            // generator returns. parallel mode skips this overhead.
            if (body.multiAgentMode === "planFirst") {
              const cpId = body.checkpointId ?? finalTask.slice(0, 40);
              const cpTraceId = `planfirst-${cpId}-${Date.now()}`;
              // multiAgentRun does not own a MessageAssembler — pass a fresh
              // one whose .steps[] just records the plan event. CheckpointableRun
              // only reads `assembler.steps` on snapshot persistence.
              const { MessageAssembler } = await import("@wasmagent/core");
              const planAssembler = new MessageAssembler({ systemPrompt: "", toolsSchema: [] });
              planAssembler.addStep({ type: "user_message", content: finalTask });
              const cpRun = new CheckpointableRun(
                { checkpointer: checkpointerFor(config) },
                planAssembler
              );
              agentRun = cpRun.run(baseRun, finalTask, cpTraceId);
            } else {
              agentRun = baseRun;
            }
          }
        } else if (agentMode === "ptc") {
          agentRun = ptcAgentRun(model, policedTools, finalTask, codeLanguage, config);
        } else if (agentMode === "goalDirected") {
          // 2026-06-18 — opt-in loop where the agent synthesises its own
          // success criteria, verifies them mechanically (and with an
          // adversarial-defaulted LLM judge as last resort), retries with
          // the verifier's hint. Fixes the "outline-itis" pattern where
          // a one-shot tool-call returns 700 bytes when the user wanted a
          // 1500-word write-up. See [[bscode-md-as-card-2026-06-18]] for
          // the originating UX bug and `wasmagent/docs/guides/goal-directed.md`
          // for the architecture.
          //
          // Synth + judge models default to the executor model. A future
          // enhancement is to wire haiku-for-synth + sonnet-for-judge from
          // the model registry without touching this dispatch code.
          const { runGoalDirected } = await import("../agents/goal-directed-runner.js");
          agentRun = await runGoalDirected({
            task: finalTask,
            model,
            tools: policedTools,
            ...(config.filesKv ? { filesKv: config.filesKv } : {}),
            ...(agentExtras.maxSteps !== undefined
              ? { maxStepsPerIteration: agentExtras.maxSteps }
              : {}),
            ...(body.maxIterations !== undefined ? { maxIterations: body.maxIterations } : {}),
          });
        } else {
          const agent =
            agentMode === "tool"
              ? createToolAgent(model, policedTools, agentExtras)
              : createCodeAgent(model, policedTools, {
                  ...agentExtras,
                  codeLanguage,
                  e2bApiKey: config.e2bApiKey,
                });

          // Inject conversation history as prior user_message + assistant steps
          // so the agent has multi-turn context within its MessageAssembler.
          if (body.conversationHistory?.length) {
            for (const turn of body.conversationHistory) {
              agent.assembler.addStep({ type: "user_message", content: turn.content });
            }
          }

          // Auto-compact: if history is long, summarise it before the new task.
          // Triggered when autoCompactThreshold is set and the assembled messages
          // would exceed that token count (estimated). Keeps latency low by
          // compressing the earliest chunks into a summary.
          if (body.autoCompactThreshold && body.autoCompactThreshold > 0) {
            const msgs = agent.assembler.build();
            const { estimateMessagesTokens } = await import("@wasmagent/core");
            const estimatedTokens = estimateMessagesTokens(msgs);
            if (estimatedTokens > body.autoCompactThreshold) {
              await agent.assembler.compact(model);
              console.log(`[auto-compact] compressed history from ~${estimatedTokens} tokens`);
            }
          }

          if (useCheckpoint) {
            const cpId = checkpointId ?? finalTask.slice(0, 40);
            const cpTraceId = `cp-${cpId}-${Date.now()}`;
            const cpRun = new CheckpointableRun(
              { checkpointer: checkpointerFor(config) },
              agent.assembler
            );
            agentRun = cpRun.run(agent.run(finalTask, cpTraceId), finalTask, cpTraceId);
          } else {
            agentRun = agent.run(finalTask);
          }
        }

        if (useOtel) {
          const bridge = new OtelBridge({ exporter: new InMemorySpanExporter() });
          agentRun = withOtel(agentRun, bridge);
        }

        // Compute cache key for write-back (same inputs as pre-check above)
        const resolvedModelId = getModelId(model);
        const kvKey = sessionsKv
          ? await contentHash({
              task: finalTask,
              agentMode,
              maxSteps: clampedSteps,
              modelId: resolvedModelId,
              enhancement,
              ...((body as unknown as Record<string, unknown>)._testRunId
                ? { _r: (body as unknown as Record<string, unknown>)._testRunId }
                : {}),
            })
          : null;

        // Stream live events. When `eventLog` is bound, we tap the agent
        // generator so every event is persisted under `evlog:<runTraceId>:`
        // before it leaves the writer; SSE frames carry the matching `id:`
        // line via formatSseFrame() so a reconnecting client can resume
        // exactly past the last id it saw.
        const allEvents: AgentEvent[] = [];
        let success = false;
        if (eventLog) {
          for await (const logged of eventLog.tap(agentRun, runTraceId)) {
            await writer.write(encoder.encode(formatSseFrame(logged)));
            const event = logged.event;
            if (
              kvKey &&
              sessionsKv &&
              (event.event === "final_answer" || allEvents.length < MAX_KV_EVENTS)
            )
              allEvents.push(event);
            if (event.event === "final_answer") success = true;
          }
        } else {
          // No checkpointsKv bound — keep the original best-effort path.
          // Clients still get every event live; only resume is unavailable.
          for await (const event of agentRun) {
            await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            if (
              kvKey &&
              sessionsKv &&
              (event.event === "final_answer" || allEvents.length < MAX_KV_EVENTS)
            )
              allEvents.push(event);
            if (event.event === "final_answer") success = true;
          }
        }
        await writer.write(encoder.encode("data: [DONE]\n\n"));
        if (kvKey && sessionsKv && success)
          await sessionsKv
            .put(kvKey, JSON.stringify(allEvents), { expirationTtl: SESSION_TTL })
            .catch(console.error);

        // Successful completion → purge the persisted EventLog. Resume only
        // makes sense for in-flight runs; a finished run has nothing left
        // to deliver, and leaving the entries around grows KV unboundedly.
        if (eventLog && success) {
          eventLog.purge(runTraceId).catch(() => {
            /* best-effort cleanup */
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const stack =
          err instanceof Error && err.stack
            ? err.stack.split("\n").slice(0, 4).join("\n")
            : undefined;
        recordError(msg, stack);
        // The error frame is a terminal event — clients stop after seeing
        // it, so it does not need an EventLog id to enable resume. Write
        // the bare data frame and let the resumed client (if any) replay
        // up to whatever was persisted before the throw.
        await writer.write(
          encoder.encode(
            `data: ${JSON.stringify({ event: "error", data: { error: msg, ...(stack ? { stack } : {}) } })}\n\n`
          )
        );
      } finally {
        await writer.close().catch(() => {});
      }
    })();

    const allowOrigin =
      (config.allowedOrigin ?? "*") === "*"
        ? "*"
        : (c.req.header("Origin") ?? "") === config.allowedOrigin
          ? (config.allowedOrigin ?? "null")
          : "null";

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": allowOrigin,
        "Access-Control-Allow-Private-Network": "true",
        // C1 — surface the trace id so the client can echo it back as
        // `resumeTraceId` on reconnect. Must be in expose-headers so a
        // CORS request can read it from JS.
        "X-Agentkit-Trace-Id": runTraceId,
        "Access-Control-Expose-Headers": "X-Agentkit-Trace-Id",
      },
    });
  });

  // ── POST /eval ────────────────────────────────────────────────────────────
  app.post("/eval", async (c) => {
    const {
      samples,
      scorerNames = ["exactMatch"],
      modelId,
      agentMode = "tool",
      maxSteps = 5,
    } = await c.req.json();
    if (!Array.isArray(samples) || samples.length === 0)
      return c.json({ error: "samples array required" }, 400);

    const model = await resolveModelFromRegistry(modelId, config, getModelStore(config));
    if (!model) return c.json({ error: "Model not available" }, 400);

    const tools = buildTools(config.filesKv, false, config);
    const agent =
      agentMode === "code"
        ? createCodeAgent(model, tools, { maxSteps })
        : createToolAgent(model, tools, { maxSteps });

    const scorerMap: Record<string, Scorer> = {
      exactMatch: exactMatch,
      toolCallAccuracy: toolCallAccuracy,
      trajectoryValidity: trajectoryValidity,
      finalAnswerLength: finalAnswerLength(200),
    };
    const scorers = (scorerNames as string[]).map((n) => scorerMap[n]).filter(Boolean);

    const results = await runEval(samples, (task: string) => agent.run(task), scorers);
    return c.json(results);
  });
}

// ── Helpers (only used by /run and /eval) ────────────────────────────────────

function getModelStore(config: AppConfig): import("../platform.js").KvStore {
  return (
    config.sessionsKv ??
    config.filesKv ?? {
      get: async () => null,
      put: async () => {},
      list: async () => ({ keys: [] }),
    }
  );
}

function getModelId(model: Model): string {
  return (model as { modelId?: string }).modelId ?? "unknown";
}

/**
 * C4 — Load AGENTS.md project instructions from the (per-session) files KV.
 * Returns the empty string when no AGENTS.md exists anywhere in the workspace —
 * stable shape for the system prompt so prompt-cache keys don't drift between
 * "has instructions" and "doesn't" runs.
 */
async function loadProjectInstructions(
  filesKv: KvStore,
  adaptKvStoreToBackend: RunRoutesDeps["adaptKvStoreToBackend"]
): Promise<string> {
  const loader = makeKvAgentsMdLoader(adaptKvStoreToBackend(filesKv));
  const project = new ProjectInstructions({ loader });
  // For now we always resolve at the repo root. A future refinement could
  // pass the path of the file the agent is about to edit (when known) so
  // nested AGENTS.md files take precedence — this requires plumbing the
  // current edit target through /run, which is bigger than C4 needs.
  const out = await project.forRepo();
  return out.text;
}

/** Build a tree-style string of all files in the KV store for project context. */
async function buildProjectFileTree(kv: KvStore | undefined): Promise<string> {
  if (!kv) return "(no files in workspace)";
  const list = await kv.list({ prefix: "file:" });
  const paths = list.keys.map((k) => k.name.replace(/^file:/, "")).sort();
  if (paths.length === 0) return "(workspace is empty)";

  // Build directory tree
  const tree: Record<string, string[]> = {};
  for (const p of paths) {
    const parts = p.split("/");
    if (parts.length === 1) {
      if (!tree[""]) tree[""] = [];
      tree[""].push(p);
    } else {
      const dir = parts.slice(0, -1).join("/");
      if (!tree[dir]) tree[dir] = [];
      tree[dir].push(parts[parts.length - 1]);
    }
  }

  const lines: string[] = [];
  // Root files first
  for (const f of tree[""] ?? []) lines.push(`  ${f}`);
  // Directories
  for (const [dir, files] of Object.entries(tree)) {
    if (!dir) continue;
    lines.push(`  ${dir}/`);
    for (const f of files) lines.push(`    ${f}`);
  }

  return `${paths.length} file(s):
${lines.join("\n")}`;
}

function buildTools(
  filesKv: KvStore | undefined,
  useMemory: boolean,
  config: AppConfig,
  deniedTools?: string[],
  fileTree?: FileTreeManager,
  indexer?: SemanticIndexer,
  // B2 — session id for the build-result reverse channel. Optional so
  // out-of-band paths (eg /eval) can keep calling buildTools unchanged.
  sessionId?: string,
  isFramework?: boolean
): ToolDefinition[] {
  const shellRunner = createShellRunner(config);
  const tools: ToolDefinition[] = [
    createReadFileTool(filesKv),
    createListFilesTool(filesKv),
    createSearchCodeTool(filesKv),
    createWriteFileTool(filesKv, fileTree, indexer),
    createPatchFileTool(filesKv, indexer),
    createDeleteFileTool(filesKv, indexer),
    createRenameFileTool(filesKv, indexer),
    createRunCommandTool(shellRunner),
    createWebSearchTool(),
    // C4 — init_agents_md drafts a project AGENTS.md; needsApproval=true
    // forces it through the planFirst HITL gate so it does not silently
    // land on disk (research showed LLM-authored AGENTS.md degrades 5/8
    // benchmarks when written without review).
    createInitAgentsMdTool(filesKv),
    ...createGitTools(config),
  ];
  // B2 — read_build_result tool registered in framework mode where the
  // browser is the only execution surface. Outside framework mode the
  // agent has run_command, so the build-result channel is redundant.
  if (isFramework && sessionId) {
    tools.push(createReadBuildResultTool({ sessionId, kv: config.buildResultsKv }));
    // C3 — visual_verify / visual_interact pair. Always registered when
    // we're in framework mode + have a sessionId, even when no CDP
    // endpoint is configured: the tools degrade to a "not configured"
    // snapshot rather than throwing, and the agent learns it can't rely
    // on visual checks via the same channel as everything else.
    const resolvePreviewUrl = async () => {
      const snap = await getBuildResult(sessionId, config.buildResultsKv);
      return snap.previewUrl;
    };
    tools.push(
      createVisualVerifyTool({
        sessionId,
        ...(config.buildResultsKv ? { buildResultsKv: config.buildResultsKv } : {}),
        ...(config.cdpWsEndpoint ? { cdpWsEndpoint: config.cdpWsEndpoint } : {}),
        resolvePreviewUrl,
      }) as ToolDefinition
    );
    tools.push(
      createVisualInteractTool({
        sessionId,
        ...(config.buildResultsKv ? { buildResultsKv: config.buildResultsKv } : {}),
        ...(config.cdpWsEndpoint ? { cdpWsEndpoint: config.cdpWsEndpoint } : {}),
        resolvePreviewUrl,
      }) as ToolDefinition
    );
  }
  // B2 — semantic search registered when an indexer is present.
  if (indexer) tools.push(createSemanticSearchTool(indexer));
  // B4 — versioning tools registered when a per-session FileTreeManager is present.
  if (fileTree) {
    tools.push(createListFileVersionsTool(fileTree));
    tools.push(createRevertFileTool(filesKv, fileTree, indexer));
  }
  // B3 — GitHub PR loop registered when KV is bound. needsApproval=true means
  // the agent's HITL gate (A3) catches it before the push happens.
  if (filesKv) {
    const ambientToken = config.githubToken;
    tools.push(
      createGitHubPrTool({
        filesKv,
        ...(ambientToken !== undefined && { ambientToken }),
      })
    );
  }
  // P4: filter out denied tools
  const filteredTools = deniedTools?.length
    ? tools.filter((t) => !deniedTools.includes(t.name))
    : tools;
  if (useMemory) {
    const memTool = createMemoryTool({ backend: globalMemoryBackend });
    // BUG FIX: previously this was `tools.push(...)` which mutated the
    // pre-filter array; the returned `filteredTools` never included
    // the memory tool, so the model never saw it and the agent
    // claimed "I don't have a memory tool available".
    filteredTools.push({
      ...memTool,
      rawInputJsonSchema: {
        type: "object",
        description: "Perform memory operations: read, write, list, or delete",
        properties: {
          op: { type: "string", enum: ["read", "write", "list", "delete"] },
          key: { type: "string" },
          value: { type: "string" },
          prefix: { type: "string" },
        },
        required: ["op"],
      },
    });
  }
  return filteredTools;
}

/**
 * B4 — Translate the per-call `approvalPolicy` field into an
 * ApprovalPolicy instance. Returns `null` for "permissive" / undefined
 * so the caller can short-circuit and skip the wrap.
 */
function resolveApprovalPolicy(spec: RunBody["approvalPolicy"]): ApprovalPolicy | null {
  if (spec === undefined || spec === "permissive") return null;
  if (spec === "balanced") return PolicyPresets.balanced();
  if (spec === "strict") return PolicyPresets.strict();
  return new ApprovalPolicy(spec);
}

function buildInputGuardrails(guardrails?: RunBody["guardrails"]) {
  if (!guardrails?.maxInputChars) return [];
  return [maxInputLength(guardrails.maxInputChars)];
}

function buildOutputGuardrails(guardrails?: RunBody["guardrails"]) {
  if (!guardrails?.forbiddenOutputPhrases?.length) return [];
  return [forbiddenPhrases(guardrails.forbiddenOutputPhrases)];
}

async function* enhancedAgentRun(
  model: Model,
  runner:
    | SelfConsistencyRunner
    | ReflectRefineRunner
    | BudgetForcingRunner
    | ParallelForkJoinRunner,
  task: string
): AsyncGenerator<AgentEvent> {
  const traceId = `enhanced-${Date.now()}`;
  const base = { traceId, parentTraceId: null, timestampMs: Date.now() };
  const messages: ModelMessage[] = [{ role: "user", content: task }];

  yield { ...base, channel: "text", event: "run_start", data: { task } } as AgentEvent;
  yield { ...base, channel: "thinking", event: "step_start", data: { step: 1 } } as AgentEvent;

  try {
    const result = await runner.run(model, messages, { stream: true });
    const runnerName = runner.constructor.name;
    const meta =
      "votes" in result
        ? `votes=${result.votes}/${result.totalCandidates}`
        : "cyclesUsed" in result
          ? `cyclesUsed=${result.cyclesUsed}`
          : "waitRoundsUsed" in result
            ? `waitRoundsUsed=${result.waitRoundsUsed}`
            : "";
    yield {
      ...base,
      channel: "thinking",
      event: "thinking_delta",
      data: { delta: `[${runnerName}] ${meta}`, step: 1 },
    } as AgentEvent;
    yield {
      ...base,
      channel: "text",
      event: "final_answer",
      data: { answer: result.answer },
    } as AgentEvent;
  } catch (err) {
    yield {
      ...base,
      channel: "text",
      event: "error",
      data: { error: err instanceof Error ? err.message : String(err) },
    } as AgentEvent;
  }
}

async function* ptcAgentRun(
  model: Model,
  tools: ToolDefinition[],
  task: string,
  _codeLanguage: string,
  _config: AppConfig
): AsyncGenerator<AgentEvent> {
  const traceId = `ptc-${Date.now()}`;
  const base = { traceId, parentTraceId: null, timestampMs: Date.now() };

  yield { ...base, channel: "text", event: "run_start", data: { task } } as AgentEvent;
  yield { ...base, channel: "thinking", event: "step_start", data: { step: 1 } } as AgentEvent;
  yield {
    ...base,
    channel: "thinking",
    event: "thinking_delta",
    data: { delta: "[PTC] Generating orchestration script…", step: 1 },
  } as AgentEvent;

  try {
    const { QuickJSKernel } = await import("@wasmagent/kernel-quickjs");
    const { newQuickJSWASMModuleFromVariant } = await import("quickjs-emscripten-core");
    const cfVariant = (await import("@jitl/quickjs-wasmfile-release-sync")).default;

    const kernel = new QuickJSKernel({
      timeoutMs: 30_000,
      variant: cfVariant as unknown,
      variantLoader: newQuickJSWASMModuleFromVariant as never,
    });

    const registry = new ToolRegistry();
    for (const t of tools) registry.register(t);

    const orchestrator = new ProgrammaticOrchestrator(kernel, registry, {}, { resetKernelPerRun: true });

    // Generate script via model
    const collectModelText = async (msgs: ModelMessage[]) => {
      let text = "";
      for await (const ev of model.generate(msgs, { stream: true })) {
        if (ev.type === "text_delta" && ev.delta) text += ev.delta;
      }
      return text.trim();
    };

    const systemPrompt = `You are a PTC orchestrator. Generate a JavaScript script that calls tools via callTool(name, args).
Available tools: ${tools.map((t) => t.name).join(", ")}.
Set __finalAnswer__ = <result> to return the answer.
Respond with ONLY a JS code block.`;

    const script = await collectModelText([
      { role: "user", content: `${systemPrompt}\n\nTask: ${task}` },
    ]);

    const codeMatch = /```(?:js|javascript)?\n([\s\S]+?)```/.exec(script);
    const code = codeMatch?.[1]?.trim() ?? script;

    yield {
      ...base,
      channel: "thinking",
      event: "thinking_delta",
      data: { delta: `[PTC] Executing script (${code.length} chars)…`, step: 1 },
    } as AgentEvent;

    const result = await orchestrator.run(code);

    yield {
      ...base,
      channel: "text",
      event: "final_answer",
      data: { answer: result.finalOutput },
    } as AgentEvent;
  } catch (err) {
    yield {
      ...base,
      channel: "text",
      event: "error",
      data: { error: err instanceof Error ? err.message : String(err) },
    } as AgentEvent;
  }
}

function streamCachedEvents(cachedJson: string): Response {
  let events: AgentEvent[];
  try {
    events = JSON.parse(cachedJson) as AgentEvent[];
  } catch {
    return Response.json({ error: "corrupted cache" }, { status: 500 });
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of events)
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Bscode-Cache": "HIT",
    },
  });
}

/**
 * C1 — Replay-only response for an SSE reconnect.
 *
 * Reads persisted events from the EventLog under `runTraceId`, skips
 * everything ≤ `lastEventId` (the value the client received in the
 * `Last-Event-ID` request header), and streams the remainder using
 * canonical SSE frames (id: + data:). Always finishes with `data: [DONE]`
 * so the client transitions back to "complete" or "interrupted" state
 * deterministically.
 *
 * If the trace has no persisted entries (purged / never existed) we
 * still send `[DONE]` — better than hanging the client forever. The
 * client distinguishes "all caught up" from "trace unknown" by the
 * absence of the X-Agentkit-Trace-Id echo (we don't set it on resume).
 */
function streamResumeReplay(
  kv: ReturnType<RunRoutesDeps["adaptKvStoreToBackend"]>,
  runTraceId: string,
  lastEventId: string | null,
  config: AppConfig,
  origin: string | undefined
): Response {
  const log = new EventLog(kv);
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  (async () => {
    // Flush headers immediately — same rationale as the live /run path.
    await writer.write(encoder.encode(": resume\n\n"));
    try {
      for await (const logged of log.replay(runTraceId, lastEventId)) {
        await writer.write(encoder.encode(formatSseFrame(logged)));
      }
      await writer.write(encoder.encode("data: [DONE]\n\n"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await writer.write(
        encoder.encode(
          `data: ${JSON.stringify({ event: "error", data: { error: `resume failed: ${msg}` } })}\n\n`
        )
      );
    } finally {
      await writer.close().catch(() => {});
    }
  })();

  const allowOrigin =
    (config.allowedOrigin ?? "*") === "*"
      ? "*"
      : (origin ?? "") === config.allowedOrigin
        ? (config.allowedOrigin ?? "null")
        : "null";

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Private-Network": "true",
      // Echo the trace id so the client confirms we accepted the resume.
      "X-Agentkit-Trace-Id": runTraceId,
      "X-Bscode-Resume": "1",
      "Access-Control-Expose-Headers": "X-Agentkit-Trace-Id, X-Bscode-Resume",
    },
  });
}

/**
 * Return up to maxFiles files whose names or content keywords overlap with the task text.
 * Simple keyword matching — avoids sending the full workspace for large projects.
 */
async function getRelevantFileContents(
  kv: KvStore,
  task: string,
  maxFiles = 5,
  sessionId: string | undefined = undefined,
  sessionFileTrees: Map<string, FileTreeManager>
): Promise<{ path: string; content: string }[]> {
  // Resolve a per-session FileTreeManager — falls back to "default"
  // for legacy callers that don't propagate the session id (e.g. CLI).
  const id = sessionId ?? "default";
  let tree = sessionFileTrees.get(id);
  if (!tree) {
    tree = new FileTreeManager();
    sessionFileTrees.set(id, tree);
  }
  // Hydrate from KV if it's empty
  if (tree.size === 0) {
    const list = await kv.list({ prefix: "file:" });
    const entries = await Promise.all(
      list.keys
        .filter((k) => !k.name.startsWith("file:session:") && !k.name.startsWith("file:meta:"))
        .slice(0, 200) // cap at 200 files
        .map(async (k) => {
          const path = k.name.replace(/^file:/, "");
          const content = await kv.get(k.name);
          return content !== null ? { path, content } : null;
        })
    );
    tree.hydrate(entries.filter(Boolean) as { path: string; content: string }[]);
  }

  // Use FileTreeManager's semantic scoring (path + content keywords + recency)
  const scored = tree.getRelevantFiles(task, maxFiles, 2000);
  return scored.map((f) => ({ path: f.path, content: f.content }));
}

async function contentHash(inputs: object): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(inputs))
  );
  return "run:" + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

"use client";
import { useAgentRun } from "@wasmagent/react";
import { useCallback, useRef, useState } from "react";
import { getOrCreateSessionId } from "@/lib/session";
import { getWorkerUrl } from "@/lib/workerUrl";

export interface TokenStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  calls: number;
  /**
   * Accumulated USD cost as reported by the worker's per-call `estimatedUsd`.
   * The worker computes this with the actual model's pricing (Haiku is much
   * cheaper than Sonnet, etc.), so we sum rather than recompute here.
   */
  accumulatedUsd: number;
  /** Last modelId seen — informational, surfaced as a tooltip. */
  lastModelId?: string;
}

export interface AgentConfig {
  agentMode: "code" | "tool" | "multi" | "ptc" | "goalDirected";
  modelId: string;
  maxSteps: number;
  codeLanguage?: "js" | "python" | "node";
  modelIds?: string[];
  useOtel?: boolean;
  projectContext?: boolean;
  /** Framework mode — when set, uses a framework-aware system prompt and auto-mounts to WebContainers */
  framework?: "react" | "vue" | "svelte" | "vanilla" | null;
  /** Whether to auto-detect mode from task text before running */
  autoMode?: boolean;
  /** Stop conditions: "noProgress", "stepCount:<n>", "costBudget:<maxUSD>" */
  stopConditions?: string[];
  /** Enhancement policy — replaces flat enhancement string, adds ParallelForkJoin */
  enhancementPolicy?: {
    selfConsistency?: { enabled: boolean; n?: number; earlyStopThreshold?: number };
    reflectRefine?: { enabled: boolean; maxCycles?: number };
    budgetForcing?: { enabled: boolean };
    parallelForkJoin?: {
      enabled: boolean;
      branches?: number;
      concurrency?: number;
      aggregation?: "summary" | "first";
    };
    budget?: { maxTokens?: number; maxSteps?: number; maxDurationMs?: number };
  };
  /** Seal a B2 cache breakpoint every N steps (default: 5 for prompt-cache savings) */
  chunkSizeSteps?: number;
  /** Cache TTL for system prompt prefix (default: "1h" for extended Anthropic cache) */
  systemPrefixTtl?: "5m" | "1h";
  /** Scheduler override */
  scheduler?: "dag" | "parallel";
  /** Max total tokens before auto-stop (cost control) */
  maxBudgetTokens?: number;
  /** Max milliseconds before auto-stop */
  maxDurationMs?: number;
  /** Auto-compact history when estimated tokens exceed this threshold (e.g. 80000) */
  autoCompactThreshold?: number;
  /**
   * 2026-06-18 — When `agentMode === "goalDirected"`, cap on goal-loop
   * iterations. Each iteration = 1 ToolCallingAgent run + 1 verify pass.
   * Defaults server-side; client may override.
   */
  maxIterations?: number;
}

export interface ClassifyResult {
  mode: "code" | "tool" | "framework";
  framework: "react" | "vue" | "svelte" | "vanilla" | null;
  /**
   * 2026-06-18 — Verifier-loop axis. `verify` means the task expects a
   * substantive deliverable that benefits from auto-criteria + retry
   * (long-form writing, multi-file refactor, "build must pass"). Any
   * `mode` can carry `loop: "verify"`; the dispatch layer in this hook
   * maps `loop=verify` (excluding framework, which has its own loop)
   * onto `agentMode === "goalDirected"`. Optional + defaults to
   * `"single"` for backward compatibility with classifiers / proxies
   * that haven't learned this axis yet.
   */
  loop?: "single" | "verify";
}

/** A clarifying question with optional multiple-choice options (Claude Code style) */
export interface ClarifyQuestion {
  text: string;
  /** Pre-defined options the user can click; empty = free text only */
  options: string[];
}

// Minimal shape we need from AgentEvent — avoids importing @wasmagent/core in the browser bundle
interface AgentEventMinimal {
  event: string;
  data: Record<string, unknown>;
  traceId?: string;
}

export function useAgent(
  config: AgentConfig,
  onConfigUpdate?: (update: Partial<AgentConfig>) => void
) {
  const workerUrl = getWorkerUrl();
  const [tokenStats, setTokenStats] = useState<TokenStats>({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    calls: 0,
    accumulatedUsd: 0,
  });
  const [rawEvents, setRawEvents] = useState<AgentEventMinimal[]>([]);
  const [classifying, setClassifying] = useState(false);
  const [detectedMode, setDetectedMode] = useState<ClassifyResult | null>(null);
  /** Clarifying questions for the current task (null = no clarification needed) */
  const [clarifyingQuestions, setClarifyingQuestions] = useState<ClarifyQuestion[] | null>(null);
  const statsRef = useRef(tokenStats);

  const onEvent = useCallback((ev: AgentEventMinimal) => {
    setRawEvents((prev) => [...prev, ev]);
    if (ev.event === "model_done") {
      const d = ev.data as {
        modelId?: string;
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        // New enriched fields from wasmagent TokenBudget
        cacheHitRate?: number;
        estimatedUsd?: number;
        calls?: number;
      };
      setTokenStats((prev) => {
        const next: TokenStats = {
          // SEC-017 / UX bug 2026-06-17: previously rebuilt the whole object
          // from scratch, dropping `lastModelId` whenever a model_done event
          // arrived without `modelId`. The UI tooltip flickered between the
          // model name and undefined. Spread `...prev` first so every field
          // carries forward unless we explicitly overwrite it below.
          ...prev,
          inputTokens: prev.inputTokens + (d.inputTokens ?? 0),
          outputTokens: prev.outputTokens + (d.outputTokens ?? 0),
          cacheReadTokens: prev.cacheReadTokens + (d.cacheReadTokens ?? 0),
          calls: prev.calls + 1,
          // Sum the worker's per-call cost (computed with the actual model
          // pricing — Haiku ≠ Sonnet ≠ Opus). Old behaviour recomputed
          // locally with hardcoded Sonnet rates, mis-reporting Haiku 4×.
          accumulatedUsd: prev.accumulatedUsd + (d.estimatedUsd ?? 0),
          ...(d.modelId !== undefined && { lastModelId: d.modelId }),
        };
        statsRef.current = next;
        return next;
      });
    }
  }, []);

  const { messages, status, isRunning, finalAnswer, run, abort, reset } = useAgentRun(
    `${workerUrl}/run`,
    // biome-ignore lint/suspicious/noExplicitAny: useAgentRun onEvent callback type
    { onEvent: onEvent as any, headers: () => ({ "X-Session-Id": getOrCreateSessionId() }) }
  );

  const submit = useCallback(
    async (
      task: string,
      conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>,
      /** Pass true when the task already contains user answers — skips /clarify */
      skipClarify = false
    ) => {
      setRawEvents([]);
      setDetectedMode(null);
      setClarifyingQuestions(null);

      let effectiveConfig = config;

      // Auto-detect mode if enabled — call /classify before launching agent
      if (config.autoMode) {
        setClassifying(true);
        try {
          const res = await fetch(`${workerUrl}/classify`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ task }),
          });
          const result = (await res.json()) as ClassifyResult;
          setDetectedMode(result);

          // Build updated config based on classification.
          //
          // 2026-06-18: classifier emits two axes — `mode` (code/tool/framework)
          // and `loop` (single/verify). When loop=verify and the task is NOT
          // a framework build (which has its own plan→build→preview loop via
          // WebContainers), upgrade agentMode to "goalDirected" so the worker
          // runs synth-criteria → execute → verify → retry. UI users never
          // see this dial — the classifier decides on their behalf, and the
          // turn badge shows a "🎯" suffix so the choice is transparent.
          const baseAgentMode = result.mode === "framework" ? "tool" : result.mode;
          const agentMode =
            result.loop === "verify" && result.mode !== "framework"
              ? "goalDirected"
              : baseAgentMode;
          const framework = result.mode === "framework" ? result.framework : null;
          // Framework mode: cap at 15 steps (4-8 files + planning overhead).
          // Too many steps → retry loops on errors; too few → truncated projects.
          const maxSteps = result.mode === "framework" ? 15 : config.maxSteps;
          effectiveConfig = { ...config, agentMode, framework, maxSteps };

          // Notify parent so UI reflects the auto-detected mode
          onConfigUpdate?.({ agentMode, framework, maxSteps });
        } catch {
          // Classification failed — proceed with current config
        } finally {
          setClassifying(false);
        }
      }

      // Clarification check — only once per original task, never after user has answered
      if (
        !skipClarify &&
        config.autoMode &&
        effectiveConfig.agentMode === "tool" &&
        !task.includes("@")
      ) {
        try {
          const res = await fetch(`${workerUrl}/clarify`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ task: task.slice(0, 600) }),
          });
          const result = (await res.json()) as {
            needsClarification: boolean;
            questions?: Array<{ text: string; options: string[] } | string>;
          };
          if (result.needsClarification && result.questions?.length) {
            // Normalise to ClarifyQuestion[]
            const qs: ClarifyQuestion[] = result.questions.map((q) =>
              typeof q === "string"
                ? { text: q, options: [] }
                : { text: q.text, options: q.options ?? [] }
            );
            setClarifyingQuestions(qs);
            return; // pause — let user answer before running
          }
        } catch {
          // clarify failed silently — proceed
        }
      }
      setClarifyingQuestions(null);

      // Always include noProgress for framework/tool mode to stop retry loops
      const stopConditions = effectiveConfig.stopConditions?.length
        ? effectiveConfig.stopConditions
        : effectiveConfig.agentMode === "tool" || effectiveConfig.framework
          ? ["noProgress"]
          : undefined;

      run({
        task,
        agentMode: effectiveConfig.agentMode,
        modelId: effectiveConfig.modelId,
        maxSteps: effectiveConfig.maxSteps,
        codeLanguage: effectiveConfig.codeLanguage ?? "js",
        useOtel: effectiveConfig.useOtel ?? true,
        projectContext: effectiveConfig.projectContext ?? false,
        // Prompt-cache optimisation: 5-step chunks + 1h system prefix TTL
        chunkSizeSteps: effectiveConfig.chunkSizeSteps ?? 5,
        systemPrefixTtl: effectiveConfig.systemPrefixTtl ?? "1h",
        ...(effectiveConfig.framework ? { framework: effectiveConfig.framework } : {}),
        ...(effectiveConfig.modelIds?.length ? { modelIds: effectiveConfig.modelIds } : {}),
        ...(stopConditions?.length ? { stopConditions } : {}),
        ...(effectiveConfig.enhancementPolicy
          ? { enhancementPolicy: effectiveConfig.enhancementPolicy }
          : {}),
        ...(effectiveConfig.maxIterations !== undefined
          ? { maxIterations: effectiveConfig.maxIterations }
          : {}),
        ...(effectiveConfig.scheduler ? { scheduler: effectiveConfig.scheduler } : {}),
        ...(effectiveConfig.maxBudgetTokens
          ? { maxBudgetTokens: effectiveConfig.maxBudgetTokens }
          : {}),
        ...(effectiveConfig.maxDurationMs ? { maxDurationMs: effectiveConfig.maxDurationMs } : {}),
        ...(effectiveConfig.autoCompactThreshold
          ? { autoCompactThreshold: effectiveConfig.autoCompactThreshold }
          : {}),
        ...(conversationHistory?.length ? { conversationHistory } : {}),
      });
    },
    [run, config, workerUrl, onConfigUpdate]
  );

  const resetAll = useCallback(() => {
    reset();
    setRawEvents([]);
    setDetectedMode(null);
    setClarifyingQuestions(null);
    setTokenStats({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      calls: 0,
      accumulatedUsd: 0,
    });
  }, [reset]);

  /** Dismiss clarifying questions and proceed with the run as-is */
  const dismissClarify = useCallback(() => setClarifyingQuestions(null), []);

  return {
    messages,
    status,
    isRunning,
    classifying,
    detectedMode,
    clarifyingQuestions,
    dismissClarify,
    finalAnswer,
    rawEvents,
    tokenStats,
    submit,
    abort,
    resetAll,
  };
}

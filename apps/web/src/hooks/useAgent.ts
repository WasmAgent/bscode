"use client";
import { useAgentRun } from "@agentkit-js/react";
import { useCallback, useRef, useState } from "react";

export interface TokenStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  calls: number;
}

export interface AgentConfig {
  agentMode: "code" | "tool" | "multi" | "ptc";
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
    parallelForkJoin?: { enabled: boolean; branches?: number; concurrency?: number; aggregation?: "summary" | "first" };
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
}

export interface ClassifyResult {
  mode: "code" | "tool" | "framework";
  framework: "react" | "vue" | "svelte" | "vanilla" | null;
}

/** A clarifying question with optional multiple-choice options (Claude Code style) */
export interface ClarifyQuestion {
  text: string;
  /** Pre-defined options the user can click; empty = free text only */
  options: string[];
}

// Minimal shape we need from AgentEvent — avoids importing @agentkit-js/core in the browser bundle
interface AgentEventMinimal {
  event: string;
  data: Record<string, unknown>;
  traceId?: string;
}

export function useAgent(config: AgentConfig, onConfigUpdate?: (update: Partial<AgentConfig>) => void) {
  const workerUrl = process.env.NEXT_PUBLIC_WORKER_URL ?? "http://localhost:8788";
  const [tokenStats, setTokenStats] = useState<TokenStats>({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    calls: 0,
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
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        // New enriched fields from agentkit-js TokenBudget
        cacheHitRate?: number;
        estimatedUsd?: number;
        calls?: number;
      };
      setTokenStats((prev) => {
        const next = {
          inputTokens: prev.inputTokens + (d.inputTokens ?? 0),
          outputTokens: prev.outputTokens + (d.outputTokens ?? 0),
          cacheReadTokens: prev.cacheReadTokens + (d.cacheReadTokens ?? 0),
          calls: prev.calls + 1,
        };
        statsRef.current = next;
        return next;
      });
    }
  }, []);

  const { messages, status, isRunning, finalAnswer, run, abort, reset } = useAgentRun(
    `${workerUrl}/run`,
    // biome-ignore lint/suspicious/noExplicitAny: useAgentRun onEvent callback type
    { onEvent: onEvent as any }
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

          // Build updated config based on classification
          const agentMode = result.mode === "framework" ? "tool" : result.mode;
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
      if (!skipClarify && config.autoMode && effectiveConfig.agentMode === "tool" && !task.includes("@")) {
        try {
          const res = await fetch(`${workerUrl}/clarify`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ task: task.slice(0, 600) }),
          });
          const result = await res.json() as {
            needsClarification: boolean;
            questions?: Array<{ text: string; options: string[] } | string>;
          };
          if (result.needsClarification && result.questions?.length) {
            // Normalise to ClarifyQuestion[]
            const qs: ClarifyQuestion[] = result.questions.map((q) =>
              typeof q === "string" ? { text: q, options: [] } : { text: q.text, options: q.options ?? [] }
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
        ...(effectiveConfig.enhancementPolicy ? { enhancementPolicy: effectiveConfig.enhancementPolicy } : {}),
        ...(effectiveConfig.scheduler ? { scheduler: effectiveConfig.scheduler } : {}),
        ...(effectiveConfig.maxBudgetTokens ? { maxBudgetTokens: effectiveConfig.maxBudgetTokens } : {}),
        ...(effectiveConfig.maxDurationMs ? { maxDurationMs: effectiveConfig.maxDurationMs } : {}),
        ...(effectiveConfig.autoCompactThreshold ? { autoCompactThreshold: effectiveConfig.autoCompactThreshold } : {}),
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
    setTokenStats({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 });
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

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
}

export interface ClassifyResult {
  mode: "code" | "tool" | "framework";
  framework: "react" | "vue" | "svelte" | "vanilla" | null;
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
  const statsRef = useRef(tokenStats);

  const onEvent = useCallback((ev: AgentEventMinimal) => {
    setRawEvents((prev) => [...prev, ev]);
    if (ev.event === "model_done") {
      const d = ev.data as {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
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
    async (task: string) => {
      setRawEvents([]);
      setDetectedMode(null);

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
          // Framework mode needs more steps to write all project files
          const maxSteps = result.mode === "framework"
            ? Math.max(config.maxSteps, 20)
            : config.maxSteps;
          effectiveConfig = { ...config, agentMode, framework, maxSteps };

          // Notify parent so UI reflects the auto-detected mode
          onConfigUpdate?.({ agentMode, framework, maxSteps });
        } catch {
          // Classification failed — proceed with current config
        } finally {
          setClassifying(false);
        }
      }

      run({
        task,
        agentMode: effectiveConfig.agentMode,
        modelId: effectiveConfig.modelId,
        maxSteps: effectiveConfig.maxSteps,
        codeLanguage: effectiveConfig.codeLanguage ?? "js",
        useOtel: effectiveConfig.useOtel ?? true,
        projectContext: effectiveConfig.projectContext ?? false,
        ...(effectiveConfig.framework ? { framework: effectiveConfig.framework } : {}),
        ...(effectiveConfig.modelIds?.length ? { modelIds: effectiveConfig.modelIds } : {}),
      });
    },
    [run, config, workerUrl, onConfigUpdate]
  );

  const resetAll = useCallback(() => {
    reset();
    setRawEvents([]);
    setDetectedMode(null);
    setTokenStats({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 });
  }, [reset]);

  return {
    messages,
    status,
    isRunning,
    classifying,
    detectedMode,
    finalAnswer,
    rawEvents,
    tokenStats,
    submit,
    abort,
    resetAll,
  };
}

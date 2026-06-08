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
}

// Minimal shape we need from AgentEvent — avoids importing @agentkit-js/core in the browser bundle
interface AgentEventMinimal {
  event: string;
  data: Record<string, unknown>;
  traceId?: string;
}

export function useAgent(config: AgentConfig) {
  const workerUrl = process.env.NEXT_PUBLIC_WORKER_URL ?? "http://localhost:8788";
  const [tokenStats, setTokenStats] = useState<TokenStats>({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    calls: 0,
  });
  const [rawEvents, setRawEvents] = useState<AgentEventMinimal[]>([]);
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
    (task: string) => {
      setRawEvents([]);
      run({
        task,
        agentMode: config.agentMode,
        modelId: config.modelId,
        maxSteps: config.maxSteps,
        codeLanguage: config.codeLanguage ?? "js",
        useOtel: config.useOtel ?? true,
        projectContext: config.projectContext ?? false,
        ...(config.modelIds?.length ? { modelIds: config.modelIds } : {}),
      });
    },
    [run, config]
  );

  const resetAll = useCallback(() => {
    reset();
    setRawEvents([]);
    setTokenStats({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 });
  }, [reset]);

  return {
    messages,
    status,
    isRunning,
    finalAnswer,
    rawEvents,
    tokenStats,
    submit,
    abort,
    resetAll,
  };
}

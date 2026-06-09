"use client";
import type { AgentMessage } from "@agentkit-js/react";
import { useEffect, useRef } from "react";

// Minimal AgentEvent shape for the browser — avoids importing the Node-side core package
interface AgentEventMinimal {
  event: string;
  data: Record<string, unknown>;
}

const EVENT_COLORS: Record<string, string> = {
  run_start: "#58a6ff",
  step_start: "#8b949e",
  thinking_delta: "#bc8cff",
  planning: "#bc8cff",
  tool_call: "#e3b341",
  tool_result: "#3fb950",
  model_start: "#8b949e",
  model_done: "#8b949e",
  final_answer: "#3fb950",
  error: "#f85149",
  status: "#8b949e",
};

const EVENT_PREFIXES: Record<string, string> = {
  run_start: "▶ RUN",
  step_start: "── STEP",
  thinking_delta: "  ·",
  planning: "  PLAN",
  tool_call: "  → TOOL",
  tool_result: "  ← RESULT",
  model_start: "  ⚙ MODEL",
  model_done: "  ✓ MODEL",
  final_answer: "✓ ANSWER",
  error: "✗ ERROR",
  status: "  STATUS",
};

interface TerminalProps {
  messages: AgentMessage[];
  rawEvents: AgentEventMinimal[];
  isRunning: boolean;
  viewMode: "messages" | "events" | "preview";
  previewHtml?: string;
}

export function Terminal({ messages, rawEvents, isRunning, viewMode, previewHtml }: TerminalProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  const styles: Record<string, React.CSSProperties> = {
    container: {
      height: "100%",
      overflowY: "auto",
      background: "#0d1117",
      padding: "12px 16px",
      fontFamily: "JetBrains Mono, monospace",
      fontSize: "12px",
      lineHeight: "1.6",
    },
    line: {
      marginBottom: 2,
      wordBreak: "break-word" as const,
      whiteSpace: "pre-wrap" as const,
    },
    cursor: {
      display: "inline-block",
      width: 8,
      height: 14,
      background: "#58a6ff",
      animation: "blink 1s step-end infinite",
      verticalAlign: "text-bottom",
      marginLeft: 4,
    },
    empty: {
      color: "#8b949e",
      fontStyle: "italic",
      textAlign: "center" as const,
      marginTop: 40,
    },
  };

  if (viewMode === "preview") {
    if (!previewHtml) {
      return (
        <div
          style={{
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#0d1117",
            color: "#8b949e",
            fontSize: 12,
            fontFamily: "JetBrains Mono, monospace",
          }}
        >
          No preview available — ask the agent to generate HTML content.
        </div>
      );
    }
    return (
      <div style={{ height: "100%", overflow: "hidden", background: "#fff" }}>
        <iframe
          title="bscode-preview"
          srcDoc={previewHtml}
          sandbox="allow-scripts allow-same-origin allow-forms"
          style={{ width: "100%", height: "100%", border: "none", display: "block" }}
        />
      </div>
    );
  }

  if (viewMode === "messages") {
    return (
      <div style={styles.container}>
        {messages.length === 0 && (
          <div style={styles.empty}>Output will appear here after running the agent.</div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} style={{ ...styles.line, color: msgColor(msg.role) }}>
            <span style={{ color: "#8b949e" }}>{msgPrefix(msg.role, msg.toolName)}</span>{" "}
            {msg.content}
          </div>
        ))}
        {isRunning && <span style={styles.cursor} />}
        <div ref={bottomRef} />
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {rawEvents.length === 0 && (
        <div style={styles.empty}>Raw AgentEvent stream will appear here.</div>
      )}
      {rawEvents.map((ev, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: event log display, no stable ID
        <div key={i} style={{ ...styles.line, color: EVENT_COLORS[ev.event] ?? "#c9d1d9" }}>
          <span style={{ color: "#8b949e", marginRight: 8 }}>{String(i).padStart(3, "0")}</span>
          <span style={{ marginRight: 8 }}>{EVENT_PREFIXES[ev.event] ?? ev.event}</span>
          <span style={{ color: "#c9d1d9" }}>{formatEventData(ev)}</span>
        </div>
      ))}
      {isRunning && <span style={styles.cursor} />}
      <div ref={bottomRef} />
    </div>
  );
}

function msgColor(role: string): string {
  if (role === "tool") return "#e3b341";
  if (role === "error") return "#f85149";
  return "#c9d1d9";
}

function msgPrefix(role: string, toolName?: string): string {
  if (role === "tool") return `[${toolName ?? "tool"}]`;
  if (role === "error") return "[error]";
  return "[agent]";
}

function formatEventData(ev: AgentEventMinimal): string {
  const d = ev.data as Record<string, unknown>;
  switch (ev.event) {
    case "run_start":
      return `task: "${String(d.task ?? "").slice(0, 80)}"`;
    case "step_start":
      return `step ${d.step}`;
    case "thinking_delta":
      return String(d.delta ?? "").slice(0, 120);
    case "planning":
      return `step ${d.step} — ${String(d.plan ?? "").slice(0, 100)}`;
    case "tool_call":
      return `${d.toolName}(${JSON.stringify(d.args ?? {}).slice(0, 80)})`;
    case "tool_result":
      return `${d.toolName} → ${JSON.stringify(d.output ?? "").slice(0, 100)}`;
    case "model_start":
      return `${d.modelId} step ${d.step}`;
    case "model_done":
      return `${d.modelId} in:${d.inputTokens ?? 0} out:${d.outputTokens ?? 0} cache:${d.cacheReadTokens ?? 0}`;
    case "final_answer":
      return String(d.answer ?? "").slice(0, 200);
    case "error": {
      const errMsg = String(d.error ?? "");
      const stack = d.stack ? `\n  ${String(d.stack).split("\n").slice(0, 3).join("\n  ")}` : "";
      return errMsg + stack;
    }
    default:
      return JSON.stringify(d).slice(0, 120);
  }
}

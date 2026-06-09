"use client";
import type { AgentMessage } from "@agentkit-js/react";
import { useEffect, useRef } from "react";

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

export interface PreviewContent {
  /** Raw HTML document to render in iframe via srcDoc */
  html?: string;
  /** Live WebContainers dev server URL */
  url?: string;
  /** Plain-text or structured execution output (stdout, kernel result) */
  output?: string;
  /** Kernel execution logs (stdout lines) */
  logs?: string[];
  /** Error message from execution */
  error?: string;
}

interface TerminalProps {
  messages: AgentMessage[];
  rawEvents: AgentEventMinimal[];
  isRunning: boolean;
  viewMode: "messages" | "events" | "preview";
  preview?: PreviewContent;
  /** Live WebContainers terminal output lines */
  wcLines?: string[];
}

export function Terminal({ messages, rawEvents, isRunning, viewMode, preview, wcLines }: TerminalProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, rawEvents]);

  const mono: React.CSSProperties = {
    fontFamily: "JetBrains Mono, monospace",
    fontSize: 12,
    lineHeight: 1.6,
  };

  const container: React.CSSProperties = {
    height: "100%",
    overflowY: "auto",
    background: "#0d1117",
    padding: "12px 16px",
    ...mono,
  };

  const cursor: React.CSSProperties = {
    display: "inline-block",
    width: 8,
    height: 14,
    background: "#58a6ff",
    animation: "blink 1s step-end infinite",
    verticalAlign: "text-bottom",
    marginLeft: 4,
  };

  const empty: React.CSSProperties = {
    color: "#8b949e",
    fontStyle: "italic",
    textAlign: "center",
    marginTop: 40,
  };

  // ── Preview tab ───────────────────────────────────────────────────────────
  if (viewMode === "preview") {
    const allLines = [...(wcLines ?? []), ...(preview?.logs ?? [])];

    // Nothing to show yet — but WebContainers may be running (show its terminal)
    if (!preview?.html && !preview?.url && !preview?.output && !preview?.error) {
      if (allLines.length > 0) {
        // WebContainers is installing/starting — show live terminal output
        return (
          <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
            <div style={{ background: "#161b22", borderBottom: "1px solid #30363d", padding: "4px 12px", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <span style={{ ...mono, fontSize: 10, color: "#8b949e", textTransform: "uppercase", letterSpacing: 0.8 }}>WebContainers</span>
              <span style={{ ...mono, fontSize: 10, color: "#e3b341", animation: "pulse 1.2s ease-in-out infinite" }}>● building…</span>
            </div>
            <div style={{ ...container, flex: 1 }}>
              {allLines.map((line, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: ordered terminal lines
                <div key={i} style={{ color: "#c9d1d9", marginBottom: 1, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{line}</div>
              ))}
              <div ref={bottomRef} />
            </div>
          </div>
        );
      }
      return (
        <div style={{ ...container, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 24 }}>🖥️</div>
          <div style={{ color: "#8b949e", textAlign: "center" }}>
            Preview will appear here after the agent finishes.<br />
            <span style={{ fontSize: 11, color: "#484f58" }}>
              HTML → live render · JS/Python → execution output · Framework → WebContainers
            </span>
          </div>
        </div>
      );
    }

    // Live WebContainers dev server URL
    if (preview?.url) {
      return (
        <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
          <div style={{ background: "#161b22", borderBottom: "1px solid #30363d", padding: "4px 12px", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <span style={{ ...mono, fontSize: 10, color: "#8b949e", textTransform: "uppercase", letterSpacing: 0.8 }}>Live Preview</span>
            <span style={{ ...mono, fontSize: 10, color: "#3fb950" }}>● WebContainers</span>
            <a href={preview.url} target="_blank" rel="noreferrer" style={{ ...mono, fontSize: 10, color: "#58a6ff", marginLeft: "auto", textDecoration: "none" }}>
              ↗ {preview.url}
            </a>
          </div>
          <div style={{ flex: 1, overflow: "hidden", background: "#fff" }}>
            {/* No sandbox — WebContainers needs full access for HMR and service workers */}
            <iframe
              title="bscode-wc-preview"
              src={preview.url}
              style={{ width: "100%", height: "100%", border: "none", display: "block" }}
              allow="cross-origin-isolated"
            />
          </div>
        </div>
      );
    }

    // Static HTML document → iframe via srcDoc
    if (preview?.html) {
      return (
        <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
          <div style={{ background: "#161b22", borderBottom: "1px solid #30363d", padding: "4px 12px", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <span style={{ ...mono, fontSize: 10, color: "#8b949e", textTransform: "uppercase", letterSpacing: 0.8 }}>Live Preview</span>
            <span style={{ ...mono, fontSize: 10, color: "#3fb950" }}>● HTML</span>
          </div>
          <div style={{ flex: 1, overflow: "hidden", background: "#fff" }}>
            <iframe
              title="bscode-preview"
              srcDoc={preview.html}
              sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
              style={{ width: "100%", height: "100%", border: "none", display: "block" }}
            />
          </div>
        </div>
      );
    }

    // Text / execution output (Python print, JS console, kernel result)
    const outputLines = [...allLines, ...(preview?.output ? [preview.output] : [])];
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        <div style={{ background: "#161b22", borderBottom: "1px solid #30363d", padding: "4px 12px", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <span style={{ ...mono, fontSize: 10, color: "#8b949e", textTransform: "uppercase", letterSpacing: 0.8 }}>Execution Output</span>
          {preview?.error
            ? <span style={{ ...mono, fontSize: 10, color: "#f85149" }}>● Error</span>
            : <span style={{ ...mono, fontSize: 10, color: "#3fb950" }}>● Done</span>
          }
        </div>
        <div style={{ ...container, flex: 1 }}>
          {preview?.error && (
            <div style={{ background: "#1a0a0a", border: "1px solid #f8514944", borderRadius: 4, padding: "8px 12px", marginBottom: 12, color: "#f85149", whiteSpace: "pre-wrap" }}>
              <span style={{ color: "#f85149", fontWeight: 700 }}>Error: </span>{preview.error}
            </div>
          )}
          {outputLines.length === 0 && !preview?.error && (
            <div style={empty}>No output produced.</div>
          )}
          {outputLines.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: ordered output lines
            <div key={i} style={{ color: "#c9d1d9", marginBottom: 2, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {line}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── Messages tab ──────────────────────────────────────────────────────────
  if (viewMode === "messages") {
    return (
      <div style={container}>
        {messages.length === 0 && (
          <div style={empty}>Output will appear here after running the agent.</div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} style={{ marginBottom: 2, wordBreak: "break-word", whiteSpace: "pre-wrap", color: msgColor(msg.role) }}>
            <span style={{ color: "#8b949e" }}>{msgPrefix(msg.role, msg.toolName)}</span>{" "}
            {msg.content}
          </div>
        ))}
        {isRunning && <span style={cursor} />}
        <div ref={bottomRef} />
      </div>
    );
  }

  // ── Events tab ────────────────────────────────────────────────────────────
  return (
    <div style={container}>
      {rawEvents.length === 0 && (
        <div style={empty}>Raw AgentEvent stream will appear here.</div>
      )}
      {rawEvents.map((ev, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: event log display, no stable ID
        <div key={i} style={{ marginBottom: 2, wordBreak: "break-word", whiteSpace: "pre-wrap", color: EVENT_COLORS[ev.event] ?? "#c9d1d9" }}>
          <span style={{ color: "#8b949e", marginRight: 8 }}>{String(i).padStart(3, "0")}</span>
          <span style={{ marginRight: 8 }}>{EVENT_PREFIXES[ev.event] ?? ev.event}</span>
          <span style={{ color: "#c9d1d9" }}>{formatEventData(ev)}</span>
        </div>
      ))}
      {isRunning && <span style={cursor} />}
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

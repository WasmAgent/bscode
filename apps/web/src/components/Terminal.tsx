"use client";
import type { AgentMessage } from "@agentkit-js/react";
import type { CardBlock } from "@agentkit-js/ui-cards";
import { CardRenderer, ChatMessage } from "@agentkit-js/ui-cards-react";
import { useCallback, useEffect, useRef } from "react";
import { theme } from "@/lib/theme";

interface AgentEventMinimal {
  event: string;
  data: Record<string, unknown>;
}

const EVENT_COLORS: Record<string, string> = {
  run_start: "#58a6ff",
  step_start: theme.textMuted,
  thinking_delta: "#bc8cff",
  planning: "#bc8cff",
  tool_call: "#e3b341",
  tool_result: "#3fb950",
  model_start: theme.textMuted,
  model_done: theme.textMuted,
  final_answer: "#3fb950",
  error: "#f85149",
  status: theme.textMuted,
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
  /** A card block selected from the conversation to display full-size */
  card?: CardBlock;
}

interface TerminalProps {
  messages: AgentMessage[];
  rawEvents: AgentEventMinimal[];
  isRunning: boolean;
  viewMode: "messages" | "events" | "preview";
  preview?: PreviewContent;
  /** Live WebContainers terminal output lines */
  wcLines?: string[];
  /** Streaming artifacts being written (from artifact_delta events) */
  streamingArtifacts?: Map<string, { path?: string; content: string; done: boolean }>;
  /**
   * WebContainer lifecycle for the loading skeleton between "agent
   * finished writing files" and "preview iframe is live". Otherwise
   * the right pane stays empty for 10–30s with no signal and users
   * think the demo froze. Mirrors the union exported by
   * `useWebContainer`.
   */
  wcStatus?: "idle" | "booting" | "installing" | "starting" | "ready" | "error";
}

export function Terminal({
  messages,
  rawEvents,
  isRunning,
  viewMode,
  preview,
  wcLines,
  streamingArtifacts,
  wcStatus,
}: TerminalProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  // D2 renderer — fresh instance per call to avoid Worker message ordering issues
  const renderD2 = useCallback(async (content: string): Promise<string> => {
    const { D2 } = await import("@terrastruct/d2");
    const d2 = new D2();
    const result = await d2.compile(content);
    return d2.render(result.diagram, { ...result.renderOptions, noXMLTag: true, pad: 32 });
  }, []);

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
    color: theme.textMuted,
    fontStyle: "italic",
    textAlign: "center",
    marginTop: 40,
  };

  // ── Preview tab ───────────────────────────────────────────────────────────
  if (viewMode === "preview") {
    const allLines = [...(wcLines ?? []), ...(preview?.logs ?? [])];

    // WebContainer is provisioning the live preview but the iframe
    // URL hasn't resolved yet — show a structured loader so users
    // know the right pane isn't frozen. Without this, between "agent
    // finished writing files" and "vite dev is up" (10–30 s on cold
    // mount) the pane is just blank and users panic.
    if (
      !preview?.url &&
      !preview?.html &&
      !preview?.card &&
      wcStatus &&
      wcStatus !== "idle" &&
      wcStatus !== "ready" &&
      wcStatus !== "error"
    ) {
      const labelMap: Record<"booting" | "installing" | "starting", { title: string; sub: string }> = {
        booting: {
          title: "Booting WebContainer…",
          sub: "Mounting an in-tab Service Worker filesystem for the generated code.",
        },
        installing: {
          title: "Installing dependencies…",
          sub: "Running npm install inside the in-tab sandbox. First mount usually takes 10–20 s.",
        },
        starting: {
          title: "Starting dev server…",
          sub: "Booting Vite / the framework runtime. Almost there.",
        },
      };
      const phase = labelMap[wcStatus as "booting" | "installing" | "starting"] ?? labelMap.booting;
      const { title, sub } = phase;
      const recentLines = (wcLines ?? []).slice(-4);
      return (
        <div
          style={{
            height: "100%",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            background: "#0d1117",
            padding: "24px 32px",
            gap: 14,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: "#e3b341",
                animation: "pulse 1.2s ease-in-out infinite",
              }}
            />
            <span
              style={{
                ...mono,
                fontSize: 13,
                color: "#c9d1d9",
                fontWeight: 600,
              }}
            >
              {title}
            </span>
          </div>
          <div
            style={{
              ...mono,
              fontSize: 11,
              color: theme.textMuted,
              lineHeight: 1.6,
              maxWidth: 520,
              textAlign: "center",
            }}
          >
            {sub}
          </div>
          {recentLines.length > 0 && (
            <div
              style={{
                ...mono,
                fontSize: 10,
                color: theme.textMuted,
                background: "#161b22",
                border: "1px solid #21262d",
                borderRadius: 4,
                padding: "8px 12px",
                marginTop: 6,
                maxWidth: 600,
                width: "100%",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                opacity: 0.85,
              }}
            >
              {recentLines.join("\n")}
            </div>
          )}
        </div>
      );
    }

    // Card selected from conversation → render full-size
    if (preview?.card) {
      return (
        <div
          style={{
            height: "100%",
            display: "flex",
            flexDirection: "column",
            background: "#f8fafc",
          }}
        >
          <div
            style={{
              background: "#161b22",
              borderBottom: "1px solid #30363d",
              padding: "4px 12px",
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexShrink: 0,
            }}
          >
            <span
              style={{
                ...mono,
                fontSize: 10,
                color: theme.textMuted,
                textTransform: "uppercase",
                letterSpacing: 0.8,
              }}
            >
              Card Preview
            </span>
            <span style={{ ...mono, fontSize: 10, color: "#58a6ff" }}>
              card:{preview.card.type}
              {preview.card.meta ? ` — ${preview.card.meta}` : ""}
            </span>
          </div>
          {/* flex: 1 + overflow: hidden lets the card fill remaining height */}
          <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
            <CardRenderer
              card={preview.card}
              onRenderD2={renderD2}
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                margin: 0,
                borderRadius: 0,
                border: "none",
                boxShadow: "none",
                height: "100%",
              }}
              fillHeight
            />
          </div>
        </div>
      );
    }

    // Nothing to show yet — but WebContainers may be running (show its terminal)
    if (!preview?.html && !preview?.url && !preview?.output && !preview?.error) {
      if (allLines.length > 0) {
        // WebContainers is installing/starting — show live terminal output
        return (
          <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
            <div
              style={{
                background: "#161b22",
                borderBottom: "1px solid #30363d",
                padding: "4px 12px",
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  ...mono,
                  fontSize: 10,
                  color: theme.textMuted,
                  textTransform: "uppercase",
                  letterSpacing: 0.8,
                }}
              >
                WebContainers
              </span>
              <span
                style={{
                  ...mono,
                  fontSize: 10,
                  color: "#e3b341",
                  animation: "pulse 1.2s ease-in-out infinite",
                }}
              >
                ● building…
              </span>
            </div>
            <div style={{ ...container, flex: 1 }}>
              {allLines.map((line, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: terminal lines are append-only — i IS the identity
                  key={i}
                  style={{
                    color: "#c9d1d9",
                    marginBottom: 1,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {line}
                </div>
              ))}
              <div ref={bottomRef} />
            </div>
          </div>
        );
      }
      return (
        <div
          style={{
            ...container,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div style={{ fontSize: 24 }}>🖥️</div>
          <div style={{ color: theme.textMuted, textAlign: "center" }}>
            Preview will appear here after the agent finishes.
            <br />
            <span style={{ fontSize: 11, color: theme.textDim }}>
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
          <div
            style={{
              background: "#161b22",
              borderBottom: "1px solid #30363d",
              padding: "4px 12px",
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexShrink: 0,
            }}
          >
            <span
              style={{
                ...mono,
                fontSize: 10,
                color: theme.textMuted,
                textTransform: "uppercase",
                letterSpacing: 0.8,
              }}
            >
              Live Preview
            </span>
            <span style={{ ...mono, fontSize: 10, color: "#3fb950" }}>● WebContainers</span>
            {/* WebContainer preview URLs (`*.local-credentialless.webcontainer-api.io`)
                are an in-browser sandbox served by a Service Worker — they
                only resolve inside this tab. Showing the raw URL led
                users to click it as if it were a public link and land on
                "DNS_PROBE_FINISHED_NXDOMAIN". Hide it; the green
                "● WebContainers" indicator already says preview is live.
                A future "Share / publish" feature would deploy the app
                to a real Cloudflare Worker subdomain — at that point we'd
                show that URL here as a copy-link button. */}
            <span
              title="Preview is rendered by a WebContainer Service Worker inside this tab. The URL is sandbox-local and not shareable."
              style={{
                ...mono,
                fontSize: 10,
                color: theme.textMuted,
                marginLeft: "auto",
                whiteSpace: "nowrap",
              }}
            >
              sandbox preview · in-tab only
            </span>
          </div>
          <div style={{ flex: 1, overflow: "hidden", background: "#fff" }}>
            {/* No sandbox — WebContainers needs full access for HMR and service workers */}
            <iframe
              title="bscode-wc-preview"
              src={preview.url}
              style={{
                width: "100%",
                height: "100%",
                border: "none",
                display: "block",
                pointerEvents: "auto",
              }}
              allow="cross-origin-isolated; pointer-lock *; clipboard-read *; clipboard-write *"
            />
          </div>
        </div>
      );
    }

    // Static HTML document → iframe via srcDoc
    //
    // SECURITY: this iframe combines `allow-scripts` + `allow-same-origin`,
    // which Chrome warns is a sandbox-bypass risk. The combination is
    // necessary because:
    //   - allow-scripts: agent-generated previews include real JS (toy
    //     calculators, todo apps, canvas animations) — without it the
    //     preview is a static screenshot.
    //   - allow-same-origin: Monaco-style apps and any code that uses
    //     localStorage / IndexedDB / fetch-relative URLs needs the
    //     iframe to *have* an origin (sandbox without it produces
    //     `null` origin → those APIs throw).
    //   - allow-forms / allow-modals: agent demos commonly include
    //     `<form>` submissions and `confirm()` calls.
    //
    // The HTML source is the agent's output, which is itself shaped by
    // bscode prompts and the user's task. Trust boundary: the user is
    // running their own agent, so executing the agent's code in their
    // own browser is the *intended* behaviour, not a vulnerability.
    // See SECURITY.md → "HTML preview iframe sandbox".
    if (preview?.html) {
      return (
        <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
          <div
            style={{
              background: "#161b22",
              borderBottom: "1px solid #30363d",
              padding: "4px 12px",
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexShrink: 0,
            }}
          >
            <span
              style={{
                ...mono,
                fontSize: 10,
                color: theme.textMuted,
                textTransform: "uppercase",
                letterSpacing: 0.8,
              }}
            >
              Live Preview
            </span>
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
        <div
          style={{
            background: "#161b22",
            borderBottom: "1px solid #30363d",
            padding: "4px 12px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexShrink: 0,
          }}
        >
          <span
            style={{
              ...mono,
              fontSize: 10,
              color: theme.textMuted,
              textTransform: "uppercase",
              letterSpacing: 0.8,
            }}
          >
            Execution Output
          </span>
          {preview?.error ? (
            <span style={{ ...mono, fontSize: 10, color: "#f85149" }}>● Error</span>
          ) : (
            <span style={{ ...mono, fontSize: 10, color: "#3fb950" }}>● Done</span>
          )}
        </div>
        <div style={{ ...container, flex: 1 }}>
          {preview?.error && (
            <div
              style={{
                background: "#1a0a0a",
                border: "1px solid #f8514944",
                borderRadius: 4,
                padding: "8px 12px",
                marginBottom: 12,
                color: "#f85149",
                whiteSpace: "pre-wrap",
              }}
            >
              <span style={{ color: "#f85149", fontWeight: 700 }}>Error: </span>
              {preview.error}
            </div>
          )}
          {outputLines.length === 0 && !preview?.error && (
            <div style={empty}>No output produced.</div>
          )}
          {outputLines.map((line, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only output buffer — i IS the identity
              key={i}
              style={{
                color: "#c9d1d9",
                marginBottom: 2,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {line}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── Messages tab ──────────────────────────────────────────────────────────
  if (viewMode === "messages") {
    const artifacts = streamingArtifacts
      ? Array.from(streamingArtifacts.entries()).filter(([, a]) => a.content.length > 0)
      : [];
    return (
      <div style={container}>
        {messages.length === 0 && artifacts.length === 0 && (
          <div style={empty}>Output will appear here after running the agent.</div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} style={{ marginBottom: 8 }}>
            {/* Tool and error messages stay in terminal style */}
            {msg.role === "tool" || msg.role === "error" ? (
              <div
                style={{
                  wordBreak: "break-word",
                  whiteSpace: "pre-wrap",
                  color: msgColor(msg.role),
                  fontFamily: "JetBrains Mono, monospace",
                  fontSize: 12,
                }}
              >
                <span style={{ color: theme.textMuted }}>{msgPrefix(msg.role, msg.toolName)}</span>{" "}
                {msg.content}
              </div>
            ) : (
              /* Assistant messages: render in a light container so card components display correctly */
              <div
                style={{
                  background: "#ffffff",
                  borderRadius: 6,
                  padding: "2px 0",
                  overflow: "hidden",
                }}
              >
                <ChatMessage message={msg} onRenderD2={renderD2} />
              </div>
            )}
          </div>
        ))}
        {/* v0.dev pattern: streaming artifacts shown as they're written */}
        {artifacts.map(([id, artifact]) => (
          <div key={id} style={{ marginBottom: 8, marginTop: 4 }}>
            <div
              style={{
                fontSize: 10,
                color: "#58a6ff",
                marginBottom: 3,
                display: "flex",
                alignItems: "center",
                gap: 5,
              }}
            >
              <span style={{ color: "#30363d" }}>──</span>
              {artifact.path ?? "file"}
              {!artifact.done && (
                <span style={{ color: "#e3b341", animation: "pulse 1s infinite" }}>● writing</span>
              )}
              {artifact.done && <span style={{ color: "#3fb950" }}>✓ done</span>}
            </div>
            <div
              style={{
                background: "#0d1117",
                border: "1px solid #21262d",
                borderRadius: 4,
                padding: "6px 10px",
                fontSize: 11,
                color: "#c9d1d9",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: 150,
                overflowY: "auto",
                fontFamily: "JetBrains Mono, monospace",
              }}
            >
              {artifact.content.slice(0, 600)}
              {artifact.content.length > 600 ? "…" : ""}
              {!artifact.done && (
                <span
                  style={{
                    display: "inline-block",
                    width: 6,
                    height: 12,
                    background: "#58a6ff",
                    animation: "blink 1s step-end infinite",
                    verticalAlign: "text-bottom",
                    marginLeft: 2,
                  }}
                />
              )}
            </div>
          </div>
        ))}
        {isRunning && artifacts.length === 0 && <span style={cursor} />}
        <div ref={bottomRef} />
      </div>
    );
  }

  // ── Events tab ────────────────────────────────────────────────────────────
  return (
    <div style={container}>
      {rawEvents.length === 0 && <div style={empty}>Raw AgentEvent stream will appear here.</div>}
      {rawEvents.map((ev, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: event log is append-only — i IS the identity
          key={i}
          style={{
            marginBottom: 2,
            wordBreak: "break-word",
            whiteSpace: "pre-wrap",
            color: EVENT_COLORS[ev.event] ?? "#c9d1d9",
          }}
        >
          <span style={{ color: theme.textMuted, marginRight: 8 }}>
            {String(i).padStart(3, "0")}
          </span>
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

"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentPanel } from "@/components/AgentPanel";
import { Editor } from "@/components/Editor";
import { Terminal, type PreviewContent } from "@/components/Terminal";
import { TokenMeter } from "@/components/TokenMeter";
import { type AgentConfig, useAgent } from "@/hooks/useAgent";
import { toFileSystemTree, useWebContainer } from "@/hooks/useWebContainer";

const DEFAULT_CODE = `// BSCode — AI Coding Assistant
// Powered by agentkit-js on Cloudflare Workers
//
// Features tested here:
//   1. CodeAgent + QuickJSKernel  — agent writes & executes JS in WASM sandbox
//   2. ToolCallingAgent + DAG      — parallel tool calls (read/write/search files)
//   3. Prompt Cache optimization   — see TokenMeter below for cache hit rate
//   4. Multi-model switching       — Claude / Doubao / DeepSeek in the panel
//
// Try: "Write a merge sort in TypeScript and test it with [3,1,4,1,5,9,2,6]"

function greet(name: string): string {
  return \`Hello, \${name}! Welcome to BSCode.\`;
}

console.log(greet("world"));
`;

interface Toast {
  id: number;
  message: string;
  kind: "info" | "success" | "warn" | "error";
}

let toastId = 0;

export default function Home() {
  const [config, setConfig] = useState<AgentConfig>({
    agentMode: "code",
    modelId: "claude-sonnet-4-6",
    maxSteps: 10,
    codeLanguage: "js",
    useOtel: true,
    projectContext: false,
    framework: null,
  });
  const [originalCode, setOriginalCode] = useState<string | undefined>(undefined);
  const [isDiffMode, setIsDiffMode] = useState(false);
  const [preview, setPreview] = useState<PreviewContent | undefined>(undefined);
  const [task, setTask] = useState("");
  const [editorCode, setEditorCode] = useState(DEFAULT_CODE);
  const [terminalView, setTerminalView] = useState<"messages" | "events" | "preview">("messages");
  const [activeTab, setActiveTab] = useState<"editor" | "output">("editor");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const prevIsRunning = useRef(false);

  const addToast = useCallback((message: string, kind: Toast["kind"] = "info") => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, message, kind }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3500);
  }, []);

  const { messages, isRunning, rawEvents, tokenStats, finalAnswer, submit, abort, resetAll } =
    useAgent(config);

  const { status: wcStatus, previewUrl, terminalLines: wcLines, runProject, reset: wcReset } =
    useWebContainer();

  // When WebContainers gets a preview URL → show it in Preview tab
  useEffect(() => {
    if (previewUrl) {
      setPreview((prev) => ({ ...prev, url: previewUrl }));
      setTerminalView("preview");
      addToast("Framework app is live in Preview", "success");
    }
  }, [previewUrl, addToast]);

  // When WebContainers errors → surface it
  useEffect(() => {
    if (wcStatus === "error") {
      setPreview((prev) => ({ ...prev, error: "WebContainers build failed — check terminal output" }));
      addToast("WebContainers build failed", "error");
    }
  }, [wcStatus, addToast]);

  // Extract execution output from the raw event stream (kernel results from CodeAgent steps)
  useEffect(() => {
    if (rawEvents.length === 0) return;
    const kernelResults = rawEvents
      .filter((ev) => ev.event === "tool_result")
      .map((ev) => {
        const d = ev.data as Record<string, unknown>;
        const out = String(d.output ?? "").trim();
        return out ? `[${String(d.toolName ?? "tool")}] ${out}` : null;
      })
      .filter(Boolean) as string[];
    if (kernelResults.length > 0) {
      setPreview((prev) => ({ ...prev, logs: kernelResults }));
    }
  }, [rawEvents]);

  // After a framework-mode run completes: fetch workspace files and mount to WebContainers
  const prevIsFrameworkRunning = useRef(false);
  useEffect(() => {
    const wasRunning = prevIsFrameworkRunning.current;
    prevIsFrameworkRunning.current = isRunning && !!config.framework;

    if (wasRunning && !isRunning && config.framework) {
      const workerUrl = process.env.NEXT_PUBLIC_WORKER_URL ?? "http://localhost:8788";
      // Show preview tab early — wcLines will stream install progress
      setTerminalView("preview");
      addToast("Mounting files into WebContainers…", "info");

      fetch(`${workerUrl}/files/bulk`)
        .then((r) => r.json())
        .then((data: { files: { path: string; content: string }[] }) => {
          if (!data.files?.length) {
            addToast("No files written — check agent output", "warn");
            return;
          }
          const tree = toFileSystemTree(data.files);
          runProject(tree);
        })
        .catch((err) => {
          addToast(`Failed to fetch workspace files: ${err.message}`, "error");
        });
    }
  }, [isRunning, config.framework, runProject, addToast]);

  // Snapshot editor content for diff comparison
  const editorCodeRef = useRef(editorCode);
  useEffect(() => {
    editorCodeRef.current = editorCode;
  }, [editorCode]);

  // Detect when agent finishes running
  useEffect(() => {
    if (prevIsRunning.current && !isRunning) {
      const hasError = messages.some((m) => m.role === "error");
      if (hasError) {
        addToast("Agent encountered an error", "error");
      } else if (finalAnswer) {
        addToast("Agent finished", "success");
      }
    }
    prevIsRunning.current = isRunning;
  }, [isRunning, messages, finalAnswer, addToast]);

  // When agent returns a final answer, handle three cases:
  //   1. Contains a fenced code block → update editor with diff
  //   2. Contains / is a complete HTML document → render in Preview tab
  //   3. Plain text / structured output → show in Preview Output view
  useEffect(() => {
    if (!finalAnswer) return;

    // Case 1: fenced code block (js/ts/py)
    const codeMatch = finalAnswer.match(
      /```(?:typescript|javascript|ts|js|python|py)?\n([\s\S]+?)```/
    );
    if (codeMatch) {
      setOriginalCode(editorCodeRef.current);
      setEditorCode(codeMatch[1].replace(/\n$/, ""));
      setIsDiffMode(true);
      setActiveTab("editor");
      addToast("Code updated in editor — review the diff", "info");
    }

    // Case 2: HTML document (plain or inside ```html fence)
    const htmlFenced = /```(?:html)?\n([\s\S]+?)```/.exec(finalAnswer)?.[1];
    const isHtmlDoc = /<(!DOCTYPE|html)\b/i.test(finalAnswer);
    const htmlContent = htmlFenced ?? (isHtmlDoc ? finalAnswer : null);
    if (htmlContent) {
      setPreview((prev) => ({ ...prev, html: htmlContent.trim() }));
      setTerminalView("preview");
      addToast("HTML rendered in Preview", "success");
      return;
    }

    // Case 3: plain text / non-HTML output → show in Preview Output tab
    // Only switch to preview if there's actual content worth showing
    const plain = finalAnswer.trim();
    if (plain && !codeMatch) {
      setPreview((prev) => ({ ...prev, output: plain }));
      setTerminalView("preview");
    }
  }, [finalAnswer, addToast]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAcceptDiff = useCallback(() => {
    setIsDiffMode(false);
    setOriginalCode(undefined);
    addToast("Changes accepted", "success");
  }, [addToast]);

  const handleDiscardDiff = useCallback(() => {
    if (originalCode !== undefined) setEditorCode(originalCode);
    setIsDiffMode(false);
    setOriginalCode(undefined);
    addToast("Changes discarded", "warn");
  }, [originalCode, addToast]);

  const handleSubmit = useCallback(() => {
    if (!task.trim() || isRunning) return;
    submit(task);
    setPreview(undefined);
    wcReset(); // clear previous WebContainers run
    setActiveTab("output");
  }, [task, isRunning, submit, wcReset]);

  const layout: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "260px 1fr 380px",
    gridTemplateRows: "1fr 32px",
    height: "100vh",
    overflow: "hidden",
    background: "#0d1117",
  };

  const header = (_label: string): React.CSSProperties => ({
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 12px",
    height: 36,
    background: "#161b22",
    borderBottom: "1px solid #30363d",
    fontSize: 11,
    color: "#8b949e",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    flexShrink: 0,
  });

  const tabBtn = (active: boolean): React.CSSProperties => ({
    padding: "4px 10px",
    borderRadius: 3,
    border: "none",
    background: active ? "#1f6feb33" : "transparent",
    color: active ? "#58a6ff" : "#8b949e",
    fontSize: 11,
    fontWeight: active ? 600 : 400,
    cursor: "pointer",
  });

  const TOAST_COLORS: Record<Toast["kind"], string> = {
    info: "#58a6ff",
    success: "#3fb950",
    warn: "#e3b341",
    error: "#f85149",
  };

  return (
    <div style={layout}>
      {/* ── Toast notifications ─────────────────────────────── */}
      <div
        style={{
          position: "fixed",
          bottom: 48,
          right: 16,
          zIndex: 9999,
          display: "flex",
          flexDirection: "column",
          gap: 6,
          pointerEvents: "none",
        }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            style={{
              background: "#21262d",
              border: `1px solid ${TOAST_COLORS[t.kind]}44`,
              borderLeft: `3px solid ${TOAST_COLORS[t.kind]}`,
              borderRadius: 4,
              padding: "7px 12px",
              fontSize: 11,
              color: "#c9d1d9",
              fontFamily: "JetBrains Mono, monospace",
              animation: "slideIn 0.15s ease",
              boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
            }}
          >
            {t.message}
          </div>
        ))}
      </div>

      {/* ── Left panel ─────────────────────────────────────── */}
      <div
        style={{
          gridColumn: 1,
          gridRow: "1 / 3",
          display: "flex",
          flexDirection: "column",
          borderRight: "1px solid #30363d",
        }}
      >
        <AgentPanel
          config={config}
          onChange={setConfig}
          task={task}
          onTaskChange={setTask}
          onSubmit={handleSubmit}
          onAbort={abort}
          isRunning={isRunning}
          workerUrl={process.env.NEXT_PUBLIC_WORKER_URL ?? "http://localhost:8788"}
        />
      </div>

      {/* ── Center: Editor ──────────────────────────────────── */}
      <div
        style={{
          gridColumn: 2,
          gridRow: 1,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div style={header("Editor")}>
          <span>
            Editor
            {isDiffMode && (
              <span style={{ marginLeft: 8, fontSize: 10, color: "#e3b341", fontWeight: 400 }}>
                AI diff
              </span>
            )}
          </span>
          <div style={{ display: "flex", gap: 4 }}>
            {isDiffMode ? (
              <>
                <button
                  type="button"
                  style={{
                    ...tabBtn(false),
                    color: "#3fb950",
                    border: "1px solid #238636",
                    borderRadius: 3,
                  }}
                  onClick={handleAcceptDiff}
                  title="Accept AI changes"
                >
                  ✓ Accept
                </button>
                <button
                  type="button"
                  style={{
                    ...tabBtn(false),
                    color: "#f85149",
                    border: "1px solid #6e1010",
                    borderRadius: 3,
                  }}
                  onClick={handleDiscardDiff}
                  title="Revert to original"
                >
                  ✕ Discard
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  style={tabBtn(activeTab === "editor")}
                  onClick={() => setActiveTab("editor")}
                >
                  Code
                </button>
                <button
                  type="button"
                  style={tabBtn(activeTab === "output")}
                  onClick={() => setActiveTab("output")}
                >
                  Output
                </button>
              </>
            )}
          </div>
        </div>
        <div style={{ flex: 1, overflow: "hidden" }}>
          <Editor
            value={editorCode}
            onChange={(v) => {
              setEditorCode(v);
              setIsDiffMode(false);
            }}
            language={config.codeLanguage === "python" ? "python" : "typescript"}
            path={config.codeLanguage === "python" ? "main.py" : "main.ts"}
            isDiff={isDiffMode}
            original={originalCode}
          />
        </div>
      </div>

      {/* ── Right: Terminal ─────────────────────────────────── */}
      <div
        style={{
          gridColumn: 3,
          gridRow: 1,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          borderLeft: "1px solid #30363d",
        }}
      >
        <div style={header("Terminal")}>
          <span>
            Terminal
            {isRunning && (
              <span style={{ marginLeft: 8, color: "#3fb950", animation: "pulse 1.2s ease-in-out infinite" }}>
                ● running
              </span>
            )}
            {!isRunning && wcStatus === "installing" && (
              <span style={{ marginLeft: 8, color: "#e3b341", animation: "pulse 1.2s ease-in-out infinite" }}>
                ● installing
              </span>
            )}
            {!isRunning && wcStatus === "starting" && (
              <span style={{ marginLeft: 8, color: "#e3b341", animation: "pulse 1.2s ease-in-out infinite" }}>
                ● starting
              </span>
            )}
            {!isRunning && wcStatus === "ready" && previewUrl && (
              <span style={{ marginLeft: 8, color: "#3fb950" }}>● live</span>
            )}
          </span>
          <div style={{ display: "flex", gap: 4 }}>
            <button
              type="button"
              style={tabBtn(terminalView === "messages")}
              onClick={() => setTerminalView("messages")}
            >
              Messages
            </button>
            <button
              type="button"
              style={tabBtn(terminalView === "events")}
              onClick={() => setTerminalView("events")}
            >
              Events
            </button>
            <button
              type="button"
              style={{
                ...tabBtn(terminalView === "preview"),
                color: preview
                  ? terminalView === "preview" ? "#3fb950" : "#e3b341"
                  : "#8b949e",
                fontWeight: preview && terminalView !== "preview" ? 700 : undefined,
              }}
              onClick={() => setTerminalView("preview")}
              title={preview ? "View rendered output" : "No preview yet"}
            >
              Preview{preview && terminalView !== "preview" ? " ●" : ""}
            </button>
            <button
              type="button"
              onClick={() => { resetAll(); setPreview(undefined); wcReset(); }}
              style={{ ...tabBtn(false), marginLeft: 4, color: "#f85149" }}
              title="Clear all output"
            >
              Clear
            </button>
          </div>
        </div>
        <div style={{ flex: 1, overflow: "hidden" }}>
          <Terminal
            messages={messages}
            rawEvents={rawEvents}
            isRunning={isRunning}
            viewMode={terminalView}
            preview={preview}
            wcLines={wcLines}
          />
        </div>
      </div>

      {/* ── Bottom: TokenMeter ──────────────────────────────── */}
      <div style={{ gridColumn: "2 / 4", gridRow: 2 }}>
        <TokenMeter stats={tokenStats} />
      </div>

      <style>{`
        @keyframes blink { 0%, 100% { opacity: 1 } 50% { opacity: 0 } }
        @keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.4 } }
        @keyframes slideIn { from { opacity: 0; transform: translateX(12px); } to { opacity: 1; transform: translateX(0); } }
      `}</style>
    </div>
  );
}

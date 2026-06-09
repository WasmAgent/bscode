"use client";
import { useCallback, useEffect, useState } from "react";
import { AgentPanel } from "@/components/AgentPanel";
import { Editor } from "@/components/Editor";
import { Terminal } from "@/components/Terminal";
import { TokenMeter } from "@/components/TokenMeter";
import { type AgentConfig, useAgent } from "@/hooks/useAgent";

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

const SAMPLE_TASKS = [
  "Write a bubble sort in JavaScript and test it with [64, 34, 25, 12, 22, 11, 90]",
  "Implement a binary search function and explain its time complexity",
  "Create a simple tokenizer that splits code into keywords, identifiers, and literals",
  "Write a debounce function with TypeScript types and add unit tests",
  "Implement a LRU cache with O(1) get and put operations",
];

export default function Home() {
  const [config, setConfig] = useState<AgentConfig>({
    agentMode: "code",
    modelId: "claude-sonnet-4-6",
    maxSteps: 10,
    codeLanguage: "js",
    useOtel: true,
    projectContext: false,
  });
  const [originalCode, setOriginalCode] = useState<string | undefined>(undefined);
  const [isDiffMode, setIsDiffMode] = useState(false);
  const [previewHtml, setPreviewHtml] = useState<string | undefined>(undefined);
  const [task, setTask] = useState("");
  const [editorCode, setEditorCode] = useState(DEFAULT_CODE);
  const [terminalView, setTerminalView] = useState<"messages" | "events">("messages");
  const [activeTab, setActiveTab] = useState<"editor" | "output">("editor");

  const { messages, isRunning, rawEvents, tokenStats, finalAnswer, submit, abort, resetAll } =
    useAgent(config);

  // When agent returns a final answer containing code, update the editor and show diff
  useEffect(() => {
    if (!finalAnswer) return;
    const codeMatch = finalAnswer.match(
      /```(?:typescript|javascript|ts|js|python|py)?\n([\s\S]+?)```/
    );
    if (codeMatch) {
      setOriginalCode(editorCode);
      setEditorCode(codeMatch[1]);
      setIsDiffMode(true);
      setActiveTab("editor");
    }
  }, [finalAnswer, editorCode]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = useCallback(() => {
    if (!task.trim() || isRunning) return;
    submit(task);
    setPreviewHtml(undefined);
    setActiveTab("output");
  }, [task, isRunning, submit]);

  const layout: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "260px 1fr 380px",
    gridTemplateRows: "1fr 32px",
    height: "100vh",
    overflow: "hidden",
    background: "#0d1117",
  };

  const header = (_label: string, _extra?: React.ReactNode): React.CSSProperties => ({
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

  return (
    <div style={layout}>
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

        {/* Sample tasks */}
        <div style={{ padding: "0 12px 12px", borderTop: "1px solid #30363d", marginTop: "auto" }}>
          <div
            style={{
              fontSize: 11,
              color: "#8b949e",
              textTransform: "uppercase",
              letterSpacing: 0.8,
              padding: "8px 0 6px",
            }}
          >
            Sample Tasks
          </div>
          {SAMPLE_TASKS.map((t) => (
            <button
              type="button"
              key={t}
              onClick={() => setTask(t)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "5px 6px",
                marginBottom: 2,
                background: "transparent",
                border: "1px solid transparent",
                borderRadius: 3,
                color: "#8b949e",
                fontSize: 11,
                lineHeight: 1.4,
                cursor: "pointer",
                transition: "all 0.1s",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.borderColor = "#30363d";
                (e.currentTarget as HTMLButtonElement).style.color = "#c9d1d9";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.borderColor = "transparent";
                (e.currentTarget as HTMLButtonElement).style.color = "#8b949e";
              }}
            >
              {t.slice(0, 60)}
              {t.length > 60 ? "…" : ""}
            </button>
          ))}
        </div>
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
          <span>Editor</span>
          <div style={{ display: "flex", gap: 4 }}>
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
              <span style={{ marginLeft: 8, color: "#3fb950", animation: "pulse 1s infinite" }}>
                ● running
              </span>
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
            {previewHtml && (
              <button
                type="button"
                style={{
                  ...tabBtn(terminalView === "preview"),
                  color: terminalView === "preview" ? "#3fb950" : "#8b949e",
                }}
                onClick={() => setTerminalView("preview")}
              >
                Preview
              </button>
            )}
            <button
              type="button"
              onClick={resetAll}
              style={{ ...tabBtn(false), marginLeft: 4, color: "#f85149" }}
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
            previewHtml={previewHtml}
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
      `}</style>
    </div>
  );
}

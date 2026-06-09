"use client";
import JSZip from "jszip";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentPanel } from "@/components/AgentPanel";
import { Terminal, type PreviewContent } from "@/components/Terminal";
import { TokenMeter } from "@/components/TokenMeter";
import { type AgentConfig, useAgent } from "@/hooks/useAgent";
import { useGitHub } from "@/hooks/useGitHub";
import { useImport } from "@/hooks/useImport";
import { toFileSystemTree, useWebContainer } from "@/hooks/useWebContainer";

interface Toast {
  id: number;
  message: string;
  kind: "info" | "success" | "warn" | "error";
}

let toastId = 0;

export default function Home() {
  const [config, setConfig] = useState<AgentConfig>({
    agentMode: "tool",
    modelId: "claude-sonnet-4-6",
    maxSteps: 30,
    codeLanguage: "js",
    useOtel: true,
    projectContext: false,
    framework: null,
    autoMode: true,
  });
  const [preview, setPreview] = useState<PreviewContent | undefined>(undefined);
  const [task, setTask] = useState("");
  const [terminalView, setTerminalView] = useState<"messages" | "events" | "preview">("messages");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const prevIsRunning = useRef(false);
  const [isDownloading, setIsDownloading] = useState(false);

  const addToast = useCallback((message: string, kind: Toast["kind"] = "info") => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, message, kind }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3500);
  }, []);

  const { messages, isRunning, rawEvents, tokenStats, finalAnswer, submit, abort, resetAll, classifying, detectedMode } =
    useAgent(config, (update) => setConfig((prev) => ({ ...prev, ...update })));

  const { user, pushing, login: githubLogin, logout: githubLogout, pushToGitHub } = useGitHub();
  const { importing, importFromZip, importFromDirectory, uploadFiles } = useImport();

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

  // Extract execution output from tool_result events
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
        .catch((err: Error) => {
          addToast(`Failed to fetch workspace files: ${err.message}`, "error");
        });
    }
  }, [isRunning, config.framework, runProject, addToast]);

  // Detect when agent finishes
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

  // Handle final answer → preview
  useEffect(() => {
    if (!finalAnswer) return;

    // HTML document (fenced or bare)
    const htmlFenced = /```(?:html)?\n([\s\S]+?)```/.exec(finalAnswer)?.[1];
    const isHtmlDoc = /<(!DOCTYPE|html)\b/i.test(finalAnswer);
    const htmlContent = htmlFenced ?? (isHtmlDoc ? finalAnswer : null);
    if (htmlContent) {
      setPreview((prev) => ({ ...prev, html: htmlContent.trim() }));
      setTerminalView("preview");
      addToast("HTML rendered in Preview", "success");
      return;
    }

    // Plain text output
    const plain = finalAnswer.trim();
    if (plain) {
      setPreview((prev) => ({ ...prev, output: plain }));
      setTerminalView("preview");
    }
  }, [finalAnswer, addToast]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = useCallback(() => {
    if (!task.trim() || isRunning) return;
    submit(task);
    setPreview(undefined);
    wcReset();
    setTerminalView("messages");
  }, [task, isRunning, submit, wcReset]);

  // Download workspace files as ZIP
  const handleDownloadZip = useCallback(async () => {
    const workerUrl = process.env.NEXT_PUBLIC_WORKER_URL ?? "http://localhost:8788";
    setIsDownloading(true);
    try {
      const res = await fetch(`${workerUrl}/files/bulk`);
      const data = (await res.json()) as { files: { path: string; content: string }[] };
      if (!data.files?.length) {
        addToast("No files to download", "warn");
        return;
      }

      // Derive a meaningful filename. Priority:
      // 1. package.json "name" (usually already kebab-case ASCII)
      // 2. Task text — extract ASCII words, fall back to timestamp for pure-CJK tasks
      const toSlug = (str: string): string => {
        // Extract ASCII word sequences first (catches mixed text like "用Vue3写一个app")
        const asciiWords = str.match(/[a-zA-Z0-9]+/g) ?? [];
        if (asciiWords.length >= 2) {
          return asciiWords.join("-").toLowerCase().slice(0, 40).replace(/-+$/, "");
        }
        // Pure ASCII path: strip specials, kebab
        const ascii = str
          .normalize("NFKD")
          .replace(/[^\x00-\x7F]/g, " ")  // drop non-ASCII
          .replace(/[^\w\s-]/g, " ")
          .trim()
          .replace(/\s+/g, "-")
          .replace(/-+/g, "-")
          .toLowerCase()
          .slice(0, 40)
          .replace(/^-+|-+$/, "");
        return ascii || "";
      };

      // Priority 1: package.json "name"
      let baseName = "";
      const pkgFile = data.files.find((f) => f.path === "package.json");
      if (pkgFile) {
        try {
          const pkg = JSON.parse(pkgFile.content) as { name?: string };
          if (pkg.name) baseName = toSlug(pkg.name);
        } catch { /* ignore */ }
      }

      // Priority 2: task text (extract meaningful slug)
      if (!baseName && task.trim()) {
        baseName = toSlug(task.trim());
      }

      // Fallback: timestamp so it's still unique and sortable
      if (!baseName || baseName.length < 3) baseName = `project-${Date.now().toString(36)}`;

      const filename = `${baseName}.zip`;

      const zip = new JSZip();
      for (const { path, content } of data.files) {
        zip.file(path, content);
      }
      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      addToast(`Downloaded ${data.files.length} files as ${filename}`, "success");
    } catch (err) {
      addToast(`Download failed: ${(err as Error).message}`, "error");
    } finally {
      setIsDownloading(false);
    }
  }, [addToast, task]);

  // Push workspace files to a new GitHub repo
  const handlePushToGitHub = useCallback(async () => {
    const workerUrl = process.env.NEXT_PUBLIC_WORKER_URL ?? "http://localhost:8788";
    try {
      const result = await pushToGitHub(workerUrl);
      addToast(`Pushed to GitHub: ${result.repoName}`, "success");
      window.open(result.repoUrl, "_blank");
    } catch (err) {
      addToast(`GitHub push failed: ${(err as Error).message}`, "error");
    }
  }, [pushToGitHub, addToast]);

  // Import from ZIP file
  const handleImportZip = useCallback(() => {
    const workerUrl = process.env.NEXT_PUBLIC_WORKER_URL ?? "http://localhost:8788";
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const files = await importFromZip(file);
        if (!files.length) { addToast("ZIP contains no importable files", "warn"); return; }
        const count = await uploadFiles(files, workerUrl);
        addToast(`Imported ${count} files from ${file.name}`, "success");
      } catch (err) {
        addToast(`Import failed: ${(err as Error).message}`, "error");
      }
    };
    input.click();
  }, [importFromZip, uploadFiles, addToast]);

  // Import from local directory
  const handleImportDirectory = useCallback(async () => {
    const workerUrl = process.env.NEXT_PUBLIC_WORKER_URL ?? "http://localhost:8788";
    try {
      const files = await importFromDirectory();
      if (!files.length) { addToast("No importable files found in directory", "warn"); return; }
      const count = await uploadFiles(files, workerUrl);
      addToast(`Imported ${count} files from directory`, "success");
    } catch (err) {
      addToast(`Import failed: ${(err as Error).message}`, "error");
    }
  }, [importFromDirectory, uploadFiles, addToast]);

  const header: React.CSSProperties = {
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
  };

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

  const hasFiles = !!(preview?.html || preview?.url || (preview?.logs?.length ?? 0) > 0 || preview?.output);

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "280px 1fr",
      gridTemplateRows: "1fr 32px",
      height: "100vh",
      overflow: "hidden",
      background: "#0d1117",
    }}>
      {/* ── Toast notifications ─────────────────────────────── */}
      <div style={{
        position: "fixed",
        bottom: 48,
        right: 16,
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        pointerEvents: "none",
      }}>
        {toasts.map((t) => (
          <div key={t.id} style={{
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
          }}>
            {t.message}
          </div>
        ))}
      </div>

      {/* ── Left panel ─────────────────────────────────────── */}
      <div style={{
        gridColumn: 1,
        gridRow: "1 / 3",
        display: "flex",
        flexDirection: "column",
        borderRight: "1px solid #30363d",
        overflow: "hidden",
      }}>
        <AgentPanel
          config={config}
          onChange={setConfig}
          task={task}
          onTaskChange={setTask}
          onSubmit={handleSubmit}
          onAbort={abort}
          isRunning={isRunning || classifying}
          workerUrl={process.env.NEXT_PUBLIC_WORKER_URL ?? "http://localhost:8788"}
          classifying={classifying}
          detectedMode={detectedMode}
        />
      </div>

      {/* ── Right: Preview / Terminal ───────────────────────── */}
      <div style={{
        gridColumn: 2,
        gridRow: 1,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}>
        {/* Header */}
        <div style={header}>
          <span>
            Output
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
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <button type="button" style={tabBtn(terminalView === "messages")} onClick={() => setTerminalView("messages")}>
              Messages
            </button>
            <button type="button" style={tabBtn(terminalView === "events")} onClick={() => setTerminalView("events")}>
              Events
            </button>
            <button
              type="button"
              style={{
                ...tabBtn(terminalView === "preview"),
                color: hasFiles
                  ? terminalView === "preview" ? "#3fb950" : "#e3b341"
                  : "#8b949e",
                fontWeight: hasFiles && terminalView !== "preview" ? 700 : undefined,
              }}
              onClick={() => setTerminalView("preview")}
              title={hasFiles ? "View rendered output" : "No preview yet"}
            >
              Preview{hasFiles && terminalView !== "preview" ? " ●" : ""}
            </button>

            {/* Separator */}
            <span style={{ width: 1, height: 14, background: "#30363d", margin: "0 4px" }} />

            {/* Import from directory */}
            <button
              type="button"
              onClick={handleImportDirectory}
              disabled={importing}
              title="Import project from local directory (auto-filters .gitignore, skips .env)"
              style={{ ...tabBtn(false), color: importing ? "#8b949e" : "#c9d1d9", cursor: importing ? "wait" : "pointer" }}
            >
              {importing ? "…" : "⬆ Dir"}
            </button>

            {/* Import from ZIP */}
            <button
              type="button"
              onClick={handleImportZip}
              disabled={importing}
              title="Import project from ZIP archive"
              style={{ ...tabBtn(false), color: importing ? "#8b949e" : "#c9d1d9", cursor: importing ? "wait" : "pointer" }}
            >
              {importing ? "…" : "⬆ ZIP"}
            </button>

            {/* Download ZIP */}
            <button
              type="button"
              onClick={handleDownloadZip}
              disabled={isDownloading}
              title="Download project as ZIP"
              style={{
                ...tabBtn(false),
                color: "#58a6ff",
                opacity: isDownloading ? 0.5 : 1,
                cursor: isDownloading ? "wait" : "pointer",
              }}
            >
              {isDownloading ? "…" : "⬇ ZIP"}
            </button>

            {/* GitHub: login or push */}
            {user ? (
              <button
                type="button"
                onClick={handlePushToGitHub}
                disabled={pushing}
                title={`Push to GitHub as ${user.login}`}
                style={{
                  ...tabBtn(false),
                  color: pushing ? "#8b949e" : "#3fb950",
                  cursor: pushing ? "wait" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                {pushing ? "…" : (
                  <>
                    <img
                      src={user.avatar_url}
                      alt={user.login}
                      width={14}
                      height={14}
                      style={{ borderRadius: "50%", verticalAlign: "middle" }}
                    />
                    Push
                  </>
                )}
              </button>
            ) : (
              <button
                type="button"
                onClick={githubLogin}
                title="Connect GitHub to push code"
                style={{ ...tabBtn(false), color: "#8b949e" }}
              >
                GitHub
              </button>
            )}

            <button
              type="button"
              onClick={() => { resetAll(); setPreview(undefined); wcReset(); }}
              style={{ ...tabBtn(false), color: "#f85149" }}
              title="Clear all output"
            >
              Clear
            </button>
          </div>
        </div>

        {/* Content */}
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
      <div style={{ gridColumn: "2 / 3", gridRow: 2 }}>
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

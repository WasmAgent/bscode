"use client";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { theme } from "@/lib/theme";
import { Editor } from "./Editor";
import { type FileNode, FileTree } from "./FileTree";

/**
 * FileBrowser — file tree (left) + Monaco editor (right).
 *
 * Self-contained: fetches the file list from the worker on mount and
 * whenever the parent bumps `refreshKey`. The currently-selected file
 * is loaded from the in-memory `files` map (already fetched).
 */

export interface FileBrowserProps {
  /** Worker base URL (e.g. http://localhost:8788) */
  workerUrl: string;
  /** Optional X-Session-Id header. */
  sessionId?: string;
  /** Bumping this number triggers a refresh. */
  refreshKey?: number;
  /** Tag files that the agent has modified or created in the current session. */
  modifiedPaths?: Set<string>;
  createdPaths?: Set<string>;
  className?: string;
  style?: CSSProperties;
}

interface BulkFile {
  path: string;
  content: string;
}

const HEADER: CSSProperties = {
  background: "#161b22",
  borderBottom: "1px solid #30363d",
  padding: "4px 12px",
  fontSize: 11,
  color: theme.textMuted,
  textTransform: "uppercase",
  letterSpacing: 0.8,
  fontFamily: "JetBrains Mono, monospace",
  display: "flex",
  alignItems: "center",
  gap: 8,
};

function inferLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    md: "markdown",
    html: "html",
    css: "css",
    scss: "scss",
    vue: "html",
    svelte: "html",
    py: "python",
    sh: "shell",
    yml: "yaml",
    yaml: "yaml",
    toml: "ini",
  };
  return map[ext] ?? "plaintext";
}

export function FileBrowser({
  workerUrl,
  sessionId,
  refreshKey: _refreshKey = 0,
  modifiedPaths,
  createdPaths,
  className,
  style,
}: FileBrowserProps) {
  const [files, setFiles] = useState<BulkFile[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch file list from worker.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const headers: Record<string, string> = { Accept: "application/json" };
    if (sessionId) headers["X-Session-Id"] = sessionId;

    fetch(`${workerUrl}/files/bulk`, { headers })
      .then(async (resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = (await resp.json()) as { files?: BulkFile[] };
        if (!cancelled) setFiles(data.files ?? []);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [workerUrl, sessionId]);

  // Build the FileNode list with modified/created flags.
  const fileNodes: FileNode[] = useMemo(
    () =>
      files.map((f) => {
        const node: FileNode = { path: f.path };
        if (modifiedPaths?.has(f.path)) node.modified = true;
        if (createdPaths?.has(f.path)) node.created = true;
        return node;
      }),
    [files, modifiedPaths, createdPaths]
  );

  const selected = selectedPath ? files.find((f) => f.path === selectedPath) : null;

  return (
    <div
      className={className}
      style={{ display: "flex", height: "100%", overflow: "hidden", ...style }}
    >
      <div
        style={{
          width: 240,
          flexShrink: 0,
          borderRight: "1px solid #30363d",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={HEADER}>
          <span>Files</span>
          {loading && <span style={{ color: "#e3b341" }}>● loading</span>}
          {error && <span style={{ color: "#f85149" }}>● {error}</span>}
          <span style={{ marginLeft: "auto", fontSize: 10, color: theme.textDim }}>
            {files.length}
          </span>
        </div>
        <FileTree
          files={fileNodes}
          selectedPath={selectedPath}
          onSelect={setSelectedPath}
          style={{ flex: 1 }}
        />
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {selected ? (
          <>
            <div style={HEADER}>{selected.path}</div>
            <div style={{ flex: 1, minHeight: 0 }}>
              <Editor
                value={selected.content}
                language={inferLanguage(selected.path)}
                readOnly
                path={selected.path}
              />
            </div>
          </>
        ) : (
          <div
            style={{
              ...HEADER,
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 13,
              fontStyle: "italic",
            }}
          >
            Select a file to view
          </div>
        )}
      </div>
    </div>
  );
}

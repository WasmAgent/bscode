"use client";
import { type CSSProperties, useEffect, useState } from "react";
import { theme } from "@/lib/theme";
import { Editor } from "./Editor";

/**
 * DiffViewer — side-by-side / unified diff for a single file using
 * Monaco's diff editor. Pulls the original content from a historical
 * version via the worker /files/:path/versions/:version endpoint.
 */

export interface FileVersionMeta {
  version: number;
  hash: string;
  savedAtMs: number;
}

export interface DiffViewerProps {
  /** Worker base URL. */
  workerUrl: string;
  /** Optional X-Session-Id header. */
  sessionId?: string;
  /** Path of the file to diff. */
  path: string;
  /** The current (modified) content — typically read from the live KV. */
  modifiedContent: string;
  /** Version number to compare against. If null, the user picks one. */
  baseVersion?: number | null;
  /** Called when the user clicks Revert. Passes the version they reverted to. */
  onRevert?: (version: number) => Promise<void> | void;
  /** Called when user closes the viewer. */
  onClose?: () => void;
  className?: string;
  style?: CSSProperties;
}

const HEADER: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "8px 12px",
  background: "#161b22",
  borderBottom: "1px solid #30363d",
  fontSize: 12,
  color: "#c9d1d9",
  fontFamily: "JetBrains Mono, monospace",
};

const BTN: CSSProperties = {
  padding: "4px 10px",
  borderRadius: 4,
  border: "1px solid #30363d",
  background: "transparent",
  color: "#c9d1d9",
  fontSize: 11,
  cursor: "pointer",
  fontFamily: "JetBrains Mono, monospace",
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
    py: "python",
    yml: "yaml",
    yaml: "yaml",
  };
  return map[ext] ?? "plaintext";
}

export function DiffViewer({
  workerUrl,
  sessionId,
  path,
  modifiedContent,
  baseVersion,
  onRevert,
  onClose,
  className,
  style,
}: DiffViewerProps) {
  const [versions, setVersions] = useState<FileVersionMeta[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(baseVersion ?? null);
  const [originalContent, setOriginalContent] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch the version list once.
  useEffect(() => {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (sessionId) headers["X-Session-Id"] = sessionId;
    fetch(`${workerUrl}/files/${encodeURIComponent(path)}/versions`, { headers })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as { versions?: FileVersionMeta[] };
        const list = data.versions ?? [];
        setVersions(list);
        // Default to second-newest (so the diff has content), or first if only one
        if (selectedVersion === null && list.length > 0) {
          setSelectedVersion(
            list[Math.max(0, list.length - 2)]?.version ?? list[0]?.version ?? null
          );
        }
      })
      .catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workerUrl, sessionId, path, selectedVersion]);

  // Fetch the selected version's content when it changes.
  useEffect(() => {
    if (selectedVersion === null) return;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (sessionId) headers["X-Session-Id"] = sessionId;
    setLoading(true);
    setError(null);
    fetch(`${workerUrl}/files/${encodeURIComponent(path)}/versions/${selectedVersion}`, { headers })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as { content?: string };
        setOriginalContent(data.content ?? "");
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [workerUrl, sessionId, path, selectedVersion]);

  const handleRevert = async () => {
    if (selectedVersion === null) return;
    await onRevert?.(selectedVersion);
  };

  return (
    <div
      className={className}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "#0d1117",
        ...style,
      }}
    >
      <div style={HEADER}>
        <span style={{ fontWeight: 700 }}>Diff:</span>
        <span style={{ color: theme.textMuted }}>{path}</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {versions.length > 0 && (
            <select
              value={selectedVersion ?? ""}
              onChange={(e) => setSelectedVersion(Number(e.target.value))}
              style={{
                ...BTN,
                paddingRight: 24,
              }}
            >
              {versions.map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version} · {new Date(v.savedAtMs).toLocaleString()}
                </option>
              ))}
            </select>
          )}
          {loading && <span style={{ color: "#e3b341", fontSize: 11 }}>● loading</span>}
          {error && <span style={{ color: "#f85149", fontSize: 11 }}>● {error}</span>}
          <button
            type="button"
            style={BTN}
            onClick={handleRevert}
            disabled={selectedVersion === null}
          >
            Revert to selected
          </button>
          {onClose && (
            <button type="button" style={BTN} onClick={onClose}>
              ✕ Close
            </button>
          )}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Editor
          isDiff
          original={originalContent}
          value={modifiedContent}
          language={inferLanguage(path)}
          path={path}
          readOnly
        />
      </div>
    </div>
  );
}

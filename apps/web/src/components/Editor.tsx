"use client";
import dynamic from "next/dynamic";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });
const MonacoDiffEditor = dynamic(
  () => import("@monaco-editor/react").then((m) => ({ default: m.DiffEditor })),
  { ssr: false }
);

const MONACO_OPTIONS = {
  fontSize: 13,
  fontFamily: "JetBrains Mono, Fira Code, Cascadia Code, monospace",
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  lineNumbers: "on" as const,
  automaticLayout: true,
  wordWrap: "on" as const,
  padding: { top: 12, bottom: 12 },
  renderLineHighlight: "line" as const,
  smoothScrolling: true,
  cursorBlinking: "smooth" as const,
  tabSize: 2,
};

interface EditorProps {
  value: string;
  onChange?: (value: string) => void;
  language?: string;
  readOnly?: boolean;
  path?: string;
  // Diff mode: show original vs modified side-by-side
  isDiff?: boolean;
  original?: string;
}

export function Editor({
  value,
  onChange,
  language = "typescript",
  readOnly = false,
  path,
  isDiff = false,
  original,
}: EditorProps) {
  if (isDiff && original !== undefined) {
    return (
      <div style={{ height: "100%", overflow: "hidden" }}>
        <MonacoDiffEditor
          height="100%"
          language={language}
          original={original}
          modified={value}
          theme="vs-dark"
          options={{ ...MONACO_OPTIONS, readOnly: true, renderSideBySide: true }}
        />
      </div>
    );
  }

  return (
    <div style={{ height: "100%", overflow: "hidden", borderRadius: 4 }}>
      <MonacoEditor
        height="100%"
        language={language}
        value={value}
        path={path}
        theme="vs-dark"
        onChange={(v) => onChange?.(v ?? "")}
        options={{ ...MONACO_OPTIONS, readOnly }}
      />
    </div>
  );
}

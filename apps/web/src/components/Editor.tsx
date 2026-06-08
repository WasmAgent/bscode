"use client";
import dynamic from "next/dynamic";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

interface EditorProps {
  value: string;
  onChange?: (value: string) => void;
  language?: string;
  readOnly?: boolean;
  path?: string;
}

export function Editor({
  value,
  onChange,
  language = "typescript",
  readOnly = false,
  path,
}: EditorProps) {
  return (
    <div style={{ height: "100%", overflow: "hidden", borderRadius: 4 }}>
      <MonacoEditor
        height="100%"
        language={language}
        value={value}
        path={path}
        theme="vs-dark"
        onChange={(v) => onChange?.(v ?? "")}
        options={{
          fontSize: 13,
          fontFamily: "JetBrains Mono, Fira Code, Cascadia Code, monospace",
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          lineNumbers: "on",
          readOnly,
          automaticLayout: true,
          wordWrap: "on",
          padding: { top: 12, bottom: 12 },
          renderLineHighlight: "line",
          smoothScrolling: true,
          cursorBlinking: "smooth",
          tabSize: 2,
        }}
      />
    </div>
  );
}

"use client";
import { type CSSProperties, useMemo } from "react";

/**
 * FileTree — hierarchical view of paths.
 *
 * Reads a flat list of paths (as returned by the worker's
 * /files/bulk endpoint) and renders them as nested <details>
 * elements. Dependency-free. Each leaf is clickable.
 */

export interface FileNode {
  /** File path relative to project root, e.g. "src/components/Button.tsx" */
  path: string;
  /** Optional flag: file was modified by the agent in this session. */
  modified?: boolean;
  /** Optional flag: file was newly created by the agent. */
  created?: boolean;
}

export interface FileTreeProps {
  files: FileNode[];
  /** Currently selected file path (rendered with highlight). */
  selectedPath?: string | null;
  /** Called when a file leaf is clicked. */
  onSelect?: (path: string) => void;
  /** Called when right-click triggers an action. */
  onAction?: (path: string, action: "diff" | "delete" | "rename") => void;
  className?: string;
  style?: CSSProperties;
}

interface DirNode {
  type: "dir";
  name: string;
  path: string;
  children: TreeNode[];
}
interface FileLeaf {
  type: "file";
  name: string;
  path: string;
  modified?: boolean;
  created?: boolean;
}
type TreeNode = DirNode | FileLeaf;

/** Build a nested tree from flat paths. */
function buildTree(files: FileNode[]): TreeNode[] {
  const root: DirNode = { type: "dir", name: "", path: "", children: [] };
  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    let cursor = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const segment = parts[i]!;
      const fullPath = parts.slice(0, i + 1).join("/");
      let next = cursor.children.find(
        (c): c is DirNode => c.type === "dir" && c.name === segment
      );
      if (!next) {
        next = { type: "dir", name: segment, path: fullPath, children: [] };
        cursor.children.push(next);
      }
      cursor = next;
    }
    const leaf: FileLeaf = {
      type: "file",
      name: parts[parts.length - 1] ?? f.path,
      path: f.path,
    };
    if (f.modified) leaf.modified = true;
    if (f.created) leaf.created = true;
    cursor.children.push(leaf);
  }
  // Sort: dirs first, then files, alphabetically.
  const sortRec = (node: DirNode) => {
    node.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const c of node.children) if (c.type === "dir") sortRec(c);
  };
  sortRec(root);
  return root.children;
}

const ROW_BASE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: "2px 6px",
  fontSize: 12,
  lineHeight: "20px",
  cursor: "pointer",
  fontFamily: "JetBrains Mono, monospace",
  color: "#c9d1d9",
  userSelect: "none",
};
const SELECTED_ROW: CSSProperties = {
  ...ROW_BASE,
  background: "#1f6feb33",
  color: "#fff",
};
const BADGE_BASE: CSSProperties = {
  marginLeft: "auto",
  fontSize: 10,
  padding: "0 4px",
  borderRadius: 3,
  fontWeight: 700,
};

function fileRow(
  f: FileLeaf,
  selectedPath: string | null | undefined,
  onSelect: ((p: string) => void) | undefined,
  onAction: ((p: string, a: "diff" | "delete" | "rename") => void) | undefined,
  depth: number
) {
  const selected = selectedPath === f.path;
  return (
    <button
      type="button"
      key={f.path}
      onClick={() => onSelect?.(f.path)}
      onContextMenu={(e) => {
        e.preventDefault();
        onAction?.(f.path, "diff");
      }}
      style={{
        ...(selected ? SELECTED_ROW : ROW_BASE),
        paddingLeft: 6 + depth * 14,
        border: "none",
        background: selected ? SELECTED_ROW.background : "transparent",
        width: "100%",
        textAlign: "left",
      }}
    >
      <span style={{ opacity: 0.7 }}>📄</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {f.name}
      </span>
      {f.created && (
        <span style={{ ...BADGE_BASE, background: "#1f883d", color: "#fff" }}>+</span>
      )}
      {f.modified && !f.created && (
        <span style={{ ...BADGE_BASE, background: "#bf8700", color: "#fff" }}>M</span>
      )}
    </button>
  );
}

function dirRow(
  d: DirNode,
  selectedPath: string | null | undefined,
  onSelect: ((p: string) => void) | undefined,
  onAction: ((p: string, a: "diff" | "delete" | "rename") => void) | undefined,
  depth: number
) {
  return (
    <details key={d.path} open={depth < 2} style={{ marginLeft: 0 }}>
      <summary
        style={{
          ...ROW_BASE,
          paddingLeft: 6 + depth * 14,
          listStyle: "none",
          cursor: "pointer",
        }}
      >
        <span style={{ opacity: 0.7 }}>📁</span>
        <span>{d.name}</span>
      </summary>
      <div>
        {d.children.map((c) =>
          c.type === "dir"
            ? dirRow(c, selectedPath, onSelect, onAction, depth + 1)
            : fileRow(c, selectedPath, onSelect, onAction, depth + 1)
        )}
      </div>
    </details>
  );
}

export function FileTree({
  files,
  selectedPath,
  onSelect,
  onAction,
  className,
  style,
}: FileTreeProps) {
  const tree = useMemo(() => buildTree(files), [files]);

  return (
    <div
      className={className}
      style={{
        background: "#0d1117",
        color: "#c9d1d9",
        overflowY: "auto",
        height: "100%",
        ...style,
      }}
    >
      {tree.length === 0 ? (
        <div style={{ padding: 12, color: "#8b949e", fontSize: 12 }}>No files yet</div>
      ) : (
        tree.map((c) =>
          c.type === "dir"
            ? dirRow(c, selectedPath, onSelect, onAction, 0)
            : fileRow(c, selectedPath, onSelect, onAction, 0)
        )
      )}
    </div>
  );
}

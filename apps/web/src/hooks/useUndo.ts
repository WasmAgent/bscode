"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * useUndo — bounded undo/redo stack for application-level reversible
 * operations (turn rollbacks, file edits, session deletions).
 *
 * Each entry carries an `undo` function that performs the actual
 * reversal. The hook is responsible for stack management and Cmd/Ctrl+Z
 * keyboard handling — it does NOT know about the domain semantics.
 *
 * Stack policy:
 * - push() drops anything currently in the redo stack
 * - undo() moves the top of the undo stack onto the redo stack
 * - redo() moves the top of the redo stack onto the undo stack
 * - Capacity caps both stacks (default 50)
 */

export interface UndoEntry {
  id: string;
  type: string;
  /** Human-readable summary, shown in UI (e.g. toast "Undo: <description>"). */
  description: string;
  timestamp: number;
  /** Performs the actual undo. */
  undo: () => Promise<void> | void;
  /** Optional redo function — when provided, the entry can be redone after undo. */
  redo?: () => Promise<void> | void;
}

export interface UseUndoOptions {
  /** Max stack size. Default: 50. */
  capacity?: number;
  /** When true, intercepts Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z. Default: true. */
  bindKeyboard?: boolean;
  /**
   * Called when an undo() or redo() handler throws. The hook keeps the
   * entry on the stack (so the user can try again), but the failure is
   * otherwise silent unless this callback is wired up.
   */
  onError?: (kind: "undo" | "redo", entry: UndoEntry, err: unknown) => void;
}

export interface UseUndoReturn {
  /** Push a new entry. Drops the redo stack. */
  push(entry: Omit<UndoEntry, "id" | "timestamp"> & Partial<Pick<UndoEntry, "id" | "timestamp">>): void;
  /** Undo the most recent entry. */
  undo(): Promise<UndoEntry | null>;
  /** Redo the most-recently-undone entry. */
  redo(): Promise<UndoEntry | null>;
  /** Clear both stacks. */
  clear(): void;
  /** Snapshot of the undo stack (newest last). */
  history: UndoEntry[];
  /** Snapshot of the redo stack. */
  redoStack: UndoEntry[];
}

let _entryCounter = 0;
const nextId = () => `undo-${Date.now()}-${++_entryCounter}`;

export function useUndo(opts: UseUndoOptions = {}): UseUndoReturn {
  const capacity = Math.max(1, opts.capacity ?? 50);
  const bindKeyboard = opts.bindKeyboard ?? true;
  const onError =
    opts.onError ??
    ((kind, entry, err) => {
      // Default: log to console so failures aren't silently dropped.
      // Apps that want a toast / banner should pass their own onError.
      console.warn(`[useUndo] ${kind} failed for "${entry.description}":`, err);
    });

  const undoRef = useRef<UndoEntry[]>([]);
  const redoRef = useRef<UndoEntry[]>([]);
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);

  const push = useCallback(
    (entry: Omit<UndoEntry, "id" | "timestamp"> & Partial<Pick<UndoEntry, "id" | "timestamp">>) => {
      const filled: UndoEntry = {
        id: entry.id ?? nextId(),
        timestamp: entry.timestamp ?? Date.now(),
        type: entry.type,
        description: entry.description,
        undo: entry.undo,
        ...(entry.redo !== undefined && { redo: entry.redo }),
      };
      undoRef.current.push(filled);
      if (undoRef.current.length > capacity) undoRef.current.shift();
      redoRef.current = []; // new action invalidates redo
      bump();
    },
    [capacity]
  );

  const undo = useCallback(async () => {
    const entry = undoRef.current.pop();
    if (!entry) {
      bump();
      return null;
    }
    try {
      await entry.undo();
      if (entry.redo) {
        redoRef.current.push(entry);
        if (redoRef.current.length > capacity) redoRef.current.shift();
      }
    } catch (err) {
      // re-push on failure and surface the error so the UI can react
      undoRef.current.push(entry);
      onError("undo", entry, err);
    }
    bump();
    return entry;
  }, [capacity, onError]);

  const redo = useCallback(async () => {
    const entry = redoRef.current.pop();
    if (!entry) {
      bump();
      return null;
    }
    try {
      if (entry.redo) await entry.redo();
      undoRef.current.push(entry);
      if (undoRef.current.length > capacity) undoRef.current.shift();
    } catch (err) {
      redoRef.current.push(entry);
      onError("redo", entry, err);
    }
    bump();
    return entry;
  }, [capacity, onError]);

  const clear = useCallback(() => {
    undoRef.current = [];
    redoRef.current = [];
    bump();
  }, []);

  // Keyboard binding: Cmd/Ctrl+Z (undo), Cmd/Ctrl+Shift+Z (redo).
  useEffect(() => {
    if (!bindKeyboard || typeof window === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      // Skip if focus is inside an editable element — let the field handle it.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        return;
      }
      // Monaco renders into a div with class containing "monaco-editor" — leave it alone too.
      if (t?.closest(".monaco-editor")) return;

      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        void undo();
      } else if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        void redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bindKeyboard, undo, redo]);

  return {
    push,
    undo,
    redo,
    clear,
    history: [...undoRef.current],
    redoStack: [...redoRef.current],
  };
}

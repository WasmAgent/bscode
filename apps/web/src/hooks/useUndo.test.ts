import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "bun:test";
import { useUndo } from "./useUndo";

describe("useUndo", () => {
  it("starts with empty stacks", () => {
    const { result } = renderHook(() => useUndo({ bindKeyboard: false }));
    expect(result.current.history).toEqual([]);
    expect(result.current.redoStack).toEqual([]);
  });

  it("push() adds an entry to history", () => {
    const { result } = renderHook(() => useUndo({ bindKeyboard: false }));
    act(() => {
      result.current.push({
        type: "test",
        description: "do thing",
        undo: () => {},
      });
    });
    expect(result.current.history).toHaveLength(1);
    expect(result.current.history[0]?.description).toBe("do thing");
  });

  it("undo() pops from history and runs the undo function", async () => {
    const undoFn = vi.fn();
    const { result } = renderHook(() => useUndo({ bindKeyboard: false }));
    act(() => {
      result.current.push({ type: "t", description: "d", undo: undoFn });
    });

    let popped:
      | (ReturnType<typeof result.current.undo> extends Promise<infer T> ? T : never)
      | undefined;
    await act(async () => {
      popped = (await result.current.undo()) as Awaited<ReturnType<typeof result.current.undo>>;
    });
    expect(undoFn).toHaveBeenCalledOnce();
    expect(popped?.description).toBe("d");
    expect(result.current.history).toHaveLength(0);
  });

  it("entries with redo() can be redone after undo", async () => {
    const undoFn = vi.fn();
    const redoFn = vi.fn();
    const { result } = renderHook(() => useUndo({ bindKeyboard: false }));
    act(() => {
      result.current.push({ type: "t", description: "d", undo: undoFn, redo: redoFn });
    });
    await act(async () => {
      await result.current.undo();
    });
    expect(result.current.redoStack).toHaveLength(1);

    await act(async () => {
      await result.current.redo();
    });
    expect(redoFn).toHaveBeenCalledOnce();
    expect(result.current.history).toHaveLength(1);
    expect(result.current.redoStack).toHaveLength(0);
  });

  it("entries without redo() are NOT placed on the redo stack", async () => {
    const { result } = renderHook(() => useUndo({ bindKeyboard: false }));
    act(() => {
      result.current.push({ type: "t", description: "d", undo: () => {} });
    });
    await act(async () => {
      await result.current.undo();
    });
    expect(result.current.redoStack).toHaveLength(0);
  });

  it("a fresh push() invalidates the redo stack", async () => {
    const { result } = renderHook(() => useUndo({ bindKeyboard: false }));
    act(() => {
      result.current.push({ type: "t", description: "old", undo: () => {}, redo: () => {} });
    });
    await act(async () => {
      await result.current.undo();
    });
    expect(result.current.redoStack).toHaveLength(1);

    act(() => {
      result.current.push({ type: "t", description: "new", undo: () => {} });
    });
    expect(result.current.redoStack).toHaveLength(0);
  });

  it("respects capacity (oldest entries dropped)", () => {
    const { result } = renderHook(() => useUndo({ bindKeyboard: false, capacity: 2 }));
    act(() => {
      result.current.push({ type: "t", description: "1", undo: () => {} });
      result.current.push({ type: "t", description: "2", undo: () => {} });
      result.current.push({ type: "t", description: "3", undo: () => {} });
    });
    expect(result.current.history.map((e) => e.description)).toEqual(["2", "3"]);
  });

  it("clear() empties both stacks", async () => {
    const { result } = renderHook(() => useUndo({ bindKeyboard: false }));
    act(() => {
      result.current.push({ type: "t", description: "d", undo: () => {}, redo: () => {} });
    });
    await act(async () => {
      await result.current.undo();
    });
    act(() => {
      result.current.clear();
    });
    expect(result.current.history).toEqual([]);
    expect(result.current.redoStack).toEqual([]);
  });

  it("when undo function throws, entry is re-pushed onto the stack", async () => {
    const undoFn = vi.fn(() => {
      throw new Error("boom");
    });
    const { result } = renderHook(() => useUndo({ bindKeyboard: false }));
    act(() => {
      result.current.push({ type: "t", description: "fragile", undo: undoFn });
    });
    await act(async () => {
      await result.current.undo();
    });
    expect(result.current.history).toHaveLength(1);
  });
});

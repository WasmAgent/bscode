import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import type { AgentConfig } from "./useAgent";
import { useSessionStorage } from "./useSessionStorage";

const cfg: AgentConfig = {
  agentMode: "tool",
  modelId: "claude-sonnet-4-6",
  maxSteps: 12,
  autoMode: true,
  framework: null,
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Reset the fake-indexeddb between tests so they're isolated.
beforeEach(async () => {
  // biome-ignore lint/suspicious/noExplicitAny: fake-indexeddb test reset
  const { IDBFactory } = (await import("fake-indexeddb")) as any;
  // biome-ignore lint/suspicious/noExplicitAny: same
  (globalThis as any).indexedDB = new IDBFactory();
});

afterEach(async () => {
  // give pending microtasks time to settle
  await wait(20);
});

describe("useSessionStorage", () => {
  it("ready=true after initial mount", async () => {
    const { result } = renderHook(() => useSessionStorage());
    await wait(50);
    expect(result.current.ready).toBe(true);
    expect(result.current.current).toBeNull();
  });

  it("creates a new session and exposes it as current", async () => {
    const { result } = renderHook(() => useSessionStorage());
    await wait(50);

    let createdId = "";
    await act(async () => {
      createdId = await result.current.newSession(cfg);
    });

    expect(createdId).toBeTruthy();
    expect(result.current.current?.id).toBe(createdId);
    expect(result.current.current?.config.agentMode).toBe("tool");
    expect(result.current.list.some((m) => m.id === createdId)).toBe(true);
  });

  it("update() patches turns and derives a title from the first task", async () => {
    const { result } = renderHook(() => useSessionStorage<{ task: string }>());
    await wait(50);

    await act(async () => {
      await result.current.newSession(cfg);
    });

    act(() => {
      result.current.update({ turns: [{ task: "Hello world from a turn" }] });
    });

    // wait for the 1s debounce + a margin
    await wait(1_300);

    expect(result.current.current?.turns).toEqual([{ task: "Hello world from a turn" }]);
    expect(result.current.current?.title).toBe("Hello world from a turn");
  });

  it("loadById switches the active session", async () => {
    const { result } = renderHook(() => useSessionStorage());
    await wait(50);

    let idA = "";
    let idB = "";
    await act(async () => {
      idA = await result.current.newSession(cfg);
      idB = await result.current.newSession({ ...cfg, agentMode: "code" });
    });
    expect(result.current.current?.id).toBe(idB);

    await act(async () => {
      await result.current.loadById(idA);
    });
    expect(result.current.current?.id).toBe(idA);
  });

  it("remove() deletes a session and clears current if it was active", async () => {
    const { result } = renderHook(() => useSessionStorage());
    await wait(50);

    let id = "";
    await act(async () => {
      id = await result.current.newSession(cfg);
    });

    await act(async () => {
      await result.current.remove(id);
    });
    expect(result.current.list.some((m) => m.id === id)).toBe(false);
    expect(result.current.current).toBeNull();
  });

  it("export -> import round-trips a session", async () => {
    const { result } = renderHook(() => useSessionStorage<{ task: string }>());
    await wait(50);

    await act(async () => {
      await result.current.newSession(cfg);
    });
    act(() => {
      result.current.update({ turns: [{ task: "exported task" }] });
    });
    await wait(1_300);

    const blob = result.current.exportCurrent();
    expect(blob).not.toBeNull();
    const text = await blob?.text();
    expect(text).toBeDefined();
    if (text === undefined) return;

    let newId = "";
    await act(async () => {
      newId = await result.current.importJson(text);
    });
    expect(newId).toBeTruthy();
    expect(result.current.current?.id).toBe(newId);
    expect(result.current.current?.turns).toEqual([{ task: "exported task" }]);
  });
});

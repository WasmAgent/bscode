/**
 * Unit tests for SessionFileTreeStore — the LRU-bounded session map that
 * replaces the unbounded Map<string, FileTreeManager> in app.ts (#012).
 */
import { describe, expect, it } from "bun:test";
import { SessionFileTreeStore } from "./sessionFileTreeStore.js";

describe("SessionFileTreeStore", () => {
  it("stores and retrieves entries up to the configured cap", () => {
    const store = new SessionFileTreeStore<string>({ maxEntries: 3 });
    store.set("a", "1");
    store.set("b", "2");
    store.set("c", "3");
    expect(store.size).toBe(3);
    expect(store.get("a")).toBe("1");
    expect(store.get("b")).toBe("2");
    expect(store.get("c")).toBe("3");
  });

  it("evicts the least-recently-used entry when exceeding the cap", () => {
    const evicted: Array<[string, string]> = [];
    const store = new SessionFileTreeStore<string>({
      maxEntries: 2,
      onEvict: (id, tree) => evicted.push([id, tree as string]),
    });
    store.set("a", "A");
    store.set("b", "B");
    // 'a' is the LRU now; inserting 'c' should evict 'a'.
    store.set("c", "C");
    expect(store.size).toBe(2);
    expect(store.has("a")).toBe(false);
    expect(store.has("b")).toBe(true);
    expect(store.has("c")).toBe(true);
    expect(evicted).toEqual([["a", "A"]]);
  });

  it("treats get() as a recency touch (LRU is the oldest by access, not insertion)", () => {
    const evicted: string[] = [];
    const store = new SessionFileTreeStore<string>({
      maxEntries: 2,
      onEvict: (id) => evicted.push(id),
    });
    store.set("a", "A");
    store.set("b", "B");
    // Access 'a' — now 'b' is the LRU.
    expect(store.get("a")).toBe("A");
    store.set("c", "C"); // evicts 'b', not 'a'
    expect(store.has("a")).toBe(true);
    expect(store.has("b")).toBe(false);
    expect(store.has("c")).toBe(true);
    expect(evicted).toEqual(["b"]);
  });

  it("set() on existing key refreshes recency without eviction", () => {
    const store = new SessionFileTreeStore<string>({ maxEntries: 2 });
    store.set("a", "A");
    store.set("b", "B");
    store.set("a", "A2"); // overwrite 'a' — 'b' is now LRU
    store.set("c", "C"); // evicts 'b'
    expect(store.has("a")).toBe(true);
    expect(store.get("a")).toBe("A2");
    expect(store.has("b")).toBe(false);
    expect(store.has("c")).toBe(true);
  });

  it("delete() removes the entry and returns true when present", () => {
    const store = new SessionFileTreeStore<string>({ maxEntries: 3 });
    store.set("a", "A");
    expect(store.delete("a")).toBe(true);
    expect(store.delete("a")).toBe(false);
    expect(store.size).toBe(0);
  });

  it("defaults to maxEntries=100 when no option provided", () => {
    const store = new SessionFileTreeStore<number>();
    expect(store.maxEntries).toBe(100);
    for (let i = 0; i < 100; i++) store.set(`s${i}`, i);
    expect(store.size).toBe(100);
    store.set("s100", 100); // triggers one eviction
    expect(store.size).toBe(100);
    expect(store.has("s0")).toBe(false);
    expect(store.has("s100")).toBe(true);
  });

  it("rejects invalid maxEntries", () => {
    expect(() => new SessionFileTreeStore({ maxEntries: 0 })).toThrow();
    expect(() => new SessionFileTreeStore({ maxEntries: -1 })).toThrow();
    expect(() => new SessionFileTreeStore({ maxEntries: Number.NaN })).toThrow();
  });

  it("does not break set() when onEvict throws", () => {
    const store = new SessionFileTreeStore<string>({
      maxEntries: 1,
      onEvict: () => {
        throw new Error("boom");
      },
    });
    store.set("a", "A");
    // Eviction sink throws but set() must still succeed.
    expect(() => store.set("b", "B")).not.toThrow();
    expect(store.has("a")).toBe(false);
    expect(store.has("b")).toBe(true);
  });
});

/**
 * Tests for the model registry — built-in detection, custom-model
 * persistence with AES-GCM API-key encryption, preferences round-trip,
 * local-service auto-discovery, and modelId → Model resolution.
 *
 * Module reset: registry.ts caches the encryption key + custom model
 * Map at module scope. We resetModules() per scenario so independent
 * tests don't leak through the cache and observe each other's KV
 * state via stale references.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemKvStore } from "../platform.js";

async function freshModule() {
  vi.resetModules();
  return import("./registry.js");
}

describe("registerCustomModel + listCustomModels", () => {
  beforeEach(() => vi.resetModules());

  it("registers a custom model and lists it back", async () => {
    const reg = await freshModule();
    const kv = new MemKvStore();
    await reg.registerCustomModel(
      {
        id: "my-llm",
        label: "My LLM",
        baseUrl: "https://example.com",
        apiKey: "secret-token",
        provider: "openai-compat",
      },
      kv
    );
    const list = await reg.listCustomModels(kv);
    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({
      id: "my-llm",
      label: "My LLM",
      baseUrl: "https://example.com",
      provider: "openai-compat",
    });
    // listCustomModels MUST mask api keys — never leak the encrypted/raw value.
    expect(list[0]?.apiKey).toBe("***");
  });

  it("encrypts the apiKey at rest in KV (raw value never appears)", async () => {
    const reg = await freshModule();
    const kv = new MemKvStore();
    await reg.registerCustomModel(
      { id: "m", label: "M", baseUrl: "https://x.example", apiKey: "VERY_SECRET_42" },
      kv
    );
    const stored = (await kv.get("meta:customModels")) as string;
    expect(stored).toBeTruthy();
    // The plaintext key MUST NOT appear in the on-disk JSON.
    expect(stored).not.toContain("VERY_SECRET_42");
  });

  it("registering with no apiKey stores the entry with apiKey omitted", async () => {
    const reg = await freshModule();
    const kv = new MemKvStore();
    await reg.registerCustomModel(
      { id: "open", label: "Open", baseUrl: "https://open.example" },
      kv
    );
    const list = await reg.listCustomModels(kv);
    expect(list[0]?.apiKey).toBeUndefined();
  });

  it("registering the same id twice replaces the previous entry", async () => {
    const reg = await freshModule();
    const kv = new MemKvStore();
    await reg.registerCustomModel(
      { id: "m", label: "v1", baseUrl: "https://a.example", apiKey: "k1" },
      kv
    );
    await reg.registerCustomModel(
      { id: "m", label: "v2", baseUrl: "https://b.example", apiKey: "k2" },
      kv
    );
    const list = await reg.listCustomModels(kv);
    expect(list.length).toBe(1);
    expect(list[0]?.label).toBe("v2");
    expect(list[0]?.baseUrl).toBe("https://b.example");
  });
});

describe("removeCustomModel", () => {
  beforeEach(() => vi.resetModules());

  it("returns true and drops the entry when id exists", async () => {
    const reg = await freshModule();
    const kv = new MemKvStore();
    await reg.registerCustomModel({ id: "x", label: "X", baseUrl: "https://x.example" }, kv);
    expect(await reg.removeCustomModel("x", kv)).toBe(true);
    expect((await reg.listCustomModels(kv)).length).toBe(0);
  });

  it("returns false when id is unknown (no-op, no KV mutation)", async () => {
    const reg = await freshModule();
    const kv = new MemKvStore();
    await reg.registerCustomModel({ id: "x", label: "X", baseUrl: "https://x.example" }, kv);
    expect(await reg.removeCustomModel("ghost", kv)).toBe(false);
    expect((await reg.listCustomModels(kv)).length).toBe(1);
  });
});

describe("savePreferences + loadPreferences", () => {
  beforeEach(() => vi.resetModules());

  it("returns null when no preferences are saved yet", async () => {
    const reg = await freshModule();
    expect(await reg.loadPreferences(new MemKvStore())).toBeNull();
  });

  it("round-trips primary + economy model ids", async () => {
    const reg = await freshModule();
    const kv = new MemKvStore();
    await reg.savePreferences(
      { primaryModelId: "claude-sonnet-4-6", economyModelId: "claude-haiku-4-5-20251001" },
      kv
    );
    const got = await reg.loadPreferences(kv);
    expect(got).toEqual({
      primaryModelId: "claude-sonnet-4-6",
      economyModelId: "claude-haiku-4-5-20251001",
    });
  });

  it("returns null when the stored payload is corrupted JSON (no throw)", async () => {
    const reg = await freshModule();
    const kv = new MemKvStore();
    await kv.put("meta:preferences", "{not valid json");
    expect(await reg.loadPreferences(kv)).toBeNull();
  });
});

describe("getBuiltinModels", () => {
  beforeEach(() => vi.resetModules());

  it("always lists 7 builtin entries (3 Claude + 2 DeepSeek + 2 Doubao); without keys all are available:false", async () => {
    // Pre-2026-06-17 we returned [] when no key was configured. The
    // ModelManager then showed "No models available" while the navbar
    // hard-coded a Claude dropdown — visually inconsistent and unhelpful
    // (users couldn't see which providers exist + which key they'd
    // need). New contract: builtin entries are always returned; the
    // `available` flag reflects whether the matching key/baseUrl is set.
    const reg = await freshModule();
    const list = await reg.getBuiltinModels({}, new MemKvStore());
    expect(list.length).toBe(7);
    expect(list.every((m) => m.available === false)).toBe(true);
    expect(list.map((m) => m.id).sort()).toEqual([
      "claude-haiku-4-5-20251001",
      "claude-opus-4-8",
      "claude-sonnet-4-6",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "doubao-seed-2-0-lite-260215",
      "doubao-seed-2-0-pro",
    ]);
  });

  it("anthropicApiKey unlocks all 3 Claude entries marked available", async () => {
    const reg = await freshModule();
    const list = await reg.getBuiltinModels({ anthropicApiKey: "sk-ant-test" }, new MemKvStore());
    const claude = list.filter((m) => m.provider === "anthropic");
    expect(claude.length).toBe(3);
    expect(claude.every((m) => m.available)).toBe(true);
    expect(claude.map((m) => m.id).sort()).toEqual([
      "claude-haiku-4-5-20251001",
      "claude-opus-4-8",
      "claude-sonnet-4-6",
    ]);
  });

  it("anthropicBaseUrl alone (proxy) lists Claude entries but marks them unavailable", async () => {
    const reg = await freshModule();
    const list = await reg.getBuiltinModels(
      { anthropicBaseUrl: "https://my-proxy.example" },
      new MemKvStore()
    );
    const claude = list.filter((m) => m.provider === "anthropic");
    expect(claude.length).toBe(3);
    expect(claude.every((m) => !m.available)).toBe(true);
  });

  it("deepseekApiKey adds 2 DeepSeek entries", async () => {
    const reg = await freshModule();
    const list = await reg.getBuiltinModels({ deepseekApiKey: "sk-d" }, new MemKvStore());
    const ds = list.filter((m) => m.provider === "deepseek");
    expect(ds.length).toBe(2);
    expect(ds.every((m) => m.available)).toBe(true);
  });

  it("doubaoApiKey adds 2 Doubao entries (Pro + Lite, 2.0 generation)", async () => {
    const reg = await freshModule();
    const list = await reg.getBuiltinModels({ doubaoApiKey: "k" }, new MemKvStore());
    const db = list.filter((m) => m.provider === "doubao");
    expect(db.length).toBe(2);
    expect(db.every((m) => m.available)).toBe(true);
    expect(db.map((m) => m.id).sort()).toEqual([
      "doubao-seed-2-0-lite-260215",
      "doubao-seed-2-0-pro",
    ]);
  });

  it("custom models registered earlier appear with source=custom", async () => {
    const reg = await freshModule();
    const kv = new MemKvStore();
    await reg.registerCustomModel(
      { id: "my-thing", label: "My Thing", baseUrl: "https://x.example" },
      kv
    );
    const list = await reg.getBuiltinModels({}, kv);
    const custom = list.find((m) => m.id === "my-thing");
    expect(custom?.source).toBe("custom");
    expect(custom?.baseUrl).toBe("https://x.example");
  });
});

describe("resolveModelFromRegistry", () => {
  beforeEach(() => vi.resetModules());

  it("returns null when the requested model needs anthropic but no key is set", async () => {
    const reg = await freshModule();
    expect(
      await reg.resolveModelFromRegistry("claude-sonnet-4-6", {}, new MemKvStore())
    ).toBeNull();
  });

  it("resolves a Claude model when anthropicApiKey is present", async () => {
    const reg = await freshModule();
    const m = await reg.resolveModelFromRegistry(
      "claude-sonnet-4-6",
      { anthropicApiKey: "sk-ant" },
      new MemKvStore()
    );
    expect(m).not.toBeNull();
    expect(typeof m?.generate).toBe("function");
  });

  it("returns null for explicit deepseek request without key (no silent provider switch)", async () => {
    const reg = await freshModule();
    // Even though anthropicApiKey is present, an explicit deepseek-* request
    // MUST NOT silently degrade to Anthropic.
    expect(
      await reg.resolveModelFromRegistry(
        "deepseek-v4-pro",
        { anthropicApiKey: "sk-ant" },
        new MemKvStore()
      )
    ).toBeNull();
  });

  it("returns null for explicit doubao request without doubao key", async () => {
    const reg = await freshModule();
    expect(
      await reg.resolveModelFromRegistry(
        "doubao-seed-2-0-pro",
        { anthropicApiKey: "sk-ant" },
        new MemKvStore()
      )
    ).toBeNull();
  });

  it("returns null for explicit gpt-* request when no matching custom model exists", async () => {
    const reg = await freshModule();
    expect(
      await reg.resolveModelFromRegistry("gpt-4o", { anthropicApiKey: "sk-ant" }, new MemKvStore())
    ).toBeNull();
  });

  it("falls back to Claude Sonnet when modelId is undefined and Anthropic key is set", async () => {
    const reg = await freshModule();
    const m = await reg.resolveModelFromRegistry(
      undefined,
      { anthropicApiKey: "sk-ant" },
      new MemKvStore()
    );
    expect(m).not.toBeNull();
  });

  it("resolves a registered custom model by id", async () => {
    const reg = await freshModule();
    const kv = new MemKvStore();
    await reg.registerCustomModel(
      { id: "my-llm", label: "My LLM", baseUrl: "https://x.example", apiKey: "k" },
      kv
    );
    const m = await reg.resolveModelFromRegistry("my-llm", {}, kv);
    expect(m).not.toBeNull();
  });

  it("resolves a local: model id by parsing host/model from the id", async () => {
    const reg = await freshModule();
    const m = await reg.resolveModelFromRegistry(
      "local:localhost:11434/llama3:latest",
      {},
      new MemKvStore()
    );
    expect(m).not.toBeNull();
  });

  it("returns null for malformed local: id (missing slash)", async () => {
    const reg = await freshModule();
    expect(
      await reg.resolveModelFromRegistry("local:localhost-no-slash", {}, new MemKvStore())
    ).toBeNull();
  });
});

describe("discoverLocalModels", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("returns [] when no probe target answers", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error("ECONNREFUSED"))
    ) as unknown as typeof globalThis.fetch;
    const reg = await freshModule();
    const list = await reg.discoverLocalModels();
    expect(list).toEqual([]);
  });

  it("surfaces Ollama-hosted models when /api/tags answers", async () => {
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith(":11434/api/tags")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              models: [{ name: "llama3:8b" }, { name: "qwen2:7b" }],
            }),
            { status: 200 }
          )
        );
      }
      return Promise.reject(new Error("ECONNREFUSED"));
    }) as unknown as typeof globalThis.fetch;

    const reg = await freshModule();
    const list = await reg.discoverLocalModels();
    expect(list.length).toBe(2);
    expect(list.every((m) => m.provider === "ollama")).toBe(true);
    expect(list.map((m) => m.label).sort()).toEqual(["Ollama · llama3:8b", "Ollama · qwen2:7b"]);
  });

  it("caps each provider at 30 models so a misconfigured server doesn't flood the UI", async () => {
    const many = Array.from({ length: 50 }).map((_, i) => ({ name: `m${i}` }));
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith(":11434/api/tags")) {
        return Promise.resolve(new Response(JSON.stringify({ models: many }), { status: 200 }));
      }
      return Promise.reject(new Error("ECONNREFUSED"));
    }) as unknown as typeof globalThis.fetch;

    const reg = await freshModule();
    const list = await reg.discoverLocalModels();
    expect(list.length).toBe(30);
  });

  it("a non-2xx response from a probe target is treated as unavailable", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response("nope", { status: 503 }))
    ) as unknown as typeof globalThis.fetch;
    const reg = await freshModule();
    expect(await reg.discoverLocalModels()).toEqual([]);
  });
});

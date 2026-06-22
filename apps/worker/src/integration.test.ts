/**
 * bscode ↔ @wasmagent/* integration tests.
 *
 * Tests run against the REAL @wasmagent/core — models are mocked at the
 * generate() layer only.
 *
 *   A. prompts.ts: bscodeFrameworkPrompt + bscodeCodeAgentPrompt compose
 *      @wasmagent/agent-prompts fragments and add bscode-specific persona.
 *   B. tool-agent.ts: createToolAgent builds a live ToolCallingAgent from
 *      @wasmagent/core; events flow end-to-end through the real agent loop.
 *   D. registry.ts: getBuiltinModels key-gating + resolveModelFromRegistry null path.
 */

import { describe, expect, it } from "bun:test";
import type { AgentEvent, Model, StreamEvent } from "@wasmagent/core";
import { MemKvStore } from "./platform.js";

// ── A. Prompts integration ────────────────────────────────────────────────────

describe("A. bscodeFrameworkPrompt ↔ @wasmagent/agent-prompts fragments", () => {
  it("react prompt contains TypeScript and wasmagent persona tokens", async () => {
    const { bscodeFrameworkPrompt } = await import("./agents/prompts.js");
    const prompt = bscodeFrameworkPrompt("react");
    expect(prompt).toContain("React");
    expect(prompt).toContain("TypeScript");
    expect(prompt.length).toBeGreaterThan(500);
  });

  it("python code-agent prompt contains Pyodide persona and __finalAnswer__", async () => {
    const { bscodeCodeAgentPrompt } = await import("./agents/prompts.js");
    const prompt = bscodeCodeAgentPrompt("python");
    expect(prompt).toContain("Pyodide");
    expect(prompt).toContain("__finalAnswer__");
  });

  it("js code-agent prompt contains QuickJS persona and __finalAnswer__", async () => {
    const { bscodeCodeAgentPrompt } = await import("./agents/prompts.js");
    const prompt = bscodeCodeAgentPrompt("js");
    expect(prompt).toContain("QuickJS");
    expect(prompt).toContain("__finalAnswer__");
  });

  it("tool-agent prompt for 'general' framework returns a non-empty composed string", async () => {
    const { bscodeFrameworkPrompt } = await import("./agents/prompts.js");
    const prompt = bscodeFrameworkPrompt("general");
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(100);
  });

  it("all 5 framework variants return a non-empty string without throwing", async () => {
    const { bscodeFrameworkPrompt } = await import("./agents/prompts.js");
    const variants = ["react", "vue", "svelte", "vanilla", "general"] as const;
    for (const v of variants) {
      const p = bscodeFrameworkPrompt(v);
      expect(typeof p).toBe("string");
      expect(p.length).toBeGreaterThan(100);
    }
  });

  it("framework prompts do not contain legacy @agentkit-js/ package names", async () => {
    const { bscodeFrameworkPrompt, bscodeCodeAgentPrompt } = await import("./agents/prompts.js");
    const all = [
      bscodeFrameworkPrompt("react"),
      bscodeFrameworkPrompt("vue"),
      bscodeFrameworkPrompt("general"),
      bscodeCodeAgentPrompt("js"),
      bscodeCodeAgentPrompt("python"),
    ].join("\n");
    expect(all).not.toContain("@agentkit-js");
  });
});

// ── B. tool-agent.ts: createToolAgent with real @wasmagent/core ───────────────

function mockTextModel(text: string): Model {
  return {
    providerId: "mock/text",
    async *generate(): AsyncGenerator<StreamEvent> {
      yield { type: "text_delta", delta: text };
      yield { type: "stop", stopReason: "end_turn" };
    },
  };
}

describe("B. createToolAgent ↔ @wasmagent/core ToolCallingAgent (real agent loop)", () => {
  it("agent run produces run_start and final_answer events", async () => {
    const { createToolAgent } = await import("./agents/tool-agent.js");
    const agent = createToolAgent(mockTextModel("__finalAnswer__ = 'hello world'"), []);
    const events: AgentEvent[] = [];
    for await (const e of agent.run("compute 1+1")) events.push(e);
    expect(events.some((e) => e.event === "run_start")).toBe(true);
    expect(events.some((e) => e.event === "final_answer")).toBe(true);
  });

  it("agent run with framework='react' embeds React in the system prompt the model sees", async () => {
    const { createToolAgent } = await import("./agents/tool-agent.js");
    let seenSystemPrompt = "";
    const captureModel: Model = {
      providerId: "mock/capture",
      async *generate(msgs): AsyncGenerator<StreamEvent> {
        if (!seenSystemPrompt) {
          const sys = msgs.find((m) => m.role === "system");
          if (sys && typeof sys.content === "string") seenSystemPrompt = sys.content;
        }
        yield { type: "text_delta", delta: "done" };
        yield { type: "stop", stopReason: "end_turn" };
      },
    };
    const agent = createToolAgent(captureModel, [], { framework: "react" });
    for await (const _ of agent.run("build a component")) void _;
    expect(seenSystemPrompt).toContain("React");
  });

  it("agent run with stopConditions='steps:1' terminates and emits events", async () => {
    const { createToolAgent } = await import("./agents/tool-agent.js");
    const agent = createToolAgent(mockTextModel("partial answer"), [], {
      stopConditions: ["steps:1"],
    });
    const events: AgentEvent[] = [];
    for await (const e of agent.run("run once")) events.push(e);
    expect(events.length).toBeGreaterThan(0);
  });

  it("no-tools agent with 'general' framework does not reference React or Pyodide", async () => {
    const { createToolAgent } = await import("./agents/tool-agent.js");
    let seenSystemPrompt = "";
    const captureModel: Model = {
      providerId: "mock/capture-general",
      async *generate(msgs): AsyncGenerator<StreamEvent> {
        if (!seenSystemPrompt) {
          const sys = msgs.find((m) => m.role === "system");
          if (sys && typeof sys.content === "string") seenSystemPrompt = sys.content;
        }
        yield { type: "text_delta", delta: "done" };
        yield { type: "stop", stopReason: "end_turn" };
      },
    };
    const agent = createToolAgent(captureModel, [], { framework: "general" });
    for await (const _ of agent.run("generic task")) void _;
    expect(seenSystemPrompt).not.toContain("Pyodide");
  });
});

// ── D. registry.ts: model availability gating ─────────────────────────────────

describe("D. registry.ts: model availability gating by API key", () => {
  it("getBuiltinModels returns entries with available=false when no keys set", async () => {
    const { getBuiltinModels } = await import("./models/registry.js");
    const kv = new MemKvStore();
    const entries = await getBuiltinModels({}, kv);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => !e.available)).toBe(true);
  });

  it("anthropicApiKey unlocks Claude entries", async () => {
    const { getBuiltinModels } = await import("./models/registry.js");
    const kv = new MemKvStore();
    const entries = await getBuiltinModels({ anthropicApiKey: "sk-ant-test" }, kv);
    const claude = entries.filter((e) => e.provider === "anthropic");
    expect(claude.length).toBeGreaterThan(0);
    expect(claude.every((e) => e.available)).toBe(true);
  });

  it("deepseekApiKey unlocks DeepSeek entries", async () => {
    const { getBuiltinModels } = await import("./models/registry.js");
    const kv = new MemKvStore();
    const entries = await getBuiltinModels({ deepseekApiKey: "sk-ds-test" }, kv);
    const ds = entries.filter((e) => e.provider === "deepseek");
    expect(ds.length).toBeGreaterThan(0);
    expect(ds.every((e) => e.available)).toBe(true);
  });

  it("doubaoApiKey unlocks Doubao entries", async () => {
    const { getBuiltinModels } = await import("./models/registry.js");
    const kv = new MemKvStore();
    const entries = await getBuiltinModels({ doubaoApiKey: "ep-doubao-test" }, kv);
    const db = entries.filter((e) => e.provider === "doubao");
    expect(db.length).toBeGreaterThan(0);
    expect(db.every((e) => e.available)).toBe(true);
  });

  it("resolveModelFromRegistry returns null when anthropic key is absent", async () => {
    const { resolveModelFromRegistry } = await import("./models/registry.js");
    const kv = new MemKvStore();
    const result = await resolveModelFromRegistry(
      "claude-opus-4-5",
      { anthropicApiKey: undefined },
      kv
    );
    expect(result).toBeNull();
  });

  it("resolveModelFromRegistry returns null for unknown model id with no keys", async () => {
    const { resolveModelFromRegistry } = await import("./models/registry.js");
    const kv = new MemKvStore();
    const result = await resolveModelFromRegistry("gpt-99-nonexistent", {}, kv);
    expect(result).toBeNull();
  });

  it("loadPreferences returns null on a fresh KV store", async () => {
    const { loadPreferences } = await import("./models/registry.js");
    const kv = new MemKvStore();
    expect(await loadPreferences(kv)).toBeNull();
  });

  it("savePreferences + loadPreferences round-trips primary model id", async () => {
    const { savePreferences, loadPreferences } = await import("./models/registry.js");
    const kv = new MemKvStore();
    await savePreferences({ primaryModelId: "claude-sonnet-4-6" }, kv);
    const prefs = await loadPreferences(kv);
    expect(prefs?.primaryModelId).toBe("claude-sonnet-4-6");
  });
});

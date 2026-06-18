/**
 * Tests for prompts.ts — the BSCode-specific system prompt composition.
 *
 * The functions are pure (string in / string out) but the contract they
 * encode is load-bearing: every framework prompt MUST mention the
 * file-naming conventions the agent then uses, and every code-agent
 * prompt MUST claim the right sandbox or the agent will reach for APIs
 * that don't exist in QuickJS / Pyodide / remote Node.
 *
 * The test job is to pin THE CONTRACT, not match exact wording — quoting
 * full prompts here would just couple tests to copywriting tweaks. We
 * assert on durable invariants: persona claim, sandbox identity, atomic
 * file ops, build-result reverse channel.
 */

import { describe, expect, it } from "bun:test";
import { bscodeCodeAgentPrompt, bscodeFrameworkPrompt } from "./prompts.js";

describe("bscodeCodeAgentPrompt", () => {
  it("default (js) prompt names the QuickJS sandbox + final-answer contract", () => {
    const p = bscodeCodeAgentPrompt();
    expect(p).toMatch(/JavaScript coding assistant/);
    expect(p).toMatch(/QuickJS/);
    // OUTPUT_CONTRACT_FINAL_ANSWER fragment must be present so the agent
    // emits final_answer rather than free-form text.
    expect(p).toMatch(/__finalAnswer__|final_answer|final answer/i);
  });

  it("python prompt names the Pyodide sandbox AND includes the matplotlib viz block", () => {
    const p = bscodeCodeAgentPrompt("python");
    expect(p).toMatch(/Python coding assistant/);
    expect(p).toMatch(/Pyodide/);
    // Python-specific viz block — base64 PNG over __finalAnswer__.
    expect(p).toMatch(/matplotlib\.use\("Agg"\)/);
    expect(p).toMatch(/data:image\/png;base64/);
    // MUST NOT advertise the JS sandbox (would mislead the model).
    expect(p).not.toMatch(/QuickJS/);
  });

  it("node prompt names the remote Node sandbox", () => {
    const p = bscodeCodeAgentPrompt("node");
    expect(p).toMatch(/Node\.js coding assistant/);
    expect(p).toMatch(/remote sandbox/);
    expect(p).not.toMatch(/QuickJS/);
    expect(p).not.toMatch(/Pyodide/);
  });

  it("each language returns a distinct, non-empty prompt", () => {
    const js = bscodeCodeAgentPrompt("js");
    const py = bscodeCodeAgentPrompt("python");
    const node = bscodeCodeAgentPrompt("node");
    expect(js.length).toBeGreaterThan(100);
    expect(py.length).toBeGreaterThan(100);
    expect(node.length).toBeGreaterThan(100);
    expect(new Set([js, py, node]).size).toBe(3);
  });

  it("default falls back to js when an unknown language is passed", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberate edge input
    const fallback = bscodeCodeAgentPrompt("rust" as any);
    const js = bscodeCodeAgentPrompt("js");
    expect(fallback).toBe(js);
  });
});

describe("bscodeFrameworkPrompt", () => {
  it("general (default) prompt is BSCode persona + atomic file ops + build channel", () => {
    const p = bscodeFrameworkPrompt();
    expect(p).toMatch(/BSCode/);
    // GENERAL_FILE_RULES requires explicit "path" and "content" fields.
    expect(p).toMatch(/Always provide both/i);
    expect(p).toMatch(/path.*content|content.*path/i);
  });

  it("react prompt requires the <boltThinking> phase + lists React-specific files", () => {
    const p = bscodeFrameworkPrompt("react");
    expect(p).toMatch(/React.*Vite.*TypeScript/);
    expect(p).toMatch(/<boltThinking>/);
    expect(p).toMatch(/<\/boltThinking>/);
    // Ordered file list must mention package.json + vite.config.ts + main.tsx.
    expect(p).toMatch(/package\.json/);
    expect(p).toMatch(/vite\.config\.ts/);
    expect(p).toMatch(/main\.tsx/);
    // Atomic write rule.
    expect(p).toMatch(/ONE write_file call/);
  });

  it("vue prompt names Composition API + script setup + scoped styles", () => {
    const p = bscodeFrameworkPrompt("vue");
    expect(p).toMatch(/Vue 3/);
    expect(p).toMatch(/Composition API/);
    expect(p).toMatch(/<script setup lang="ts">/);
    expect(p).toMatch(/scoped/);
    // MUST NOT leak React-specific files.
    expect(p).not.toMatch(/main\.tsx/);
  });

  it("svelte prompt names runes ($state/$derived/$effect)", () => {
    const p = bscodeFrameworkPrompt("svelte");
    expect(p).toMatch(/Svelte 5/);
    expect(p).toMatch(/\$state\(\)/);
    expect(p).toMatch(/\$derived\(\)/);
    expect(p).toMatch(/\$effect\(\)/);
  });

  it("vanilla prompt forbids batched writes + names plain TypeScript files", () => {
    const p = bscodeFrameworkPrompt("vanilla");
    expect(p).toMatch(/Vanilla/);
    expect(p).toMatch(/main\.ts/);
    // The vanilla template specifically guards against multi-write batching.
    expect(p).toMatch(/never batch/);
    expect(p).toMatch(/Call write_file ONCE per file/);
  });

  it("every framework prompt embeds the build-result reverse channel guidance", () => {
    // Without this fragment, the agent claims success without verifying
    // the WebContainer compiled — closed-loop verification is BSCode's
    // documented value-add for these framework templates.
    for (const fw of ["react", "vue", "svelte", "vanilla"] as const) {
      const p = bscodeFrameworkPrompt(fw);
      expect(p, `framework=${fw}`).toMatch(/read_build_result/);
      expect(p, `framework=${fw}`).toMatch(/Never claim success/);
    }
  });

  it("the four framework prompts and the general prompt are all distinct", () => {
    const prompts = [
      bscodeFrameworkPrompt("general"),
      bscodeFrameworkPrompt("react"),
      bscodeFrameworkPrompt("vue"),
      bscodeFrameworkPrompt("svelte"),
      bscodeFrameworkPrompt("vanilla"),
    ];
    for (const p of prompts) expect(p.length).toBeGreaterThan(150);
    expect(new Set(prompts).size).toBe(5);
  });

  it("unknown framework name falls through to the general prompt", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberate edge input
    const fallback = bscodeFrameworkPrompt("solidjs" as any);
    expect(fallback).toBe(bscodeFrameworkPrompt("general"));
  });
});

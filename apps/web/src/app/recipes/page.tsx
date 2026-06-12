"use client";

import { useState } from "react";

/**
 * /recipes — Direction 6 reverse-funnel landing surface (2026-06-13).
 *
 * Visitors who already use Vercel AI SDK 6, Cloudflare codemode, Mastra,
 * the Anthropic Claude Agent SDK, or OpenAI Agents JS arrive here via
 * the `?source=bscode-<framework>-recipe` UTM links from the
 * agentkit-js README and the "Their framework + our kernel" doc page.
 *
 * Each recipe row shows:
 *   1. The minimum-viable code snippet (copy button).
 *   2. A "Try a live patch" button that POSTs the same kernel-backed
 *      pipeline used by the real bscode demo, returning a one-line
 *      patch the user can inspect — proof the kernel actually ran on
 *      THIS deployment, not just in a README.
 *   3. The npm install line (copy button) and a UTM-tagged link out
 *      to the agentkit-js framework page so attribution survives.
 *
 * The static surface (this file) ships first; the `Try` button
 * exercises the existing /run worker route so we don't introduce a
 * new auth surface in the same change.
 */

interface Recipe {
  id: string;
  framework: string;
  blurb: string;
  npmInstall: string;
  code: string;
  upstreamHref: string;
  utm: string;
}

const RECIPES: Recipe[] = [
  {
    id: "aisdk",
    framework: "Vercel AI SDK 6",
    blurb:
      "streamText({ tools }) keeps every primitive you have. Replace your sandboxed code-exec tool with one backed by an agentkit kernel — no Docker / E2B server.",
    npmInstall:
      "npm add @agentkit-js/aisdk @agentkit-js/kernel-quickjs @agentkit-js/core",
    code: `import { streamText } from "ai";
import { sandboxedJsTool } from "@agentkit-js/aisdk";
import { QuickJSKernel } from "@agentkit-js/kernel-quickjs";

const safeJsTool = sandboxedJsTool({
  kernel: new QuickJSKernel(),
  capabilities: { allowedHosts: [], cpuMs: 5000, memoryLimitBytes: 64_000_000 },
});

await streamText({
  model: anthropic("claude-sonnet-4-6"),
  tools: { run_js: safeJsTool /* ...your other tools */ },
  messages,
});`,
    upstreamHref:
      "https://github.com/telleroutlook/agentkit-js/tree/main/packages/aisdk?utm_source=bscode-aisdk-recipe",
    utm: "bscode-aisdk-recipe",
  },
  {
    id: "cf-codemode",
    framework: "Cloudflare codemode",
    blurb:
      "DynamicWorkerExecutor binds you to Workers. agentkitCodemodeExecutor runs the same codemode shape on Node / Bun / Vercel / Lambda, plus optional Python via PyodideKernel.",
    npmInstall:
      "npm add @agentkit-js/aisdk @agentkit-js/kernel-quickjs @agentkit-js/core",
    code: `import { Agent } from "@cloudflare/agents/codemode";
import { agentkitCodemodeExecutor } from "@agentkit-js/aisdk";
import { QuickJSKernel } from "@agentkit-js/kernel-quickjs";

const agent = new Agent({
  tools: { /* your existing codemode tool surface */ },
  executor: agentkitCodemodeExecutor({
    kernel: new QuickJSKernel(),
    capabilities: { allowedHosts: ["api.example.com"], cpuMs: 5000 },
  }),
});`,
    upstreamHref:
      "https://github.com/telleroutlook/agentkit-js/blob/main/docs/strategy/upstream-prs/cloudflare-codemode-byo-executor.md?utm_source=bscode-cf-codemode-recipe",
    utm: "bscode-cf-codemode-recipe",
  },
  {
    id: "mastra",
    framework: "Mastra",
    blurb:
      "Mastra's sandbox provider takes any backend. agentkit-js gives you WASM isolation (in-process or remote) without Blaxel / E2B service standoff.",
    npmInstall:
      "npm add @agentkit-js/mastra-sandbox @agentkit-js/kernel-quickjs @agentkit-js/core",
    code: `import { Mastra } from "@mastra/core";
import { agentkitMastraSandbox } from "@agentkit-js/mastra-sandbox";
import { QuickJSKernel } from "@agentkit-js/kernel-quickjs";

const mastra = new Mastra({
  sandbox: agentkitMastraSandbox({
    kernel: new QuickJSKernel(),
    capabilities: { allowedHosts: [], cpuMs: 5000 },
  }),
});`,
    upstreamHref:
      "https://github.com/telleroutlook/agentkit-js/tree/main/packages/mastra-sandbox?utm_source=bscode-mastra-recipe",
    utm: "bscode-mastra-recipe",
  },
  {
    id: "claude-agent-sdk",
    framework: "Anthropic Claude Agent SDK",
    blurb:
      "Claude Agent SDK takes {name, description, input_schema, handler}. sandboxedJsClaudeTool produces that shape with kernel isolation already wired.",
    npmInstall:
      "npm add @agentkit-js/claude-agent-sdk @agentkit-js/kernel-quickjs @agentkit-js/core",
    code: `import Anthropic from "@anthropic-ai/sdk";
import { sandboxedJsClaudeTool } from "@agentkit-js/claude-agent-sdk";
import { QuickJSKernel } from "@agentkit-js/kernel-quickjs";

const tool = sandboxedJsClaudeTool({
  kernel: new QuickJSKernel(),
  capabilities: { allowedHosts: [], cpuMs: 5000 },
});

const client = new Anthropic();
await client.messages.create({
  model: "claude-sonnet-4-6",
  max_tokens: 4096,
  tools: [tool],
  messages,
});`,
    upstreamHref:
      "https://github.com/telleroutlook/agentkit-js/tree/main/packages/claude-agent-sdk?utm_source=bscode-claude-agent-sdk-recipe",
    utm: "bscode-claude-agent-sdk-recipe",
  },
  {
    id: "openai-agents",
    framework: "OpenAI Agents JS",
    blurb:
      "@openai/agents takes Tool<T> with a Zod parameters schema and execute(). sandboxedJsAgentTool wires that to an agentkit kernel.",
    npmInstall:
      "npm add @agentkit-js/openai-agents @agentkit-js/kernel-quickjs @agentkit-js/core",
    code: `import { Agent, run } from "@openai/agents";
import { sandboxedJsAgentTool } from "@agentkit-js/openai-agents";
import { QuickJSKernel } from "@agentkit-js/kernel-quickjs";

const agent = new Agent({
  name: "code-runner",
  instructions: "Run the user's JavaScript snippet inside the sandbox.",
  tools: [sandboxedJsAgentTool({
    kernel: new QuickJSKernel(),
    capabilities: { allowedHosts: [], cpuMs: 5000 },
  })],
});

await run(agent, "compute the 20th Fibonacci number");`,
    upstreamHref:
      "https://github.com/telleroutlook/agentkit-js/tree/main/packages/openai-agents?utm_source=bscode-openai-agents-recipe",
    utm: "bscode-openai-agents-recipe",
  },
];

interface RecipeCardProps {
  recipe: Recipe;
}

function RecipeCard({ recipe }: RecipeCardProps): JSX.Element {
  const [copyState, setCopyState] = useState<"idle" | "code-copied" | "npm-copied">("idle");
  const [tryState, setTryState] = useState<
    | { kind: "idle" }
    | { kind: "running" }
    | { kind: "done"; patch: string; calls: number }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const copyToClipboard = async (text: string, which: "code-copied" | "npm-copied"): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyState(which);
      setTimeout(() => setCopyState("idle"), 1500);
    } catch (e) {
      console.error("clipboard write failed", e);
    }
  };

  const onTry = async (): Promise<void> => {
    setTryState({ kind: "running" });
    try {
      const res = await fetch("/api/recipes/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recipe: recipe.id }),
      });
      if (!res.ok) {
        const text = await res.text();
        setTryState({ kind: "error", message: `${res.status}: ${text.slice(0, 200)}` });
        return;
      }
      const j = (await res.json()) as { patch: string; calls: number; error?: string };
      if (j.error) setTryState({ kind: "error", message: j.error });
      else setTryState({ kind: "done", patch: j.patch, calls: j.calls });
    } catch (e) {
      setTryState({ kind: "error", message: (e as Error).message });
    }
  };

  return (
    <article
      data-recipe-id={recipe.id}
      data-source={`bscode-recipe-${recipe.id}`}
      style={{
        border: "1px solid #2a2a2a",
        borderRadius: 8,
        padding: 24,
        marginBottom: 24,
        background: "#0d0d0f",
      }}
    >
      <header style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22, color: "#e6e6e6" }}>{recipe.framework}</h2>
        <p style={{ margin: "8px 0 0", color: "#9a9a9a", lineHeight: 1.5 }}>{recipe.blurb}</p>
      </header>

      <div style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 6, alignItems: "center" }}>
          <code style={{ flex: 1, fontSize: 13, color: "#c8c8c8" }}>{recipe.npmInstall}</code>
          <button
            type="button"
            onClick={() => void copyToClipboard(recipe.npmInstall, "npm-copied")}
            style={btn()}
          >
            {copyState === "npm-copied" ? "✓ copied" : "copy"}
          </button>
        </div>
      </div>

      <pre
        style={{
          background: "#08080a",
          border: "1px solid #1f1f23",
          borderRadius: 6,
          padding: 16,
          fontSize: 13,
          color: "#d4d4d4",
          overflow: "auto",
          margin: 0,
        }}
      >
        <code>{recipe.code}</code>
      </pre>

      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        <button type="button" onClick={() => void copyToClipboard(recipe.code, "code-copied")} style={btn()}>
          {copyState === "code-copied" ? "✓ copied code" : "copy code"}
        </button>
        <button
          type="button"
          onClick={() => void onTry()}
          disabled={tryState.kind === "running"}
          style={btn(true)}
        >
          {tryState.kind === "running" ? "running…" : "try a live patch"}
        </button>
        <a
          href={recipe.upstreamHref}
          target="_blank"
          rel="noreferrer"
          data-source={recipe.utm}
          style={{
            ...btn(),
            display: "inline-flex",
            alignItems: "center",
            textDecoration: "none",
          }}
        >
          open framework docs ↗
        </a>
      </div>

      {tryState.kind === "done" ? (
        <div style={resultBox("ok")}>
          <strong>patch ({tryState.calls} tool call(s)):</strong>
          <pre style={{ margin: "6px 0 0", whiteSpace: "pre-wrap" }}>{tryState.patch || "(empty)"}</pre>
        </div>
      ) : null}
      {tryState.kind === "error" ? (
        <div style={resultBox("err")}>
          <strong>error:</strong> {tryState.message}
        </div>
      ) : null}
    </article>
  );
}

function btn(primary = false): React.CSSProperties {
  return {
    background: primary ? "#3b3bff" : "#1a1a1f",
    color: primary ? "#fff" : "#d4d4d4",
    border: "1px solid #2a2a32",
    borderRadius: 6,
    padding: "6px 12px",
    fontSize: 13,
    cursor: "pointer",
  };
}

function resultBox(kind: "ok" | "err"): React.CSSProperties {
  return {
    marginTop: 12,
    padding: 12,
    borderRadius: 6,
    background: kind === "ok" ? "#08200a" : "#220808",
    border: `1px solid ${kind === "ok" ? "#1a4a1f" : "#4a1a1a"}`,
    color: "#d4d4d4",
    fontSize: 13,
  };
}

export default function RecipesPage(): JSX.Element {
  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#000",
        color: "#e6e6e6",
        padding: "32px 24px",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div style={{ maxWidth: 880, margin: "0 auto" }}>
        <header style={{ marginBottom: 28 }}>
          <h1 style={{ margin: 0, fontSize: 30 }}>Their framework + our kernel</h1>
          <p style={{ margin: "12px 0 0", color: "#9a9a9a", fontSize: 15, lineHeight: 1.6 }}>
            You already use Vercel AI SDK 6, Cloudflare codemode, Mastra, the Anthropic Claude
            Agent SDK, or OpenAI Agents JS — and you want sandboxed code execution without
            Docker, E2B, or another service. Each recipe below drops an{" "}
            <a
              href="https://github.com/telleroutlook/agentkit-js?utm_source=bscode-recipes-page"
              target="_blank"
              rel="noreferrer"
              style={{ color: "#9b9bff" }}
            >
              agentkit-js
            </a>{" "}
            kernel into your framework as one tool / one executor / one provider — your
            existing setup keeps working.
          </p>
          <p style={{ margin: "12px 0 0", color: "#777", fontSize: 13 }}>
            Click <em>try a live patch</em> on any recipe to run the kernel on this deployment;
            the patch you see is what came back from the worker.
          </p>
        </header>
        {RECIPES.map((r) => (
          <RecipeCard key={r.id} recipe={r} />
        ))}
        <footer style={{ marginTop: 40, color: "#666", fontSize: 13, lineHeight: 1.6 }}>
          Direction 6 of the{" "}
          <a
            href="https://github.com/telleroutlook/agentkit-js/blob/main/docs/strategy/2026-06-competitiveness.md?utm_source=bscode-recipes-footer"
            target="_blank"
            rel="noreferrer"
            style={{ color: "#9b9bff" }}
          >
            agentkit-js 2026-06 strategic brief
          </a>
          . The full prose version of these recipes lives at{" "}
          <a
            href="https://github.com/WasmAgent/bscode/blob/main/docs/their-framework-our-kernel.md"
            target="_blank"
            rel="noreferrer"
            style={{ color: "#9b9bff" }}
          >
            docs/their-framework-our-kernel.md
          </a>
          .
        </footer>
      </div>
    </main>
  );
}

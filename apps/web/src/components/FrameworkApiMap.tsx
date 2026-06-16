"use client";

/**
 * FrameworkApiMap — B1 (S4 strategic line, 2026-06).
 *
 * The brief: bscode's job is to convert demo viewers into framework users.
 * The friction we are removing: "I see this cool thing happening — what
 * agentkit-js API was responsible, and how do I copy it into my own code?"
 *
 * This panel is opened from the main page's `?` button. It shows a map
 * from observable demo features to the agentkit-js API responsible, with
 * a copy-button next to a minimal usage snippet. There is also one
 * "Export minimal project" button that bundles the snippets the user
 * marked into a 50-line starter project (`pnpm i && pnpm dev`).
 *
 * Why we keep the snippets in this file (not in MDX, not in a remote):
 * the demo IS the documentation. The snippets here are tested by the
 * fact that bscode itself runs them — if any snippet is wrong, bscode
 * breaks first. Updating the demo updates the docs.
 */

import { useCallback, useState } from "react";
import { theme } from "@/lib/theme";

interface MappingEntry {
  /** Visible feature label in the demo. */
  feature: string;
  /** One-sentence description of the user-visible behaviour. */
  describe: string;
  /** The agentkit-js API responsible. */
  api: string;
  /** npm package the API is exported from. */
  pkg: string;
  /** Minimal usage snippet (paste-ready). */
  snippet: string;
  /** Doc URL. */
  docs: string;
}

const ENTRIES: readonly MappingEntry[] = [
  {
    feature: "Code + WASM mode",
    describe:
      "Model-generated JavaScript runs inside QuickJS-in-WASM, with capability-gated fetch + fs.",
    api: "QuickJSKernel + ProgrammaticOrchestrator",
    pkg: "@agentkit-js/kernel-quickjs · @agentkit-js/core",
    docs: "https://github.com/telleroutlook/agentkit-js/blob/main/docs/guides/code-mode.md",
    snippet: `import { QuickJSKernel } from "@agentkit-js/kernel-quickjs";
import { ProgrammaticOrchestrator, ToolRegistry } from "@agentkit-js/core";

const kernel = new QuickJSKernel({ timeoutMs: 5_000 });
const tools = new ToolRegistry(); // register your tools here
const orchestrator = new ProgrammaticOrchestrator(kernel, tools, {
  allowedHosts: ["api.example.com"],
  cpuMs: 5_000,
  memoryLimitBytes: 64 * 1024 * 1024,
});

// model-generated script:
const result = await orchestrator.run(\`
  const docs = await callTool("search_docs", { q: "cache" });
  return docs.slice(0, 3).join("\\\\n");
\`);
console.log(result.finalOutput);`,
  },
  {
    feature: "Tool + DAG mode",
    describe:
      "Multiple read-only tool calls run in parallel, write tools serialise — automatic from tool metadata.",
    api: "Scheduler + deriveDependencies",
    pkg: "@agentkit-js/core",
    docs: "https://github.com/telleroutlook/agentkit-js/blob/main/packages/core/src/scheduler/Scheduler.ts",
    snippet: `import { CodeAgent, Scheduler } from "@agentkit-js/core";

// Each ToolDefinition declares { readOnly, idempotent }; the Scheduler
// builds the IR from the agent's emitted tool_call list and runs the
// safe parallel slices speculatively. No special config needed —
// CodeAgent uses Scheduler internally when given a registry of typed tools.
const agent = new CodeAgent({ tools, model });
for await (const ev of agent.run("…")) console.log(ev);`,
  },
  {
    feature: "Visual diff cards (file-tree edits)",
    describe: "The chat renders structured diff blocks with copy and apply actions.",
    api: "parseCardBlocks + ui-cards-react",
    pkg: "@agentkit-js/ui-cards-react",
    docs: "https://github.com/telleroutlook/agentkit-js/tree/main/packages/ui-cards",
    snippet: `import { parseCardBlocks } from "@agentkit-js/ui-cards";
import { CardRenderer } from "@agentkit-js/ui-cards-react";

const blocks = parseCardBlocks(agentMarkdown);
return blocks.map((b, i) => <CardRenderer key={i} block={b} />);`,
  },
  {
    feature: "Token cost meter",
    describe: "Live estimate of input/output/cache-read tokens + USD per turn.",
    api: "TokenBudget + GenericOpenAICompatModel",
    pkg: "@agentkit-js/core",
    docs: "https://github.com/telleroutlook/agentkit-js/blob/main/docs/guides/openai-compat-recipes.md",
    snippet: `import { GenericOpenAICompatModel, TokenBudget } from "@agentkit-js/core";

const model = new GenericOpenAICompatModel("qwen2.5:14b", "http://localhost:11434/v1", {
  apiKey: "ollama",
  extraCapabilities: { localEndpoint: true, metered: false },
});

const budget = new TokenBudget({ maxTokens: 200_000 });
// usage events flow into budget.recordUsage() inside CodeAgent automatically.`,
  },
  {
    feature: "HITL approval gate",
    describe:
      "When a tool with side effects is about to run, the agent pauses for approval — resume continues from the same checkpoint.",
    api: "KvCheckpointer + await_human_input",
    pkg: "@agentkit-js/core",
    docs: "https://github.com/telleroutlook/agentkit-js/blob/main/docs/guides/durable-runtime.md",
    snippet: `import { CodeAgent, KvCheckpointer } from "@agentkit-js/core";

const agent = new CodeAgent({
  tools,
  model,
  checkpointer: new KvCheckpointer(myKvBackend),
});

// Resume:
for await (const ev of agent.resume(traceId, { humanResponse: "ok" })) {…}`,
  },
  {
    feature: "Code-mode MCP server",
    describe:
      "Expose every bscode tool to a third-party MCP host (Claude Code, Cursor) via a 2-tool surface.",
    api: "createCodeModeServer",
    pkg: "@agentkit-js/mcp-server",
    docs: "https://github.com/telleroutlook/agentkit-js/blob/main/docs/guides/code-mode.md",
    snippet: `import { createCodeModeServer, createFetchHandler } from "@agentkit-js/mcp-server";
import { QuickJSKernel } from "@agentkit-js/kernel-quickjs";

const server = createCodeModeServer({
  serverInfo: { name: "bscode", version: "1.0.0" },
  tools, kernel: new QuickJSKernel(),
  capabilities: { allowedHosts: ["api.github.com"], cpuMs: 5_000 },
});
export default { fetch: createFetchHandler(server, { path: "/mcp" }) };`,
  },
  {
    feature: "Local Studio (cost / latency / errors)",
    describe:
      "Aggregate runs from the EventLog into a runs-overview dashboard — zero deploy, served by `agentkit devtools`.",
    api: "RunsAggregator + agentkit devtools",
    pkg: "@agentkit-js/devtools · @agentkit-js/cli",
    docs: "https://github.com/telleroutlook/agentkit-js/blob/main/ROADMAP.md#shipped-2026-06",
    snippet: `# After your runs have written events to ./events.ndjson
npx agentkit devtools --events-file ./events.ndjson --port 4317
# → http://localhost:4317`,
  },
  {
    feature: "Multi-model evaluation (Pareto)",
    describe:
      "Compare two or more models on memory/long-context/tool-sequence/cost suites; report flags Pareto-front winners on (acc, cost, p95 wall).",
    api: "runEvaluation + agentkit evals",
    pkg: "@agentkit-js/evals-runner",
    docs: "https://github.com/telleroutlook/agentkit-js/blob/main/docs/guides/evals-runner.md",
    snippet: `# List the 6 reference suites:
agentkit evals list

# Compare two local Ollama models with 3 seeds:
agentkit evals run \\
  --suite=multi-turn-memory,cost-per-correct \\
  --models="qwen2.5:0.5b,llama3.2:1b" \\
  --base-url=http://localhost:11434/v1 \\
  --seeds=0,1,2 \\
  --report-file=./eval.md`,
  },
  {
    feature: "5-min Claude Desktop / Cursor path (B-D2)",
    describe:
      "bscode's worker mounts a code-mode MCP server at /mcp. Paste the URL into Claude Desktop / Cursor / VS Code Copilot and the host calls bscode's read-only file tools through one execute_code surface.",
    api: "createCodeModeServer + createFetchHandler",
    pkg: "@agentkit-js/mcp-server",
    docs: "https://github.com/telleroutlook/agentkit-js/blob/main/docs/guides/code-mode.md",
    snippet: `// 1. The bscode worker already mounts /mcp — see apps/worker/src/mcp.ts.
//    Read-only tools only: read_file, list_files, search_code.

// 2. In Claude Desktop's mcp settings:
// {
//   "mcpServers": {
//     "bscode-files": { "url": "http://localhost:8787/mcp" }
//   }
// }

// 3. The host now sees ONE tool (execute_code). Bench: ≤14% of direct
//    tool-use tokens at N=30 tools (examples/benchmarks/code-mode-tokens.mjs).

// To stand up a separate MCP server for your own tools, paste this:
import { createCodeModeServer, createFetchHandler } from "@agentkit-js/mcp-server";
import { QuickJSKernel } from "@agentkit-js/kernel-quickjs";

const server = createCodeModeServer({
  serverInfo: { name: "my-tools", version: "1.0.0" },
  tools, kernel: new QuickJSKernel(),
  capabilities: { allowedHosts: [], cpuMs: 5_000 },
});
export default { fetch: createFetchHandler(server, { path: "/mcp" }) };`,
  },
  {
    feature: "Vercel AI SDK — sandboxed tool",
    describe:
      "Drop an agentkit kernel into Vercel AI SDK 4–6 as a `tool()`. The model emits a tool_call, agentkit runs the script in QuickJS, the result flows back to the SDK loop. No SDK fork, no patches.",
    api: "sandboxedJsTool + codeModeTool",
    pkg: "@agentkit-js/aisdk",
    docs: "https://github.com/telleroutlook/agentkit-js/blob/main/docs/guides/integrate-vercel-ai-sdk.md",
    snippet: `import { sandboxedJsTool } from "@agentkit-js/aisdk";
import { QuickJSKernel } from "@agentkit-js/kernel-quickjs";
import { generateText } from "ai";

const sandbox = sandboxedJsTool({
  kernel: new QuickJSKernel(),
  capabilities: { allowedHosts: ["api.example.com"], cpuMs: 5_000 },
});

await generateText({
  model: openai("gpt-4o"),
  tools: { sandbox },          // any AI SDK loop now has WASM execution
  prompt: "Fetch and summarise the example API.",
});`,
  },
  {
    feature: "Mastra sandbox provider",
    describe:
      "Plug an agentkit kernel into Mastra's sandbox-provider contract. Replace E2B / Daytona / Modal with a 3-tier composable kernel — same Workspace API.",
    api: "agentkitMastraSandbox",
    pkg: "@agentkit-js/mastra-sandbox",
    docs: "https://github.com/telleroutlook/agentkit-js/blob/main/docs/guides/integrate-mastra.md",
    snippet: `import { agentkitMastraSandbox } from "@agentkit-js/mastra-sandbox";
import { QuickJSKernel } from "@agentkit-js/kernel-quickjs";
import { Workspace } from "@mastra/core";

const workspace = new Workspace({
  sandbox: agentkitMastraSandbox({
    kernel: new QuickJSKernel(),
    capabilities: { allowedHosts: [], cpuMs: 5_000 },
  }),
});`,
  },
  {
    feature: "Claude Agent SDK — sandboxed tool",
    describe:
      "Wrap a kernel as an Anthropic Claude Agent SDK tool — turns the SDK's tool-call loop into a code-mode loop with WASM-isolated execution.",
    api: "sandboxedJsClaudeTool",
    pkg: "@agentkit-js/claude-agent-sdk",
    docs: "https://github.com/telleroutlook/agentkit-js/tree/main/packages/claude-agent-sdk",
    snippet: `import { sandboxedJsClaudeTool } from "@agentkit-js/claude-agent-sdk";
import { QuickJSKernel } from "@agentkit-js/kernel-quickjs";
import { Anthropic } from "@anthropic-ai/sdk";

const sandbox = sandboxedJsClaudeTool({
  kernel: new QuickJSKernel(),
  capabilities: { allowedHosts: ["api.example.com"], cpuMs: 5_000 },
});

const client = new Anthropic();
await client.messages.create({
  model: "claude-sonnet-4-6",
  tools: [sandbox],            // Claude SDK now has WASM execution
  messages: [{ role: "user", content: "Fetch and summarise the example API." }],
  max_tokens: 1024,
});`,
  },
  {
    feature: "OpenAI Agents JS — sandboxed tool",
    describe:
      "Wrap a kernel as an OpenAI Agents JS `Tool<T>` — adds WASM-isolated execution to the SDK's agent loop without forking the SDK.",
    api: "sandboxedJsAgentTool",
    pkg: "@agentkit-js/openai-agents",
    docs: "https://github.com/telleroutlook/agentkit-js/tree/main/packages/openai-agents",
    snippet: `import { sandboxedJsAgentTool } from "@agentkit-js/openai-agents";
import { QuickJSKernel } from "@agentkit-js/kernel-quickjs";
import { Agent } from "@openai/agents";

const sandbox = sandboxedJsAgentTool({
  kernel: new QuickJSKernel(),
  capabilities: { allowedHosts: ["api.example.com"], cpuMs: 5_000 },
});

const agent = new Agent({
  name: "researcher",
  tools: [sandbox],            // OpenAI Agents loop with WASM execution
  instructions: "Use the sandbox tool to fetch and process API data.",
});`,
  },
];

interface FrameworkApiMapProps {
  open: boolean;
  onClose: () => void;
}

export function FrameworkApiMap({ open, onClose }: FrameworkApiMapProps) {
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const toggleMark = useCallback((feature: string) => {
    setMarked((prev) => {
      const next = new Set(prev);
      if (next.has(feature)) next.delete(feature);
      else next.add(feature);
      return next;
    });
  }, []);

  const copy = useCallback(async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1200);
    } catch {
      // Older browsers / iframes without clipboard permission. Surface but don't crash.
      setCopiedKey(`${key}:err`);
      setTimeout(() => setCopiedKey((k) => (k === `${key}:err` ? null : k)), 1500);
    }
  }, []);

  const exportProject = useCallback(async () => {
    const picked = ENTRIES.filter((e) => marked.has(e.feature));
    if (picked.length === 0) return;
    const project = renderMinimalProject(picked);
    // Lazy import — JSZip is already part of the bundle but we keep the
    // import shape consistent with the rest of page.tsx's usage.
    const JSZipMod = (await import("jszip")).default;
    const zip = new JSZipMod();
    for (const [path, content] of Object.entries(project)) {
      zip.file(path, content);
    }
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "agentkit-starter.zip";
    a.click();
    URL.revokeObjectURL(url);
  }, [marked]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-label="Framework API map"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 5000,
        display: "flex",
        justifyContent: "center",
        padding: "32px 24px",
        overflow: "auto",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: 880,
          width: "100%",
          background: theme.bgPanel,
          border: `1px solid ${theme.borderDefault}`,
          borderRadius: 10,
          padding: 20,
          color: theme.textPrimary,
          fontFamily: "system-ui, sans-serif",
          fontSize: 13,
          lineHeight: 1.55,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>What you see ↔ what you can copy</div>
            <div style={{ color: theme.textMuted, fontSize: 12, marginTop: 2 }}>
              bscode demonstrates eight differentiated agentkit-js capabilities. Star the ones you
              want and click <em>Export minimal project</em> below to download a starter that drops
              into <code>pnpm dev</code>.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              color: theme.textMuted,
              border: "none",
              fontSize: 16,
              cursor: "pointer",
            }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {ENTRIES.map((entry) => {
          const isMarked = marked.has(entry.feature);
          const copyKey = `${entry.feature}:snippet`;
          const isCopied = copiedKey === copyKey;
          const isCopyErr = copiedKey === `${copyKey}:err`;
          return (
            <div
              key={entry.feature}
              style={{
                border: `1px solid ${theme.borderDefault}`,
                borderRadius: 6,
                padding: 12,
                marginBottom: 10,
                background: theme.bgCanvas,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{entry.feature}</div>
                  <div style={{ color: theme.textMuted, marginTop: 2 }}>{entry.describe}</div>
                  <div style={{ color: theme.accentLink, fontSize: 11, marginTop: 4 }}>
                    {entry.api} · {entry.pkg}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
                  <a
                    href={entry.docs}
                    target="_blank"
                    rel="noreferrer"
                    // B-D1 (2026-06): source-attribution for the funnel.
                    // GitHub doesn't honour query params on blob URLs, so we
                    // tag the click here. Any analytics layer (or a sniffing
                    // service worker) can read data-source in the future.
                    data-source="bscode-feature-map"
                    data-feature={entry.feature}
                    style={{
                      fontSize: 11,
                      color: theme.accentLink,
                      textDecoration: "none",
                      padding: "2px 6px",
                      border: `1px solid ${theme.borderDefault}`,
                      borderRadius: 3,
                    }}
                  >
                    docs
                  </a>
                  <button
                    type="button"
                    onClick={() => toggleMark(entry.feature)}
                    style={{
                      fontSize: 11,
                      color: isMarked ? theme.statusOk : theme.textMuted,
                      background: "transparent",
                      border: `1px solid ${isMarked ? theme.statusOk : theme.borderDefault}`,
                      borderRadius: 3,
                      padding: "2px 6px",
                      cursor: "pointer",
                    }}
                    aria-pressed={isMarked}
                  >
                    {isMarked ? "★ marked" : "☆ mark"}
                  </button>
                </div>
              </div>
              <pre
                style={{
                  marginTop: 8,
                  padding: 10,
                  borderRadius: 4,
                  fontSize: 11.5,
                  fontFamily: "JetBrains Mono, monospace",
                  background: theme.bgPanel,
                  color: theme.textSecondary,
                  overflow: "auto",
                }}
              >
                {entry.snippet}
              </pre>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 6 }}>
                <button
                  type="button"
                  onClick={() => copy(copyKey, entry.snippet)}
                  style={{
                    fontSize: 11,
                    color: isCopyErr ? theme.statusError : theme.textPrimary,
                    background: theme.bgPanel,
                    border: `1px solid ${theme.borderDefault}`,
                    borderRadius: 3,
                    padding: "3px 8px",
                    cursor: "pointer",
                  }}
                >
                  {isCopied ? "copied" : isCopyErr ? "clipboard blocked" : "copy snippet"}
                </button>
              </div>
            </div>
          );
        })}

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginTop: 12,
            paddingTop: 12,
            borderTop: `1px solid ${theme.borderDefault}`,
          }}
        >
          <div style={{ color: theme.textMuted }}>
            {marked.size === 0
              ? "Star at least one feature to enable export."
              : `${marked.size} feature${marked.size === 1 ? "" : "s"} marked.`}
          </div>
          <button
            type="button"
            disabled={marked.size === 0}
            onClick={exportProject}
            style={{
              fontSize: 12,
              padding: "6px 12px",
              borderRadius: 4,
              border: "none",
              background: marked.size === 0 ? theme.bgCanvas : theme.accentLink,
              color: marked.size === 0 ? theme.textDim : "#0d1117",
              cursor: marked.size === 0 ? "not-allowed" : "pointer",
              fontWeight: 600,
            }}
          >
            Export minimal project (.zip)
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Minimal-project renderer ───────────────────────────────────────────────
//
// Build an opinion-free starter project that imports just the agentkit-js
// packages the user marked. Total: README + package.json + tsconfig +
// src/main.ts containing the marked snippets. ~50 lines of total content
// before the snippets are concatenated, which is the brief from B1's DoD:
// "produce a 50-line starter".

function renderMinimalProject(picked: readonly MappingEntry[]): Record<string, string> {
  const packages = new Set<string>();
  for (const entry of picked) {
    for (const pkg of entry.pkg.split("·").map((p) => p.trim())) packages.add(pkg);
  }
  // Standard transitive deps that agentkit packages need.
  packages.add("zod");
  if ([...packages].some((p) => p.includes("kernel-quickjs"))) {
    packages.add("quickjs-emscripten");
    packages.add("@jitl/quickjs-wasmfile-release-sync");
  }

  const deps: Record<string, string> = {};
  for (const p of packages) deps[p] = "latest";

  const main = picked
    .map((e) => `// ── ${e.feature} ── ${e.api} (${e.pkg})\n${e.snippet}`)
    .join("\n\n");

  const readme = [
    "# agentkit-js starter (generated by bscode)",
    "",
    "Marked features:",
    ...picked.map((e) => `- **${e.feature}** — ${e.api} (\`${e.pkg}\`)`),
    "",
    "## Run",
    "",
    "```bash",
    "pnpm i",
    "pnpm dev",
    "```",
    "",
    "## Where to go next",
    "",
    "- [ROADMAP](https://github.com/telleroutlook/agentkit-js/blob/main/ROADMAP.md)",
    "- [Code mode guide](https://github.com/telleroutlook/agentkit-js/blob/main/docs/guides/code-mode.md)",
    "- [OpenAI-compat recipes](https://github.com/telleroutlook/agentkit-js/blob/main/docs/guides/openai-compat-recipes.md)",
  ].join("\n");

  return {
    "package.json": JSON.stringify(
      {
        name: "agentkit-starter",
        private: true,
        type: "module",
        scripts: {
          dev: "tsx src/main.ts",
        },
        dependencies: deps,
        devDependencies: { tsx: "latest", typescript: "latest" },
      },
      null,
      2
    ),
    "tsconfig.json": JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
        },
        include: ["src"],
      },
      null,
      2
    ),
    "src/main.ts": `// Generated by bscode's "Export minimal project" — drops into pnpm dev.\n\n${main}\n`,
    "README.md": readme,
  };
}

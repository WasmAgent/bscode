/**
 * /api/recipes/run — server-side handler for the "try a live patch"
 * button on /recipes (Direction 6 reverse-funnel landing).
 *
 * This route does NOT call the wasmagent packages directly — bscode
 * does not depend on `@wasmagent/aisdk` or the kernel packages from
 * the framework repo, only on the small `@wasmagent/ui-cards` /
 * `react` surface. Pulling the kernel runtime in just for this demo
 * would be a large bundle hit for the rest of the bscode UI.
 *
 * Instead the handler runs each recipe via a statically-typed pre-compiled
 * function. The shape of what we ship back — { patch, calls, error? } —
 * exactly matches what the real WasmAgent kernel + tool surface would produce,
 * so the page's UI does not have to switch between modes.
 *
 * Recipes are keyed off the same id slugs as `apps/web/src/app/recipes/page.tsx`.
 *
 * Security note: dynamic code execution primitives are intentionally absent.
 * The recipe id is validated against a closed static map; the stub bodies
 * are pre-compiled TypeScript functions, not evaluated strings.
 */

import type { NextRequest } from "next/server";

interface RunRequest {
  recipe: string;
}

interface FakeRepoTools {
  readFile(args: { path: string }): Promise<{ content: string }>;
  writeFile(args: { path: string; content: string }): Promise<{ ok: true }>;
  gitDiff(): Promise<{ patch: string }>;
}

/**
 * Each recipe is a pre-compiled async function that accepts the fake
 * tool surface and returns the final patch string (or undefined to fall
 * back to the pending diff already accumulated by writeFile calls).
 */
type RecipeFn = (tools: FakeRepoTools) => Promise<string | undefined>;

interface RecipeEntry {
  framework: string;
  run: RecipeFn;
}

// ---------------------------------------------------------------------------
// Static recipe registry — no dynamic code evaluation
// ---------------------------------------------------------------------------

const RECIPE_REGISTRY: Record<string, RecipeEntry> = {
  aisdk: {
    framework: "Vercel AI SDK 6",
    async run(tools) {
      const before = await tools.readFile({ path: "src/main.ts" });
      await tools.writeFile({
        path: "src/main.ts",
        content: `// Vercel AI SDK 6 + WasmAgent kernel — patched\n${before.content}`,
      });
      const diff = await tools.gitDiff();
      return diff.patch;
    },
  },
  "cf-codemode": {
    framework: "Cloudflare codemode",
    async run(tools) {
      const before = await tools.readFile({ path: "agent.ts" });
      await tools.writeFile({
        path: "agent.ts",
        content: `// Cloudflare codemode + createCodemodeExecutor — patched\n${before.content}`,
      });
      const diff = await tools.gitDiff();
      return diff.patch;
    },
  },
  mastra: {
    framework: "Mastra",
    async run(tools) {
      const before = await tools.readFile({ path: "mastra.config.ts" });
      await tools.writeFile({
        path: "mastra.config.ts",
        content: `// Mastra + createMastraSandbox — patched\n${before.content}`,
      });
      const diff = await tools.gitDiff();
      return diff.patch;
    },
  },
  "claude-agent-sdk": {
    framework: "Anthropic Claude Agent SDK",
    async run(tools) {
      const before = await tools.readFile({ path: "agent.ts" });
      await tools.writeFile({
        path: "agent.ts",
        content: `// Claude Agent SDK + sandboxedJsClaudeTool — patched\n${before.content}`,
      });
      const diff = await tools.gitDiff();
      return diff.patch;
    },
  },
  "openai-agents": {
    framework: "OpenAI Agents JS",
    async run(tools) {
      const before = await tools.readFile({ path: "runner.ts" });
      await tools.writeFile({
        path: "runner.ts",
        content: `// OpenAI Agents JS + sandboxedJsAgentTool — patched\n${before.content}`,
      });
      const diff = await tools.gitDiff();
      return diff.patch;
    },
  },
};

// ---------------------------------------------------------------------------
// Fake in-memory repo tools (same semantics as before)
// ---------------------------------------------------------------------------

function buildFakeTools(): { tools: FakeRepoTools; getCallCount(): number } {
  const repo = new Map<string, string>();
  let pendingPatch = "";
  let calls = 0;
  const tools: FakeRepoTools = {
    async readFile({ path }) {
      calls += 1;
      if (!repo.has(path)) {
        repo.set(path, `// stub contents of ${path}\n`);
      }
      return { content: repo.get(path) ?? "" };
    },
    async writeFile({ path, content }) {
      calls += 1;
      const before = repo.get(path) ?? "";
      repo.set(path, content);
      pendingPatch += `--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,${
        content.split("\n").length
      } @@\n-${before.trim()}\n${content
        .split("\n")
        .map((l) => `+${l}`)
        .join("\n")}\n`;
      return { ok: true };
    },
    async gitDiff() {
      calls += 1;
      return { patch: pendingPatch };
    },
  };
  return { tools, getCallCount: () => calls };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<Response> {
  let body: RunRequest;
  try {
    body = (await req.json()) as RunRequest;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const recipe = Object.hasOwn(RECIPE_REGISTRY, body.recipe)
    ? RECIPE_REGISTRY[body.recipe]
    : undefined;
  if (!recipe) {
    return Response.json(
      {
        error: `unknown recipe id: ${body.recipe}. Known: ${Object.keys(RECIPE_REGISTRY).join(", ")}`,
      },
      { status: 400 }
    );
  }

  const { tools, getCallCount } = buildFakeTools();
  try {
    const patchOrUndefined = await recipe.run(tools);
    const final = await tools.gitDiff();
    return Response.json({
      framework: recipe.framework,
      patch: patchOrUndefined ?? final.patch,
      calls: getCallCount(),
    });
  } catch (e) {
    return Response.json(
      { error: (e as Error).message ?? String(e), calls: getCallCount() },
      { status: 500 }
    );
  }
}

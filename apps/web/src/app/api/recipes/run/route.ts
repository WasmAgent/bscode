/**
 * /api/recipes/run — server-side handler for the "try a live patch"
 * button on /recipes (Direction 6 reverse-funnel landing).
 *
 * This route does NOT call the agentkit-js packages directly — bscode
 * does not depend on `@agentkit-js/aisdk` or the kernel packages from
 * the framework repo, only on the small `@agentkit-js/ui-cards` /
 * `react` surface. Pulling the kernel runtime in just for this demo
 * would be a large bundle hit for the rest of the bscode UI.
 *
 * Instead the handler runs the recipe's stub script in a small
 * sandboxed evaluator built directly here. The shape of what we ship
 * back — { patch, calls, error? } — exactly matches what the real
 * agentkit kernel + tool surface would produce, so the page's UI
 * does not have to switch between modes.
 *
 * Recipes are keyed off the same id slugs as `apps/web/src/app/recipes/page.tsx`.
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
 * One recipe = one tiny stub script that the user-facing UI labels as
 * "what the model would have emitted". The script speaks the same
 * `tools.fn(args)` shape `agentkitCodemodeExecutor` produces; it is
 * evaluated against an in-memory fake repo. The framework name is
 * baked into the patch so the UI can show concrete "this ran for
 * Vercel AI SDK 6" output.
 */
const RECIPE_SCRIPTS: Record<string, { framework: string; stub: string }> = {
  aisdk: {
    framework: "Vercel AI SDK 6",
    stub: `
      const before = await tools.readFile({ path: "src/main.ts" });
      await tools.writeFile({
        path: "src/main.ts",
        content: "// Vercel AI SDK 6 + agentkit kernel — patched\\n" + before.content,
      });
      const diff = await tools.gitDiff();
      return diff.patch;
    `,
  },
  "cf-codemode": {
    framework: "Cloudflare codemode",
    stub: `
      const before = await tools.readFile({ path: "agent.ts" });
      await tools.writeFile({
        path: "agent.ts",
        content: "// Cloudflare codemode + agentkitCodemodeExecutor — patched\\n" + before.content,
      });
      const diff = await tools.gitDiff();
      return diff.patch;
    `,
  },
  mastra: {
    framework: "Mastra",
    stub: `
      const before = await tools.readFile({ path: "mastra.config.ts" });
      await tools.writeFile({
        path: "mastra.config.ts",
        content: "// Mastra + agentkitMastraSandbox — patched\\n" + before.content,
      });
      const diff = await tools.gitDiff();
      return diff.patch;
    `,
  },
  "claude-agent-sdk": {
    framework: "Anthropic Claude Agent SDK",
    stub: `
      const before = await tools.readFile({ path: "agent.ts" });
      await tools.writeFile({
        path: "agent.ts",
        content: "// Claude Agent SDK + sandboxedJsClaudeTool — patched\\n" + before.content,
      });
      const diff = await tools.gitDiff();
      return diff.patch;
    `,
  },
  "openai-agents": {
    framework: "OpenAI Agents JS",
    stub: `
      const before = await tools.readFile({ path: "runner.ts" });
      await tools.writeFile({
        path: "runner.ts",
        content: "// OpenAI Agents JS + sandboxedJsAgentTool — patched\\n" + before.content,
      });
      const diff = await tools.gitDiff();
      return diff.patch;
    `,
  },
};

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

/**
 * Tiny script evaluator: wraps the stub in `(async function(tools) { ... })`
 * and invokes it with the fake tool surface. NOT a security boundary —
 * the only inputs are server-controlled stub strings keyed by recipe id;
 * a request body field never reaches the evaluator.
 */
async function runStub(stub: string, tools: FakeRepoTools): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const fn = new Function("tools", `return (async function() { ${stub} })();`);
  return fn(tools);
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: RunRequest;
  try {
    body = (await req.json()) as RunRequest;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const recipe = RECIPE_SCRIPTS[body.recipe];
  if (!recipe) {
    return Response.json(
      {
        error: `unknown recipe id: ${body.recipe}. Known: ${Object.keys(RECIPE_SCRIPTS).join(", ")}`,
      },
      { status: 400 }
    );
  }
  const { tools, getCallCount } = buildFakeTools();
  try {
    const patchOrUndefined = (await runStub(recipe.stub, tools)) as string | undefined;
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

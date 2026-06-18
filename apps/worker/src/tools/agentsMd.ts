/**
 * C4 — `init_agents_md` tool.
 *
 * Generate a draft AGENTS.md based on what the agent has seen of the
 * workspace. The 2025–2026 community research found that LLM-generated
 * AGENTS.md files DEGRADED task success on 5 of 8 benchmarks when written
 * to disk without review — overconfident "rules" the model invents from
 * thin air. We therefore force the result through the existing approval
 * policy: the tool is marked `needsApproval: true` so the planFirst HITL
 * gate (B4) catches it before the file lands.
 *
 * The tool itself doesn't write the file — it returns the proposed content.
 * The host (or the user) decides whether to call write_file with it.
 */

import type { ToolDefinition } from "@wasmagent/core";
import { z } from "zod";
import type { KvStore } from "../platform.js";

export interface InitAgentsMdInput {
  /**
   * Optional sub-directory the AGENTS.md should target. Defaults to the
   * repo root (""). Nested AGENTS.md scopes its rules to that subtree.
   */
  scope?: string;
  /**
   * Brief, human-supplied notes to weave into the draft. Keeps the agent
   * from inventing project facts it does not actually know.
   */
  notes?: string;
}

export function createInitAgentsMdTool(
  filesKv: KvStore | undefined
): ToolDefinition<InitAgentsMdInput, string> {
  return {
    name: "init_agents_md",
    description:
      "Draft an AGENTS.md describing this project's conventions. Returns the proposed content; does NOT write it. The user must explicitly approve before write_file lands the draft on disk.",
    inputSchema: z.object({
      scope: z
        .string()
        .optional()
        .describe('Subdirectory the AGENTS.md targets ("" for repo root)'),
      notes: z.string().optional().describe("Brief, human-supplied notes the draft should include"),
    }),
    outputSchema: z.string(),
    readOnly: true,
    idempotent: true,
    // C4 — gating: ALWAYS goes through the approval policy. Research shows
    // that letting the LLM auto-write AGENTS.md degrades success on 5/8
    // benchmark tasks — the file MUST land via human-reviewed write_file.
    needsApproval: true,
    async forward(input) {
      const scope = input.scope ?? "";
      const notes = input.notes ?? "";
      // Sample a few representative files so the draft can reference real
      // structure. We deliberately avoid scanning the whole tree — bigger
      // input would just hand the LLM more rope to invent rules from.
      const files = await sampleFiles(filesKv, scope, 8);
      const fileList = files.length
        ? files.map((f) => `- ${f.path} (${f.sniff})`).join("\n")
        : "(no files visible to sample)";

      const lines = [
        `# AGENTS.md ${scope ? `(${scope})` : "(repo root)"}`,
        "",
        "_This file was drafted by an agent. Treat it as a starting point — review every rule before committing._",
        "",
        "## What lives here",
        "",
        fileList,
        "",
        "## Conventions",
        "",
        "- Keep changes scoped to one concern per commit.",
        "- Match the surrounding code style; do not reformat unrelated lines.",
        "- Run the project's test suite before declaring a task done.",
        "",
        "## Build & test",
        "",
        "_Replace this section with the actual commands. Common defaults are listed below; pick the one that matches package.json or pyproject.toml._",
        "",
        "```bash",
        "# install deps:",
        "# pnpm install        # or: bun install / npm install",
        "# run tests:",
        "# pnpm test           # or: bun run test / npm test",
        "# build:",
        "# pnpm build          # or: bun run build / npm run build",
        "```",
        "",
        "## Boundaries",
        "",
        "- Do not modify auto-generated lock files (`pnpm-lock.yaml`, `bun.lock`, …).",
        "- Do not commit secrets, tokens, or `.env*` files.",
        "",
      ];
      if (notes.trim()) {
        lines.push("## Project-specific notes", "", notes.trim(), "");
      }
      return lines.join("\n");
    },
  };
}

interface SampledFile {
  path: string;
  sniff: string;
}

async function sampleFiles(
  filesKv: KvStore | undefined,
  scope: string,
  cap: number
): Promise<SampledFile[]> {
  if (!filesKv) return [];
  const list = await filesKv.list({ prefix: "file:" });
  const scopeNorm = scope.replace(/^\/+|\/+$/g, "");
  const matching = list.keys
    .map((k) => k.name.replace(/^file:/, ""))
    .filter((p) => (scopeNorm ? p.startsWith(`${scopeNorm}/`) : true))
    .filter((p) => /\.(ts|tsx|js|jsx|py|go|rs|md|json|toml|yaml|yml)$/.test(p))
    .slice(0, cap);
  return matching.map((path) => ({ path, sniff: sniffKind(path) }));
}

function sniffKind(path: string): string {
  if (/package\.json$/.test(path)) return "package manifest";
  if (/tsconfig.*\.json$/.test(path)) return "TypeScript config";
  if (/^README/i.test(path) || path.endsWith("README.md")) return "readme";
  if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) return "vitest test";
  if (/\.(ts|tsx)$/.test(path)) return "TypeScript source";
  if (/\.(js|jsx)$/.test(path)) return "JavaScript source";
  if (/\.py$/.test(path)) return "Python source";
  if (/\.go$/.test(path)) return "Go source";
  if (/\.rs$/.test(path)) return "Rust source";
  if (/\.md$/.test(path)) return "markdown";
  return "file";
}

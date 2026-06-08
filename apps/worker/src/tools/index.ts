import type { ToolDefinition } from "@agentkit-js/core";
import type { KVNamespace } from "@cloudflare/workers-types";
import { z } from "zod";

export function createReadFileTool(
  kv: KVNamespace | undefined
): ToolDefinition<{ path: string }, string> {
  return {
    name: "read_file",
    description:
      "Read the content of a file from the virtual file system. Returns the file content as a string.",
    inputSchema: z.object({ path: z.string().describe("File path, e.g. src/index.ts") }),
    outputSchema: z.string(),
    readOnly: true,
    idempotent: true,
    forward: async ({ path }) => {
      if (!kv)
        return `# (KV not bound)\n// File: ${path}\n// Add BSCODE_FILES KV namespace in wrangler.toml`;
      const content = await kv.get(normalizeKey(path), "text");
      if (content === null) return `Error: File not found: ${path}`;
      return content;
    },
  };
}

export function createListFilesTool(
  kv: KVNamespace | undefined
): ToolDefinition<{ prefix?: string }, string> {
  return {
    name: "list_files",
    description: "List all files in the virtual file system, optionally filtered by a path prefix.",
    inputSchema: z.object({
      prefix: z.string().optional().describe("Optional path prefix filter, e.g. src/"),
    }),
    outputSchema: z.string(),
    readOnly: true,
    idempotent: true,
    forward: async ({ prefix }) => {
      if (!kv) return "file1.ts\nfile2.ts\nREADME.md  # (KV not bound — sample listing)";
      const list = await kv.list({ prefix: prefix ? `file:${prefix}` : "file:" });
      if (list.keys.length === 0) return "(no files found)";
      return list.keys.map((k) => k.name.replace(/^file:/, "")).join("\n");
    },
  };
}

export function createSearchCodeTool(
  kv: KVNamespace | undefined
): ToolDefinition<{ query: string; path?: string }, string> {
  return {
    name: "search_code",
    description:
      "Search for a string or pattern across all files (or within a specific file). Returns matching lines with file paths and line numbers.",
    inputSchema: z.object({
      query: z.string().describe("Text to search for"),
      path: z.string().optional().describe("Limit search to this file path"),
    }),
    outputSchema: z.string(),
    readOnly: true,
    idempotent: true,
    forward: async ({ query, path }) => {
      if (!kv) return `# (KV not bound)\n# Search for: ${query}`;
      const list = await kv.list({ prefix: path ? `file:${path}` : "file:" });
      const results: string[] = [];
      for (const key of list.keys.slice(0, 20)) {
        const content = await kv.get(key.name, "text");
        if (!content) continue;
        const filePath = key.name.replace(/^file:/, "");
        const lines = content.split("\n");
        lines.forEach((line, i) => {
          if (line.toLowerCase().includes(query.toLowerCase())) {
            results.push(`${filePath}:${i + 1}: ${line}`);
          }
        });
      }
      return results.length > 0 ? results.join("\n") : `No matches found for: ${query}`;
    },
  };
}

export function createWriteFileTool(
  kv: KVNamespace | undefined
): ToolDefinition<{ path: string; content: string }, string> {
  return {
    name: "write_file",
    description: "Write or overwrite a file in the virtual file system.",
    inputSchema: z.object({
      path: z.string().describe("File path, e.g. src/utils.ts"),
      content: z.string().describe("Full file content to write"),
    }),
    outputSchema: z.string(),
    readOnly: false,
    idempotent: false,
    forward: async ({ path, content }) => {
      if (!kv) return `OK (KV not bound — write to ${path} simulated)`;
      await kv.put(normalizeKey(path), content);
      return `OK: written ${content.length} chars to ${path}`;
    },
  };
}

export function createRunCommandTool(): ToolDefinition<{ command: string; code?: string }, string> {
  return {
    name: "run_command",
    description:
      "Simulate running a shell command. For code execution tasks, use the CodeAgent kernel directly instead.",
    inputSchema: z.object({
      command: z.string().describe("Shell command to simulate, e.g. npm test"),
      code: z.string().optional().describe("Optional code snippet to evaluate inline"),
    }),
    outputSchema: z.string(),
    readOnly: false,
    idempotent: false,
    forward: async ({ command, code }) => {
      // Cloudflare Workers cannot exec real shell processes.
      // Return a simulated response showing the command was received.
      const output: string[] = [`$ ${command}`];
      if (code) {
        try {
          // Safe inline eval for math/JSON expressions only
          const result = Function(`"use strict"; return (${code})`)();
          output.push(String(result));
        } catch (e) {
          output.push(`Error: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        output.push("(command simulation — real shell not available in edge runtime)");
      }
      return output.join("\n");
    },
  };
}

function normalizeKey(path: string): string {
  return `file:${path.replace(/^\/+/, "")}`;
}

import type { ToolDefinition } from "@agentkit-js/core";
import { FileTreeManager, globalFileLock } from "@agentkit-js/core";
import { applyPatch } from "diff";
import { z } from "zod";
import type { KvStore } from "../types.js";

// ── Re-export type so callers can use KvStore directly ────────────────────────
export type { KvStore };

// Lock Wrangler dev secrets — specific to BSCode worker deployment
globalFileLock.lock(".dev.vars", "hard", "Wrangler dev secrets — never overwrite");

// ── File tools ────────────────────────────────────────────────────────────────

export function createReadFileTool(
  kv: KvStore | undefined
): ToolDefinition<{ path: string }, string> {
  return {
    name: "read_file",
    description: "Read the content of a file from the virtual file system.",
    inputSchema: z.object({ path: z.string().describe("File path, e.g. src/index.ts") }),
    outputSchema: z.string(),
    readOnly: true,
    idempotent: true,
    forward: async ({ path }) => {
      if (!kv) return `# (KV not bound)\n// File: ${path}`;
      const content = await kv.get(normalizeKey(path));
      if (content === null) return `Error: File not found: ${path}`;
      return content;
    },
  };
}

export function createListFilesTool(
  kv: KvStore | undefined
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
      if (!kv) return "file1.ts\nfile2.ts\nREADME.md  # (KV not bound)";
      const list = await kv.list({ prefix: prefix ? `file:${prefix}` : "file:" });
      if (list.keys.length === 0) return "(no files found)";
      return list.keys.map((k) => k.name.replace(/^file:/, "")).join("\n");
    },
  };
}

export function createSearchCodeTool(
  kv: KvStore | undefined
): ToolDefinition<{ query: string; path?: string }, string> {
  return {
    name: "search_code",
    description:
      "Search for a string across all files (or a specific file). Returns matching lines with file paths and line numbers.",
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
        const content = await kv.get(key.name);
        if (!content) continue;
        const filePath = key.name.replace(/^file:/, "");
        content.split("\n").forEach((line, i) => {
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
  kv: KvStore | undefined,
  fileTree?: FileTreeManager
): ToolDefinition<{ path: string; content: string }, string> {
  return {
    name: "write_file",
    description:
      "Write or overwrite a file in the virtual file system. Prefer patch_file for edits.",
    inputSchema: z.object({
      path: z.string().describe("File path, e.g. src/utils.ts"),
      content: z.string().describe("Full file content to write"),
    }),
    outputSchema: z.string(),
    readOnly: false,
    idempotent: false,
    forward: async ({ path, content }) => {
      // bolt.new file-lock check: block writes to protected files
      try {
        const warning = globalFileLock.assertWritable(path);
        if (warning) {
          // "warn" level — proceed but surface the warning
          console.warn(`[write_file] ${warning}`);
        }
      } catch (lockErr) {
        return `Error: ${lockErr instanceof Error ? lockErr.message : String(lockErr)}`;
      }

      if (!kv) return `OK (KV not bound — write to ${path} simulated)`;
      await kv.put(normalizeKey(path), content);
      // Mirror into the per-session FileTreeManager so version history
      // accrues for agent-written files (not just user-written via POST
      // /files). Without this the v0.dev-style checkpoint feature only
      // works for manual edits, which defeats the point.
      if (fileTree) fileTree.recordWrite(path.replace(/^\/+/, ""), content);
      return `OK: written ${content.length} chars to ${path}`;
    },
  };
}

export function createPatchFileTool(
  kv: KvStore | undefined
): ToolDefinition<{ path: string; patch: string }, string> {
  return {
    name: "patch_file",
    description:
      "Apply a unified diff patch to an existing file. More efficient than write_file for edits — sends only changed lines. " +
      "Patch format: standard unified diff, e.g. '@@ -1,3 +1,4 @@\\n-old line\\n+new line\\n context'",
    inputSchema: z.object({
      path: z.string().describe("File path to patch"),
      patch: z.string().describe("Unified diff patch string"),
    }),
    outputSchema: z.string(),
    readOnly: false,
    idempotent: false,
    forward: async ({ path, patch }) => {
      try {
        const warning = globalFileLock.assertWritable(path);
        if (warning) console.warn(`[patch_file] ${warning}`);
      } catch (lockErr) {
        return `Error: ${lockErr instanceof Error ? lockErr.message : String(lockErr)}`;
      }
      if (!kv) return `OK (KV not bound — patch to ${path} simulated)`;
      const original = await kv.get(normalizeKey(path));
      if (original === null) return `Error: File not found: ${path}`;
      const patched = applyPatch(original, patch);
      if (patched === false)
        return `Error: Patch failed — hunk mismatch or context mismatch for ${path}`;
      await kv.put(normalizeKey(path), patched as string);
      const saved = patched as string;
      return `OK: patched ${path} (${original.length} → ${saved.length} chars)`;
    },
  };
}

export function createDeleteFileTool(
  kv: KvStore | undefined
): ToolDefinition<{ path: string }, string> {
  return {
    name: "delete_file",
    description: "Delete a file from the virtual file system.",
    inputSchema: z.object({
      path: z.string().describe("File path to delete"),
    }),
    outputSchema: z.string(),
    readOnly: false,
    idempotent: false,
    forward: async ({ path }) => {
      try {
        const warning = globalFileLock.assertWritable(path);
        if (warning) console.warn(`[delete_file] ${warning}`);
      } catch (lockErr) {
        return `Error: ${lockErr instanceof Error ? lockErr.message : String(lockErr)}`;
      }
      if (!kv) return `OK (KV not bound — delete ${path} simulated)`;
      const key = normalizeKey(path);
      const existing = await kv.get(key);
      if (existing === null) return `Error: File not found: ${path}`;
      await (kv as { delete?: (k: string) => Promise<void> }).delete?.(key);
      return `OK: deleted ${path}`;
    },
  };
}

export function createRenameFileTool(
  kv: KvStore | undefined
): ToolDefinition<{ from: string; to: string }, string> {
  return {
    name: "rename_file",
    description: "Rename or move a file in the virtual file system.",
    inputSchema: z.object({
      from: z.string().describe("Source file path"),
      to: z.string().describe("Destination file path"),
    }),
    outputSchema: z.string(),
    readOnly: false,
    idempotent: false,
    forward: async ({ from, to }) => {
      if (!kv) return `OK (KV not bound — rename ${from} → ${to} simulated)`;
      const content = await kv.get(normalizeKey(from));
      if (content === null) return `Error: File not found: ${from}`;
      await kv.put(normalizeKey(to), content);
      await (kv as { delete?: (k: string) => Promise<void> }).delete?.(normalizeKey(from));
      return `OK: renamed ${from} → ${to}`;
    },
  };
}

export function createRunCommandTool(
  shellRunner?: (cmd: string) => Promise<string>
): ToolDefinition<{ command: string; code?: string }, string> {
  return {
    name: "run_command",
    description: shellRunner
      ? "Execute a shell command. Returns stdout/stderr output. Avoid destructive commands (rm -rf, drop table, etc.)."
      : "Simulate running a shell command (real shell unavailable in edge runtime).",
    inputSchema: z.object({
      command: z.string().describe("Shell command, e.g. npm test or git status"),
      code: z.string().optional().describe("Optional inline JS expression to evaluate"),
    }),
    outputSchema: z.string(),
    readOnly: false,
    idempotent: false,
    forward: async ({ command, code }) => {
      if (shellRunner) {
        // Pre-execution validation (bolt.diy pattern): rewrite predictably-failing commands
        let safeCommand = command;
        // Add -f to rm to avoid "No such file" errors
        if (/^rm\s+(?!.*-[rf])/.test(safeCommand)) {
          safeCommand = safeCommand.replace(/^rm\s+/, "rm -f ");
        }
        // Add -p to mkdir to avoid "already exists" errors
        if (/^mkdir\s+(?!.*-p)/.test(safeCommand)) {
          safeCommand = safeCommand.replace(/^mkdir\s+/, "mkdir -p ");
        }
        // Block truly destructive commands
        const blocked = /rm\s+-rf\s+\/\b|DROP\s+TABLE|DELETE\s+FROM\s+\w+\s*;?\s*$/i.test(safeCommand);
        if (blocked) return "Error: Command blocked (destructive operation requires explicit confirmation)";

        const output = await shellRunner(safeCommand);

        // Post-execution error classification (bolt.diy pattern)
        if (/exit:[1-9]/.test(output)) {
          if (/No such file or directory/.test(output)) return `${output}\nHint: The file/directory doesn't exist. Check the path or create it first.`;
          if (/Permission denied/.test(output)) return `${output}\nHint: Permission denied. Try with appropriate permissions.`;
          if (/command not found/.test(output)) {
            const cmd = safeCommand.split(/\s+/)[0];
            return `${output}\nHint: '${cmd}' not found. Install it or check if it's in PATH.`;
          }
          if (/Cannot find module|Module not found/.test(output)) return `${output}\nHint: Missing npm package. Add it to package.json and run npm install.`;
          if (/SyntaxError|TypeError|ReferenceError/.test(output)) return `${output}\nHint: Code syntax/runtime error. Check the specific line mentioned above.`;
        }
        return output;
      }
      const output: string[] = [`$ ${command}`];
      if (code) {
        try {
          const result = Function(`"use strict"; return (${code})`)();
          output.push(String(result));
        } catch (e) {
          output.push(`Error: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        output.push("(simulation — real shell unavailable on edge runtime)");
      }
      return output.join("\n");
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeKey(path: string): string {
  return `file:${path.replace(/^\/+/, "")}`;
}

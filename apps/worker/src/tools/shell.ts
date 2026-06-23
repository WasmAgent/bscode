import type { ToolDefinition } from "@wasmagent/core";
import { z } from "zod";
import type { AppConfig } from "../types.js";

export function createShellRunner(
  config: AppConfig
): ((argv: string[]) => Promise<string>) | undefined {
  if (!config.enableShell || !config.workdir) return undefined;

  const workdir = config.workdir;
  return async (argv: string[]) => {
    const proc = Bun.spawn(argv, {
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    const output = `${stdout}${stderr}`.trim();
    return `exit:${code}\n${output || "(no output)"}`.slice(0, 16_384);
  };
}

/** Git tool suite — only active when enableShell=true. */
export function createGitTools(config: AppConfig): ToolDefinition[] {
  const runner = createShellRunner(config);
  if (!runner) return [];

  return [
    {
      name: "git_status",
      description: "Show git working tree status (modified, staged, untracked files).",
      inputSchema: z.object({}),
      outputSchema: z.string(),
      readOnly: true,
      idempotent: true,
      forward: async () => runner(["git", "status", "--short"]),
    },
    {
      name: "git_diff",
      description: "Show diff of working tree or staged changes.",
      inputSchema: z.object({
        staged: z.boolean().optional().describe("Show staged diff (--cached)"),
        path: z.string().optional().describe("Limit diff to this path"),
      }),
      outputSchema: z.string(),
      readOnly: true,
      idempotent: true,
      forward: async ({ staged, path }) => {
        const argv = ["git", "diff"];
        if (staged) argv.push("--cached");
        if (path) argv.push("--", path);
        return runner(argv);
      },
    },
    {
      name: "git_log",
      description: "Show recent commit history.",
      inputSchema: z.object({
        n: z.number().int().min(1).max(50).optional().default(10).describe("Number of commits"),
      }),
      outputSchema: z.string(),
      readOnly: true,
      idempotent: true,
      forward: async ({ n }) => runner(["git", "log", "--oneline", `-${n ?? 10}`]),
    },
    {
      name: "git_commit",
      description: "Stage all changes and create a commit.",
      inputSchema: z.object({
        message: z.string().describe("Commit message"),
      }),
      outputSchema: z.string(),
      readOnly: false,
      idempotent: false,
      forward: async ({ message }) => {
        const stage = await runner(["git", "add", "-A"]);
        const commit = await runner(["git", "commit", "-m", message]);
        return `${stage}\n${commit}`.trim();
      },
    },
    {
      name: "git_checkout",
      description: "Create or switch to a git branch.",
      inputSchema: z.object({
        branch: z.string().describe("Branch name"),
        create: z.boolean().optional().describe("Create branch if it doesn't exist (-b)"),
      }),
      outputSchema: z.string(),
      readOnly: false,
      idempotent: false,
      forward: async ({ branch, create }) => {
        const argv = ["git", "checkout"];
        if (create) argv.push("-b");
        argv.push(branch);
        return runner(argv);
      },
    },
  ];
}

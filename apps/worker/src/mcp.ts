/**
 * B-D2 follow-up — code-mode MCP server mount for bscode.
 *
 * Wires `@wasmagent/mcp-server`'s `createCodeModeServer` +
 * `createFetchHandler` into the bscode worker so a host like Claude
 * Desktop / Cursor / VS Code Copilot can paste this Worker's
 * `/mcp` URL and call read-only bscode tools through one
 * `execute_code` surface.
 *
 * Scope is deliberately minimal:
 *
 *   - **Read-only file tools only.** `read_file`, `list_files`,
 *     `search_code`. The write tools (`write_file`, `patch_file`,
 *     `delete_file`, `rename_file`, `run_command`,
 *     `create_github_pr`, `init_agents_md`, the visual interact
 *     tools) require approval/state that does not translate cleanly
 *     across an MCP transport boundary — those are product-shaped
 *     and belong on a fork that owns the access policy.
 *
 *     `web_search` is explicitly *not* registered here even though
 *     it's read-only — it needs outbound network, and the
 *     manifest below denies network. Register it later if your
 *     deployment narrows `allowedHosts` to a known search backend.
 *
 *   - **One CapabilityManifest applied to every call.** No host,
 *     no FS, low CPU/memory ceiling. The kernel runs the model's
 *     snippet but it cannot reach the network or the host process.
 *     Tightening to allow specific hosts is a deployment-time
 *     decision the operator makes via env.
 *
 *   - **Per-deployment scope.** MCP is connectionless from the
 *     server's perspective; the `filesKv` reference is the only
 *     state, and it's the same one bscode's agent uses — so what
 *     an MCP host sees is what the agent sees.
 *
 * The implementation is one factory:
 * `createMcpFetchHandler(config)` returns a `(Request) =>
 * Promise<Response>` that the Hono route mounts via `app.all`.
 *
 * See `docs/tools-audit-2026-06-12.md` for which tools are KEEP /
 * UPLIFT — the read-only set here matches the KEEP intersection
 * minus the visual-verify path (which depends on a CDP endpoint
 * not always configured).
 */

import { type CapabilityManifest, type ToolDefinition, ToolRegistry } from "@wasmagent/core";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";
import { createCodeModeServer, createFetchHandler } from "@wasmagent/mcp-server";
import type { AppConfig } from "./platform.js";
import { createListFilesTool, createReadFileTool, createSearchCodeTool } from "./tools/index.js";

/** Names of tools we expose on /mcp. Strict allow-list — never derived. */
const READ_ONLY_TOOLS = ["read_file", "list_files", "search_code"] as const;

/**
 * Capability manifest applied to every `execute_code` invocation
 * the MCP server hosts. Tighten to specific allowedHosts at
 * deployment time when a client asks for them.
 */
function defaultMcpCapabilities(): Partial<CapabilityManifest> {
  return {
    allowedHosts: [],
    allowedReadPaths: [],
    allowedWritePaths: [],
    cpuMs: 5_000,
    memoryLimitBytes: 64 * 1024 * 1024,
  };
}

/**
 * Build the MCP fetch handler for the bscode worker. The handler
 * answers `POST /mcp` (JSON-RPC body) and `OPTIONS /mcp` (CORS
 * preflight); the surrounding Hono route can mount it at any path.
 *
 * QuickJS variant + loader come from the caller because the same
 * Worker entry already imports the CF-flavoured variant
 * (`@jitl/quickjs-wasmfile-release-sync`) for `/run-ptc`. Reusing
 * it keeps the Worker bundle small and the WASM module cached.
 */
export interface CreateMcpFetchHandlerOptions {
  /** QuickJS variant module (e.g. `@jitl/quickjs-wasmfile-release-sync`). */
  quickjsVariant?: unknown;
  /** `newQuickJSWASMModuleFromVariant` from `quickjs-emscripten-core`. */
  quickjsVariantLoader?: unknown;
}

export function createMcpFetchHandler(
  config: AppConfig,
  opts: CreateMcpFetchHandlerOptions = {}
): (request: Request) => Promise<Response> {
  // P0-4: Public MCP must use a dedicated read-only KV binding, never the
  // deployment-level filesKv. If publicMcpEnabled is true and no publicReadKv
  // is provided, we build an empty handler that returns 503 on every request.
  //
  // When publicMcpEnabled is false (default), we use filesKv directly because
  // the /mcp endpoint is protected by clientToken — the same auth gate as all
  // other endpoints. In that case the caller-owns-data contract is preserved.
  const targetKv = config.publicMcpEnabled
    ? config.publicReadKv // may be undefined → 503 handler below
    : config.filesKv; // token-protected path — filesKv is OK

  if (config.publicMcpEnabled && !targetKv) {
    // Return a handler that always 503s — misconfiguration, not a runtime error.
    return (_req: Request) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error:
              "Public MCP is enabled (publicMcpEnabled=true) but no publicReadKv binding is set. " +
              "Bind BSCODE_PUBLIC_READ_KV to a dedicated read-only KV namespace.",
          }),
          { status: 503, headers: { "Content-Type": "application/json" } }
        )
      );
  }

  // Read-only tool subset — built once per worker instance because
  // the registry is stateless beyond the KV references.
  const tools: ToolDefinition[] = [];
  if (targetKv) {
    tools.push(
      createReadFileTool(targetKv),
      createListFilesTool(targetKv),
      createSearchCodeTool(targetKv)
    );
  }

  // Defence-in-depth: even if buildTools above were to grow a
  // write-class entry, filter to the strict allow-list before
  // handing the registry to the MCP server.
  const filtered = tools.filter((t) => (READ_ONLY_TOOLS as readonly string[]).includes(t.name));
  const registry = new ToolRegistry();
  for (const t of filtered) registry.register(t);

  const kernelOpts: ConstructorParameters<typeof QuickJSKernel>[0] = {
    timeoutMs: 5_000,
  };
  if (opts.quickjsVariant !== undefined) {
    (kernelOpts as { variant?: unknown }).variant = opts.quickjsVariant;
  }
  if (opts.quickjsVariantLoader !== undefined) {
    (kernelOpts as { variantLoader?: unknown }).variantLoader = opts.quickjsVariantLoader;
  }

  const server = createCodeModeServer({
    serverInfo: { name: "bscode-mcp", version: "0.1.0" },
    tools: registry,
    kernel: new QuickJSKernel(kernelOpts),
    capabilities: defaultMcpCapabilities(),
  });
  return createFetchHandler(server, { path: "/mcp" });
}

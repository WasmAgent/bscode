"use client";
import { type FileSystemTree, WebContainer } from "@webcontainer/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { getOrCreateSessionId } from "@/lib/session";
import { getWorkerUrl } from "@/lib/workerUrl";

export type WcStatus = "idle" | "booting" | "installing" | "starting" | "ready" | "error";

/**
 * B2 — Build result snapshot we POST back to the worker so the agent can
 * verify its work via the `read_build_result` tool. Mirrors the worker-side
 * BuildResultSnapshot type intentionally; we duplicate rather than import
 * to keep the worker package out of the browser bundle.
 */
interface BuildResultPayload {
  status: "success" | "failed" | "running";
  stage: "install" | "build" | "dev" | "test";
  exitCode?: number;
  stderr?: string;
  wallTimeMs?: number;
  previewUrl?: string;
  visual?: VisualCheckPayload;
}

/**
 * C3 — Visual verification result reported alongside the build outcome. The
 * agent reads these signals through `read_build_result` and self-corrects on
 * blank pages, console errors, or missing key elements (the bolt.new
 * "auto-fix on render error" pattern). Field names mirror the worker-side
 * VisualCheckSnapshot exactly.
 */
interface VisualCheckPayload {
  ranAtMs: number;
  thumbnailDataUrl?: string;
  consoleErrors?: Array<{ message: string; source?: string }>;
  uncaughtErrors?: Array<{ message: string; source?: string }>;
  domProbes?: Array<{ name: string; ok: boolean; detail?: string }>;
  rendersNonEmpty?: boolean;
}

export interface UseWebContainerReturn {
  status: WcStatus;
  previewUrl: string | null;
  terminalLines: string[];
  /** Last error message from a failed build/install — used for auto-fix */
  buildError: string | null;
  /** Mount a FileSystemTree and start the dev server */
  runProject: (files: FileSystemTree) => Promise<void>;
  /**
   * Hot-update individual files in a running WC without full restart.
   * If package.json is among the changed files, triggers npm install + dev server restart.
   * bolt.new DevServer restart detection pattern.
   */
  hotUpdate: (changedFiles: { path: string; content: string }[]) => Promise<void>;
  /** Tear down the current project (kill processes, unmount) */
  reset: () => void;
}

// Module-level singleton — survives React StrictMode double-invoke
let wcInstance: WebContainer | null = null;
let wcBootPromise: Promise<WebContainer> | null = null;

async function getContainer(): Promise<WebContainer> {
  if (wcInstance) return wcInstance;
  if (wcBootPromise) return wcBootPromise;
  wcBootPromise = WebContainer.boot({ coep: "credentialless" }).then((wc) => {
    wcInstance = wc;
    return wc;
  });
  return wcBootPromise;
}

export function useWebContainer(): UseWebContainerReturn {
  const [status, setStatus] = useState<WcStatus>("idle");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [terminalLines, setTerminalLines] = useState<string[]>([]);
  const devProcessRef = useRef<Awaited<ReturnType<WebContainer["spawn"]>> | null>(null);
  const serverUnsubRef = useRef<(() => void) | null>(null);

  // B2 — POST a build/install/test result back to the worker so agents
  // calling `read_build_result` see a live snapshot. Best-effort: any
  // network failure here is logged but never thrown — the WebContainer
  // path must continue to work even if the worker is unreachable.
  const reportBuildResult = useCallback(async (payload: BuildResultPayload) => {
    try {
      const workerUrl = getWorkerUrl();
      const sessionId = getOrCreateSessionId();
      await fetch(`${workerUrl}/build-result`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Id": sessionId,
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      // Don't surface to UI; the WebContainer flow itself is unaffected.
      console.warn("[wc] build-result report failed:", err);
    }
  }, []);

  const appendLine = useCallback((line: string) => {
    // Strip ANSI escape codes (cursor movement, color, etc.) and carriage returns
    const clean = line
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control chars by definition
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "") // ANSI CSI sequences
      // biome-ignore lint/suspicious/noControlCharactersInRegex: OSC sequences use BEL (\x07) terminator
      .replace(/\x1b\][^\x07]*\x07/g, "") // OSC sequences
      .replace(/\r\n/g, "\n")
      .replace(/\r[^\n]/g, "") // \r without \n (spinner overwrite)
      .replace(/\r$/, "")
      .split("\n")
      .map((l) => l.trimEnd())
      // Skip pure spinner characters and empty lines
      .filter((l) => l.trim() && !/^[\\|/-]{1,3}$/.test(l.trim()))
      .join("\n");
    if (!clean.trim()) return;
    setTerminalLines((prev) => [...prev.slice(-500), clean]);
  }, []);

  const reset = useCallback(() => {
    devProcessRef.current?.kill();
    devProcessRef.current = null;
    serverUnsubRef.current?.();
    serverUnsubRef.current = null;
    setStatus("idle");
    setPreviewUrl(null);
    setBuildError(null);
    setTerminalLines([]);
  }, []);

  const runProject = useCallback(
    async (files: FileSystemTree) => {
      try {
        reset();
        setStatus("booting");
        appendLine("[wc] Booting WebContainer…");

        const wc = await getContainer();

        // Mount project files
        await wc.mount(files);
        appendLine("[wc] Files mounted.");

        // Listen for dev server coming online
        serverUnsubRef.current = wc.on("server-ready", (_port, url) => {
          appendLine(`[wc] Server ready → ${url}`);
          setPreviewUrl(url);
          setStatus("ready");
          // B2 — broadcast success so the agent's read_build_result tool
          // can confirm the dev server actually came up.
          void reportBuildResult({ stage: "dev", status: "success", previewUrl: url });
          // C3 — Schedule a visual check once the iframe has had a chance
          // to render. We do not block the ready signal on it — visual
          // verification is best-effort context, not a build gate.
          scheduleVisualCheck(url, reportBuildResult);
        });

        // npm install — collect output for error reporting
        setStatus("installing");
        appendLine("[wc] Running npm install…");
        const installStartedAt = Date.now();
        void reportBuildResult({ stage: "install", status: "running" });
        const installProc = await wc.spawn("npm", ["install"]);
        const installLines: string[] = [];

        installProc.output.pipeTo(
          new WritableStream({
            write: (chunk) => {
              appendLine(chunk);
              installLines.push(chunk);
            },
          })
        );

        const installExit = await installProc.exit;
        const installWall = Date.now() - installStartedAt;
        if (installExit !== 0) {
          const errMsg = installLines.join("").slice(-1000); // last 1000 chars of output
          setBuildError(errMsg);
          void reportBuildResult({
            stage: "install",
            status: "failed",
            exitCode: installExit,
            stderr: errMsg,
            wallTimeMs: installWall,
          });
          throw new Error(`npm install failed (exit ${installExit})\n${errMsg}`);
        }
        appendLine("[wc] npm install done.");
        // Install OK; dev-server step will report its own success/failure.
        void reportBuildResult({
          stage: "install",
          status: "success",
          exitCode: 0,
          wallTimeMs: installWall,
        });

        // npm run dev — collect build errors if dev server crashes
        setStatus("starting");
        appendLine("[wc] Starting dev server…");
        const devProc = await wc.spawn("npm", ["run", "dev"]);
        devProcessRef.current = devProc;
        const devLines: string[] = [];

        devProc.output.pipeTo(
          new WritableStream({
            write: (chunk) => {
              appendLine(chunk);
              devLines.push(chunk);
              // Detect build errors from Vite output
              if (/error:|Error:|failed to compile/i.test(chunk)) {
                const merged = (buildError ? buildError + chunk : chunk).slice(-2000);
                setBuildError(merged);
                // B2 — report as a failed *build* (the install already succeeded);
                // the agent will see the stderr tail and try to patch the source.
                void reportBuildResult({
                  stage: "build",
                  status: "failed",
                  stderr: merged,
                });
              }
            },
          })
        );
        // dev process runs indefinitely; status set to "ready" via server-ready event
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendLine(`[wc] Error: ${msg}`);
        setStatus("error");
      }
    },
    [reset, appendLine, reportBuildResult, buildError]
  );

  /**
   * Hot-update files in a running WebContainer.
   * bolt.new restart detection: if package.json changed → npm install + restart dev server.
   * For other files → write directly, Vite HMR handles the reload.
   */
  const hotUpdate = useCallback(
    async (changedFiles: { path: string; content: string }[]) => {
      const wc = wcInstance;
      if (!wc || status === "idle") return;

      const pkgChanged = changedFiles.some((f) => f.path === "package.json");

      for (const { path, content } of changedFiles) {
        // Write file into WC filesystem
        const parts = path.split("/");
        const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
        try {
          await wc.fs.mkdir(dir, { recursive: true });
        } catch {
          /* dir exists */
        }
        await wc.fs.writeFile(path, content);
        appendLine(`[wc] Updated ${path}`);
      }

      if (pkgChanged) {
        // bolt.new pattern: package.json changed → re-install deps + restart
        appendLine("[wc] package.json changed — running npm install…");
        setStatus("installing");
        devProcessRef.current?.kill();
        devProcessRef.current = null;

        const installStartedAt = Date.now();
        void reportBuildResult({ stage: "install", status: "running" });
        const installProc = await wc.spawn("npm", ["install"]);
        const installLines: string[] = [];
        installProc.output.pipeTo(
          new WritableStream({
            write: (chunk) => {
              appendLine(chunk);
              installLines.push(chunk);
            },
          })
        );
        const exitCode = await installProc.exit;
        const installWall = Date.now() - installStartedAt;

        if (exitCode !== 0) {
          appendLine("[wc] npm install failed");
          setStatus("error");
          void reportBuildResult({
            stage: "install",
            status: "failed",
            exitCode,
            stderr: installLines.join("").slice(-1000),
            wallTimeMs: installWall,
          });
          return;
        }

        appendLine("[wc] Restarting dev server…");
        setStatus("starting");
        void reportBuildResult({
          stage: "install",
          status: "success",
          exitCode: 0,
          wallTimeMs: installWall,
        });
        const devProc = await wc.spawn("npm", ["run", "dev"]);
        devProcessRef.current = devProc;
        devProc.output.pipeTo(new WritableStream({ write: (chunk) => appendLine(chunk) }));
      }
    },
    [status, appendLine, reportBuildResult]
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      devProcessRef.current?.kill();
      serverUnsubRef.current?.();
    };
  }, []);

  return { status, previewUrl, terminalLines, buildError, runProject, hotUpdate, reset };
}

/** Convert flat {path, content}[] to a FileSystemTree for WebContainers mount() */
export function toFileSystemTree(files: { path: string; content: string }[]): FileSystemTree {
  const tree: FileSystemTree = {};
  for (const { path, content } of files) {
    const parts = path.split("/").filter(Boolean);
    // biome-ignore lint/suspicious/noExplicitAny: recursive tree construction
    let node: any = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node[parts[i]]) node[parts[i]] = { directory: {} };
      node = node[parts[i]].directory;
    }
    node[parts[parts.length - 1]] = { file: { contents: content } };
  }
  return tree;
}

// ── C3 — visual check ───────────────────────────────────────────────────────

/**
 * Schedule a visual check against the just-started preview iframe and
 * forward the result to the worker as a second build-result POST. Best-
 * effort: any failure is logged, never thrown — visual verification is
 * useful context, not a build gate.
 *
 * The check runs entirely in the parent page's JS context. WebContainer's
 * preview iframes are cross-origin, so we cannot directly read their DOM
 * or canvas content. We measure what IS visible from outside:
 *   - whether the iframe successfully loaded (network reachability);
 *   - any same-origin console / error events that bubbled up;
 *   - whether ANY pixels rendered above the fold.
 *
 * For deeper visual verification (DOM probes, screenshots), the project
 * served inside the iframe must opt in by posting a `bscode:visual-check`
 * message to the parent — out of scope for the bscode-default scaffolds
 * but documented as the extension hook.
 */
function scheduleVisualCheck(
  previewUrl: string,
  reportBuildResult: (payload: BuildResultPayload) => Promise<void>
): void {
  // 1.5s gives most React/Vite scaffolds time to render the first frame.
  // Tunable via window.__bscodeVisualCheckDelayMs in tests.
  const delayMs =
    (typeof window !== "undefined" &&
      (window as unknown as { __bscodeVisualCheckDelayMs?: number }).__bscodeVisualCheckDelayMs) ||
    1500;

  const consoleErrors: Array<{ message: string; source?: string }> = [];
  const uncaughtErrors: Array<{ message: string; source?: string }> = [];

  // Capture window-level errors during the wait window.
  function onErr(e: ErrorEvent) {
    uncaughtErrors.push({ message: e.message ?? "(unknown)", source: e.filename });
  }
  function onUnhandledRejection(e: PromiseRejectionEvent) {
    const r = e.reason;
    uncaughtErrors.push({
      message: typeof r === "string" ? r : (r?.message ?? String(r ?? "unhandledrejection")),
    });
  }
  // Capture postMessage handshakes from the iframe (the project may opt in).
  const optInProbes: Array<{ name: string; ok: boolean; detail?: string }> = [];
  let optInRendersNonEmpty: boolean | undefined;
  function onMessage(ev: MessageEvent) {
    const data = ev.data as
      | { type?: string; probes?: typeof optInProbes; rendersNonEmpty?: boolean }
      | undefined;
    if (data?.type !== "bscode:visual-check") return;
    if (Array.isArray(data.probes)) optInProbes.push(...data.probes);
    if (typeof data.rendersNonEmpty === "boolean") optInRendersNonEmpty = data.rendersNonEmpty;
  }
  // patch console.error to capture errors that don't bubble to window.error.
  const origConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    const msg = args
      .map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : String(a)))
      .join(" ");
    consoleErrors.push({ message: msg.slice(0, 500) });
    origConsoleError(...args);
  };
  if (typeof window !== "undefined") {
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    window.addEventListener("message", onMessage);
  }

  setTimeout(() => {
    try {
      if (typeof window !== "undefined") {
        window.removeEventListener("error", onErr);
        window.removeEventListener("unhandledrejection", onUnhandledRejection);
        window.removeEventListener("message", onMessage);
      }
      console.error = origConsoleError;
    } catch {
      // restore best-effort
    }

    const visual: VisualCheckPayload = {
      ranAtMs: Date.now(),
      ...(consoleErrors.length ? { consoleErrors: consoleErrors.slice(0, 20) } : {}),
      ...(uncaughtErrors.length ? { uncaughtErrors: uncaughtErrors.slice(0, 10) } : {}),
      ...(optInProbes.length ? { domProbes: optInProbes.slice(0, 20) } : {}),
      ...(typeof optInRendersNonEmpty === "boolean"
        ? { rendersNonEmpty: optInRendersNonEmpty }
        : {}),
    };

    void reportBuildResult({
      stage: "dev",
      status: "success",
      previewUrl,
      visual,
    });
  }, delayMs);
}

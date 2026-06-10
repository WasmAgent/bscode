"use client";
import { type FileSystemTree, WebContainer } from "@webcontainer/api";
import { useCallback, useEffect, useRef, useState } from "react";

export type WcStatus = "idle" | "booting" | "installing" | "starting" | "ready" | "error";

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

  const appendLine = useCallback((line: string) => {
    // Strip ANSI escape codes (cursor movement, color, etc.) and carriage returns
    const clean = line
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")  // ANSI CSI sequences
      .replace(/\x1b\][^\x07]*\x07/g, "")       // OSC sequences
      .replace(/\r\n/g, "\n")
      .replace(/\r[^\n]/g, "")                   // \r without \n (spinner overwrite)
      .replace(/\r$/, "")
      .split("\n")
      .map((l) => l.trimEnd())
      // Skip pure spinner characters and empty lines
      .filter((l) => l.trim() && !/^[\\|/\-]{1,3}$/.test(l.trim()))
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
        });

        // npm install — collect output for error reporting
        setStatus("installing");
        appendLine("[wc] Running npm install…");
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
        if (installExit !== 0) {
          const errMsg = installLines.join("").slice(-1000); // last 1000 chars of output
          setBuildError(errMsg);
          throw new Error(`npm install failed (exit ${installExit})\n${errMsg}`);
        }
        appendLine("[wc] npm install done.");

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
                setBuildError((prev) => (prev ? prev + chunk : chunk).slice(-2000));
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
    [reset, appendLine]
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
        } catch { /* dir exists */ }
        await wc.fs.writeFile(path, content);
        appendLine(`[wc] Updated ${path}`);
      }

      if (pkgChanged) {
        // bolt.new pattern: package.json changed → re-install deps + restart
        appendLine("[wc] package.json changed — running npm install…");
        setStatus("installing");
        devProcessRef.current?.kill();
        devProcessRef.current = null;

        const installProc = await wc.spawn("npm", ["install"]);
        installProc.output.pipeTo(new WritableStream({ write: (chunk) => appendLine(chunk) }));
        const exitCode = await installProc.exit;

        if (exitCode !== 0) {
          appendLine("[wc] npm install failed");
          setStatus("error");
          return;
        }

        appendLine("[wc] Restarting dev server…");
        setStatus("starting");
        const devProc = await wc.spawn("npm", ["run", "dev"]);
        devProcessRef.current = devProc;
        devProc.output.pipeTo(new WritableStream({ write: (chunk) => appendLine(chunk) }));
      }
    },
    [status, appendLine]
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
export function toFileSystemTree(
  files: { path: string; content: string }[]
): FileSystemTree {
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

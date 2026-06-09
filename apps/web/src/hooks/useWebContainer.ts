"use client";
import { type FileSystemTree, WebContainer } from "@webcontainer/api";
import { useCallback, useEffect, useRef, useState } from "react";

export type WcStatus = "idle" | "booting" | "installing" | "starting" | "ready" | "error";

export interface UseWebContainerReturn {
  status: WcStatus;
  previewUrl: string | null;
  terminalLines: string[];
  /** Mount a FileSystemTree and start the dev server */
  runProject: (files: FileSystemTree) => Promise<void>;
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
  const [terminalLines, setTerminalLines] = useState<string[]>([]);
  const devProcessRef = useRef<Awaited<ReturnType<WebContainer["spawn"]>> | null>(null);
  const serverUnsubRef = useRef<(() => void) | null>(null);

  const appendLine = useCallback((line: string) => {
    // Strip ANSI escape codes (cursor movement, color codes, etc.)
    const clean = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");
    if (!clean.trim()) return; // skip blank lines after stripping
    setTerminalLines((prev) => [...prev.slice(-500), clean]);
  }, []);

  const reset = useCallback(() => {
    devProcessRef.current?.kill();
    devProcessRef.current = null;
    serverUnsubRef.current?.();
    serverUnsubRef.current = null;
    setStatus("idle");
    setPreviewUrl(null);
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

        // npm install
        setStatus("installing");
        appendLine("[wc] Running npm install…");
        const installProc = await wc.spawn("npm", ["install"]);

        installProc.output.pipeTo(
          new WritableStream({ write: (chunk) => appendLine(chunk) })
        );

        const installExit = await installProc.exit;
        if (installExit !== 0) {
          throw new Error(`npm install exited with code ${installExit}`);
        }
        appendLine("[wc] npm install done.");

        // npm run dev
        setStatus("starting");
        appendLine("[wc] Starting dev server…");
        const devProc = await wc.spawn("npm", ["run", "dev"]);
        devProcessRef.current = devProc;

        devProc.output.pipeTo(
          new WritableStream({ write: (chunk) => appendLine(chunk) })
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

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      devProcessRef.current?.kill();
      serverUnsubRef.current?.();
    };
  }, []);

  return { status, previewUrl, terminalLines, runProject, reset };
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

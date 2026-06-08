"use client";
import { useEffect, useRef } from "react";

interface WebTerminalProps {
  output: string;
  isRunning: boolean;
}

/**
 * xterm.js-based terminal for rendering real shell output with ANSI colors.
 * Used when run_command returns actual shell output (enableShell=true).
 */
export function WebTerminal({ output, isRunning }: WebTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // biome-ignore lint/suspicious/noExplicitAny: xterm Terminal type
  const termRef = useRef<any>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    let isMounted = true;

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);

      if (!isMounted || !containerRef.current) return;

      // Lazy-load xterm CSS
      await import("@xterm/xterm/css/xterm.css" as string);

      const term = new Terminal({
        theme: {
          background: "#0d1117",
          foreground: "#c9d1d9",
          cursor: "#58a6ff",
          selectionBackground: "#264f78",
          black: "#0d1117",
          brightBlack: "#8b949e",
          green: "#3fb950",
          brightGreen: "#3fb950",
          yellow: "#e3b341",
          brightYellow: "#e3b341",
          blue: "#58a6ff",
          brightBlue: "#79c0ff",
          red: "#f85149",
          brightRed: "#ff7b72",
          cyan: "#39d353",
          white: "#c9d1d9",
          brightWhite: "#ffffff",
        },
        fontFamily: "JetBrains Mono, Fira Code, monospace",
        fontSize: 12,
        lineHeight: 1.5,
        cursorBlink: true,
        scrollback: 2000,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(containerRef.current);
      fitAddon.fit();
      termRef.current = term;

      const ro = new ResizeObserver(() => fitAddon.fit());
      ro.observe(containerRef.current);

      return () => {
        ro.disconnect();
        term.dispose();
      };
    })();

    return () => {
      isMounted = false;
    };
  }, []);

  // Write new output to terminal
  useEffect(() => {
    if (!termRef.current || !output) return;
    termRef.current.clear();
    // Convert \n to \r\n for xterm
    termRef.current.write(output.replace(/\n/g, "\r\n"));
    if (isRunning) termRef.current.write("\r\n\x1b[34m▶ running...\x1b[0m");
  }, [output, isRunning]);

  return (
    <div ref={containerRef} style={{ height: "100%", background: "#0d1117", overflow: "hidden" }} />
  );
}

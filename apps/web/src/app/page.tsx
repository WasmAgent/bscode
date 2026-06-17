"use client";
import type { CardBlock } from "@agentkit-js/ui-cards";
import { parseCardBlocks, upgradeCardSyntax } from "@agentkit-js/ui-cards";
import JSZip from "jszip";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { TurnBlock } from "@/components/TurnBlock";
import type { ConversationTurn } from "@/lib/conversationTypes";

// react-markdown types are not yet updated for React 19. Same compat
// shim ui-cards-react ships in MarkdownCard.tsx.
// biome-ignore lint/suspicious/noExplicitAny: type compat shim
const Markdown = ReactMarkdown as any;

// FrameworkApiMap is a 535-line modal that only renders when the user
// clicks the navbar button. Lazy-loading it (Direction 4 of the
// 2026-06 strategic brief — "bscode漏斗成本控制") removes ~535 LOC of
// modal markup from the / first-paint chunk; the import only fires
// on actual click.
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { DifferentiatorBand } from "@/components/DifferentiatorBand";
import { SettingsDrawer } from "@/components/SettingsDrawer";

const FrameworkApiMap = dynamic(
  () => import("@/components/FrameworkApiMap").then((m) => m.FrameworkApiMap),
  { ssr: false, loading: () => null }
);

// Lazy because the model manager is only opened on the first-run probe
// or when the user clicks the model dropdown — keeps it out of the
// first-paint chunk.
const ModelManager = dynamic(
  () => import("@/components/ModelManager").then((m) => m.ModelManager),
  { ssr: false, loading: () => null }
);

// Lazy because the modal only renders on Differentiator-band → "isolation" click.
// Keeps it out of the first-paint chunk; no UX cost (the click handler awaits
// the chunk while the click feedback is already showing).
const IsolationDemoModal = dynamic(
  () => import("@/components/IsolationDemoModal").then((m) => m.IsolationDemoModal),
  { ssr: false, loading: () => null }
);

import { type PreviewContent, Terminal } from "@/components/Terminal";
import { TokenMeter } from "@/components/TokenMeter";
import { type AgentConfig, useAgent } from "@/hooks/useAgent";
import { useGitHub } from "@/hooks/useGitHub";
import { useImport } from "@/hooks/useImport";
import { toFileSystemTree, useWebContainer } from "@/hooks/useWebContainer";
import { theme } from "@/lib/theme";
import { getWorkerUrl } from "@/lib/workerUrl";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Toast {
  id: number;
  message: string;
  kind: "info" | "success" | "warn" | "error";
}

let toastId = 0;
let turnId = 0;

const TOAST_COLORS: Record<Toast["kind"], string> = {
  info: "#58a6ff",
  success: "#3fb950",
  warn: "#e3b341",
  error: "#f85149",
};

// ── Styles ────────────────────────────────────────────────────────────────────

const mono: React.CSSProperties = { fontFamily: "JetBrains Mono, monospace" };

const iconBtn = (color = theme.textMuted): React.CSSProperties => ({
  padding: "4px 8px",
  borderRadius: 3,
  border: "none",
  background: "transparent",
  color,
  fontSize: 11,
  cursor: "pointer",
  whiteSpace: "nowrap" as const,
});

// ── Main component ────────────────────────────────────────────────────────────

export default function Home() {
  // Hydrate from localStorage on the first render. The `bscode:modelPreference`
  // key is owned by SettingsDrawer; reading it here keeps the header dropdown
  // in sync with whatever the user picked there, even after a reload.
  // We MUST guard against SSR — Next.js renders this on the server first and
  // `localStorage` is not defined there. Returning the static default for the
  // server pass and the persisted value for the client pass would mismatch
  // hydration; instead we always start from the static default and override
  // in a useEffect once we know we're on the client.
  const [config, setConfig] = useState<AgentConfig>({
    agentMode: "tool",
    modelId: "claude-sonnet-4-6",
    maxSteps: 30,
    codeLanguage: "js",
    useOtel: true,
    projectContext: false,
    framework: null,
    autoMode: true,
  });

  useEffect(() => {
    try {
      const saved = localStorage.getItem("bscode:modelPreference");
      if (saved && saved !== "claude-sonnet-4-6") {
        setConfig((c) => ({ ...c, modelId: saved }));
      }
    } catch {
      // localStorage may throw in strict privacy modes; fall through to default.
    }
  }, []);

  // Chat history
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const currentTurnId = useRef<string | null>(null);

  const [inputText, setInputText] = useState("");
  /** User's answers to each clarifying question (index → answer string) */
  const [clarifyAnswers, setClarifyAnswers] = useState<Record<number, string>>({});
  const [preview, setPreview] = useState<PreviewContent | undefined>(undefined);
  /** Currently selected card from conversation — shown full-size in preview */
  const [selectedCard, setSelectedCard] = useState<CardBlock | null>(null);
  const [previewView, setPreviewView] = useState<"messages" | "events" | "preview">("preview");
  /** Streaming artifacts collected from artifact_delta events (v0.dev progressive rendering) */
  const [streamingArtifacts, setStreamingArtifacts] = useState<
    Map<string, { path?: string; content: string; done: boolean }>
  >(new Map());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [isDownloading, setIsDownloading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [apiMapOpen, setApiMapOpen] = useState(false);
  const [isolationDemoOpen, setIsolationDemoOpen] = useState(false);
  // ModelManager is the drawer where the user adds an OpenAI-compatible
  // endpoint + API key. We keep its open state at the page level so:
  //   1. The first-run probe (below) can open it directly when no
  //      models are usable, without prop-drilling through any
  //      sub-component or relying on a CustomEvent dance.
  //   2. The same `bscode:open-model-manager` event AgentPanel used to
  //      listen for still works for any other component that wants to
  //      pop the drawer (kept for compatibility).
  const [modelManagerOpen, setModelManagerOpen] = useState(false);

  // Listen for the open-model-manager event — kept for backwards
  // compatibility with components that may dispatch it (e.g. the
  // recipes page, future deep-links). The first-run probe below
  // calls setState directly instead of going through the event.
  useEffect(() => {
    const handler = () => setModelManagerOpen(true);
    window.addEventListener("bscode:open-model-manager", handler);
    return () => window.removeEventListener("bscode:open-model-manager", handler);
  }, []);
  const chatBottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const prevIsRunning = useRef(false);
  // Synchronous guard for rapid re-clicks on Run — React's `isRunning`
  // state is updated asynchronously, so multiple clicks within the same
  // tick all see isRunning=false and submit duplicate turns. This ref
  // is flipped synchronously inside handleSubmit before any awaits.
  const submitInFlight = useRef(false);

  const addToast = useCallback((message: string, kind: Toast["kind"] = "info") => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, message, kind }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 3500);
  }, []);

  const {
    messages,
    isRunning,
    rawEvents,
    tokenStats,
    finalAnswer,
    submit,
    abort,
    resetAll,
    classifying,
    detectedMode,
    clarifyingQuestions,
    dismissClarify,
  } = useAgent(config, (update) => setConfig((prev) => ({ ...prev, ...update })));

  const { user, pushing, login: githubLogin, pushToGitHub } = useGitHub();
  const { importing, importFromZip, importFromDirectory, uploadFiles } = useImport();
  const {
    status: wcStatus,
    previewUrl,
    terminalLines: wcLines,
    buildError,
    runProject,
    reset: wcReset,
  } = useWebContainer();

  // ── Scroll chat to bottom ──────────────────────────────────────────────────
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  // ── Track detectedMode onto current turn ───────────────────────────────────
  useEffect(() => {
    if (!detectedMode || !currentTurnId.current) return;
    setTurns((prev) =>
      prev.map((t) => (t.id === currentTurnId.current ? { ...t, detectedMode } : t))
    );
  }, [detectedMode]);

  // ── Sync streaming messages into current turn ──────────────────────────────
  useEffect(() => {
    if (!currentTurnId.current) return;
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    const rawText = lastAssistant?.content ?? "";

    // Extract <boltThinking> plan block (bolt.new pattern) — show as plan preview
    const planMatch = /<boltThinking>([\s\S]*?)<\/boltThinking>/i.exec(rawText);
    const planText = planMatch ? planMatch[1].trim() : null;
    // Strip the boltThinking block from displayed agent text
    const agentText = rawText.replace(/<boltThinking>[\s\S]*?<\/boltThinking>/gi, "").trim();

    const toolLines = messages.filter((m) => m.role === "tool").map((m) => m.content);
    const errorMsg = messages.find((m) => m.role === "error")?.content ?? null;
    setTurns((prev) =>
      prev.map((t) =>
        t.id === currentTurnId.current
          ? {
              ...t,
              agentText: agentText || t.agentText,
              planText: planText ?? t.planText,
              toolLines,
              error: errorMsg,
              status: isRunning ? "running" : errorMsg ? "error" : t.status,
            }
          : t
      )
    );
  }, [messages, isRunning]);

  // ── Finalize turn on completion ────────────────────────────────────────────
  useEffect(() => {
    if (prevIsRunning.current && !isRunning && currentTurnId.current) {
      const hasError = messages.some((m) => m.role === "error");
      setTurns((prev) =>
        prev.map((t) =>
          t.id === currentTurnId.current
            ? {
                ...t,
                finalAnswer: finalAnswer ?? null,
                status: hasError ? "error" : "done",
                thinkingCollapsed: true, // auto-collapse thinking when done
              }
            : t
        )
      );
      if (hasError) {
        addToast("Agent encountered an error", "error");
      } else if (finalAnswer) {
        addToast("Done", "success");
      }
    }
    prevIsRunning.current = isRunning;
  }, [isRunning, messages, finalAnswer, addToast]);

  // ── Tool results → execution output + write progress ─────────────────────
  useEffect(() => {
    if (rawEvents.length === 0 || !currentTurnId.current) return;

    // Track write_file tool_calls to show file write progress in the turn bubble
    const writtenFiles = rawEvents
      .filter((ev) => ev.event === "tool_call")
      .map((ev) => {
        const d = ev.data as Record<string, unknown>;
        if (d.toolName !== "write_file") return null;
        const args = d.args as Record<string, unknown> | undefined;
        return String(args?.path ?? "").trim() || null;
      })
      .filter(Boolean) as string[];

    if (writtenFiles.length > 0) {
      setTurns((prev) =>
        prev.map((t) => (t.id === currentTurnId.current ? { ...t, writtenFiles } : t))
      );
    }

    // Execution output for preview
    const kernelResults = rawEvents
      .filter((ev) => ev.event === "tool_result")
      .map((ev) => {
        const d = ev.data as Record<string, unknown>;
        const out = String(d.output ?? "").trim();
        return out ? `[${String(d.toolName ?? "tool")}] ${out}` : null;
      })
      .filter(Boolean) as string[];
    if (kernelResults.length > 0) {
      setPreview((prev) => ({ ...prev, logs: kernelResults }));
    }

    // Progressive artifact streaming (v0.dev pattern) — collect artifact_delta events
    for (const ev of rawEvents) {
      const d = ev.data as Record<string, unknown>;
      if (ev.event === "artifact_stream_start") {
        const id = String(d.artifactId ?? "");
        setStreamingArtifacts((prev) =>
          new Map(prev).set(id, { path: d.path as string | undefined, content: "", done: false })
        );
      } else if (ev.event === "artifact_delta") {
        const id = String(d.artifactId ?? "");
        const delta = String(d.delta ?? "");
        setStreamingArtifacts((prev) => {
          const existing = prev.get(id);
          if (!existing) return prev;
          return new Map(prev).set(id, { ...existing, content: existing.content + delta });
        });
      } else if (ev.event === "artifact_stream_end") {
        const id = String(d.artifactId ?? "");
        setStreamingArtifacts((prev) => {
          const existing = prev.get(id);
          if (!existing) return prev;
          return new Map(prev).set(id, { ...existing, done: true });
        });
      }
    }
  }, [rawEvents]);

  // ── Framework mode → WebContainers ────────────────────────────────────────
  const prevIsFrameworkRunning = useRef(false);
  useEffect(() => {
    const wasRunning = prevIsFrameworkRunning.current;
    prevIsFrameworkRunning.current = isRunning && !!config.framework;
    if (wasRunning && !isRunning && config.framework) {
      const workerUrl = getWorkerUrl();
      setPreviewView("preview");
      addToast("Mounting files into WebContainers…", "info");
      fetch(`${workerUrl}/files/bulk`)
        .then((r) => r.json())
        .then((data: { files: { path: string; content: string }[] }) => {
          if (!data.files?.length) {
            addToast("No files written", "warn");
            return;
          }
          runProject(toFileSystemTree(data.files));
        })
        .catch((err: Error) => addToast(`Mount failed: ${err.message}`, "error"));
    }
  }, [isRunning, config.framework, runProject, addToast]);

  // ── WebContainers preview URL ──────────────────────────────────────────────
  useEffect(() => {
    if (previewUrl) {
      setPreview((prev) => ({ ...prev, url: previewUrl }));
      setPreviewView("preview");
      addToast("App is live", "success");
    }
  }, [previewUrl, addToast]);

  // Forward ref to handleSubmit — the auto-fix and other callback-driven
  // effects below reference it before its declaration, which is fine at
  // runtime (deps fire after render) but trips TypeScript strict mode.
  // The ref is assigned in a useEffect right after handleSubmit's definition.
  const handleSubmitRef = useRef<((task: string, skipClarify?: boolean) => Promise<void>) | null>(
    null
  );

  useEffect(() => {
    if (wcStatus === "error" && buildError) {
      setPreview((prev) => ({ ...prev, error: "WebContainers build failed" }));
      addToast("Build failed — auto-fixing…", "warn");

      // Auto-fix loop: fetch workspace files and ask agent to fix the error
      const workerUrl = getWorkerUrl();
      fetch(`${workerUrl}/files/bulk`)
        .then((r) => r.json())
        .then((data: { files: { path: string; content: string }[] }) => {
          if (!data.files?.length) {
            addToast("No files to fix", "warn");
            return;
          }
          // Provide error context + file list so agent can fix precisely
          const fileSummary = data.files
            .filter((f) => /\.(ts|tsx|js|jsx|vue|svelte|json)$/.test(f.path))
            .slice(0, 10)
            .map((f) => `${f.path}:\n${f.content.slice(0, 500)}`)
            .join("\n---\n");
          const fixTask = `WebContainers build failed with this error:
\`\`\`
${buildError.slice(0, 800)}
\`\`\`

Project files:
${fileSummary}

Please fix the error. Use patch_file or write_file to correct the broken files.`;
          // skipClarify=true — fix tasks always run immediately, no re-clarify
          handleSubmitRef.current?.(fixTask, true);
        })
        .catch(() => addToast("Could not auto-fix: failed to fetch files", "error"));
    }
  }, [
    wcStatus,
    buildError,
    addToast, // skipClarify=true — fix tasks always run immediately, no re-clarify
  ]);

  // ── Final answer → preview ─────────────────────────────────────────────────
  useEffect(() => {
    if (!finalAnswer) return;

    // Clear any preview state carried over from the previous turn — a new
    // final answer must not silently inherit the old turn's card / html /
    // output. The 2026-06-17 user report ("first turn was just '你好',
    // right pane still showed the previous turn's GDP markdown card")
    // was caused by us only ever WRITING to preview state below, never
    // resetting it.
    setSelectedCard(null);
    setPreview((prev) => ({ ...prev, card: undefined, html: undefined, output: undefined }));

    // 1. card:* blocks — let the Preview tab render them via CardRenderer
    //    so the user sees the same rich rendering as the chat. Pre-fix
    //    they fell through to the `plain` branch and showed raw markdown
    //    text in the preview iframe, which made the Messages tab look
    //    "more rendered" than Preview.
    //
    //    BUT: in framework mode (react/vue/svelte/vanilla), WebContainer
    //    is about to mount the freshly-written files and produce a real
    //    live preview URL — that's the artefact the user actually wants
    //    to see in the right pane. The agent's companion `card:markdown`
    //    summary should NOT take the preview slot away from the running
    //    app. Skip the markdown card here; the chat side already inline-
    //    renders it (TurnBlock checks turn.writtenFiles.length > 0).
    //    D2 / SVG / HTML cards still claim preview — those are visual
    //    artefacts in their own right.
    const parsed = parseCardBlocks(finalAnswer);
    const firstCard = parsed.cards[0];
    const isFrameworkRun = !!config.framework;
    if (firstCard && !(isFrameworkRun && firstCard.type === "markdown")) {
      setPreview((prev) => ({ ...prev, card: firstCard }));
      setPreviewView("preview");
      return;
    }
    // 2. Only treat the final answer as HTML if it's:
    //   (a) a complete HTML document (<!DOCTYPE / <html>), OR
    //   (b) wrapped in an EXPLICIT ```html ... ``` fence (lang=html required).
    // The earlier regex used (?:html)? which made the language optional, so a
    // `card:markdown` block (which contains its OWN nested ``` fences) would
    // be mistakenly extracted as HTML and rendered as plain text in the
    // iframe — see the chromedev regression for the "raw markdown in
    // preview" finding.
    const htmlFenced = /```html\n([\s\S]+?)```/.exec(finalAnswer)?.[1];
    const isHtmlDoc = /<(!DOCTYPE|html)\b/i.test(finalAnswer);
    const htmlContent = htmlFenced ?? (isHtmlDoc ? finalAnswer : null);
    if (htmlContent) {
      setPreview((prev) => ({ ...prev, html: htmlContent.trim() }));
      setPreviewView("preview");
      return;
    }
    // matplotlib / image output: data:image/png;base64,...
    const isDataUrl = /^data:image\/(png|jpeg|gif|webp);base64,/.test(finalAnswer.trim());
    if (isDataUrl) {
      const imgHtml = `<html><body style="margin:0;background:#0d1117;display:flex;align-items:center;justify-content:center;min-height:100vh"><img src="${finalAnswer.trim()}" style="max-width:100%;max-height:100vh;object-fit:contain"/></body></html>`;
      setPreview((prev) => ({ ...prev, html: imgHtml }));
      setPreviewView("preview");
      return;
    }
    // 3. Plain text reply — DO NOT push it into preview.output. The chat
    //    bubble already renders the Markdown inline; populating
    //    preview.output here would force the right-hand pane to stay
    //    visible just to repeat what the chat already shows. Leaving
    //    preview.output undefined keeps `hasPreview` false and lets
    //    the layout collapse to a single full-width chat column.
  }, [finalAnswer]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── First-run model probe ──────────────────────────────────────────────────
  // If a visitor lands with NO usable models (no built-in API keys
  // configured at the worker, no local Ollama/LMStudio reachable from
  // the worker, no custom models added), open the ModelManager so they
  // see exactly what to do. The worker auto-discovers local services,
  // so users with Ollama already on the SAME network as the worker
  // don't trigger this. (For a Cloudflare-deployed worker, "local" is
  // the worker datacentre, not the visitor's machine — visitors with
  // local-only Ollama won't be detected; they'll see ModelManager
  // and either point at their public endpoint or pick another
  // provider.)
  useEffect(() => {
    let cancelled = false;
    async function probe() {
      try {
        if (localStorage.getItem("bscode:firstrun:probed") === "1") return;
        const res = await fetch(`${getWorkerUrl()}/models`);
        if (!res.ok) return;
        const data = (await res.json()) as { models?: Array<{ available?: boolean }> };
        const usable = (data.models ?? []).some((m) => m.available === true);
        if (cancelled) return;
        // Mark probed FIRST so even if the user closes the manager
        // without adding anything, we don't re-pop on every refresh.
        localStorage.setItem("bscode:firstrun:probed", "1");
        if (!usable) setModelManagerOpen(true);
      } catch {
        // network / parse / localStorage unavailable — fail silently.
      }
    }
    void probe();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Submit ─────────────────────────────────────────────────────────────────
  /** Keep the last submitted task text so skip button can reference it */
  const lastSubmittedTask = useRef("");

  const handleSubmit = useCallback(
    async (taskText: string, skipClarify = false) => {
      const text = taskText.trim();
      // React state isRunning/classifying flip on next render — between
      // a rapid click sequence they're all still false, so we'd submit
      // N duplicate turns. Use a synchronous ref to short-circuit.
      if (!text || isRunning || classifying || submitInFlight.current) return;
      submitInFlight.current = true;
      try {
        lastSubmittedTask.current = text;
        setInputText("");
        setClarifyAnswers({});
        setPreview(undefined);
        setSelectedCard(null);
        setStreamingArtifacts(new Map());
        wcReset();

        const workerUrl = getWorkerUrl();

        // Clear workspace files before each new run to prevent cross-task file contamination
        // (framework mode writes many files; old files from prior runs cause mismatch bugs)
        fetch(`${workerUrl}/files`, { method: "DELETE" }).catch(() => {});

        // ── @ file reference resolution ─────────────────────────────────────────
        let resolvedText = text;
        const atMentions = [...text.matchAll(/@([\w./-]+\.\w+)/g)].map((m) => m[1]);
        if (atMentions.length > 0) {
          const fileContents = await Promise.all(
            atMentions.map(async (path) => {
              try {
                const res = await fetch(`${workerUrl}/files/${encodeURIComponent(path)}`);
                if (!res.ok) return null;
                const data = (await res.json()) as { content: string };
                return { path, content: data.content };
              } catch {
                return null;
              }
            })
          );
          const injected = fileContents
            .filter(Boolean)
            .map((f) => `\n\n### @${f?.path}\n\`\`\`\n${f?.content.slice(0, 2000)}\n\`\`\``)
            .join("");
          if (injected) resolvedText = text + injected;
        }

        const id = `turn-${++turnId}`;
        currentTurnId.current = id;
        setTurns((prev) => [
          ...prev,
          {
            id,
            task: text,
            detectedMode: null,
            timestamp: Date.now(),
            agentText: "",
            planText: null,
            toolLines: [],
            writtenFiles: [],
            thinkingCollapsed: false,
            finalAnswer: null,
            error: null,
            status: "running",
          },
        ]);
        resetAll();

        const history = turns
          .filter((t) => t.status === "done" && t.finalAnswer)
          .slice(-5)
          .flatMap(
            (t): Array<{ role: "user" | "assistant"; content: string }> => [
              { role: "user", content: t.task },
              { role: "assistant", content: t.finalAnswer ?? "" },
            ]
          );

        submit(resolvedText, history.length > 0 ? history : undefined, skipClarify);
      } catch (err) {
        // Submit failed synchronously — release the guard so the user
        // can try again. Without this, a thrown error would strand the
        // ref at true and silently disable Run forever.
        submitInFlight.current = false;
        throw err;
      }
      // NOTE: do NOT reset submitInFlight in a finally here. submit()
      // schedules React state updates that haven't flushed yet — if we
      // released the guard now, a second click in the same tick would
      // race past it. The guard is released by the useEffect below that
      // watches isRunning/classifying.
    },
    [isRunning, classifying, submit, resetAll, wcReset, turns]
  );

  // Bind the ref now that handleSubmit exists. This lets earlier-declared
  // useEffects (auto-fix, etc.) call handleSubmit without TS strict mode
  // tripping on the use-before-declaration. The ref is updated on every
  // render so the latest closure is always reachable.
  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

  // Release the synchronous-submit guard once React has acknowledged
  // the run started (isRunning OR classifying flips to true). After
  // that, the disabled-Run-button + isRunning check cover repeat clicks.
  useEffect(() => {
    if ((isRunning || classifying) && submitInFlight.current) {
      submitInFlight.current = false;
    }
  }, [isRunning, classifying]);

  // ── Enhance Prompt ─────────────────────────────────────────────────────────
  // Calls /enhance-prompt to rewrite a vague task into a detailed spec (bolt.new)
  const [enhancing, setEnhancing] = useState(false);
  const handleEnhancePrompt = useCallback(async () => {
    const text = inputText.trim();
    if (!text || enhancing) return;
    const workerUrl = getWorkerUrl();
    setEnhancing(true);
    try {
      const res = await fetch(`${workerUrl}/enhance-prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task: text,
          mode: config.agentMode,
          framework: config.framework,
        }),
      });
      const data = (await res.json()) as { enhanced: string };
      if (data.enhanced && data.enhanced !== text) {
        setInputText(data.enhanced);
        addToast("Prompt enhanced ✨", "info");
      }
    } catch {
      /* ignore */
    } finally {
      setEnhancing(false);
    }
  }, [inputText, config, enhancing, addToast]);

  // ── One-click Fix ──────────────────────────────────────────────────────────
  const handleFix = useCallback(() => {
    const lastTurn = turns.at(-1);
    if (!lastTurn?.error) return;
    // Use the same language as the original task so the agent's reply
    // matches the user's language. The user instructs the assistant
    // when they type the task; we shouldn't clobber that with English.
    const isChinese = /[一-鿿]/.test(lastTurn.task);
    const fixTask = isChinese
      ? `请修复以下错误：\n${lastTurn.error}\n\n原始任务：${lastTurn.task}`
      : `Fix the following error:\n${lastTurn.error}\n\nOriginal task: ${lastTurn.task}`;
    handleSubmit(fixTask, true); // skipClarify=true — fix runs immediately, no re-clarify
  }, [turns, handleSubmit]);

  // ── ZIP download ───────────────────────────────────────────────────────────
  const handleDownloadZip = useCallback(async () => {
    const workerUrl = getWorkerUrl();
    setIsDownloading(true);
    try {
      const res = await fetch(`${workerUrl}/files/bulk`);
      const data = (await res.json()) as { files: { path: string; content: string }[] };
      if (!data.files?.length) {
        addToast("No files to download", "warn");
        return;
      }
      const toSlug = (str: string) => {
        const w = str.match(/[a-zA-Z0-9]+/g) ?? [];
        if (w.length >= 2) return w.join("-").toLowerCase().slice(0, 40).replace(/-+$/, "");
        return (
          str
            .normalize("NFKD")
            // biome-ignore lint/suspicious/noControlCharactersInRegex: ASCII-range filter for non-ASCII fallback
            .replace(/[^\x00-\x7F]/g, " ")
            .replace(/[^\w\s-]/g, " ")
            .trim()
            .replace(/\s+/g, "-")
            .replace(/-+/g, "-")
            .toLowerCase()
            .slice(0, 40)
            .replace(/^-+|-+$/, "")
        );
      };
      let name = "";
      const pkg = data.files.find((f) => f.path === "package.json");
      if (pkg) {
        try {
          name = toSlug((JSON.parse(pkg.content) as { name?: string }).name ?? "");
        } catch {
          /**/
        }
      }
      if (!name) name = toSlug(turns.at(-1)?.task ?? "");
      if (!name || name.length < 3) name = `project-${Date.now().toString(36)}`;
      const zip = new JSZip();
      for (const { path, content } of data.files) zip.file(path, content);
      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${name}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      addToast(`Downloaded ${data.files.length} files as ${name}.zip`, "success");
    } catch (err) {
      addToast(`Download failed: ${(err as Error).message}`, "error");
    } finally {
      setIsDownloading(false);
    }
  }, [addToast, turns]);

  // ── Import ─────────────────────────────────────────────────────────────────
  const handleImportZip = useCallback(() => {
    const workerUrl = getWorkerUrl();
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const files = await importFromZip(file);
        if (!files.length) {
          addToast("ZIP contains no importable files", "warn");
          return;
        }
        addToast(`Imported ${await uploadFiles(files, workerUrl)} files`, "success");
      } catch (err) {
        addToast(`Import failed: ${(err as Error).message}`, "error");
      }
    };
    input.click();
  }, [importFromZip, uploadFiles, addToast]);

  const handleImportDir = useCallback(async () => {
    const workerUrl = getWorkerUrl();
    try {
      const files = await importFromDirectory();
      if (!files.length) {
        addToast("No importable files found", "warn");
        return;
      }
      addToast(`Imported ${await uploadFiles(files, workerUrl)} files from directory`, "success");
    } catch (err) {
      addToast(`Import failed: ${(err as Error).message}`, "error");
    }
  }, [importFromDirectory, uploadFiles, addToast]);

  // ── GitHub ─────────────────────────────────────────────────────────────────
  const handleGitHub = useCallback(async () => {
    if (!user) {
      githubLogin();
      return;
    }
    const workerUrl = getWorkerUrl();
    try {
      const r = await pushToGitHub(workerUrl);
      addToast(`Pushed: ${r.repoName}`, "success");
      window.open(r.repoUrl, "_blank");
    } catch (err) {
      addToast(`GitHub: ${(err as Error).message}`, "error");
    }
  }, [user, githubLogin, pushToGitHub, addToast]);

  // ── Last error ─────────────────────────────────────────────────────────────
  const lastTurnError = turns.at(-1)?.status === "error" ? turns.at(-1)?.error : null;

  // ── Render ─────────────────────────────────────────────────────────────────
  // hasPreview drives whether the right-hand Terminal/Preview pane is
  // visible. We include card + selectedCard explicitly: if all that's in
  // preview state is a stale `card` from a prior turn (now cleared by
  // the finalAnswer effect above) but selectedCard is null and no
  // turn is producing one, the pane should collapse so chat takes the
  // full width.
  const hasPreview = !!(
    preview?.html ||
    preview?.url ||
    preview?.card ||
    selectedCard ||
    (preview?.logs?.length ?? 0) > 0 ||
    preview?.output ||
    // Show the pane during WebContainer build so the user sees the
    // loading skeleton instead of nothing for the 10–30 s between
    // "agent done writing files" and "vite dev server up".
    (wcStatus && wcStatus !== "idle" && wcStatus !== "ready" && wcStatus !== "error")
  );

  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: "#0d1117",
        ...mono,
      }}
    >
      {/* ── Toasts ── */}
      <div
        style={{
          position: "fixed",
          bottom: 56,
          right: 16,
          zIndex: 9999,
          display: "flex",
          flexDirection: "column",
          gap: 6,
          pointerEvents: "none",
        }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            style={{
              background: "#21262d",
              border: `1px solid ${TOAST_COLORS[t.kind]}44`,
              borderLeft: `3px solid ${TOAST_COLORS[t.kind]}`,
              borderRadius: 4,
              padding: "7px 12px",
              fontSize: 11,
              color: "#c9d1d9",
              animation: "slideIn 0.15s ease",
              boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
            }}
          >
            {t.message}
          </div>
        ))}
      </div>

      {/* ── Top navbar ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          rowGap: 6,
          padding: "0 16px",
          minHeight: 44,
          background: "#161b22",
          borderBottom: "1px solid #30363d",
          flexShrink: 0,
        }}
      >
        {/* Left: logo + mode */}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ color: "#58a6ff", fontWeight: 700, fontSize: 14, letterSpacing: 1 }}>
            BSCode
          </span>
          {/* B-D1 (2026-06): unified funnel CTA. The same string lives in
              README.md so both surfaces send the same signal. The
              source=ui-pill query param distinguishes UI clicks from
              README-link / deploy-button traffic in any aggregation. */}
          <a
            href="https://www.npmjs.com/package/@agentkit-js/core?source=bscode-ui-pill"
            target="_blank"
            rel="noopener noreferrer"
            title="bscode is a thin template; the framework lives at @agentkit-js/core"
            style={{
              fontSize: 10,
              padding: "2px 7px",
              borderRadius: 999,
              background: "#3fb95022",
              color: "#3fb950",
              textDecoration: "none",
              border: "1px solid #3fb95044",
              whiteSpace: "nowrap",
            }}
          >
            npm add @agentkit-js/core →
          </a>
          {/* Direction 6 reverse-funnel entry: "their framework + our kernel".
              Visible alongside the npm pill so a visitor on Vercel AI SDK 6 /
              Cloudflare codemode / Mastra / Anthropic / OpenAI Agents JS
              sees the runtime pitch immediately, not only after exploring
              the CodeAgent demo. */}
          <a
            href="/recipes?source=bscode-ui-recipes-pill"
            title="Drop the agentkit kernel into the framework you already use"
            style={{
              fontSize: 10,
              padding: "2px 7px",
              borderRadius: 999,
              background: "#9b9bff22",
              color: "#9b9bff",
              textDecoration: "none",
              border: "1px solid #9b9bff44",
              whiteSpace: "nowrap",
            }}
          >
            their framework + our kernel →
          </a>
          {/* Mode toggle */}
          <div style={{ display: "flex", gap: 3 }}>
            {(["code", "tool"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setConfig((c) => ({ ...c, agentMode: mode, framework: null }))}
                style={{
                  padding: "3px 8px",
                  borderRadius: 3,
                  fontSize: 10,
                  border: "none",
                  cursor: "pointer",
                  background:
                    config.agentMode === mode && !config.framework ? "#1f6feb33" : "transparent",
                  color:
                    config.agentMode === mode && !config.framework ? "#58a6ff" : theme.textMuted,
                  fontWeight: 600,
                }}
              >
                {mode === "code" ? "Code" : "Tool"}
              </button>
            ))}
            <button
              type="button"
              onClick={() =>
                setConfig((c) => ({
                  ...c,
                  agentMode: "tool",
                  framework: c.framework ? null : "react",
                }))
              }
              style={{
                padding: "3px 8px",
                borderRadius: 3,
                fontSize: 10,
                border: "none",
                cursor: "pointer",
                background: config.framework ? "#23863622" : "transparent",
                color: config.framework ? "#3fb950" : theme.textMuted,
                fontWeight: 600,
              }}
            >
              {config.framework ? `⚡ ${config.framework}` : "Framework"}
            </button>
          </div>
          {/* Framework selector */}
          {config.framework && (
            <div style={{ display: "flex", gap: 3 }}>
              {(["react", "vue", "svelte", "vanilla"] as const).map((fw) => (
                <button
                  key={fw}
                  type="button"
                  onClick={() => setConfig((c) => ({ ...c, framework: fw }))}
                  style={{
                    padding: "2px 7px",
                    borderRadius: 3,
                    fontSize: 10,
                    border: "none",
                    cursor: "pointer",
                    background: config.framework === fw ? "#3fb95022" : "transparent",
                    color: config.framework === fw ? "#3fb950" : theme.textMuted,
                  }}
                >
                  {fw === "react"
                    ? "React"
                    : fw === "vue"
                      ? "Vue"
                      : fw === "svelte"
                        ? "Svelte"
                        : "Vanilla"}
                </button>
              ))}
            </div>
          )}
          {/* Auto-detect badge */}
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              cursor: "pointer",
              fontSize: 10,
              color: theme.textMuted,
            }}
          >
            <input
              type="checkbox"
              checked={config.autoMode ?? true}
              onChange={(e) => setConfig((c) => ({ ...c, autoMode: e.target.checked }))}
              style={{ accentColor: "#58a6ff", width: 11, height: 11 }}
            />
            Auto-detect
          </label>
        </div>

        {/* Right: model + tools */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <select
            id="bscode-model-select"
            name="model"
            aria-label="Model"
            title="Select language model"
            value={config.modelId}
            onChange={(e) => setConfig((c) => ({ ...c, modelId: e.target.value }))}
            style={{
              background: "#21262d",
              border: "1px solid #30363d",
              borderRadius: 4,
              color: "#c9d1d9",
              fontSize: 11,
              padding: "3px 6px",
              cursor: "pointer",
            }}
          >
            <option value="claude-sonnet-4-6">Sonnet 4.6</option>
            <option value="claude-opus-4-8">Opus 4.8</option>
            <option value="claude-haiku-4-5-20251001">Haiku 4.5</option>
          </select>
          <button
            type="button"
            onClick={handleImportDir}
            disabled={importing}
            style={iconBtn(importing ? theme.textMuted : "#c9d1d9")}
            title="Import from directory"
          >
            ⬆ Dir
          </button>
          <button
            type="button"
            onClick={handleImportZip}
            disabled={importing}
            style={iconBtn(importing ? theme.textMuted : "#c9d1d9")}
            title="Import ZIP"
          >
            ⬆ ZIP
          </button>
          <button
            type="button"
            onClick={handleDownloadZip}
            disabled={isDownloading}
            style={iconBtn("#58a6ff")}
            title="Download ZIP"
          >
            ⬇ ZIP
          </button>
          <button
            type="button"
            onClick={handleGitHub}
            disabled={pushing}
            style={{
              ...iconBtn(user ? "#3fb950" : theme.textMuted),
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
            title={user ? `Push to GitHub (${user.login})` : "Connect GitHub"}
          >
            {user ? (
              // biome-ignore lint/performance/noImgElement: avatar from GitHub CDN — using next/image would require remotePatterns config and adds no perf benefit for a 13×13 px image
              <img
                src={user.avatar_url}
                alt={user.login}
                width={13}
                height={13}
                style={{ borderRadius: "50%" }}
              />
            ) : null}
            {pushing ? "…" : user ? "Push" : "GitHub"}
          </button>
          <button
            type="button"
            onClick={() => setApiMapOpen(true)}
            style={iconBtn(theme.textMuted)}
            title="What you see ↔ what you can copy (B1, 2026-06)"
          >
            ?
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen((o) => !o)}
            style={iconBtn(theme.textMuted)}
            title="Settings"
          >
            ⚙
          </button>
        </div>
      </div>

      {/* D6 (2026-06-13) — three differentiated demos. Sits below the
          navbar so first-paint includes the funnel signals; collapses
          on dismissal (localStorage `bscode:diffband:dismissed`). The
          handleTryDemo callback dispatches a UTM event AND scrolls /
          opens the matching subsection of the existing UI. */}
      <DifferentiatorBand
        onTry={(demoId) => {
          // Each demo is a *signal*, not a full tutorial. We surface a
          // toast that points the visitor at the matching part of the
          // existing UI; the funnel-tracking event has already fired
          // inside the band itself.
          //
          // The `isolation` demo is the one exception — it opens a
          // modal because the OWASP attack scenarios + intercepted
          // errors are inherently visual and don't map to "scroll to a
          // section of the existing app." The other three demos all
          // exist as flows in the existing UI.
          const toastMessages: Record<typeof demoId, string> = {
            portal: "Try: prompt 'federate fs + github MCP servers and list the agentkit-js repos'",
            resume:
              "Try: start any run, then DevTools → Network → throttle Offline; the run resumes when you go back online",
            fork: "Try: run any task, then click the EventLog timeline → Fork from this step",
            isolation: "Watch four OWASP Agentic Top 10 attacks hit the kernel and bounce.",
          };
          addToast(toastMessages[demoId], "info");
          if (demoId === "isolation") {
            setIsolationDemoOpen(true);
          }
        }}
      />

      {/* First-run model probe — runs ONCE per browser. If the worker
          reports zero usable models (no local Ollama/LMStudio running,
          no built-in keys configured, no custom models added), open
          the ModelManager directly so the visitor sees what they need
          to do. The worker auto-discovers local services, so users
          with Ollama already running don't trigger this — it only
          fires for true cold-start "I have no model anywhere" cases. */}

      {settingsOpen && <SettingsDrawer onClose={() => setSettingsOpen(false)} />}
      {/* Only mount the API-map modal when it's actually open — combined
          with the dynamic() wrapper this defers both the chunk download
          AND the React tree until the user clicks. */}
      {apiMapOpen && <FrameworkApiMap open={true} onClose={() => setApiMapOpen(false)} />}
      {isolationDemoOpen && <IsolationDemoModal onClose={() => setIsolationDemoOpen(false)} />}
      {modelManagerOpen && (
        <ModelManager
          workerUrl={getWorkerUrl()}
          currentPrefs={{ primaryModelId: config.modelId }}
          onClose={() => setModelManagerOpen(false)}
          onApply={(prefs) => {
            setConfig((c) => ({ ...c, modelId: prefs.primaryModelId }));
            // Persist so the SettingsDrawer dropdown stays in sync.
            try {
              localStorage.setItem("bscode:modelPreference", prefs.primaryModelId);
            } catch {
              // localStorage may throw in privacy modes; ignore.
            }
            setModelManagerOpen(false);
          }}
        />
      )}

      {/* ── Main area ── */}
      {/* On narrow viewports collapse to a single column so neither pane gets squeezed
          below readability — chat input and Run button were getting clipped at 375px.
          When `hasPreview` is false, also collapse to one column on wide
          viewports — there is nothing to show in the right pane, so chat
          takes the full width (2026-06-17 fix for the "你好 reply, but
          right pane still occupied half the screen" report). */}
      <div
        style={{
          flex: 1,
          display: "grid",
          gridTemplateColumns: hasPreview ? "minmax(0, 1fr) minmax(0, 1fr)" : "minmax(0, 1fr)",
          overflow: "hidden",
        }}
        className="bscode-main-grid"
      >
        {/* ── Left: chat history ── */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            borderRight: "1px solid #30363d",
            overflow: "hidden",
          }}
        >
          {/* Chat scroll area */}
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "16px 20px",
              display: "flex",
              flexDirection: "column",
              gap: 24,
            }}
          >
            {turns.length === 0 && (
              <div
                style={{ color: theme.textDim, fontSize: 13, textAlign: "center", marginTop: 60 }}
              >
                <div style={{ fontSize: 32, marginBottom: 12 }}>💬</div>
                <div>Describe a task to get started.</div>
                <div style={{ fontSize: 11, marginTop: 6, color: theme.textDim }}>
                  e.g. "build a Vue 3 todo list" · "implement quicksort" · "create a React
                  dashboard"
                </div>
              </div>
            )}
            {turns.map((turn) => (
              <TurnBlock
                key={turn.id}
                turn={turn}
                isActive={turn.id === currentTurnId.current && isRunning}
                streamingText={
                  turn.id === currentTurnId.current
                    ? messages.find((m) => m.role === "assistant")?.content
                    : undefined
                }
                onFix={
                  turn.status === "error"
                    ? () => {
                        // Match the original task's language so the agent's
                        // reply uses the same one.
                        const isCh = /[一-鿿]/.test(turn.task);
                        const fixTask = isCh
                          ? `修复错误：${turn.error}\n\n原始任务：${turn.task}`
                          : `Fix this error: ${turn.error}\n\nOriginal task: ${turn.task}`;
                        handleSubmit(fixTask, true);
                      }
                    : undefined
                }
                onRetry={() => handleSubmit(turn.task, true)}
                onPreviewCard={(card) => {
                  setSelectedCard(card);
                  setPreviewView("preview");
                }}
                isFrameworkMode={!!config.framework}
                previewUrl={previewUrl ?? undefined}
              />
            ))}
            <div ref={chatBottomRef} />
          </div>

          {/* ── Input bar ── */}
          <div
            style={{
              borderTop: "1px solid #30363d",
              padding: "12px 16px",
              background: "#0d1117",
              flexShrink: 0,
            }}
          >
            {/* Clarifying questions — Claude Code style: options + free text + auto-continue */}
            {clarifyingQuestions &&
              clarifyingQuestions.length > 0 &&
              !isRunning &&
              (() => {
                // Check if all questions have been answered
                const allAnswered = clarifyingQuestions.every((_, i) =>
                  (clarifyAnswers[i] ?? "").trim()
                );

                const submitWithAnswers = () => {
                  const answerSuffix = clarifyingQuestions
                    .map((q, i) => `${q.text}: ${(clarifyAnswers[i] ?? "").replace(/^other:/, "")}`)
                    .join("\n");
                  // Build enriched task: original task + Q&A answers
                  const baseTask = lastSubmittedTask.current || inputText.trim();
                  const enrichedTask = baseTask ? `${baseTask}\n\n${answerSuffix}` : answerSuffix;
                  dismissClarify();
                  setClarifyAnswers({});
                  // skipClarify=true so this doesn't trigger another clarify round
                  handleSubmit(enrichedTask, true);
                };

                return (
                  <div
                    style={{
                      marginBottom: 10,
                      background: "#0d1b2a",
                      border: "1px solid #1f6feb55",
                      borderRadius: 8,
                      padding: "12px 14px",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 11,
                        color: "#58a6ff",
                        fontWeight: 700,
                        marginBottom: 10,
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <span>
                        💬{" "}
                        {/[一-龥]/.test(clarifyingQuestions[0]?.text ?? "")
                          ? "几个问题帮我更好地理解需求："
                          : "A few questions before I start:"}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          dismissClarify();
                          setClarifyAnswers({});
                          // Use the original task (before inputText was cleared), skipClarify=true
                          handleSubmit(lastSubmittedTask.current || inputText, true);
                        }}
                        style={{
                          background: "none",
                          border: "none",
                          color: theme.textMuted,
                          fontSize: 10,
                          cursor: "pointer",
                          fontFamily: "inherit",
                        }}
                      >
                        {/[一-龥]/.test(clarifyingQuestions[0]?.text ?? "")
                          ? "跳过，直接运行 →"
                          : "Skip, run anyway →"}
                      </button>
                    </div>

                    {clarifyingQuestions.map((q, qi) => (
                      <div
                        // biome-ignore lint/suspicious/noArrayIndexKey: questions render once per clarification round; index IS identity
                        key={qi}
                        style={{ marginBottom: qi < clarifyingQuestions.length - 1 ? 12 : 8 }}
                      >
                        <div
                          style={{
                            fontSize: 12,
                            color: "#c9d1d9",
                            marginBottom: 6,
                            fontWeight: 500,
                          }}
                        >
                          {qi + 1}. {q.text}
                        </div>

                        {/* Option buttons */}
                        {q.options.length > 0 && (
                          <div
                            style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}
                          >
                            {q.options.map((opt, oi) => {
                              const selected = clarifyAnswers[qi] === opt;
                              return (
                                <button
                                  // biome-ignore lint/suspicious/noArrayIndexKey: option list is fixed per question — index IS identity
                                  key={oi}
                                  type="button"
                                  onClick={() =>
                                    setClarifyAnswers((prev) => ({
                                      ...prev,
                                      [qi]: selected ? "" : opt,
                                    }))
                                  }
                                  style={{
                                    padding: "5px 12px",
                                    borderRadius: 20,
                                    border: `1px solid ${selected ? "#58a6ff" : "#30363d"}`,
                                    background: selected ? "#1f6feb22" : "transparent",
                                    color: selected ? "#58a6ff" : theme.textMuted,
                                    fontSize: 11,
                                    cursor: "pointer",
                                    fontFamily: "inherit",
                                    transition: "all 0.1s",
                                  }}
                                >
                                  {opt}
                                </button>
                              );
                            })}
                            {/* "Other" option to show free text */}
                            <button
                              type="button"
                              onClick={() =>
                                setClarifyAnswers((prev) => ({
                                  ...prev,
                                  [qi]: prev[qi] && !q.options.includes(prev[qi]) ? "" : "other:",
                                }))
                              }
                              style={{
                                padding: "5px 12px",
                                borderRadius: 20,
                                border: `1px solid ${clarifyAnswers[qi] && !q.options.includes(clarifyAnswers[qi]) ? "#58a6ff" : "#30363d"}`,
                                background:
                                  clarifyAnswers[qi] && !q.options.includes(clarifyAnswers[qi])
                                    ? "#1f6feb22"
                                    : "transparent",
                                color:
                                  clarifyAnswers[qi] && !q.options.includes(clarifyAnswers[qi])
                                    ? "#58a6ff"
                                    : theme.textMuted,
                                fontSize: 11,
                                cursor: "pointer",
                                fontFamily: "inherit",
                              }}
                            >
                              {/[一-龥]/.test(clarifyingQuestions[0]?.text ?? "")
                                ? "其他…"
                                : "Other…"}
                            </button>
                          </div>
                        )}

                        {/* Free text — shown when "Other" selected or no options */}
                        {(q.options.length === 0 ||
                          (clarifyAnswers[qi] && !q.options.includes(clarifyAnswers[qi]))) && (
                          <input
                            type="text"
                            placeholder={
                              /[一-龥]/.test(clarifyingQuestions[0]?.text ?? "")
                                ? "请输入..."
                                : "Type your answer..."
                            }
                            value={clarifyAnswers[qi]?.replace(/^other:/, "") ?? ""}
                            onChange={(e) =>
                              setClarifyAnswers((prev) => ({
                                ...prev,
                                [qi]: e.target.value || "other:",
                              }))
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && allAnswered) submitWithAnswers();
                            }}
                            style={{
                              width: "100%",
                              background: "#161b22",
                              border: "1px solid #30363d",
                              borderRadius: 6,
                              color: "#c9d1d9",
                              fontSize: 12,
                              padding: "6px 10px",
                              fontFamily: "inherit",
                              outline: "none",
                            }}
                            // biome-ignore lint/a11y/noAutofocus: intentional focus for UX
                            autoFocus={qi === 0}
                          />
                        )}
                      </div>
                    ))}

                    {/* Submit button — enabled when all answered */}
                    <button
                      type="button"
                      onClick={submitWithAnswers}
                      disabled={!allAnswered}
                      style={{
                        marginTop: 4,
                        padding: "7px 16px",
                        borderRadius: 6,
                        border: "none",
                        background: allAnswered ? "#1f6feb" : "#21262d",
                        color: allAnswered ? "#fff" : theme.textMuted,
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: allAnswered ? "pointer" : "default",
                        fontFamily: "inherit",
                        transition: "background 0.15s",
                      }}
                    >
                      {/[一-龥]/.test(clarifyingQuestions[0]?.text ?? "")
                        ? "确认并运行 ▶"
                        : "Submit & Run ▶"}
                    </button>
                  </div>
                );
              })()}

            {/* Fix error banner */}
            {lastTurnError && !isRunning && (
              <div
                style={{
                  marginBottom: 10,
                  background: "#1a0a0a",
                  border: "1px solid #f8514933",
                  borderRadius: 6,
                  padding: "8px 12px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    color: "#f85149",
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  ✗ {lastTurnError.slice(0, 120)}
                  {lastTurnError.length > 120 ? "…" : ""}
                </span>
                <button
                  type="button"
                  onClick={handleFix}
                  style={{
                    flexShrink: 0,
                    padding: "4px 12px",
                    borderRadius: 4,
                    border: "none",
                    background: "#f85149",
                    color: "#fff",
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  ⚡ Fix Error
                </button>
              </div>
            )}

            <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
              <textarea
                ref={textareaRef}
                id="bscode-task-input"
                name="task"
                aria-label="Coding task"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    handleSubmit(inputText);
                  }
                }}
                placeholder="Describe a coding task…  (Cmd+Enter to send)"
                rows={2}
                style={{
                  flex: 1,
                  background: "#161b22",
                  border: "1px solid #30363d",
                  borderRadius: 8,
                  color: "#c9d1d9",
                  fontSize: 13,
                  padding: "10px 12px",
                  resize: "none" as const,
                  outline: "none",
                  lineHeight: 1.5,
                  fontFamily: "inherit",
                  transition: "border-color 0.15s",
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = "#58a6ff44";
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = "#30363d";
                }}
              />
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {isRunning || classifying ? (
                  <button
                    type="button"
                    onClick={abort}
                    style={{
                      padding: "10px 16px",
                      borderRadius: 8,
                      border: "none",
                      background: "#b91c1c",
                      color: "#fff",
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: "pointer",
                      fontFamily: "inherit",
                    }}
                  >
                    ■ Stop
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleSubmit(inputText)}
                    disabled={!inputText.trim()}
                    style={{
                      padding: "10px 16px",
                      borderRadius: 8,
                      border: "none",
                      background: inputText.trim() ? "#1f6feb" : "#21262d",
                      color: inputText.trim() ? "#fff" : theme.textMuted,
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: inputText.trim() ? "pointer" : "default",
                      fontFamily: "inherit",
                      transition: "background 0.15s",
                    }}
                  >
                    {classifying ? "⟳" : "▶ Run"}
                  </button>
                )}
              </div>
            </div>
            <div
              style={{
                marginTop: 6,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: 10, color: theme.textDim }}>
                  Cmd+Enter · @file to reference
                </span>
                {/* Enhance Prompt button (bolt.new pattern) */}
                {inputText.trim() && !isRunning && !classifying && (
                  <button
                    type="button"
                    onClick={handleEnhancePrompt}
                    disabled={enhancing}
                    title="Enhance prompt — expand into detailed spec (bolt.new ✨)"
                    style={{
                      padding: "2px 8px",
                      borderRadius: 3,
                      border: "1px solid #30363d",
                      background: "transparent",
                      color: enhancing ? theme.textMuted : "#bc8cff",
                      fontSize: 10,
                      cursor: enhancing ? "wait" : "pointer",
                      fontFamily: "inherit",
                    }}
                  >
                    {enhancing ? "⟳" : "✨ Enhance"}
                  </button>
                )}
              </div>
              <TokenMeter stats={tokenStats} compact />
            </div>
          </div>
        </div>

        {/* ── Right: preview ──
            Only render when there is something to show. The grid above
            collapses to a single column when hasPreview is false, but
            without this guard React still mounts <Terminal/> + the
            header chrome on the closed column, which both wastes work
            and leaves stale event listeners attached. */}
        {hasPreview && (
          <div style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
            {/* Preview header */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "0 12px",
                height: 36,
                background: "#161b22",
                borderBottom: "1px solid #30363d",
                flexShrink: 0,
                fontSize: 11,
                color: theme.textMuted,
              }}
            >
              <span style={{ textTransform: "uppercase", letterSpacing: 0.8 }}>
                Preview
                {!isRunning && wcStatus === "installing" && (
                  <span
                    style={{
                      marginLeft: 8,
                      color: "#e3b341",
                      animation: "pulse 1.2s ease-in-out infinite",
                    }}
                  >
                    ● installing
                  </span>
                )}
                {!isRunning && wcStatus === "starting" && (
                  <span
                    style={{
                      marginLeft: 8,
                      color: "#e3b341",
                      animation: "pulse 1.2s ease-in-out infinite",
                    }}
                  >
                    ● starting
                  </span>
                )}
                {!isRunning && wcStatus === "ready" && previewUrl && (
                  <span style={{ marginLeft: 8, color: "#3fb950" }}>● live</span>
                )}
              </span>
              <div style={{ display: "flex", gap: 4 }}>
                {(["preview", "messages", "events"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setPreviewView(v)}
                    style={{
                      padding: "3px 8px",
                      borderRadius: 3,
                      border: "none",
                      background: previewView === v ? "#1f6feb33" : "transparent",
                      color:
                        previewView === v
                          ? "#58a6ff"
                          : v === "preview" && hasPreview && previewView !== "preview"
                            ? "#e3b341"
                            : theme.textMuted,
                      fontSize: 10,
                      cursor: "pointer",
                      fontWeight: previewView === v ? 600 : 400,
                    }}
                  >
                    {v.charAt(0).toUpperCase() + v.slice(1)}
                    {v === "preview" && hasPreview && previewView !== "preview" ? " ●" : ""}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    // Reset agent state, drop all conversation turns,
                    // wipe preview pane, and reset the WebContainers
                    // mount. The previous behaviour only reset the
                    // agent + preview, leaving stale turns visible.
                    resetAll();
                    setTurns([]);
                    setPreview(undefined);
                    wcReset();
                  }}
                  style={{
                    padding: "3px 8px",
                    borderRadius: 3,
                    border: "none",
                    background: "transparent",
                    color: "#f85149",
                    fontSize: 10,
                    cursor: "pointer",
                  }}
                >
                  Clear
                </button>
              </div>
            </div>
            <div style={{ flex: 1, overflow: "hidden" }}>
              <Terminal
                messages={messages}
                rawEvents={rawEvents}
                isRunning={isRunning}
                viewMode={previewView}
                preview={selectedCard ? { ...preview, card: selectedCard } : preview}
                wcLines={wcLines}
                wcStatus={wcStatus}
                streamingArtifacts={streamingArtifacts.size > 0 ? streamingArtifacts : undefined}
              />
            </div>
          </div>
        )}
      </div>

      <style>{`
        @keyframes blink { 0%, 100% { opacity: 1 } 50% { opacity: 0 } }
        @keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.4 } }
        @keyframes slideIn { from { opacity: 0; transform: translateX(12px); } to { opacity: 1; transform: translateX(0); } }
        @keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
        textarea:focus { outline: none !important; }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }
      `}</style>
    </main>
  );
}

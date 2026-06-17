"use client";
/**
 * FirstRunGuide — D8 (2026-06-17).
 *
 * Demo visitors arriving at https://bscode.byteslim.com (or any other
 * deployment) hit a real Cloudflare Worker that **has no LLM API key
 * configured**. Hosting the demo with the maintainer's own key would let
 * any visitor empty the maintainer's billing account in one curl loop;
 * we deliberately don't do that.
 *
 * So a first-time visitor who clicks "Run" on a default model gets a
 * 401 / "no API key configured" error and walks away thinking the demo
 * is broken. This component is the soft landing — it only renders when:
 *
 *   1. The /models endpoint returns 0 user-added custom models AND
 *   2. The visitor hasn't dismissed the guide previously
 *      (localStorage `bscode:firstrun:dismissed`).
 *
 * Once the visitor adds a model — any model — the banner is satisfied
 * and stays out of the way for future sessions on that browser.
 *
 * The guide is pitched as actionable, not apologetic: "This demo runs
 * with **your** API key, here are 3 cheap providers we recommend, click
 * to open settings." The DifferentiatorBand above stays the conversion
 * signal; this is the deck guard so nobody ricochets off a 401 before
 * reaching the IsolationDemoModal or the Differentiator's other heroes.
 */
import { useEffect, useState } from "react";
import { theme } from "@/lib/theme";
import { getWorkerUrl } from "@/lib/workerUrl";

const STORAGE_KEY = "bscode:firstrun:dismissed";

interface ProviderRecommendation {
  /** Display name visitors will recognise. */
  name: string;
  /** One-line elevator pitch — why pick this provider, not promotional fluff. */
  pitch: string;
  /** OpenAI-compatible endpoint to paste into the custom-model form. */
  baseUrl: string;
  /** Where to actually buy the key. */
  signupUrl: string;
}

const RECOMMENDED: ProviderRecommendation[] = [
  {
    name: "DeepSeek",
    pitch: "Strong reasoning at a fraction of GPT-4 cost. ~¥0.001/1k tokens.",
    baseUrl: "https://api.deepseek.com/v1",
    signupUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    name: "OpenRouter",
    pitch: "One key, hundreds of models. Pay-as-you-go, free tier on small models.",
    baseUrl: "https://openrouter.ai/api/v1",
    signupUrl: "https://openrouter.ai/settings/keys",
  },
  {
    name: "Ollama (local)",
    pitch: "Already running Ollama? Point at http://localhost:11434/v1 — no key, no cost.",
    baseUrl: "http://localhost:11434/v1",
    signupUrl: "https://ollama.com/download",
  },
];

export interface FirstRunGuideProps {
  /** Optional override; defaults to dispatching a `bscode:open-model-manager` CustomEvent. */
  onOpenSettings?: () => void;
}

export function FirstRunGuide({ onOpenSettings }: FirstRunGuideProps) {
  // Three-state: loading → visible → hidden. Loading prevents the banner
  // from flashing on hydration. Hidden covers both "user has models" and
  // "user dismissed."
  const [state, setState] = useState<"loading" | "visible" | "hidden">("loading");

  useEffect(() => {
    let cancelled = false;
    async function probe() {
      try {
        const dismissed = localStorage.getItem(STORAGE_KEY) === "1";
        if (dismissed) {
          if (!cancelled) setState("hidden");
          return;
        }
        const res = await fetch(`${getWorkerUrl()}/models`);
        if (!res.ok) {
          // Worker unreachable is a different problem (we surface it
          // elsewhere). Don't show the first-run guide on top of a
          // network error — the visitor already has a real problem to
          // solve and a banner here would be noise.
          if (!cancelled) setState("hidden");
          return;
        }
        const data = (await res.json()) as { models?: Array<{ source?: string }> };
        const customCount = (data.models ?? []).filter((m) => m.source === "custom").length;
        if (!cancelled) setState(customCount === 0 ? "visible" : "hidden");
      } catch {
        // localStorage unavailable (Safari private mode), fetch threw, etc.
        // Don't pretend the banner is appropriate — fail closed.
        if (!cancelled) setState("hidden");
      }
    }
    void probe();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleDismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // ignore
    }
    setState("hidden");
  };

  if (state !== "visible") return null;

  return (
    <div
      data-testid="first-run-guide"
      style={{
        margin: "12px 16px 0",
        padding: "14px 16px",
        background: "linear-gradient(180deg, #0f1f2c 0%, #0d1117 100%)",
        border: "1px solid #21465c",
        borderLeft: "3px solid #58a6ff",
        borderRadius: 6,
        fontFamily: "JetBrains Mono, monospace",
        color: theme.textColor,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#f0f6fc" }}>
          Welcome — bring your own LLM API key (5 minutes)
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss first-run guide"
          title="Dismiss (remembered for next visit)"
          style={{
            padding: "0 8px",
            background: "transparent",
            border: "none",
            color: theme.textMuted,
            cursor: "pointer",
            fontSize: 16,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>
      <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 4, lineHeight: 1.5 }}>
        This is a public demo. To keep it free for everyone, the host doesn't ship LLM credentials —
        you bring your own key. Pick any OpenAI-compatible provider; we suggest one of these to start:
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginTop: 12 }}>
        {RECOMMENDED.map((p) => (
          <div
            key={p.name}
            style={{
              padding: "10px 12px",
              background: "#161b22",
              border: "1px solid #21262d",
              borderRadius: 4,
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 700, color: "#f0f6fc", marginBottom: 4 }}>
              {p.name}
            </div>
            <div style={{ fontSize: 10, color: theme.textMuted, lineHeight: 1.4, marginBottom: 6 }}>
              {p.pitch}
            </div>
            <div
              style={{
                fontSize: 9,
                color: "#7ee787",
                fontFamily: "JetBrains Mono, monospace",
                marginBottom: 4,
                wordBreak: "break-all",
              }}
            >
              {p.baseUrl}
            </div>
            <a
              href={p.signupUrl}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 10, color: "#58a6ff" }}
            >
              Get key →
            </a>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 14 }}>
        <button
          type="button"
          onClick={() => {
            if (onOpenSettings) {
              onOpenSettings();
              return;
            }
            // Default: ask AgentPanel (which owns ModelManager) to open
            // the form. AgentPanel listens for this event; the indirection
            // keeps FirstRunGuide loosely coupled — it can render
            // anywhere in the tree without needing a callback chain.
            if (typeof window !== "undefined") {
              window.dispatchEvent(new CustomEvent("bscode:open-model-manager"));
            }
          }}
          style={{
            padding: "6px 14px",
            background: "#1f6feb",
            border: "none",
            borderRadius: 4,
            color: "#fff",
            cursor: "pointer",
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          Open settings → Add Model
        </button>
        <span style={{ fontSize: 10, color: theme.textMuted }}>
          Your key is encrypted at rest in this deployment's KV store. No key, no copies, no
          telemetry. Pure BYO.
        </span>
      </div>
    </div>
  );
}

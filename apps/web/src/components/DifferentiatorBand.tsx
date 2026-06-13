"use client";
/**
 * DifferentiatorBand — D6 (2026-06-13) of the
 * agentkit-js + bscode optimization brief.
 *
 * Three differentiated moments rendered as a thin band below the navbar.
 * The strategic premise (S4): bscode is the *funnel*, not the product —
 * the conversion-determining 30 seconds is whether a visitor sees
 * something *only agentkit-js can give them*.
 *
 * The three moments, in order of decreasing surprise:
 *
 *   1. **MCP Portal token-counter** — federate 3 servers behind ONE
 *      `docs_search + execute_code` MCP face. Direct multi-MCP cost vs
 *      Portal cost is shown as a live ratio sourced from the
 *      portal-tokens.mjs offline accounting model.
 *
 *   2. **Kill-and-resume** — kill the worker mid-stream; watch the SSE
 *      Last-Event-ID resume gap-free. There is no other framework where
 *      this is a one-button demo.
 *
 *   3. **DevTools fork-from-step** — open the embedded devtools, jump
 *      to any step in the EventLog, fork from there. LangGraph Studio's
 *      headline feature, in a 25-test package you can `npm i`.
 *
 * The band is visually small on purpose — it deliberately does not
 * compete with the product surface below. It is a *signal*, not a
 * tutorial. Each of the three moments has a `Try it` button that
 * scrolls / opens the relevant subsection of the existing app.
 *
 * Funnel attribution: each `Try it` click fires
 * `window.dispatchEvent(new CustomEvent('bscode:funnel', { detail: { step:
 * 'differentiator-<id>-click', source: <id> } }))`. The existing UTM
 * + funnel-cost plumbing in `useFunnelTracking` (added 2026-06-12 v3)
 * picks it up.
 */
import { useEffect, useState } from "react";

type Demo = {
  id: "portal" | "resume" | "fork";
  /** ≤4 words. Reads in <1 second; this is the funnel's 30-second budget. */
  headline: string;
  /** ≤14 words. The *promise* — what the visitor will see after one click. */
  pitch: string;
  /** Numeric badge that grounds the claim in something verifiable. */
  badge: string;
};

const DEMOS: Demo[] = [
  {
    id: "portal",
    headline: "MCP Portal · 3 servers, 1 face",
    pitch: "Federate N MCP servers behind one execute_code surface — bootstrap stays O(1).",
    badge: "3.1% of direct-MCP @ 150 tools",
  },
  {
    id: "resume",
    headline: "Kill worker · resume mid-stream",
    pitch: "SSE Last-Event-ID replay restores the run gap-free across worker restarts.",
    badge: "no other framework ships this",
  },
  {
    id: "fork",
    headline: "Time-travel debugger · fork from step",
    pitch: "Open the EventLog timeline; jump to any step; branch the run from there.",
    badge: "LangGraph Studio's killer feature, OSS",
  },
];

const STORAGE_KEY = "bscode:diffband:dismissed";

export function DifferentiatorBand({
  onTry,
}: {
  onTry: (demoId: Demo["id"]) => void;
}) {
  // SSR safe: read localStorage only after mount. The band ALWAYS renders
  // on first paint (the funnel benefits from the visitor seeing it once,
  // even if they later dismiss it) and only collapses on subsequent loads.
  const [dismissed, setDismissed] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(STORAGE_KEY) === "1");
    } catch {
      // localStorage may throw in Safari private mode — treat as not dismissed.
    }
    setHydrated(true);
  }, []);

  if (hydrated && dismissed) return null;

  function handleTry(demo: Demo) {
    onTry(demo.id);
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("bscode:funnel", {
          detail: { step: `differentiator-${demo.id}-click`, source: demo.id },
        }),
      );
    }
  }

  function handleDismiss() {
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // ignore — best effort
    }
    setDismissed(true);
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("bscode:funnel", {
          detail: { step: "differentiator-dismiss" },
        }),
      );
    }
  }

  return (
    <div
      data-testid="differentiator-band"
      style={{
        display: "flex",
        alignItems: "stretch",
        gap: 0,
        padding: 0,
        background: "#0d1117",
        borderBottom: "1px solid #30363d",
        flexShrink: 0,
      }}
    >
      {DEMOS.map((demo, idx) => (
        <button
          key={demo.id}
          type="button"
          onClick={() => handleTry(demo)}
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            gap: 2,
            padding: "6px 12px",
            background: "transparent",
            border: "none",
            borderRight: idx < DEMOS.length - 1 ? "1px solid #21262d" : "none",
            cursor: "pointer",
            color: "#c9d1d9",
            fontFamily: "JetBrains Mono, monospace",
            textAlign: "left",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = "#161b22";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = "transparent";
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 8,
              width: "100%",
            }}
          >
            <span style={{ fontSize: 11, fontWeight: 600 }}>{demo.headline}</span>
            <span
              style={{
                fontSize: 9,
                color: "#3fb950",
                marginLeft: "auto",
                fontWeight: 500,
              }}
            >
              {demo.badge}
            </span>
          </div>
          <span style={{ fontSize: 10, color: "#8b949e", lineHeight: 1.3 }}>
            {demo.pitch} <span style={{ color: "#58a6ff" }}>→ Try it</span>
          </span>
        </button>
      ))}
      <button
        type="button"
        onClick={handleDismiss}
        title="Dismiss band (remembered for next visit)"
        style={{
          padding: "0 8px",
          background: "transparent",
          border: "none",
          borderLeft: "1px solid #21262d",
          color: "#8b949e",
          cursor: "pointer",
          fontSize: 10,
        }}
      >
        ×
      </button>
    </div>
  );
}

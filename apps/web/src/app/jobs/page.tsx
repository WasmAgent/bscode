"use client";

/**
 * B1 — /jobs page.
 *
 * Standalone multi-run dashboard. Reaches the same worker as the main
 * conversation page but does NOT share React state — each Tab is its own
 * surface. The conversational page stays untouched (low-risk integration).
 *
 * Pulls X-Session-Id from localStorage so per-session filters work; falls
 * back to "default" so the page is usable in a fresh browser without
 * setup.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { JobsPanel } from "@/components/JobsPanel";
import { theme } from "@/lib/theme";

export default function JobsPage() {
  const [sessionId, setSessionId] = useState<string>("default");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem("bscode.sessionId");
    if (stored) setSessionId(stored);
  }, []);

  return (
    <main style={{ padding: 16, maxWidth: 1100, margin: "0 auto" }}>
      <header style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <h1 style={{ fontSize: 18, margin: 0, color: theme.textPrimary }}>BSCode Jobs</h1>
          <Link href="/" style={{ fontSize: 12, color: theme.textMuted }}>
            ← Back to chat
          </Link>
        </div>
        <p style={{ color: theme.textMuted, fontSize: 12, margin: "4px 0 0 0" }}>
          Submit batches of independent tasks; the worker runs them in parallel. Session:{" "}
          <code>{sessionId}</code>
        </p>
      </header>
      <JobsPanel sessionId={sessionId} />
    </main>
  );
}

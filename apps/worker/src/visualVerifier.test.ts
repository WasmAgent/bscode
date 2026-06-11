/**
 * C3 — visualVerifier tests.
 *
 * Verifies that `runVisualVerification` and `runVisualInteraction`:
 *  - degrade cleanly when no CDP endpoint is configured
 *  - capture rendersNonEmpty / consoleErrors / domProbes / screenshot
 *  - run all probes even when one of them throws
 *  - call the vision judge only when intent + screenshot are both present
 *  - never throw on a dead session — they always return a snapshot
 *  - drive click/fill ops in order and report per-op success
 *
 * The browser session is stubbed; real CDP is exercised via integration
 * tests behind a BSCODE_CDP_WS env var (out of scope for unit tests).
 */

import type { BrowserSession } from "@agentkit-js/tools-browser";
import { describe, expect, it, vi } from "vitest";
import { runVisualInteraction, runVisualVerification } from "./visualVerifier.js";

function stubSession(overrides: Partial<BrowserSession> = {}): BrowserSession {
  return {
    navigate: vi.fn(async () => ({
      title: "OK",
      dom:
        "<!doctype html><html><head><title>OK</title></head>" +
        '<body><div id="app"><h1>Hello</h1><p>welcome to the app</p></div></body></html>',
    })),
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    screenshot: vi.fn(async () => "data:image/png;base64,AAAA"),
    extract: vi.fn(async (selectors: Record<string, string>) => {
      const out: Record<string, string> = {};
      for (const [k] of Object.entries(selectors)) out[k] = "found";
      return out;
    }),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("runVisualVerification", () => {
  it("returns a degraded snapshot when neither cdpWsEndpoint nor sessionFactory is provided", async () => {
    const snap = await runVisualVerification({ previewUrl: "http://x" });
    expect(snap.source).toBe("cdp");
    expect(snap.consoleErrors?.[0]?.message).toMatch(/BSCODE_CDP_WS not configured/);
  });

  it("captures pageTitle and rendersNonEmpty=true on a healthy page", async () => {
    const session = stubSession();
    const snap = await runVisualVerification({
      previewUrl: "http://app",
      sessionFactory: async () => session,
    });
    expect(snap.pageTitle).toBe("OK");
    expect(snap.rendersNonEmpty).toBe(true);
    expect(snap.thumbnailDataUrl).toBe("data:image/png;base64,AAAA");
    expect(session.close).toHaveBeenCalledOnce();
  });

  it("flags rendersNonEmpty=false on a blank-body page", async () => {
    const session = stubSession({
      navigate: vi.fn(async () => ({ title: "Blank", dom: "<html><body></body></html>" })),
    });
    const snap = await runVisualVerification({
      previewUrl: "http://app",
      sessionFactory: async () => session,
    });
    expect(snap.rendersNonEmpty).toBe(false);
  });

  it("runs all probes — one bad probe does not abort the others", async () => {
    let calls = 0;
    const session = stubSession({
      extract: vi.fn(async (selectors: Record<string, string>) => {
        calls++;
        if (calls === 2) throw new Error("selector blew up");
        const out: Record<string, string> = {};
        for (const [k] of Object.entries(selectors)) out[k] = "found";
        return out;
      }),
    });
    const snap = await runVisualVerification({
      previewUrl: "http://app",
      sessionFactory: async () => session,
      probes: [
        { name: "p1", selector: "h1" },
        { name: "p2", selector: ".broken" },
        { name: "p3", textContains: "found" },
      ],
    });
    expect(snap.domProbes).toHaveLength(3);
    expect(snap.domProbes?.[0]?.ok).toBe(true);
    expect(snap.domProbes?.[1]?.ok).toBe(false);
    expect(snap.domProbes?.[1]?.detail).toMatch(/selector blew up/);
    expect(snap.domProbes?.[2]?.ok).toBe(true);
  });

  it("invokes the vision judge only when both intent and screenshot are present", async () => {
    const judge = vi.fn(async () => ({
      matchesIntent: false,
      reason: "page is wrong",
    }));
    const snap = await runVisualVerification({
      previewUrl: "http://app",
      sessionFactory: async () => stubSession(),
      intent: "show login form",
      judge,
    });
    expect(judge).toHaveBeenCalledOnce();
    expect(snap.verdict).toEqual({
      matchesIntent: false,
      reason: "page is wrong",
      intent: "show login form",
    });
  });

  it("skips the judge when intent is omitted", async () => {
    const judge = vi.fn();
    const snap = await runVisualVerification({
      previewUrl: "http://app",
      sessionFactory: async () => stubSession(),
      judge,
    });
    expect(judge).not.toHaveBeenCalled();
    expect(snap.verdict).toBeUndefined();
  });

  it("never throws even when navigation crashes — returns a snapshot with the error", async () => {
    const session = stubSession({
      navigate: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    });
    const snap = await runVisualVerification({
      previewUrl: "http://dead",
      sessionFactory: async () => session,
    });
    expect(snap.consoleErrors?.[0]?.message).toMatch(/navigation failed.*ECONNREFUSED/);
    // close is still called even when navigate failed
    expect(session.close).toHaveBeenCalledOnce();
  });
});

describe("runVisualInteraction", () => {
  it("performs click+fill in order and reports per-op success", async () => {
    const events: string[] = [];
    const session = stubSession({
      click: vi.fn(async (sel: string) => {
        events.push(`click:${sel}`);
      }),
      fill: vi.fn(async (sel: string, val: string) => {
        events.push(`fill:${sel}=${val}`);
      }),
    });
    const snap = await runVisualInteraction({
      previewUrl: "http://app",
      sessionFactory: async () => session,
      ops: [
        { kind: "click", selector: "#open" },
        { kind: "fill", selector: "#name", value: "Ada" },
      ],
    });
    expect(events).toEqual(["click:#open", "fill:#name=Ada"]);
    expect(snap.domProbes).toHaveLength(2);
    expect(snap.domProbes?.every((p) => p.ok)).toBe(true);
  });

  it("flags a fill op missing a value as a failed probe (does not crash)", async () => {
    const session = stubSession();
    const snap = await runVisualInteraction({
      previewUrl: "http://app",
      sessionFactory: async () => session,
      ops: [{ kind: "fill", selector: "#x" }],
    });
    expect(snap.domProbes?.[0]?.ok).toBe(false);
    expect(snap.domProbes?.[0]?.detail).toMatch(/missing value/);
  });
});

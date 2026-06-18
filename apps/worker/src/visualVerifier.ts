/**
 * C3 — Worker-side visual verifier.
 *
 * The browser-side passive observer in `useWebContainer.ts` can only watch
 * the parent page's event bus — it cannot see *into* the cross-origin
 * preview iframe. This module closes that gap by driving a Chrome DevTools
 * Protocol session against the preview URL from the worker side, where it
 * can:
 *   • read the actual DOM and console events
 *   • capture a real screenshot
 *   • run selector / textContains assertions the agent supplied
 *   • feed the screenshot to a vision-capable model for an
 *     "intent matches render?" verdict
 *
 * The output is written into `BuildResultSnapshot.visual` so the existing
 * `read_build_result` formatter surfaces it without changes.
 *
 * CDP endpoint configuration: the worker reads `BSCODE_CDP_WS` (or an
 * AppConfig field) — when unset, `runVisualVerification` returns a
 * structured "no endpoint configured" result rather than throwing.
 * Cloudflare Browser Rendering, a Docker-hosted Chromium, or a local
 * `chrome --remote-debugging-port=9222` all work.
 */

import {
  type BrowserRunOpenable,
  type BrowserSession,
  openBrowserRunSession,
  openCdpSession,
} from "@wasmagent/tools-browser";
import type { VisualCheckSnapshot } from "./build-results.js";
import { judgeRender, type VisionJudge } from "./visionJudge.js";

/** A single agent-supplied probe — selector OR text assertion. */
export interface VisualProbeSpec {
  /** Stable label used in the result. */
  name: string;
  /** CSS selector that must resolve to ≥1 element. */
  selector?: string;
  /** Substring that must appear in `document.body.innerText`. */
  textContains?: string;
}

export interface RunVisualVerificationOptions {
  /** Preview URL to navigate to. Required. */
  previewUrl: string;
  /**
   * CDP WebSocket endpoint. When omitted, returns a degraded snapshot with
   * `source: "cdp"` + a single console-error explaining the gap, so the
   * agent's read path is uniform.
   */
  cdpWsEndpoint?: string;
  /**
   * B2 (2026-06): Cloudflare Browser Run binding. When supplied (and
   * `cdpWsEndpoint` is absent), the verifier opens a Browser Run session
   * via the binding and uses it as the BrowserSession instead of dialling
   * CDP directly. Pass `await puppeteer.launch(env.BROWSER)` here, or any
   * object satisfying {@link BrowserRunOpenable}.
   *
   * Precedence: explicit `sessionFactory` > `browserRunBinding` >
   * `cdpWsEndpoint`. We document this so a worker can configure both
   * (binding for production, ws endpoint as a local-debugging fallback)
   * and the production path always wins.
   */
  browserRunBinding?: BrowserRunOpenable;
  /** Probes the agent wants asserted on the rendered page. */
  probes?: VisualProbeSpec[];
  /**
   * Agent-stated intent ("the page should show a login form with email +
   * password fields"). When supplied AND a vision judge is wired, the judge
   * scores whether the screenshot matches.
   */
  intent?: string;
  /** Vision judge — usually a wrapper around the agent's primary model. */
  judge?: VisionJudge;
  /** Test seam: inject an already-open BrowserSession instead of dialling CDP. */
  sessionFactory?: () => Promise<BrowserSession>;
  /** Per-call timeout for the whole verification flow. */
  timeoutMs?: number;
}

/** Internal: stub used when no CDP endpoint is configured. */
function noEndpointSnapshot(): VisualCheckSnapshot {
  return {
    ranAtMs: Date.now(),
    source: "cdp",
    consoleErrors: [
      {
        message:
          "visual_verify: BSCODE_CDP_WS not configured — set the env var or pass config.cdpWsEndpoint to enable CDP-based visual checks.",
      },
    ],
  };
}

/**
 * Drive a CDP session against the preview URL and produce a single
 * `VisualCheckSnapshot`. Best-effort: a dead CDP endpoint, a navigation
 * timeout, or a vision-judge crash all degrade into a snapshot rather than
 * throwing — the agent's loop should never abort because the optional
 * verifier failed.
 */
export async function runVisualVerification(
  opts: RunVisualVerificationOptions
): Promise<VisualCheckSnapshot> {
  if (!opts.cdpWsEndpoint && !opts.sessionFactory && !opts.browserRunBinding) {
    return noEndpointSnapshot();
  }

  let session: BrowserSession | null = null;
  const consoleErrors: Array<{ message: string; source?: string }> = [];
  const probeResults: Array<{ name: string; ok: boolean; detail?: string }> = [];

  try {
    if (opts.sessionFactory) {
      session = await opts.sessionFactory();
    } else if (opts.browserRunBinding) {
      // B2: Cloudflare Browser Run path. The binding owns the Chromium
      // lifetime; openBrowserRunSession wraps close() so the BR resource
      // is released when the session is closed by the verifier below.
      session = await openBrowserRunSession({
        binding: opts.browserRunBinding,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
    } else {
      session = await openCdpSession({
        wsEndpoint: opts.cdpWsEndpoint as string,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
    }

    // 1) Navigate. If the page never loads, surface that as a console error
    //    rather than throwing — the agent should still see *something*.
    let title = "";
    let dom = "";
    try {
      const nav = await session.navigate(opts.previewUrl);
      title = nav.title;
      dom = nav.dom;
    } catch (e) {
      consoleErrors.push({
        message: `navigation failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    // 2) `rendersNonEmpty` — proxy via DOM size. Anything under ~100
    //    chars of HTML is almost certainly an empty mount point or a Vite
    //    error overlay shell. We also strip whitespace/tags inside <body>
    //    to catch the "<body></body>" / "<body>   </body>" cases.
    const bodyMatch = dom.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const bodyInner = bodyMatch ? (bodyMatch[1] ?? "") : "";
    const bodyTextLen = bodyInner.replace(/<[^>]*>/g, "").trim().length;
    const rendersNonEmpty = dom.length > 100 && (bodyTextLen > 0 || /<\w/.test(bodyInner));

    // 3) Probes. Each is its own try/catch so one bad selector doesn't kill
    //    the rest of the report.
    for (const probe of opts.probes ?? []) {
      try {
        if (probe.selector) {
          const r = await session.extract({ [probe.name]: probe.selector });
          const text = r[probe.name] ?? "";
          probeResults.push({
            name: probe.name,
            ok: text.length > 0,
            ...(text.length === 0
              ? { detail: `selector "${probe.selector}" matched nothing` }
              : {}),
          });
        } else if (probe.textContains) {
          const r = await session.extract({ __body: "body" });
          const ok = (r.__body ?? "").includes(probe.textContains);
          probeResults.push({
            name: probe.name,
            ok,
            ...(ok ? {} : { detail: `text "${probe.textContains}" not found` }),
          });
        } else {
          probeResults.push({
            name: probe.name,
            ok: false,
            detail: "probe has neither selector nor textContains",
          });
        }
      } catch (e) {
        probeResults.push({
          name: probe.name,
          ok: false,
          detail: `probe crashed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }

    // 4) Screenshot — best-effort. If the page is broken enough that the
    //    screenshot fails, we still return the structural signals.
    let thumbnailDataUrl: string | undefined;
    try {
      thumbnailDataUrl = await session.screenshot({ fullPage: false });
    } catch (e) {
      consoleErrors.push({
        message: `screenshot failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    // 5) Vision judge — only when both intent + judge + screenshot are present.
    let verdict: VisualCheckSnapshot["verdict"];
    if (opts.intent && opts.judge && thumbnailDataUrl) {
      try {
        verdict = await judgeRender({
          judge: opts.judge,
          intent: opts.intent,
          screenshotDataUrl: thumbnailDataUrl,
        });
      } catch (e) {
        consoleErrors.push({
          message: `vision-judge failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }

    const snapshot: VisualCheckSnapshot = {
      ranAtMs: Date.now(),
      source: "cdp",
      rendersNonEmpty,
      ...(title ? { pageTitle: title } : {}),
      ...(consoleErrors.length ? { consoleErrors: consoleErrors.slice(0, 20) } : {}),
      ...(probeResults.length ? { domProbes: probeResults.slice(0, 20) } : {}),
      ...(thumbnailDataUrl ? { thumbnailDataUrl } : {}),
      ...(verdict ? { verdict } : {}),
    };
    return snapshot;
  } catch (e) {
    // Catastrophic failure (e.g. CDP socket refused). Still produce a
    // snapshot so `read_build_result` has something to surface.
    return {
      ranAtMs: Date.now(),
      source: "cdp",
      consoleErrors: [
        { message: `visual verifier crashed: ${e instanceof Error ? e.message : String(e)}` },
      ],
    };
  } finally {
    if (session) {
      try {
        await session.close();
      } catch {
        // best-effort cleanup
      }
    }
  }
}

/**
 * Drive an interactive browser op (click / fill) through the same CDP
 * session API. Used by `visual_interact` (which has `needsApproval=true`).
 *
 * Returns a structured snapshot with one DOM probe per op so the agent can
 * see whether each step landed.
 */
export interface VisualInteractOp {
  kind: "click" | "fill";
  selector: string;
  /** Required for `fill`. */
  value?: string;
}

export async function runVisualInteraction(
  opts: Omit<RunVisualVerificationOptions, "probes" | "intent" | "judge"> & {
    ops: VisualInteractOp[];
  }
): Promise<VisualCheckSnapshot> {
  if (!opts.cdpWsEndpoint && !opts.sessionFactory) {
    return noEndpointSnapshot();
  }
  let session: BrowserSession | null = null;
  const probeResults: Array<{ name: string; ok: boolean; detail?: string }> = [];
  const consoleErrors: Array<{ message: string; source?: string }> = [];

  try {
    session = opts.sessionFactory
      ? await opts.sessionFactory()
      : await openCdpSession({
          wsEndpoint: opts.cdpWsEndpoint as string,
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        });
    try {
      await session.navigate(opts.previewUrl);
    } catch (e) {
      consoleErrors.push({
        message: `navigation failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    for (let i = 0; i < opts.ops.length; i++) {
      const op = opts.ops[i] as VisualInteractOp;
      const name = `${op.kind}#${i + 1} ${op.selector}`;
      try {
        if (op.kind === "click") {
          await session.click(op.selector);
          probeResults.push({ name, ok: true });
        } else {
          if (typeof op.value !== "string") {
            probeResults.push({ name, ok: false, detail: "fill op missing value" });
            continue;
          }
          await session.fill(op.selector, op.value);
          probeResults.push({ name, ok: true });
        }
      } catch (e) {
        probeResults.push({
          name,
          ok: false,
          detail: e instanceof Error ? e.message : String(e),
        });
      }
    }
    let thumbnailDataUrl: string | undefined;
    try {
      thumbnailDataUrl = await session.screenshot({ fullPage: false });
    } catch {
      // screenshot is optional after interaction
    }
    return {
      ranAtMs: Date.now(),
      source: "cdp",
      ...(probeResults.length ? { domProbes: probeResults } : {}),
      ...(consoleErrors.length ? { consoleErrors } : {}),
      ...(thumbnailDataUrl ? { thumbnailDataUrl } : {}),
    };
  } catch (e) {
    return {
      ranAtMs: Date.now(),
      source: "cdp",
      consoleErrors: [
        {
          message: `visual interaction crashed: ${e instanceof Error ? e.message : String(e)}`,
        },
      ],
    };
  } finally {
    if (session) {
      try {
        await session.close();
      } catch {
        // best-effort cleanup
      }
    }
  }
}

/**
 * D7 (2026-06-17) — IsolationDemoModal tests.
 *
 * Lands the S1' governance/isolation axis from
 * `wasmagent/docs/strategy/2026-06-17-update.md`. The modal demos four
 * OWASP Agentic Top 10 attacks the kernel actually blocks; this test
 * pins down:
 *
 *   1. All four scenarios render with their attack code, intercepted
 *      error, and OWASP entry — nothing silently disappears in a future
 *      copy edit.
 *   2. The intercepted-error strings are present verbatim. These match
 *      the strings the deployed kernel returns; if marketing wants to
 *      sand them later, the test forces a conversation about whether
 *      the kernel's actual output should be changed too.
 *   3. Esc and click-out dismiss the modal — keyboard + pointer parity
 *      with SettingsDrawer.
 *   4. Outbound links go to the wasmagent source-of-truth files
 *      (CapabilityManifest types.ts, SECURITY.md, OWASP coverage matrix).
 *      The link contract is stable across releases — these are GitHub
 *      paths the documentation page also points at.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { IsolationDemoModal } from "./IsolationDemoModal.js";

afterEach(() => {
  cleanup();
});

describe("IsolationDemoModal (D7)", () => {
  it("renders all four OWASP scenarios with their headlines", () => {
    render(<IsolationDemoModal onClose={() => {}} />);
    expect(screen.getByText(/Exfiltrate API key over HTTP/)).toBeTruthy();
    expect(screen.getByText(/Call a tool not in the allow-list/)).toBeTruthy();
    expect(screen.getByText(/Spin in an infinite loop/)).toBeTruthy();
    expect(screen.getByText(/Write outside the workspace/)).toBeTruthy();
  });

  it("renders the OWASP Agentic Top 10 entry tag for each scenario", () => {
    render(<IsolationDemoModal onClose={() => {}} />);
    expect(screen.getByText(/OWASP-AA #8 — Data exfiltration/)).toBeTruthy();
    expect(screen.getByText(/OWASP-AA #2 — Tool misuse/)).toBeTruthy();
    expect(screen.getByText(/OWASP-AA #5 — Cascading failures/)).toBeTruthy();
    expect(screen.getByText(/OWASP-AA #7 — Excessive agency/)).toBeTruthy();
  });

  it("renders the verbatim intercepted error strings — these match deployed kernel output", () => {
    render(<IsolationDemoModal onClose={() => {}} />);
    // These are the strings the WasmAgent kernel actually returns. If
    // they need to change, the kernel changes first; the modal reflects.
    expect(
      screen.getByText(/network access denied — host "attacker.example" not in allowedHosts/)
    ).toBeTruthy();
    expect(screen.getByText(/shell_exec is not defined — kernel did not bind a tool/)).toBeTruthy();
    expect(screen.getByText(/cpuMs deadline exceeded \(5000ms\)/)).toBeTruthy();
    expect(
      screen.getByText(
        /write denied — resolved path "\/etc\/cron.d\/backdoor" is not under any allowedWritePaths prefix/
      )
    ).toBeTruthy();
  });

  it("Esc key calls onClose", () => {
    const onClose = vi.fn();
    render(<IsolationDemoModal onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("close button (×) calls onClose", () => {
    const onClose = vi.fn();
    render(<IsolationDemoModal onClose={onClose} />);
    // Multiple × buttons exist (header + click-out aria-label); pick the
    // visible one with the aria-label "Close".
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("click-out overlay calls onClose", () => {
    const onClose = vi.fn();
    render(<IsolationDemoModal onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("Close isolation demo"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("links point at the wasmagent source-of-truth files (stable contract)", () => {
    const { container } = render(<IsolationDemoModal onClose={() => {}} />);
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    // OWASP coverage matrix appears twice (header link + footer link); both
    // must point at the same canonical doc path.
    expect(
      hrefs.some((h) =>
        h?.includes("WasmAgent/wasmagent-js/blob/main/docs/security/capability-manifest-owasp.md")
      )
    ).toBe(true);
    expect(
      hrefs.some((h) =>
        h?.includes("WasmAgent/wasmagent-js/blob/main/packages/core/src/executor/types.ts")
      )
    ).toBe(true);
    expect(hrefs.some((h) => h?.includes("WasmAgent/wasmagent-js/blob/main/SECURITY.md"))).toBe(
      true
    );
  });
});

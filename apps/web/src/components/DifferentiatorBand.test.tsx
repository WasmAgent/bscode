/**
 * DifferentiatorBand tests.
 *
 * Pin down:
 *   1. The band renders all four demos on first paint with the expected
 *      headlines and badges (the funnel signals must be visible BEFORE
 *      the visitor scrolls). Demos map to WasmAgent's three product lines:
 *      security (isolation), quality (rollout), data (export), tooling (fork).
 *   2. Clicking a demo fires (a) the onTry callback with the demo id and
 *      (b) a `bscode:funnel` CustomEvent with `step: differentiator-<id>-click`.
 *   3. Dismissal sets `bscode:diffband:dismissed=1` in localStorage and
 *      hides the band on subsequent renders.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { DifferentiatorBand } from "./DifferentiatorBand.js";

describe("DifferentiatorBand (D6)", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
    cleanup();
  });

  it("renders the four differentiated demos with badges on first paint", () => {
    render(<DifferentiatorBand onTry={() => {}} />);
    expect(screen.getByText(/Sandbox blocks an OWASP attack/)).toBeTruthy();
    expect(screen.getByText(/Build-verified coding rollout/)).toBeTruthy();
    expect(screen.getByText(/Export training data/)).toBeTruthy();
    expect(screen.getByText(/Time-travel debugger/)).toBeTruthy();
    // Verifiable badges.
    expect(screen.getByText(/OWASP Agentic Top 10 — 7 of 10 enforced/)).toBeTruthy();
    expect(screen.getByText(/pass\/fail objective_score/)).toBeTruthy();
    expect(screen.getByText(/rollout-wire\/v1/)).toBeTruthy();
    expect(screen.getByText(/LangGraph Studio/)).toBeTruthy();
  });

  it("calls onTry(<id>) AND fires bscode:funnel CustomEvent on click", () => {
    const onTry = vi.fn();
    const events: string[] = [];
    function listener(e: Event) {
      const ce = e as CustomEvent<{ step: string }>;
      events.push(ce.detail.step);
    }
    window.addEventListener("bscode:funnel", listener);
    try {
      render(<DifferentiatorBand onTry={onTry} />);
      fireEvent.click(screen.getByText(/Build-verified coding rollout/));
      expect(onTry).toHaveBeenCalledWith("rollout");
      expect(events).toContain("differentiator-rollout-click");
    } finally {
      window.removeEventListener("bscode:funnel", listener);
    }
  });

  it("isolation demo click fires onTry('isolation') and the matching funnel event", () => {
    const onTry = vi.fn();
    const events: string[] = [];
    function listener(e: Event) {
      const ce = e as CustomEvent<{ step: string }>;
      events.push(ce.detail.step);
    }
    window.addEventListener("bscode:funnel", listener);
    try {
      render(<DifferentiatorBand onTry={onTry} />);
      fireEvent.click(screen.getByText(/Sandbox blocks an OWASP attack/));
      expect(onTry).toHaveBeenCalledWith("isolation");
      expect(events).toContain("differentiator-isolation-click");
    } finally {
      window.removeEventListener("bscode:funnel", listener);
    }
  });

  it("dismiss button persists to localStorage and hides the band on next render", () => {
    const { unmount } = render(<DifferentiatorBand onTry={() => {}} />);
    fireEvent.click(screen.getByTitle(/Dismiss band/));
    expect(localStorage.getItem("bscode:diffband:dismissed")).toBe("1");
    unmount();

    // Subsequent mount: hydration effect runs, dismissed flag honoured.
    const { container } = render(<DifferentiatorBand onTry={() => {}} />);
    expect(container.querySelector("[data-testid='differentiator-band']")).toBeNull();
  });
});

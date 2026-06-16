/**
 * D6 (2026-06-13) — DifferentiatorBand tests.
 *
 * Pin down:
 *   1. The band renders all three demos on first paint with the expected
 *      headlines and badges (the funnel signals must be visible BEFORE
 *      the visitor scrolls).
 *   2. Clicking a demo fires (a) the onTry callback with the demo id and
 *      (b) a `bscode:funnel` CustomEvent with `step: differentiator-<id>-click`.
 *      The funnel-cost reduction work (2026-06-12 v3) listens to that event;
 *      breaking the contract silently regresses the funnel.
 *   3. Dismissal sets `bscode:diffband:dismissed=1` in localStorage and
 *      hides the band on subsequent renders. The first render after
 *      dismissal is still allowed (the band has already done its job by
 *      then).
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DifferentiatorBand } from "./DifferentiatorBand.js";

describe("DifferentiatorBand (D6)", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("renders the three differentiated demos with badges on first paint", () => {
    render(<DifferentiatorBand onTry={() => {}} />);
    expect(screen.getByText(/MCP Portal/)).toBeTruthy();
    expect(screen.getByText(/Kill worker/)).toBeTruthy();
    expect(screen.getByText(/Time-travel debugger/)).toBeTruthy();
    // Numeric / verifiable badges, not vague marketing. Reflects the
    // 2026-06-13 update (commit 908e7ee) that swapped the floating "3.1%"
    // for a stable "≤14% @ N=30" envelope.
    expect(screen.getByText(/≤14% of direct-MCP/)).toBeTruthy();
    expect(screen.getByText(/no other framework ships this/)).toBeTruthy();
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
      // Clicking the Portal headline triggers the Portal demo.
      fireEvent.click(screen.getByText(/MCP Portal/));
      expect(onTry).toHaveBeenCalledWith("portal");
      expect(events).toContain("differentiator-portal-click");
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
    // The band no longer renders any of the demo headlines.
    expect(container.querySelector("[data-testid='differentiator-band']")).toBeNull();
  });
});

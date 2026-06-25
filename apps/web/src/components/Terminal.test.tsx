/**
 * 2026-06-18 — Terminal preview pane: multi-card render + WebContainers
 * label gating.
 *
 * Pins the user-reported regression where a goalDirected run produced
 * `[write_file] OK: written N chars to <file>` in the right pane but
 * never showed the file content. Fix surfaces produced files as cards;
 * these tests assert the render branch.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import type { CardBlock } from "@wasmagent/ui-cards";

// CardRenderer pulls D2 + react-markdown which are heavy and tend to
// surface "older React" runtime conflicts in vitest. The render branches
// we care about (tab strip, "Output" vs "WebContainers" header) don't
// depend on the card body itself, so stub it to a passthrough <pre>.
vi.mock("@wasmagent/ui-cards-react", () => ({
  CardRenderer: ({ card }: { card: CardBlock }) => (
    <pre data-testid="card-body">{card.content}</pre>
  ),
  ChatMessage: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

beforeAll(() => {
  // jsdom doesn't implement scrollIntoView; Terminal calls it on mount.
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
});

const { Terminal } = await import("./Terminal");
type PreviewContent = import("./Terminal").PreviewContent;

const cards = (n: number): CardBlock[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    type: "markdown",
    content: `# File ${i}\n\nContent of file ${i}.`,
    meta: `file-${i}.md`,
  }));

function renderTerminal(preview: PreviewContent | undefined, extras: Record<string, unknown> = {}) {
  return render(
    <Terminal
      messages={[]}
      rawEvents={[]}
      isRunning={false}
      viewMode="preview"
      preview={preview}
      {...extras}
    />
  );
}

describe("Terminal preview — multi-card branch", () => {
  it("renders the active card content when preview.cards has 2+ entries", () => {
    renderTerminal({ cards: cards(2) });
    expect(screen.getByText(/Artefacts \(2\)/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "file-0.md" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "file-1.md" })).toBeTruthy();
    // Active card body present (the first one by default)
    expect(screen.getByTestId("card-body").textContent).toContain("Content of file 0");
  });

  it("falls through to single-card branch when cards has exactly 1 entry", () => {
    renderTerminal({ cards: cards(1), card: cards(1)[0] });
    expect(screen.getByText(/Card Preview/i)).toBeTruthy();
    expect(screen.queryByText(/Artefacts \(/)).not.toBeTruthy();
  });
});

describe('Terminal preview — "building…" label gating', () => {
  it("shows WebContainers + building when wcLines present (real WC run)", () => {
    renderTerminal({ logs: ["[npm] installing"] }, { wcLines: ["[wc] starting"] });
    expect(screen.getByText("WebContainers")).toBeTruthy();
    expect(screen.getByText(/building…/)).toBeTruthy();
  });

  it("shows generic Output (no building) for tool/goalDirected logs alone", () => {
    // 2026-06-18 regression: goalDirected emitted only `preview.logs`
    // (tool ack lines), no wcLines — but the pane still rendered
    // "WebContainers · building…". Now the label degrades to "Output".
    renderTerminal({ logs: ["[write_file] OK: written 2074 chars to doc.md"] });
    expect(screen.getByText("Output")).toBeTruthy();
    expect(screen.queryByText(/building…/)).not.toBeTruthy();
  });
});

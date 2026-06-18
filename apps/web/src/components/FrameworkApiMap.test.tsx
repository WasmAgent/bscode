/**
 * Tests for FrameworkApiMap.
 *
 * The component is the inbound funnel for "I see a feature in bscode → I
 * want the wasmagent API for it". Every entry in ENTRIES is a contract
 * pinned by these tests:
 *   - feature label visible
 *   - docs link present + has the source-attribution data-* attrs
 *   - copy snippet writes the right text to clipboard
 *   - mark/unmark toggles + counter updates
 *   - export disabled until at least one mark; once exported, an anchor
 *     download is triggered with the .zip
 *
 * We do not try to dynamic-import jszip in the test — instead we stub
 * URL.createObjectURL + a.click so the export path runs without producing
 * an actual download. JSZip is real (the production bundle has it).
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FrameworkApiMap } from "./FrameworkApiMap";

let writtenClipboard: string[] = [];
let createdObjectUrls: string[] = [];
let triggeredDownloadName: string | null = null;
let originalCreateObjectURL: typeof URL.createObjectURL;
let originalRevokeObjectURL: typeof URL.revokeObjectURL;

beforeEach(() => {
  writtenClipboard = [];
  createdObjectUrls = [];
  triggeredDownloadName = null;

  // jsdom doesn't ship clipboard by default — install a writable stub.
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn(async (text: string) => {
        writtenClipboard.push(text);
      }),
    },
  });

  // URL.createObjectURL/revoke aren't implemented in jsdom either.
  originalCreateObjectURL = URL.createObjectURL;
  originalRevokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = vi.fn(() => {
    const u = `blob:mock-${createdObjectUrls.length}`;
    createdObjectUrls.push(u);
    return u;
  }) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;

  // Capture the synthetic download click so we don't actually navigate.
  const origCreate = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    const el = origCreate(tag);
    if (tag === "a") {
      const anchor = el as HTMLAnchorElement;
      // biome-ignore lint/suspicious/noExplicitAny: capture instead of navigate
      (anchor as any).click = () => {
        triggeredDownloadName = anchor.download || null;
      };
    }
    return el;
  }) as typeof document.createElement);
});

afterEach(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  vi.restoreAllMocks();
});

describe("FrameworkApiMap — visibility", () => {
  it("returns null when open=false (renders nothing)", () => {
    const { container } = render(<FrameworkApiMap open={false} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a dialog with the expected aria-label when open=true", () => {
    render(<FrameworkApiMap open={true} onClose={() => {}} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Framework API map");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });
});

describe("FrameworkApiMap — entries content", () => {
  it("renders all 13 mapping entries (one per feature)", () => {
    render(<FrameworkApiMap open={true} onClose={() => {}} />);
    // Sample a representative spread of features — each should be present.
    for (const feature of [
      "Code + WASM mode",
      "Tool + DAG mode",
      "Visual diff cards (file-tree edits)",
      "Token cost meter",
      "HITL approval gate",
      "Code-mode MCP server",
      "Local Studio (cost / latency / errors)",
      "Multi-model evaluation (Pareto)",
      "5-min Claude Desktop / Cursor path (B-D2)",
      "Vercel AI SDK — sandboxed tool",
      "Mastra sandbox provider",
      "Claude Agent SDK — sandboxed tool",
      "OpenAI Agents JS — sandboxed tool",
    ]) {
      expect(screen.getByText(feature)).toBeTruthy();
    }
  });

  it("docs link for each entry points to a github.com/telleroutlook URL with attribution data-attrs", () => {
    render(<FrameworkApiMap open={true} onClose={() => {}} />);
    const docLinks = screen
      .getAllByText(/^docs$/)
      .map((el) => el.closest("a") as HTMLAnchorElement);
    expect(docLinks.length).toBeGreaterThanOrEqual(13);
    for (const a of docLinks) {
      // Every link MUST be HTTPS to a github.com path — drift here ships a
      // broken / phishing-prone link to users.
      expect(a.href).toMatch(/^https:\/\/github\.com\//);
      // B-D1 source attribution — the funnel needs to know which feature
      // sent the click. Both data-source AND data-feature are required.
      expect(a.getAttribute("data-source")).toBe("bscode-feature-map");
      expect(a.getAttribute("data-feature")).toBeTruthy();
      // External links open in a new tab with rel=noreferrer (standard).
      expect(a.target).toBe("_blank");
      expect(a.rel).toContain("noreferrer");
    }
  });

  it("each entry has its own copy-snippet button", () => {
    render(<FrameworkApiMap open={true} onClose={() => {}} />);
    expect(screen.getAllByText(/^copy snippet$/).length).toBeGreaterThanOrEqual(13);
  });
});

describe("FrameworkApiMap — copy snippet", () => {
  it("clicking copy writes the matching snippet to navigator.clipboard", async () => {
    render(<FrameworkApiMap open={true} onClose={() => {}} />);
    // The first feature in ENTRIES is "Code + WASM mode" — its snippet
    // imports QuickJSKernel + ProgrammaticOrchestrator.
    const buttons = screen.getAllByText(/^copy snippet$/);
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(writtenClipboard.length).toBe(1));
    expect(writtenClipboard[0]).toContain("QuickJSKernel");
    expect(writtenClipboard[0]).toContain("ProgrammaticOrchestrator");
  });

  it("copy button switches to 'copied' label after a successful write", async () => {
    render(<FrameworkApiMap open={true} onClose={() => {}} />);
    const buttons = screen.getAllByText(/^copy snippet$/);
    fireEvent.click(buttons[0]);
    await waitFor(() => {
      const updated = screen.getAllByText(/^(copied|copy snippet)$/);
      // At least one button should now read "copied".
      expect(updated.some((b) => b.textContent === "copied")).toBe(true);
    });
  });

  it("copy gracefully degrades when clipboard.writeText rejects (no crash, error label shown)", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(() => Promise.reject(new Error("denied"))) },
    });
    render(<FrameworkApiMap open={true} onClose={() => {}} />);
    const buttons = screen.getAllByText(/^copy snippet$/);
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(screen.getByText(/clipboard blocked/)).toBeTruthy());
  });
});

describe("FrameworkApiMap — mark + export", () => {
  it("export button is DISABLED until at least one feature is marked", () => {
    render(<FrameworkApiMap open={true} onClose={() => {}} />);
    // Match the BUTTON specifically — the literal "Export minimal project"
    // also appears in the explanatory hint paragraph at the top of the modal.
    const exportBtn = screen.getByRole("button", {
      name: /Export minimal project/,
    }) as HTMLButtonElement;
    expect(exportBtn.disabled).toBe(true);
    expect(screen.getByText(/Star at least one feature/)).toBeTruthy();
  });

  it("clicking mark toggles to ★ marked + the counter increments", () => {
    render(<FrameworkApiMap open={true} onClose={() => {}} />);
    const markBtns = screen.getAllByText(/^☆ mark$/);
    fireEvent.click(markBtns[0]);
    expect(screen.getAllByText(/^★ marked$/).length).toBe(1);
    expect(screen.getByText(/1 feature marked/)).toBeTruthy();
    // Click again to unmark — counter goes back to 0.
    fireEvent.click(screen.getByText(/^★ marked$/));
    expect(screen.queryAllByText(/^★ marked$/).length).toBe(0);
    expect(screen.getByText(/Star at least one feature/)).toBeTruthy();
  });

  it("export button enables once at least one feature is marked", () => {
    render(<FrameworkApiMap open={true} onClose={() => {}} />);
    fireEvent.click(screen.getAllByText(/^☆ mark$/)[0]);
    const exportBtn = screen.getByRole("button", {
      name: /Export minimal project/,
    }) as HTMLButtonElement;
    expect(exportBtn.disabled).toBe(false);
  });

  it("export triggers a download named 'agentkit-starter.zip'", async () => {
    render(<FrameworkApiMap open={true} onClose={() => {}} />);
    fireEvent.click(screen.getAllByText(/^☆ mark$/)[0]);
    fireEvent.click(screen.getByRole("button", { name: /Export minimal project/ }));
    await waitFor(() => expect(triggeredDownloadName).toBe("agentkit-starter.zip"));
    expect(createdObjectUrls.length).toBe(1);
    // revokeObjectURL is the cleanup the production code is responsible for —
    // a regression that drops it would leak blob memory across exports.
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(createdObjectUrls[0]);
  });

  it("the singular/plural noun in the counter is correct", () => {
    render(<FrameworkApiMap open={true} onClose={() => {}} />);
    const markBtns = screen.getAllByText(/^☆ mark$/);
    fireEvent.click(markBtns[0]);
    expect(screen.getByText(/1 feature marked/)).toBeTruthy();
    fireEvent.click(markBtns[1]);
    expect(screen.getByText(/2 features marked/)).toBeTruthy();
  });
});

describe("FrameworkApiMap — close affordances", () => {
  it("clicking the ✕ button calls onClose", () => {
    const onClose = vi.fn();
    render(<FrameworkApiMap open={true} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText(/^Close$/));
    expect(onClose).toHaveBeenCalled();
  });

  it("clicking the backdrop calls onClose", () => {
    const onClose = vi.fn();
    render(<FrameworkApiMap open={true} onClose={onClose} />);
    const dialog = screen.getByRole("dialog");
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalled();
  });

  it("clicking inside the modal body does NOT close the dialog", () => {
    const onClose = vi.fn();
    render(<FrameworkApiMap open={true} onClose={onClose} />);
    // Click on a feature title — well inside the modal body.
    fireEvent.click(screen.getByText("Code + WASM mode"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Escape key on the dialog calls onClose", () => {
    const onClose = vi.fn();
    render(<FrameworkApiMap open={true} onClose={onClose} />);
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

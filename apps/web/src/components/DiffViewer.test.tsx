/**
 * Tests for DiffViewer — the audit window users see before approving an
 * agent change. Critical UX: a regression here either misrepresents what
 * changed (so users approve the wrong thing) or fails to fetch the
 * historical version at all.
 *
 * Strategy: vi.mock("./Editor") so we can read what the diff editor was
 * told to render (the original / modified strings + language).
 * Stub fetch so we control /files/.../versions and /versions/:n.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// ── Capture what DiffViewer hands to the Editor ─────────────────────────────
let capturedEditorProps: Array<Record<string, unknown>> = [];

vi.mock("./Editor", () => ({
  Editor: (props: Record<string, unknown>) => {
    capturedEditorProps.push(props);
    return (
      <div data-testid="editor-stub">
        <span data-testid="editor-original">{String(props.original ?? "")}</span>
        <span data-testid="editor-value">{String(props.value ?? "")}</span>
        <span data-testid="editor-language">{String(props.language ?? "")}</span>
        <span data-testid="editor-isDiff">{String(props.isDiff ?? "")}</span>
        <span data-testid="editor-readOnly">{String(props.readOnly ?? "")}</span>
      </div>
    );
  },
}));

// Defer import until AFTER vi.mock is set.
import { DiffViewer } from "./DiffViewer";

const realFetch = globalThis.fetch;

interface MockState {
  versions: Array<{ version: number; hash: string; savedAtMs: number }>;
  contentByVersion: Record<number, string>;
  versionListStatus?: number;
  contentStatus?: number;
}
let mockState: MockState;

function installFetch() {
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    // Match /versions and /versions/:n by ordering — the more specific path first.
    const versionMatch = url.match(/\/files\/[^/]+\/versions\/(\d+)$/);
    if (versionMatch) {
      const v = Number(versionMatch[1]);
      if (mockState.contentStatus && mockState.contentStatus >= 400) {
        return Promise.resolve(new Response("err", { status: mockState.contentStatus }));
      }
      const content = mockState.contentByVersion[v];
      if (content === undefined) {
        return Promise.resolve(new Response("not found", { status: 404 }));
      }
      // Echo the X-Session-Id back so a test can confirm it was sent.
      const sentSession = (init?.headers as Record<string, string> | undefined)?.["X-Session-Id"];
      return Promise.resolve(
        new Response(JSON.stringify({ version: v, content, sentSession }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }
    if (url.match(/\/files\/[^/]+\/versions$/)) {
      if (mockState.versionListStatus && mockState.versionListStatus >= 400) {
        return Promise.resolve(new Response("err", { status: mockState.versionListStatus }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ versions: mockState.versions }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
  capturedEditorProps = [];
  mockState = {
    versions: [
      { version: 1, hash: "h1", savedAtMs: 1_700_000_000_000 },
      { version: 2, hash: "h2", savedAtMs: 1_700_000_001_000 },
      { version: 3, hash: "h3", savedAtMs: 1_700_000_002_000 },
    ],
    contentByVersion: {
      1: "v1 content",
      2: "v2 content",
      3: "v3 content",
    },
  };
  installFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  cleanup();
});

describe("DiffViewer — initial render", () => {
  it("displays the path and renders the embedded Editor in diff mode", async () => {
    render(<DiffViewer workerUrl="http://w" path="src/foo.ts" modifiedContent="modified" />);
    await waitFor(() => expect(screen.getByTestId("editor-stub")).toBeTruthy());
    expect(screen.getByText("src/foo.ts")).toBeTruthy();
    // Editor is told this is a diff and read-only.
    expect(screen.getByTestId("editor-isDiff").textContent).toBe("true");
    expect(screen.getByTestId("editor-readOnly").textContent).toBe("true");
  });

  it("modifiedContent is forwarded verbatim as Editor's `value`", async () => {
    render(<DiffViewer workerUrl="http://w" path="x.ts" modifiedContent="USER-CONTENT-XYZ" />);
    await waitFor(() => expect(screen.getByTestId("editor-stub")).toBeTruthy());
    expect(screen.getByTestId("editor-value").textContent).toBe("USER-CONTENT-XYZ");
  });

  it("infers the editor language from the file extension", async () => {
    const { rerender } = render(
      <DiffViewer workerUrl="http://w" path="src/a.tsx" modifiedContent="" />
    );
    await waitFor(() => expect(screen.getByTestId("editor-stub")).toBeTruthy());
    expect(screen.getByTestId("editor-language").textContent).toBe("typescript");

    rerender(<DiffViewer workerUrl="http://w" path="config.yaml" modifiedContent="" />);
    expect(screen.getByTestId("editor-language").textContent).toBe("yaml");

    rerender(<DiffViewer workerUrl="http://w" path="README.md" modifiedContent="" />);
    expect(screen.getByTestId("editor-language").textContent).toBe("markdown");
  });

  it("falls back to plaintext when the extension is unknown / missing", async () => {
    render(<DiffViewer workerUrl="http://w" path="LICENSE" modifiedContent="" />);
    await waitFor(() => expect(screen.getByTestId("editor-stub")).toBeTruthy());
    expect(screen.getByTestId("editor-language").textContent).toBe("plaintext");
  });
});

describe("DiffViewer — version list + selection", () => {
  it("fetches the version list on mount and renders one option per version", async () => {
    render(<DiffViewer workerUrl="http://w" path="x.ts" modifiedContent="now" />);
    await waitFor(() => {
      const opts = document.querySelectorAll("option");
      expect(opts.length).toBe(3);
    });
    const opts = Array.from(document.querySelectorAll("option")).map((o) => o.textContent);
    expect(opts.join(" ")).toMatch(/v1.*v2.*v3/);
  });

  it("auto-selects the second-newest version (so the diff has content vs. the latest)", async () => {
    render(<DiffViewer workerUrl="http://w" path="x.ts" modifiedContent="now" />);
    await waitFor(() => {
      // v2 is the second-newest of [v1, v2, v3] — its content lands in the editor.
      expect(screen.getByTestId("editor-original").textContent).toBe("v2 content");
    });
  });

  it("auto-selects the only version when the file has just one", async () => {
    mockState.versions = [{ version: 1, hash: "h", savedAtMs: 1_700_000_000_000 }];
    mockState.contentByVersion = { 1: "only content" };
    render(<DiffViewer workerUrl="http://w" path="x.ts" modifiedContent="now" />);
    await waitFor(() =>
      expect(screen.getByTestId("editor-original").textContent).toBe("only content")
    );
  });

  it("respects a baseVersion prop over the auto-select default", async () => {
    render(<DiffViewer workerUrl="http://w" path="x.ts" modifiedContent="now" baseVersion={1} />);
    await waitFor(() =>
      expect(screen.getByTestId("editor-original").textContent).toBe("v1 content")
    );
  });

  it("changing the dropdown re-fetches the new version's content", async () => {
    render(<DiffViewer workerUrl="http://w" path="x.ts" modifiedContent="now" />);
    await waitFor(() =>
      expect(screen.getByTestId("editor-original").textContent).toBe("v2 content")
    );
    const select = document.querySelector("select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "1" } });
    await waitFor(() =>
      expect(screen.getByTestId("editor-original").textContent).toBe("v1 content")
    );
  });
});

describe("DiffViewer — error states + headers", () => {
  it("surfaces an error indicator when the version list fetch fails", async () => {
    mockState.versionListStatus = 503;
    render(<DiffViewer workerUrl="http://w" path="x.ts" modifiedContent="now" />);
    await waitFor(() => expect(document.body.textContent).toMatch(/HTTP 503/));
  });

  it("surfaces an error when fetching a specific version fails", async () => {
    mockState.contentStatus = 500;
    render(<DiffViewer workerUrl="http://w" path="x.ts" modifiedContent="now" baseVersion={1} />);
    await waitFor(() => expect(document.body.textContent).toMatch(/HTTP 500/));
  });

  it("does NOT fetch when no path versions exist (empty list, no errors raised)", async () => {
    mockState.versions = [];
    render(<DiffViewer workerUrl="http://w" path="x.ts" modifiedContent="" />);
    // Wait for any state to settle.
    await waitFor(() => expect(screen.getByTestId("editor-stub")).toBeTruthy());
    // No version dropdown rendered.
    expect(document.querySelector("select")).toBeNull();
    // The error indicator must NOT appear.
    expect(document.body.textContent).not.toMatch(/HTTP /);
  });

  it("includes X-Session-Id header in version fetches when sessionId prop is set", async () => {
    let listHeaders: Record<string, string> = {};
    let detailHeaders: Record<string, string> = {};
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const headers = (init?.headers as Record<string, string>) ?? {};
      if (url.match(/\/versions$/)) {
        listHeaders = headers;
        return Promise.resolve(
          new Response(JSON.stringify({ versions: [{ version: 1, hash: "h", savedAtMs: 0 }] }), {
            status: 200,
          })
        );
      }
      if (url.match(/\/versions\/\d+$/)) {
        detailHeaders = headers;
        return Promise.resolve(new Response(JSON.stringify({ content: "x" }), { status: 200 }));
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof globalThis.fetch;

    render(
      <DiffViewer workerUrl="http://w" path="x.ts" modifiedContent="" sessionId="alice-session" />
    );
    await waitFor(() => expect(screen.getByTestId("editor-stub")).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId("editor-original").textContent).toBe("x"));
    expect(listHeaders["X-Session-Id"]).toBe("alice-session");
    expect(detailHeaders["X-Session-Id"]).toBe("alice-session");
  });

  it("URL-encodes file paths with slashes / unusual chars", async () => {
    let lastUrl = "";
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      lastUrl = typeof input === "string" ? input : input.toString();
      return Promise.resolve(new Response(JSON.stringify({ versions: [] }), { status: 200 }));
    }) as unknown as typeof globalThis.fetch;
    render(
      <DiffViewer workerUrl="http://w" path="src/deep/file with space.ts" modifiedContent="" />
    );
    await waitFor(() => expect(lastUrl).toMatch(/\/files\/[^/]+\/versions$/));
    // Slashes within the path get encoded too — the entire `path` is one
    // URL component to the worker route.
    expect(lastUrl).toContain("src%2Fdeep%2Ffile%20with%20space.ts");
  });
});

describe("DiffViewer — actions", () => {
  it("Revert button invokes onRevert with the currently selected version", async () => {
    const onRevert = vi.fn();
    render(
      <DiffViewer workerUrl="http://w" path="x.ts" modifiedContent="now" onRevert={onRevert} />
    );
    await waitFor(() => expect(screen.getByTestId("editor-stub")).toBeTruthy());
    // Auto-selected version is v2.
    fireEvent.click(screen.getByText(/Revert to selected/));
    expect(onRevert).toHaveBeenCalledWith(2);
  });

  it("Revert button is disabled when no version is selected (empty version history)", async () => {
    mockState.versions = [];
    render(<DiffViewer workerUrl="http://w" path="x.ts" modifiedContent="" onRevert={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("editor-stub")).toBeTruthy());
    const btn = screen.getByText(/Revert to selected/) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("Close button is hidden when onClose isn't supplied", async () => {
    render(<DiffViewer workerUrl="http://w" path="x.ts" modifiedContent="" />);
    await waitFor(() => expect(screen.getByTestId("editor-stub")).toBeTruthy());
    expect(screen.queryByText(/✕ Close/)).toBeNull();
  });

  it("Close button calls onClose when supplied", async () => {
    const onClose = vi.fn();
    render(<DiffViewer workerUrl="http://w" path="x.ts" modifiedContent="" onClose={onClose} />);
    await waitFor(() => expect(screen.getByText(/✕ Close/)).toBeTruthy());
    fireEvent.click(screen.getByText(/✕ Close/));
    expect(onClose).toHaveBeenCalled();
  });
});

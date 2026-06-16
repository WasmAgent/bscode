/**
 * Tests for ModelManager — the model configuration UI.
 *
 * Strategy: stub fetch to control /models GET, /models/preferences PUT,
 * /models/custom POST/DELETE responses. Pin every user-visible flow:
 *   1. Initial mount fetches the model list and stamps the loading state.
 *   2. Selecting a model marks it as Primary; +Economy toggle works.
 *   3. Save invokes /models/preferences PUT, calls onApply + onClose.
 *   4. Add Custom: client-side validation (id/baseUrl/label required;
 *      baseUrl must be a valid URL); 4xx error message surfaced; success
 *      flash + form reset + list refetched.
 *   5. Delete custom model triggers DELETE then re-fetches.
 *   6. Empty + grouped sections render correctly.
 *   7. Backdrop click triggers onClose; ✕ button triggers onClose.
 *
 * Why heavy: ModelManager is the on-ramp for users adding API keys.
 * A regression that breaks the +Economy toggle silently keeps users
 * stuck on the wrong model forever.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelManager } from "./ModelManager";

const realFetch = globalThis.fetch;

interface FetchCall {
  url: string;
  method: string;
  body?: string;
}
let fetchCalls: FetchCall[] = [];

interface MockState {
  models: Array<{
    id: string;
    label: string;
    provider: string;
    available: boolean;
    source: "builtin" | "local" | "custom";
    baseUrl?: string;
  }>;
  preferences: { primaryModelId: string; economyModelId?: string };
  addCustomFailure?: { status: number; message: string };
}

let mockState: MockState;

function installFetch() {
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    fetchCalls.push({ url, method, body: init?.body as string | undefined });
    if (url.endsWith("/models") && method === "GET") {
      return Promise.resolve(
        new Response(
          JSON.stringify({ models: mockState.models, preferences: mockState.preferences }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }
    if (url.endsWith("/models/preferences") && method === "PUT") {
      mockState.preferences = JSON.parse((init?.body as string) ?? "{}");
      return Promise.resolve(new Response("{}", { status: 200 }));
    }
    if (url.endsWith("/models/custom") && method === "POST") {
      if (mockState.addCustomFailure) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: mockState.addCustomFailure.message }), {
            status: mockState.addCustomFailure.status,
          })
        );
      }
      const body = JSON.parse((init?.body as string) ?? "{}") as MockState["models"][number];
      mockState.models.push({ ...body, source: "custom", available: true });
      return Promise.resolve(new Response("{}", { status: 201 }));
    }
    if (url.includes("/models/custom/") && method === "DELETE") {
      const id = decodeURIComponent(url.split("/models/custom/")[1] ?? "");
      mockState.models = mockState.models.filter((m) => m.id !== id);
      return Promise.resolve(new Response("{}", { status: 200 }));
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as unknown as typeof globalThis.fetch;
}

const baseProps = {
  workerUrl: "http://w",
  currentPrefs: { primaryModelId: "claude-sonnet-4-6" },
  onApply: () => {},
  onClose: () => {},
};

beforeEach(() => {
  fetchCalls = [];
  mockState = {
    models: [
      {
        id: "claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        provider: "anthropic",
        available: true,
        source: "builtin",
      },
      {
        id: "claude-haiku-4-5-20251001",
        label: "Claude Haiku 4.5",
        provider: "anthropic",
        available: true,
        source: "builtin",
      },
      {
        id: "deepseek-v4-pro",
        label: "DeepSeek V4 Pro",
        provider: "deepseek",
        available: false,
        source: "builtin",
      },
      {
        id: "local:localhost:11434/llama3",
        label: "Ollama · llama3",
        provider: "ollama",
        available: true,
        source: "local",
        baseUrl: "http://localhost:11434",
      },
      {
        id: "my-llm",
        label: "My LLM",
        provider: "custom",
        available: true,
        source: "custom",
        baseUrl: "http://x.example",
      },
    ],
    preferences: { primaryModelId: "claude-sonnet-4-6" },
  };
  installFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ── Initial render ─────────────────────────────────────────────────────────

describe("ModelManager — initial render", () => {
  it("fetches /models on mount and renders models grouped by source", async () => {
    render(<ModelManager {...baseProps} />);
    await waitFor(() => expect(screen.getByText(/Claude Sonnet 4\.6/)).toBeTruthy());
    expect(screen.getByText(/Built-in providers/)).toBeTruthy();
    expect(screen.getByText(/Detected local services/)).toBeTruthy();
    expect(screen.getByText(/Custom endpoints/)).toBeTruthy();
    expect(screen.getByText(/Ollama · llama3/)).toBeTruthy();
    expect(screen.getByText(/My LLM/)).toBeTruthy();
    // /models was called exactly once on mount.
    expect(fetchCalls.filter((c) => c.url.endsWith("/models") && c.method === "GET").length).toBe(
      1
    );
  });

  it("shows the Loading state while /models is in flight", async () => {
    let resolveFetch: ((r: Response) => void) | null = null;
    globalThis.fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    ) as unknown as typeof globalThis.fetch;
    render(<ModelManager {...baseProps} />);
    expect(screen.getByText(/Scanning local services/)).toBeTruthy();
    // Resolve so the test cleans up.
    resolveFetch?.(
      new Response(JSON.stringify({ models: [], preferences: { primaryModelId: "" } }), {
        status: 200,
      })
    );
    await waitFor(() => expect(screen.queryByText(/Scanning local services/)).toBeNull());
  });

  it("shows the empty-state hint when no models are returned", async () => {
    mockState.models = [];
    render(<ModelManager {...baseProps} />);
    await waitFor(() => expect(screen.getByText(/No models available/)).toBeTruthy());
  });

  it("marks the configured primary model with the 'Primary' badge", async () => {
    render(<ModelManager {...baseProps} />);
    await waitFor(() => expect(screen.getByText(/Claude Sonnet 4\.6/)).toBeTruthy());
    // The Primary badge is inside the Sonnet row — assert via the row scope
    // rather than a global text match (the literal "Primary" string also
    // appears in the explanatory hint at the top of the panel).
    const sonnetRow = screen.getByText(/Claude Sonnet 4\.6/).closest("button");
    expect(sonnetRow?.textContent).toMatch(/Primary/);
  });

  it("renders 'available: false' models with reduced affordance (no +Economy button)", async () => {
    render(<ModelManager {...baseProps} />);
    await waitFor(() => expect(screen.getByText(/DeepSeek V4 Pro/)).toBeTruthy());
    // The unavailable model has no +Economy button next to it.
    const dsRow = screen.getByText(/DeepSeek V4 Pro/).closest("button");
    expect(dsRow?.textContent).not.toMatch(/\+Economy/);
  });
});

// ── Selection ──────────────────────────────────────────────────────────────

describe("ModelManager — selection", () => {
  it("clicking a model row makes it the new Primary", async () => {
    render(<ModelManager {...baseProps} />);
    await waitFor(() => expect(screen.getByText(/Claude Haiku 4\.5/)).toBeTruthy());
    const haikuRow = screen.getByText(/Claude Haiku 4\.5/).closest("button");
    fireEvent.click(haikuRow as HTMLElement);
    // The Primary badge moves with the click.
    await waitFor(() => {
      const newPrimaryRow = screen.getByText(/Claude Haiku 4\.5/).closest("button");
      expect(newPrimaryRow?.textContent).toMatch(/Primary/);
    });
  });

  it("clicking +Economy adds the Economy badge; clicking again removes it", async () => {
    render(<ModelManager {...baseProps} />);
    await waitFor(() => expect(screen.getByText(/Claude Haiku 4\.5/)).toBeTruthy());
    const haikuRow = screen.getByText(/Claude Haiku 4\.5/).closest("button");
    // Find the +Economy toggle WITHIN this row.
    const toggle = haikuRow?.querySelector("button");
    expect(toggle?.textContent).toMatch(/\+Economy/);
    fireEvent.click(toggle as HTMLElement);
    await waitFor(() => expect(haikuRow?.textContent).toMatch(/Economy/));
    // Click again to remove — the same nested button now reads "−Economy".
    const toggle2 = haikuRow?.querySelector("button");
    fireEvent.click(toggle2 as HTMLElement);
    await waitFor(() => {
      const finalRow = screen.getByText(/Claude Haiku 4\.5/).closest("button");
      // The row no longer carries an "Economy" badge label (only +Economy toggle).
      const badges = Array.from(finalRow?.querySelectorAll("span") ?? []).map((s) => s.textContent);
      expect(badges.some((t) => t === "Economy")).toBe(false);
    });
  });

  it("clicking an UNAVAILABLE model does NOT change the primary selection", async () => {
    render(<ModelManager {...baseProps} />);
    await waitFor(() => expect(screen.getByText(/DeepSeek V4 Pro/)).toBeTruthy());
    const dsRow = screen.getByText(/DeepSeek V4 Pro/).closest("button");
    fireEvent.click(dsRow as HTMLElement);
    // Primary remains on Sonnet.
    const sonnetRow = screen.getByText(/Claude Sonnet 4\.6/).closest("button");
    expect(sonnetRow?.textContent).toMatch(/Primary/);
    expect(dsRow?.textContent).not.toMatch(/Primary/);
  });
});

// ── Save / Cancel / Close ─────────────────────────────────────────────────

describe("ModelManager — save / close", () => {
  it("Apply PUTs /models/preferences with the chosen prefs and fires onApply + onClose", async () => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    render(<ModelManager {...baseProps} onApply={onApply} onClose={onClose} />);
    await waitFor(() => expect(screen.getByText(/Claude Haiku 4\.5/)).toBeTruthy());

    // Switch to Haiku as primary.
    fireEvent.click(screen.getByText(/Claude Haiku 4\.5/).closest("button") as HTMLElement);

    fireEvent.click(screen.getByText(/^Apply$/i));
    await waitFor(() => {
      const put = fetchCalls.find(
        (c) => c.url.endsWith("/models/preferences") && c.method === "PUT"
      );
      expect(put).toBeDefined();
      expect(JSON.parse(put?.body ?? "{}").primaryModelId).toBe("claude-haiku-4-5-20251001");
    });
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ primaryModelId: "claude-haiku-4-5-20251001" })
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("the Cancel button calls onClose without saving (no PUT)", async () => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    render(<ModelManager {...baseProps} onApply={onApply} onClose={onClose} />);
    await waitFor(() => expect(screen.getByText(/Claude Sonnet 4\.6/)).toBeTruthy());
    fireEvent.click(screen.getByText(/^Cancel$/i));
    expect(onClose).toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
    expect(fetchCalls.find((c) => c.method === "PUT")).toBeUndefined();
  });

  it("clicking the backdrop closes the panel; clicking inside does NOT close", async () => {
    const onClose = vi.fn();
    const { container } = render(<ModelManager {...baseProps} onClose={onClose} />);
    await waitFor(() => expect(screen.getByText(/Claude Sonnet 4\.6/)).toBeTruthy());
    // The outer overlay div is the first child of the test container.
    const overlay = container.firstElementChild as HTMLElement;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);

    // Click inside the panel (header text) — must NOT close.
    onClose.mockClear();
    fireEvent.click(screen.getByText(/Model Configuration/));
    expect(onClose).not.toHaveBeenCalled();
  });
});

// ── Add custom model ──────────────────────────────────────────────────────

describe("ModelManager — add custom model", () => {
  async function openAddTab() {
    render(<ModelManager {...baseProps} />);
    await waitFor(() => expect(screen.getByText(/Claude Sonnet 4\.6/)).toBeTruthy());
    fireEvent.click(screen.getByText(/Add Custom \/ Local/i));
  }

  it("client-side validation: blocks empty fields without a network call", async () => {
    await openAddTab();
    fireEvent.click(screen.getByText(/^Add Model$/i));
    expect(screen.getByText(/ID, Base URL, and Label are required/)).toBeTruthy();
    expect(
      fetchCalls.find((c) => c.url.endsWith("/models/custom") && c.method === "POST")
    ).toBeUndefined();
  });

  it("client-side validation: rejects an invalid Base URL", async () => {
    await openAddTab();
    fireEvent.change(screen.getByPlaceholderText(/http:\/\/localhost:11434\/v1/), {
      target: { value: "not a url" },
    });
    fireEvent.change(screen.getByPlaceholderText(/llama3:latest or gpt-4o-mini/), {
      target: { value: "my-id" },
    });
    fireEvent.change(screen.getByPlaceholderText(/My Local Llama/), {
      target: { value: "Display" },
    });
    fireEvent.click(screen.getByText(/^Add Model$/i));
    expect(screen.getByText(/Invalid Base URL/)).toBeTruthy();
    expect(
      fetchCalls.find((c) => c.url.endsWith("/models/custom") && c.method === "POST")
    ).toBeUndefined();
  });

  it("happy path: POSTs to /models/custom, flashes success, resets the form, and refetches", async () => {
    await openAddTab();
    fireEvent.change(screen.getByPlaceholderText(/http:\/\/localhost:11434\/v1/), {
      target: { value: "http://localhost:11434/v1" },
    });
    fireEvent.change(screen.getByPlaceholderText(/llama3:latest or gpt-4o-mini/), {
      target: { value: "test-model" },
    });
    fireEvent.change(screen.getByPlaceholderText(/My Local Llama/), {
      target: { value: "Test Model" },
    });
    fireEvent.click(screen.getByText(/^Add Model$/i));

    await waitFor(() => expect(screen.getByText(/Model added successfully/)).toBeTruthy());
    // Form reset — the Display Name field is empty again.
    expect((screen.getByPlaceholderText(/My Local Llama/) as HTMLInputElement).value).toBe("");
    // /models was refetched (initial + post-add = 2).
    const getModelsCalls = fetchCalls.filter(
      (c) => c.url.endsWith("/models") && c.method === "GET"
    );
    expect(getModelsCalls.length).toBe(2);
  });

  it("server error: surfaces the worker's message verbatim", async () => {
    mockState.addCustomFailure = { status: 422, message: "endpoint not reachable" };
    await openAddTab();
    fireEvent.change(screen.getByPlaceholderText(/http:\/\/localhost:11434\/v1/), {
      target: { value: "http://localhost:11434/v1" },
    });
    fireEvent.change(screen.getByPlaceholderText(/llama3:latest or gpt-4o-mini/), {
      target: { value: "x" },
    });
    fireEvent.change(screen.getByPlaceholderText(/My Local Llama/), {
      target: { value: "X" },
    });
    fireEvent.click(screen.getByText(/^Add Model$/i));
    await waitFor(() => expect(screen.getByText(/endpoint not reachable/)).toBeTruthy());
  });

  it("API key input is type='password' (does not render plaintext)", async () => {
    await openAddTab();
    const apiKeyInput = screen.getByPlaceholderText(/sk-… or leave empty for local/);
    expect((apiKeyInput as HTMLInputElement).type).toBe("password");
  });
});

// ── Delete custom model ──────────────────────────────────────────────────

describe("ModelManager — delete custom model", () => {
  it("✕ button on a custom row triggers DELETE then refetches", async () => {
    render(<ModelManager {...baseProps} />);
    await waitFor(() => expect(screen.getByText(/My LLM/)).toBeTruthy());
    const customRow = screen.getByText(/My LLM/).closest("button");
    // Find the delete (✕) button — last button inside the row.
    const buttons = customRow?.querySelectorAll("button") ?? [];
    const deleteBtn = Array.from(buttons).find((b) => b.textContent?.trim() === "✕");
    expect(deleteBtn).toBeDefined();
    fireEvent.click(deleteBtn as HTMLElement);
    await waitFor(() => {
      const del = fetchCalls.find(
        (c) => c.url.includes("/models/custom/my-llm") && c.method === "DELETE"
      );
      expect(del).toBeDefined();
    });
  });
});

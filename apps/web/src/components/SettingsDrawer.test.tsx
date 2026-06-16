/**
 * Tests for SettingsDrawer.
 *
 * The drawer's job is small but load-bearing: persist worker URL +
 * default model to localStorage and refresh the cached worker URL so
 * subsequent fetch sites in the same session see the new value. A
 * regression that forgets to call refreshWorkerUrl() would leave the
 * UI lying ("Saved ✓" flashes, but every fetch still hits the OLD URL
 * until a hard reload).
 *
 * vi.mock("@/lib/workerUrl") so we can assert refreshWorkerUrl fires
 * AND its return value is irrelevant to the test (we only need to
 * confirm the hook was called after Save).
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refreshWorkerUrlMock = vi.fn();

vi.mock("@/lib/workerUrl", () => ({
  refreshWorkerUrl: () => {
    refreshWorkerUrlMock();
    return "http://localhost:8788";
  },
  // Keep getWorkerUrl exported so any incidental import doesn't break.
  getWorkerUrl: () => "http://localhost:8788",
}));

import { SettingsDrawer } from "./SettingsDrawer";

beforeEach(() => {
  refreshWorkerUrlMock.mockReset();
  localStorage.clear();
});
afterEach(() => {
  localStorage.clear();
});

describe("SettingsDrawer — initial render", () => {
  it("loads existing values from localStorage on mount", async () => {
    localStorage.setItem("bscode:workerUrl", "https://prod.example/worker");
    localStorage.setItem("bscode:modelPreference", "claude-opus-4-8");
    render(<SettingsDrawer onClose={() => {}} />);
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe(
        "https://prod.example/worker"
      )
    );
    const select = document.querySelector("#bscode-settings-default-model") as HTMLSelectElement;
    expect(select.value).toBe("claude-opus-4-8");
  });

  it("falls back to the documented defaults when localStorage is empty", async () => {
    render(<SettingsDrawer onClose={() => {}} />);
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("http://localhost:8788")
    );
    const select = document.querySelector("#bscode-settings-default-model") as HTMLSelectElement;
    expect(select.value).toBe("claude-sonnet-4-6");
  });

  it("renders the API-key security note (server-side via Wrangler)", () => {
    render(<SettingsDrawer onClose={() => {}} />);
    // Catches a regression that accidentally moves API keys into the
    // browser-side settings — explicit warning.
    expect(document.body.textContent).toMatch(/API keys are configured server-side/);
    expect(document.body.textContent).toMatch(/Wrangler secrets/);
  });
});

describe("SettingsDrawer — save flow", () => {
  it("persists trimmed values to localStorage and calls refreshWorkerUrl", async () => {
    render(<SettingsDrawer onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/^Save$/)).toBeTruthy());

    const urlInput = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(urlInput, { target: { value: "  https://my.worker  " } });

    const select = document.querySelector("#bscode-settings-default-model") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "claude-haiku-4-5-20251001" } });

    fireEvent.click(screen.getByText(/^Save$/));

    expect(localStorage.getItem("bscode:workerUrl")).toBe("https://my.worker");
    expect(localStorage.getItem("bscode:modelPreference")).toBe("claude-haiku-4-5-20251001");
    // refreshWorkerUrl MUST fire so existing fetch closures see the new value.
    expect(refreshWorkerUrlMock).toHaveBeenCalledTimes(1);
  });

  it("Save flashes 'Saved ✓' and the flash clears after the timeout", async () => {
    render(<SettingsDrawer onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/^Save$/)).toBeTruthy());
    fireEvent.click(screen.getByText(/^Save$/));
    expect(screen.getByText(/Saved/)).toBeTruthy();
    // The flash clears after 1.2s. Use a real-timer waitFor with a
    // longer timeout — fake timers + React state updates need explicit
    // act() wrapping that adds noise without catching anything new.
    await waitFor(() => expect(screen.queryByText(/Saved/)).toBeNull(), { timeout: 2500 });
  });

  it("an empty Worker URL field saves the default fallback (never an empty string)", async () => {
    render(<SettingsDrawer onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/^Save$/)).toBeTruthy());
    const urlInput = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(urlInput, { target: { value: "   " } });
    fireEvent.click(screen.getByText(/^Save$/));
    // Empty/whitespace input MUST NOT persist as "" — the defaults guard
    // every fetch site from a 'fetch("")' which would resolve against the
    // current document origin and hit the wrong route.
    expect(localStorage.getItem("bscode:workerUrl")).toBe("http://localhost:8788");
  });
});

describe("SettingsDrawer — close affordances", () => {
  it("clicking the ✕ button calls onClose", async () => {
    const onClose = vi.fn();
    render(<SettingsDrawer onClose={onClose} />);
    await waitFor(() => expect(screen.getByText(/✕/)).toBeTruthy());
    fireEvent.click(screen.getByText(/✕/));
    expect(onClose).toHaveBeenCalled();
  });

  it("clicking the backdrop button calls onClose", () => {
    const onClose = vi.fn();
    render(<SettingsDrawer onClose={onClose} />);
    const overlay = screen.getByLabelText(/Close settings/);
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalled();
  });

  it("the dialog has role=dialog with an accessible label", () => {
    render(<SettingsDrawer onClose={() => {}} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBe("Settings");
  });
});

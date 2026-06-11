/**
 * B1 — JobsPanel tests.
 *
 * Mocks global fetch to drive the panel's three responsibilities:
 *   1. Initial GET /jobs render → table reflects server state
 *   2. Submit batch → POSTs jobs[], textarea clears, re-fetches
 *   3. Abort row → DELETEs job by id
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobsPanel } from "./JobsPanel.js";

interface MockJob {
  id: string;
  spec: { task: string };
  status: "queued" | "running" | "done" | "failed" | "aborted";
  eventCount: number;
  submittedAtMs: number;
}

let mockJobs: MockJob[] = [];
let mockStats = { running: 0, pending: 0, total: 0 };
let postedBodies: unknown[] = [];
let deletedIds: string[] = [];

function makeFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/jobs") && method === "POST") {
      postedBodies.push(init?.body ? JSON.parse(init.body as string) : null);
      return new Response(JSON.stringify({ jobIds: ["new-1"] }), { status: 200 });
    }
    if (url.match(/\/jobs\/[^/?]+$/) && method === "DELETE") {
      const id = url.split("/").pop() ?? "";
      deletedIds.push(id);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.includes("/jobs") && method === "GET") {
      return new Response(
        JSON.stringify({ jobs: mockJobs, stats: mockStats }),
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  mockJobs = [];
  mockStats = { running: 0, pending: 0, total: 0 };
  postedBodies = [];
  deletedIds = [];
  vi.stubGlobal("fetch", makeFetch());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("JobsPanel", () => {
  it("renders empty state then a single done row", async () => {
    mockJobs = [
      {
        id: "j1",
        spec: { task: "hello" },
        status: "done",
        eventCount: 5,
        submittedAtMs: Date.now() - 3000,
      },
    ];
    mockStats = { running: 0, pending: 0, total: 1 };
    render(<JobsPanel sessionId="s1" workerUrl="http://test" />);
    await waitFor(() => {
      expect(screen.getByText("hello")).toBeTruthy();
      expect(screen.getByText("done")).toBeTruthy();
    });
  });

  it("submits a batch when the user types tasks and clicks Submit", async () => {
    render(<JobsPanel sessionId="s1" workerUrl="http://test" />);
    const textarea = screen.getByLabelText(/Tasks/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "task one\ntask two\n" } });
    fireEvent.click(screen.getByText(/Submit batch/i));
    await waitFor(() => {
      expect(postedBodies.length).toBe(1);
    });
    const body = postedBodies[0] as { jobs: Array<{ task: string; agentMode: string }> };
    expect(body.jobs.length).toBe(2);
    expect(body.jobs[0]?.task).toBe("task one");
    expect(body.jobs[1]?.task).toBe("task two");
    expect(body.jobs[0]?.agentMode).toBe("tool");
    // Textarea should clear on success.
    await waitFor(() => {
      expect((screen.getByLabelText(/Tasks/i) as HTMLTextAreaElement).value).toBe("");
    });
  });

  it("does NOT submit when textarea is empty (validation)", async () => {
    render(<JobsPanel sessionId="s1" workerUrl="http://test" />);
    fireEvent.click(screen.getByText(/Submit batch/i));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    expect(postedBodies.length).toBe(0);
  });

  it("Abort button issues a DELETE for a running job and not for terminal ones", async () => {
    mockJobs = [
      {
        id: "running-1",
        spec: { task: "in-flight" },
        status: "running",
        eventCount: 2,
        submittedAtMs: Date.now() - 1000,
      },
      {
        id: "done-1",
        spec: { task: "finished" },
        status: "done",
        eventCount: 10,
        submittedAtMs: Date.now() - 5000,
      },
    ];
    mockStats = { running: 1, pending: 0, total: 2 };
    render(<JobsPanel sessionId="s1" workerUrl="http://test" />);
    const buttons = await screen.findAllByText(/Abort/i);
    // Only the running job should have an Abort button.
    expect(buttons.length).toBe(1);
    fireEvent.click(buttons[0]!);
    await waitFor(() => {
      expect(deletedIds).toEqual(["running-1"]);
    });
  });

  it("surfaces error on failed list fetch", async () => {
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Response("oops", { status: 500 })) as unknown as typeof fetch,
    );
    render(<JobsPanel sessionId="s1" workerUrl="http://test" />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
  });
});

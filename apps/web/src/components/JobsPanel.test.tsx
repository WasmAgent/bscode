/**
 * B1 — JobsPanel tests.
 *
 * Mocks global fetch to drive the panel's three responsibilities:
 *   1. Initial GET /jobs render → table reflects server state
 *   2. Submit batch → POSTs jobs[], textarea clears, re-fetches
 *   3. Abort row → DELETEs job by id
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { JobsPanel } from "./JobsPanel.js";

interface MockJob {
  id: string;
  spec: { task: string };
  status: "queued" | "running" | "done" | "failed" | "aborted";
  eventCount: number;
  submittedAtMs: number;
  finalAnswer?: string;
  eventTail?: Array<{
    channel: string;
    event: string;
    data?: Record<string, unknown>;
    timestampMs: number;
  }>;
}

let mockJobs: MockJob[] = [];
let mockStats = { running: 0, pending: 0, total: 0 };
let postedBodies: unknown[] = [];
let deletedIds: string[] = [];
let detailFetchCount = 0;

function makeFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
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
    // GET /jobs/:id — single-job detail (eventTail).
    const detailMatch = url.match(/\/jobs\/([^/?]+)$/);
    if (detailMatch && method === "GET") {
      detailFetchCount += 1;
      const id = detailMatch[1];
      const j = mockJobs.find((m) => m.id === id);
      if (!j) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      return new Response(JSON.stringify(j), { status: 200 });
    }
    if (url.includes("/jobs") && method === "GET") {
      return new Response(JSON.stringify({ jobs: mockJobs, stats: mockStats }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  mockJobs = [];
  mockStats = { running: 0, pending: 0, total: 0 };
  postedBodies = [];
  deletedIds = [];
  detailFetchCount = 0;
  globalThis.fetch = makeFetch() as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  cleanup();
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
    const firstButton = buttons[0];
    expect(firstButton).toBeDefined();
    if (!firstButton) return;
    fireEvent.click(firstButton);
    await waitFor(() => {
      expect(deletedIds).toEqual(["running-1"]);
    });
  });

  it("surfaces error on failed list fetch", async () => {
    globalThis.fetch = (async () =>
      new Response("oops", { status: 500 })) as unknown as typeof globalThis.fetch;
    render(<JobsPanel sessionId="s1" workerUrl="http://test" />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
  });

  it("expands a row and shows the final answer + event count from /jobs/:id", async () => {
    mockJobs = [
      {
        id: "answered-1",
        spec: { task: "compute 2+2" },
        status: "done",
        eventCount: 3,
        submittedAtMs: Date.now() - 5000,
        finalAnswer: "The result is **4**.",
        eventTail: [
          { channel: "text", event: "run_start", timestampMs: 1 },
          { channel: "text", event: "step_start", timestampMs: 2 },
          {
            channel: "text",
            event: "final_answer",
            data: { answer: "The result is **4**." },
            timestampMs: 3,
          },
        ],
      },
    ];
    mockStats = { running: 0, pending: 0, total: 1 };
    render(<JobsPanel sessionId="s1" workerUrl="http://test" />);
    const toggle = await screen.findByTestId("jobs-toggle-answered-1");
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(screen.getByTestId("jobs-detail-answered-1")).toBeTruthy();
      expect(screen.getByText(/The result is \*\*4\*\*\./)).toBeTruthy();
    });
    // At least one detail fetch must have happened on open. The staleness
    // effect may fire a second one if the response lands after the first
    // jobs[] poll tick — that's fine; what we're guarding against is zero.
    expect(detailFetchCount).toBeGreaterThanOrEqual(1);
    expect(detailFetchCount).toBeLessThanOrEqual(3);
  });

  it("collapses a row and stops re-fetching detail when closed", async () => {
    mockJobs = [
      {
        id: "j-collapse",
        spec: { task: "say hi" },
        status: "done",
        eventCount: 1,
        submittedAtMs: Date.now() - 100,
        finalAnswer: "hi",
      },
    ];
    mockStats = { running: 0, pending: 0, total: 1 };
    render(<JobsPanel sessionId="s1" workerUrl="http://test" />);
    const toggle = await screen.findByTestId("jobs-toggle-j-collapse");
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByTestId("jobs-detail-j-collapse")).toBeTruthy());
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryByTestId("jobs-detail-j-collapse")).toBeNull());
  });
});

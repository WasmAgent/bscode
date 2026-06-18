/**
 * /api/recipes/run unit tests — Direction 6 reverse-funnel.
 *
 * The route's only inputs are the recipe id (server-controlled stub
 * map) and a JSON body. Tests pin: (a) every documented recipe id
 * resolves to a runnable stub that returns a non-empty patch, (b)
 * unknown ids fail with 400 and a discoverable error message, (c)
 * malformed JSON fails with 400 rather than a 500.
 */

import { describe, expect, it } from "bun:test";
import { POST } from "./route";

function makeRequest(body: unknown, malformed = false): Request {
  const initBody = malformed ? "not json" : JSON.stringify(body);
  return new Request("http://localhost/api/recipes/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: initBody,
  });
}

const ALL_RECIPE_IDS = ["aisdk", "cf-codemode", "mastra", "claude-agent-sdk", "openai-agents"];

describe("/api/recipes/run", () => {
  for (const id of ALL_RECIPE_IDS) {
    it(`runs the ${id} stub and returns a non-empty patch`, async () => {
      const res = await POST(makeRequest({ recipe: id }) as never);
      expect(res.status).toBe(200);
      const json = (await res.json()) as { patch: string; calls: number; framework: string };
      expect(json.framework.length).toBeGreaterThan(0);
      expect(typeof json.patch).toBe("string");
      expect(json.patch.length).toBeGreaterThan(0);
      // Each stub does at least one read + one write + one diff.
      expect(json.calls).toBeGreaterThanOrEqual(3);
    });
  }

  it("returns 400 for an unknown recipe id with a discoverable hint", async () => {
    const res = await POST(makeRequest({ recipe: "does-not-exist" }) as never);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/unknown recipe id/);
    // The error lists known ids so the caller can self-correct.
    for (const id of ALL_RECIPE_IDS) {
      expect(json.error).toContain(id);
    }
  });

  it("returns 400 for malformed JSON", async () => {
    const res = await POST(makeRequest({}, true) as never);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/invalid JSON/i);
  });
});

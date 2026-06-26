/**
 * /api/recipes/run unit tests — Direction 6 reverse-funnel.
 *
 * The route's only inputs are the recipe id (server-controlled static
 * map) and a JSON body. Tests pin:
 *   (a) every documented recipe id resolves to a runnable function that
 *       returns a non-empty patch,
 *   (b) unknown ids fail with 400 and a discoverable error message,
 *   (c) malformed JSON fails with 400 rather than a 500,
 *   (d) attack-vector inputs (injected code in recipe id, prototype
 *       pollution attempts, oversized / missing fields) are rejected
 *       cleanly with 400 — no code execution occurs.
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

  // -------------------------------------------------------------------------
  // Attack-vector tests — these inputs must be rejected with 400, never
  // executed. With the static-map approach, there is no eval path to reach.
  // -------------------------------------------------------------------------

  it("rejects a recipe id that looks like injected JS code", async () => {
    const res = await POST(
      makeRequest({ recipe: "'); require('child_process').execSync('id'); //" }) as never
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/unknown recipe id/);
  });

  it("rejects a recipe id containing a template literal injection attempt", async () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: testing that this raw string (not a real template) is rejected as injection
    const res = await POST(makeRequest({ recipe: "${process.env.SECRET}" }) as never);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/unknown recipe id/);
  });

  it("rejects a recipe id that is __proto__", async () => {
    const res = await POST(makeRequest({ recipe: "__proto__" }) as never);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/unknown recipe id/);
  });

  it("rejects a recipe id that is constructor", async () => {
    const res = await POST(makeRequest({ recipe: "constructor" }) as never);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/unknown recipe id/);
  });

  it("rejects a recipe id that is toString", async () => {
    const res = await POST(makeRequest({ recipe: "toString" }) as never);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/unknown recipe id/);
  });

  it("rejects a recipe id that is an empty string", async () => {
    const res = await POST(makeRequest({ recipe: "" }) as never);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/unknown recipe id/);
  });

  it("rejects a body with no recipe field (undefined recipe)", async () => {
    const res = await POST(makeRequest({}) as never);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/unknown recipe id/);
  });

  it("rejects a recipe id with path-traversal characters", async () => {
    const res = await POST(makeRequest({ recipe: "../../etc/passwd" }) as never);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/unknown recipe id/);
  });

  it("rejects a recipe id with newline injection", async () => {
    const res = await POST(makeRequest({ recipe: "aisdk\neval('1+1')" }) as never);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/unknown recipe id/);
  });
});

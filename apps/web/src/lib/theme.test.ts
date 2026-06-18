/**
 * Tests for lib/theme.ts.
 *
 * theme.ts is a constants module — the test job is to pin the contract
 * other modules rely on, not assert exact hex values (those rotate). Cover:
 *   1. Every advertised key exists and is a non-empty string.
 *   2. The shape covers all four documented categories (text/bg/border/
 *      accent/status) — accidental category renames break inline-style
 *      consumers silently otherwise.
 *   3. Hex values are valid `#rrggbb` — typos like `#0d1` would render
 *      a different colour than intended.
 *   4. ThemeKey type is exported (compile-time check via `satisfies`).
 */

import { describe, expect, it } from "bun:test";
import { type ThemeKey, theme } from "./theme";

const HEX = /^#[0-9a-fA-F]{6}$/;

describe("theme", () => {
  it("every value is a valid #rrggbb hex string", () => {
    for (const [key, value] of Object.entries(theme)) {
      expect(value, `theme.${key}`).toMatch(HEX);
    }
  });

  it("covers the documented surface categories", () => {
    // Add-only contract — adding categories is fine, removing one breaks
    // every component that imports it. Keep this list aligned with the
    // file header comment.
    const required = [
      // surfaces
      "bgCanvas",
      "bgPanel",
      "bgInput",
      "bgHover",
      // borders
      "borderDefault",
      "borderStrong",
      // text
      "textPrimary",
      "textSecondary",
      "textMuted",
      "textDim",
      "textDisabled",
      // accents
      "accentLink",
      "accentCost",
      // status
      "statusOk",
      "statusWarn",
      "statusError",
      "statusInfo",
    ];
    for (const key of required) {
      expect(theme, `missing token: ${key}`).toHaveProperty(key);
    }
  });

  it("textPrimary is the canonical white", () => {
    // textPrimary feeds heading and primary-value styles. If someone
    // accidentally darkens it the AAA contrast goal in the file header
    // (14:1 against #0d1117) breaks silently.
    expect(theme.textPrimary?.toLowerCase()).toBe("#ffffff");
  });

  it("bgCanvas matches the contrast-target reference", () => {
    // The header comment fixes contrast targets against bgCanvas = #0d1117.
    // If someone updates the canvas without re-checking text contrasts,
    // accessibility regresses; this test catches the silent drift.
    expect(theme.bgCanvas?.toLowerCase()).toBe("#0d1117");
  });

  it("status colors are distinct so users can tell ok/warn/error apart", () => {
    const ok = theme.statusOk?.toLowerCase();
    const warn = theme.statusWarn?.toLowerCase();
    const error = theme.statusError?.toLowerCase();
    expect(new Set([ok, warn, error]).size).toBe(3);
  });

  it("ThemeKey type narrows to the actual keys (compile-time check)", () => {
    // If someone deletes a key, the `satisfies` clause fails to compile —
    // a much louder failure than a runtime undefined-deref.
    const key: ThemeKey = "textPrimary";
    expect(theme[key]).toBeDefined();
    // Use the type at runtime so vitest doesn't strip the import.
    const sample: ThemeKey[] = ["bgCanvas", "accentLink", "statusOk"];
    for (const k of sample) {
      expect(theme[k]).toMatch(HEX);
    }
  });
});

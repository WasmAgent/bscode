/**
 * Centralised UI color tokens (web).
 *
 * Single source of truth for all colours used in TSX inline styles. The
 * matching CSS custom properties live in `app/globals.css` so non-React
 * surfaces (e.g. Tailwind layer, plain CSS files) stay in sync.
 *
 * Why a TS module + CSS vars rather than raw hex strings scattered through
 * components? Every readability tweak (e.g. "the dim gray on the dark
 * background fails AAA contrast") was previously a sed-grep across 11 files;
 * after this refactor it's one constant.
 *
 * Naming:
 *  - `text*`      — foreground text on the dark canvas
 *  - `bg*`        — surface backgrounds
 *  - `border*`    — separator strokes
 *  - `accent*`    — highlight colours that draw the eye (cost, links, status)
 *  - `status*`    — semantic status (ok/warn/error) — palette-locked
 *
 * Contrast targets (against `bgCanvas` = #0d1117):
 *   textPrimary  — 14.0:1 (AAA Large + AA Small)
 *   textSecondary — 7.5:1 (AAA Large + AA Small)
 *   textMuted     — 4.7:1 (AA Large + AA Small)
 *   textDim       — 3.5:1 (AA Large only — reserve for incidental/disabled)
 */

export const theme: Record<string, string> = {
  // Surfaces
  bgCanvas: "#0d1117",
  bgPanel: "#161b22",
  bgInput: "#0d1117",
  bgHover: "#1f242c",

  // Borders
  borderDefault: "#30363d",
  borderStrong: "#484f58",

  // Text — replaces the previous mid-grays that were too dim on the dark bg.
  textPrimary: "#ffffff", // headings, primary values
  textSecondary: "#e6edf3", // body text
  textMuted: "#d0d7de", // labels, secondary copy (was #8b949e)
  textDim: "#9ba3af", // hints, placeholders (was #484f58)
  textDisabled: "#6e7681",

  // Accents — used for status, links, eye-catching values.
  accentLink: "#58a6ff",
  accentCost: "#f1c40f", // amber/yellow — money values
  accentNew: "#bc8cff", // purple — "enhance" prompt button
  accentSuggestion: "#e3b341", // mid-yellow — soft highlight

  // Status — preserve standard semantic colours.
  statusOk: "#3fb950",
  statusWarn: "#e3b341",
  statusError: "#f85149",
  statusInfo: "#58a6ff",
};

export type ThemeKey = keyof typeof theme;

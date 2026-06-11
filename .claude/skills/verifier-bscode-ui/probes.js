/**
 * Reusable evaluate_script payloads for verifier-bscode-ui.
 *
 * These are NOT meant to be imported — copy/paste into a
 * `mcp__plugin_chrome-devtools-mcp_chrome-devtools__evaluate_script`
 * call. They live here as the canonical reference so a probe doesn't
 * drift into "works on my page" territory.
 */

// ── Bypass the React-controlled-textarea trap ──────────────────────────────
// chrome-devtools fill() doesn't trigger React's _valueTracker, so the Run
// button stays disabled. This setter does.
export const setTaskInput = (text) => `
() => {
  const ta = document.querySelector('textarea');
  if (!ta) return { error: 'no textarea' };
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, 'value'
  ).set;
  setter.call(ta, ${JSON.stringify(text)});
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return { value: ta.value.slice(0, 80) };
}
`;

// ── Extract structured turn state for the report ───────────────────────────
export const probeLatestTurn = `
() => {
  const text = document.body.innerText;
  return {
    badge: (text.match(/(Code \\+ WASM|Code|Tool|Framework · \\w+)/) || [])[0] || null,
    thought: (text.match(/Thought \\(\\d+ words?\\)/) || [])[0] || null,
    cost: (text.match(/~\\$\\d+\\.\\d+/) || [])[0] || null,
    tokens: (text.match(/\\d[\\d,]* tok/) || [])[0] || null,
    hasD2Card: /card:d2/i.test(text),
    hasMdCard: /card:markdown/i.test(text),
    showsBoltThinking: /<boltThinking>/.test(text),
    isRunning: /Stop|Thinking…/.test(text),
    isDone: /● Done|✓/.test(text),
  };
}
`;

// ── Read what's in the Parsed Segments / Card Preview pane ─────────────────
export const probeCardPreview = `
() => {
  const after = document.body.innerText.split('CARD PREVIEW')[1];
  return after ? after.slice(0, 500) : null;
}
`;

// ── Probe the click-target for a card button by partial text match ─────────
// Returns the uid if you have one, otherwise the offsetTop for visual
// confirmation that something is clickable.
export const findCardButton = (textPrefix) => `
() => {
  const btn = Array.from(document.querySelectorAll('button')).find(
    (b) => b.innerText.startsWith(${JSON.stringify(textPrefix)})
  );
  return btn ? { found: true, text: btn.innerText.slice(0, 60) } : { found: false };
}
`;

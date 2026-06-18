"use client";
import type { CardBlock } from "@agentkit-js/ui-cards";
import { parseCardBlocks, upgradeCardSyntax } from "@agentkit-js/ui-cards";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ClassifyResult, ConversationTurn, GoalCriterion } from "@/lib/conversationTypes";
import { theme } from "@/lib/theme";

// react-markdown types are not yet updated for React 19. Same compat
// shim ui-cards-react ships in MarkdownCard.tsx.
// biome-ignore lint/suspicious/noExplicitAny: type compat shim
const Markdown = ReactMarkdown as any;

const MODE_COLORS: Record<string, string> = {
  "Code + WASM": "#bc8cff",
  "Tool + DAG": "#58a6ff",
  "Framework · react": "#3fb950",
  "Framework · vue": "#3fb950",
  "Framework · svelte": "#e3b341",
  "Framework · vanilla": "#58a6ff",
};

function modeLabel(d: ClassifyResult | null): string {
  if (!d) return "";
  // 2026-06-18: classifier's loop=verify routes the run through
  // GoalDirectedAgent. Surface that on the badge with a "🎯" suffix —
  // the dial itself is hidden (autoMode decides) but the user should
  // still see what the agent is about to do.
  const goalSuffix = d.loop === "verify" ? " · 🎯" : "";
  if (d.mode === "code") return `Code + WASM${goalSuffix}`;
  if (d.mode === "tool") return `Tool + DAG${goalSuffix}`;
  return `Framework · ${d.framework ?? "react"}`;
}

/**
 * 2026-06-18 — Compact timeline of the goal-directed loop's phases.
 * Renders inline above the agent's final answer when this turn ran with
 * `agentMode === "goalDirected"`. The timeline is the visible
 * differentiator between "the agent guesses it's done" and "the agent
 * checked against criteria it published before running" — it is the
 * UX surface for the differentiation argued in
 * agentkit-js/docs/guides/goal-directed.md.
 */
function GoalTimeline(props: {
  criteria?: GoalCriterion[];
  iteration?: number;
  done?: ConversationTurn["goalDone"];
  isActive: boolean;
}) {
  const { criteria, iteration, done, isActive } = props;
  if (!criteria && !iteration && !done) return null;
  const outcomeColor: Record<string, string> = {
    verified: "#3fb950",
    exhausted: "#e3b341",
    budget: "#e3b341",
    error: "#f85149",
    "single-shot": "#9b9bff",
  };
  return (
    <div
      style={{
        marginBottom: 8,
        background: "#0d1117",
        border: "1px solid #bc8cff44",
        borderRadius: 6,
        padding: "8px 12px",
      }}
    >
      <div
        style={{
          fontSize: 10,
          color: "#bc8cff",
          marginBottom: 6,
          textTransform: "uppercase",
          letterSpacing: 0.6,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        🎯 Goal-directed
        {iteration !== undefined && (
          <span style={{ color: theme.textMuted, textTransform: "none", letterSpacing: 0 }}>
            · iteration {iteration}
          </span>
        )}
        {done && (
          <span
            style={{
              marginLeft: "auto",
              color: outcomeColor[done.outcome] ?? theme.textMuted,
              textTransform: "none",
              letterSpacing: 0,
              fontWeight: 600,
            }}
          >
            {done.outcome === "verified"
              ? "✓ verified"
              : done.outcome === "single-shot"
                ? "single shot"
                : `× ${done.outcome}`}
          </span>
        )}
      </div>
      {criteria && criteria.length > 0 && (
        <ul
          style={{
            margin: 0,
            padding: 0,
            listStyle: "none",
            display: "flex",
            flexDirection: "column",
            gap: 3,
          }}
        >
          {criteria.map((c) => (
            <li
              key={c.id}
              style={{
                fontSize: 11,
                color: "#c9d1d9",
                fontFamily: "JetBrains Mono, monospace",
                display: "flex",
                alignItems: "baseline",
                gap: 6,
              }}
            >
              <span style={{ color: theme.textMuted }}>·</span>
              <span style={{ color: "#58a6ff" }}>{c.verify_method}</span>
              <span>{c.description}</span>
              {c.path && (
                <span style={{ color: theme.textMuted, marginLeft: "auto" }}>{c.path}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {done?.lastHint && (
        <div
          style={{
            marginTop: 6,
            fontSize: 11,
            color: "#e3b341",
            fontFamily: "JetBrains Mono, monospace",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {done.lastHint}
        </div>
      )}
      {isActive && !done && (
        <div style={{ fontSize: 10, color: theme.textMuted, marginTop: 4 }}>
          <span style={{ animation: "pulse 1.2s infinite" }}>verifying…</span>
        </div>
      )}
    </div>
  );
}

/** Format a byte count as 1.2 KB / 856 B / 3.4 MB. Pure for testing. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Pick a sensible download filename for a card. Pure for testing. */
export function cardDownloadName(card: CardBlock): string {
  // If meta looks like a filename (has an extension), use it verbatim.
  if (card.meta && /\.[A-Za-z0-9]{1,8}$/.test(card.meta)) return card.meta;
  const ext = card.type === "markdown" ? "md" : card.type === "d2" ? "d2" : "txt";
  const base = (card.meta ?? card.id).replace(/[^\w.-]+/g, "-");
  return `${base}.${ext}`;
}

function downloadCard(card: CardBlock): void {
  const mime = card.type === "markdown" ? "text/markdown" : "text/plain";
  const blob = new Blob([card.content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = cardDownloadName(card);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on next tick so Safari can finish reading the URL.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export interface TurnBlockProps {
  turn: ConversationTurn;
  isActive: boolean;
  streamingText?: string;
  onFix?: () => void;
  onRetry: () => void;
  /** Called when user clicks a card tile — sends it to the preview panel */
  onPreviewCard: (card: CardBlock) => void;
  /** Whether this turn ran in framework mode (vanilla/react/vue/svelte). */
  isFrameworkMode: boolean;
  /** WebContainer preview URL once ready — only set in framework mode. */
  previewUrl?: string;
}

export function TurnBlock({
  turn,
  isActive,
  streamingText,
  onFix,
  onRetry,
  onPreviewCard,
  isFrameworkMode,
  previewUrl,
}: TurnBlockProps) {
  const label = modeLabel(turn.detectedMode);
  // Hide raw <boltThinking>...</boltThinking> tags from the Thought panel —
  // the parsed plan is already shown separately above. While streaming, we
  // also hide an unmatched-open <boltThinking> tag (the closing one hasn't
  // arrived yet) so the user doesn't briefly see the raw markup.
  const rawThinking = (isActive ? streamingText : turn.agentText) ?? "";
  const thinkingText = rawThinking
    .replace(/<boltThinking>[\s\S]*?<\/boltThinking>/gi, "")
    .replace(/<boltThinking>[\s\S]*$/i, "")
    .trim();
  const displayText = turn.status === "done" && turn.finalAnswer ? turn.finalAnswer : null;
  const [thinkingCollapsed, setThinkingCollapsed] = useState(turn.thinkingCollapsed);

  // Parse cards out of the final answer
  // Auto-upgrade: wrap bare D2/Markdown content in card fences if AI missed it
  const upgradedText = displayText ? upgradeCardSyntax(displayText) : null;
  const parsedAnswer = upgradedText ? parseCardBlocks(upgradedText) : null;
  const hasCards = parsedAnswer && parsedAnswer.cards.length > 0;

  useEffect(() => {
    if (turn.thinkingCollapsed) setThinkingCollapsed(true);
  }, [turn.thinkingCollapsed]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* User bubble */}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <div
          style={{
            maxWidth: "80%",
            background: "#1f6feb22",
            border: "1px solid #1f6feb44",
            borderRadius: "12px 12px 3px 12px",
            padding: "10px 14px",
          }}
        >
          <div style={{ fontSize: 12, color: "#c9d1d9", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
            {turn.task}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
            {label && (
              <span
                style={{
                  fontSize: 10,
                  padding: "1px 6px",
                  borderRadius: 3,
                  background: `${MODE_COLORS[label.replace(/\s·\s🎯$/, "")] ?? "#58a6ff"}22`,
                  border: `1px solid ${MODE_COLORS[label.replace(/\s·\s🎯$/, "")] ?? "#58a6ff"}44`,
                  color: MODE_COLORS[label.replace(/\s·\s🎯$/, "")] ?? "#58a6ff",
                }}
              >
                {label}
              </span>
            )}
            <span style={{ fontSize: 10, color: theme.textDim, marginLeft: "auto" }}>
              {new Date(turn.timestamp).toLocaleTimeString()}
            </span>
          </div>
        </div>
      </div>

      {/* Agent response */}
      <div style={{ display: "flex", gap: 10 }}>
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: "50%",
            flexShrink: 0,
            background: isActive ? "#1f6feb" : turn.status === "error" ? "#b91c1c" : "#238636",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 13,
            marginTop: 2,
            animation: isActive ? "pulse 1.2s ease-in-out infinite" : undefined,
          }}
        >
          {isActive ? "⟳" : turn.status === "error" ? "✗" : "✓"}
        </div>
        <div style={{ flex: 1 }}>
          {/* Goal-directed timeline — only present when this turn ran with agentMode=goalDirected */}
          <GoalTimeline
            criteria={turn.goalCriteria}
            iteration={turn.goalIteration}
            done={turn.goalDone}
            isActive={isActive}
          />
          {/* Plan section — bolt.new <boltThinking> pattern: show plan before files are written */}
          {turn.planText && (
            <div style={{ marginBottom: 8 }}>
              <button
                type="button"
                onClick={() => setThinkingCollapsed((c) => !c)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  background: "none",
                  border: "none",
                  padding: "2px 0",
                  color: "#58a6ff",
                  fontSize: 10,
                  cursor: "pointer",
                  fontFamily: "JetBrains Mono, monospace",
                }}
              >
                <span
                  style={{
                    transform: thinkingCollapsed && !isActive ? "rotate(-90deg)" : "rotate(0)",
                    display: "inline-block",
                    transition: "transform 0.15s",
                  }}
                >
                  ▾
                </span>
                📋 Plan
              </button>
              {(!thinkingCollapsed || isActive) && (
                <div
                  style={{
                    background: "#0d1b2a",
                    border: "1px solid #1f6feb33",
                    borderRadius: 5,
                    padding: "8px 10px",
                    fontSize: 11,
                    color: theme.textMuted,
                    lineHeight: 1.7,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word" as const,
                    marginTop: 4,
                  }}
                >
                  {turn.planText}
                </div>
              )}
            </div>
          )}

          {/* File write progress — shown during framework-mode runs */}
          {isActive && turn.writtenFiles.length > 0 && (
            <div
              style={{
                marginBottom: 8,
                background: "#0d1117",
                border: "1px solid #30363d",
                borderRadius: 5,
                padding: "6px 10px",
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  color: theme.textMuted,
                  marginBottom: 4,
                  textTransform: "uppercase",
                  letterSpacing: 0.6,
                }}
              >
                Writing files ({turn.writtenFiles.length})
              </div>
              {turn.writtenFiles.map((f, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: per-turn file list is append-only — i IS identity
                  key={i}
                  style={{
                    fontSize: 11,
                    color: "#3fb950",
                    fontFamily: "JetBrains Mono, monospace",
                    lineHeight: 1.6,
                  }}
                >
                  ✓ {f}
                </div>
              ))}
            </div>
          )}

          {/* Tool lines */}
          {turn.toolLines.length > 0 && (
            <div style={{ marginBottom: 8, display: "flex", flexDirection: "column", gap: 2 }}>
              {turn.toolLines.map((line, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: per-turn tool log is append-only — i IS identity
                  key={i}
                  style={{
                    fontSize: 11,
                    color: "#e3b341",
                    fontFamily: "JetBrains Mono, monospace",
                  }}
                >
                  {line.slice(0, 120)}
                  {line.length > 120 ? "…" : ""}
                </div>
              ))}
            </div>
          )}

          {/* Thinking section — collapsible, shown while running or when expanded */}
          {thinkingText && (
            <div style={{ marginBottom: displayText ? 8 : 0 }}>
              <button
                type="button"
                onClick={() => setThinkingCollapsed((c) => !c)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  background: "none",
                  border: "none",
                  padding: "2px 0",
                  color: theme.textMuted,
                  fontSize: 10,
                  cursor: "pointer",
                  fontFamily: "JetBrains Mono, monospace",
                }}
              >
                <span
                  style={{
                    transform: thinkingCollapsed ? "rotate(-90deg)" : "rotate(0)",
                    display: "inline-block",
                    transition: "transform 0.15s",
                  }}
                >
                  ▾
                </span>
                {isActive ? "Thinking…" : `Thought (${thinkingText.split(/\s+/).length} words)`}
                {isActive && (
                  <span
                    style={{
                      display: "inline-block",
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: "#bc8cff",
                      animation: "pulse 1s infinite",
                      marginLeft: 2,
                    }}
                  />
                )}
              </button>
              {!thinkingCollapsed && (
                <div
                  style={{
                    background: "#0d1117",
                    border: "1px solid #21262d",
                    borderRadius: 5,
                    padding: "8px 10px",
                    fontSize: 11,
                    color: theme.textMuted,
                    lineHeight: 1.6,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word" as const,
                    maxHeight: 200,
                    overflowY: "auto",
                    marginTop: 4,
                  }}
                >
                  {thinkingText}
                  {isActive && (
                    <span
                      style={{
                        display: "inline-block",
                        width: 6,
                        height: 12,
                        background: "#bc8cff",
                        animation: "blink 1s step-end infinite",
                        verticalAlign: "text-bottom",
                        marginLeft: 2,
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          )}

          {/* Final answer — shown prominently when done */}
          {turn.status === "error" && turn.error ? (
            <div
              style={{
                background: "#1a0a0a",
                border: "1px solid #f8514933",
                borderRadius: 6,
                padding: "10px 12px",
                fontSize: 12,
                color: "#f85149",
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word" as const,
              }}
            >
              <span style={{ fontWeight: 700 }}>Error: </span>
              {turn.error}
            </div>
          ) : displayText ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {hasCards ? (
                // Cards found: render each segment as a tile (card) or plain text.
                //
                // 2026-06-17/18: an earlier heuristic auto-inlined `card:markdown`
                // whenever the turn wrote any files — that was meant to keep the
                // recap visible in framework mode (where WebContainer takes the
                // right pane). Tool-mode `write_file *.md` calls also tripped
                // it, producing a duplicated long markdown block in chat AND
                // the same content in the right Preview. Now we inline only when
                // framework mode AND a real WebContainer URL has arrived; in
                // every other case the markdown stays a compact card → user
                // clicks it to see full content in the right pane.
                parsedAnswer?.segments.map((seg, i) => {
                  if (seg.kind === "card") {
                    const inlineMarkdownRecap =
                      seg.card.type === "markdown" && isFrameworkMode && !!previewUrl;
                    if (inlineMarkdownRecap) {
                      return (
                        <div
                          key={seg.card.id}
                          className="bscode-chat-md"
                          style={{
                            background: "#161b22",
                            border: "1px solid #30363d",
                            borderRadius: 6,
                            padding: "10px 12px",
                            fontSize: 12,
                            color: "#c9d1d9",
                            lineHeight: 1.7,
                            wordBreak: "break-word",
                          }}
                        >
                          <Markdown remarkPlugins={[remarkGfm]}>{seg.card.content}</Markdown>
                        </div>
                      );
                    }
                    const cardTypeLabel: Record<string, string> = {
                      d2: "🔷 D2 Diagram",
                      markdown: "📄 Markdown",
                    };
                    const fallbackLabel = cardTypeLabel[seg.card.type] ?? `📎 ${seg.card.type}`;
                    const lineCount = seg.card.content.split("\n").length;
                    const byteCount = new Blob([seg.card.content]).size;
                    return (
                      <div
                        key={seg.card.id}
                        className="bscode-card-tile"
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          background: "#161b22",
                          border: "1px solid #30363d",
                          borderRadius: 8,
                          padding: "10px 14px",
                          width: "100%",
                          transition: "border-color 0.15s",
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => onPreviewCard(seg.card)}
                          aria-label={`Open ${seg.card.meta ?? fallbackLabel} in preview`}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            background: "transparent",
                            border: "none",
                            padding: 0,
                            cursor: "pointer",
                            textAlign: "left",
                            flex: 1,
                            minWidth: 0,
                          }}
                        >
                          <span style={{ fontSize: 22, flexShrink: 0 }}>
                            {seg.card.type === "d2"
                              ? "🔷"
                              : seg.card.type === "markdown"
                                ? "📄"
                                : "📎"}
                          </span>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div
                              style={{
                                fontSize: 12,
                                fontWeight: 600,
                                color: "#c9d1d9",
                                fontFamily: "inherit",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {seg.card.meta ?? fallbackLabel}
                            </div>
                            <div
                              style={{
                                fontSize: 11,
                                color: theme.textMuted,
                                fontFamily: "JetBrains Mono, monospace",
                              }}
                            >
                              {lineCount} lines · {formatBytes(byteCount)} · {seg.card.type}
                            </div>
                          </div>
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            downloadCard(seg.card);
                          }}
                          title={`Download ${cardDownloadName(seg.card)}`}
                          aria-label={`Download ${cardDownloadName(seg.card)}`}
                          style={{
                            background: "transparent",
                            border: "1px solid #30363d",
                            borderRadius: 4,
                            color: theme.textMuted,
                            fontSize: 12,
                            padding: "4px 8px",
                            cursor: "pointer",
                            fontFamily: "JetBrains Mono, monospace",
                            flexShrink: 0,
                          }}
                        >
                          ⬇
                        </button>
                        <button
                          type="button"
                          onClick={() => onPreviewCard(seg.card)}
                          aria-label="Open in preview"
                          style={{
                            background: "transparent",
                            border: "none",
                            color: "#58a6ff",
                            fontSize: 16,
                            cursor: "pointer",
                            padding: "0 4px",
                            flexShrink: 0,
                          }}
                        >
                          ›
                        </button>
                      </div>
                    );
                  }
                  // Plain text segments (non-empty)
                  const text = seg.content.trim();
                  if (!text) return null;
                  return (
                    <div
                      // biome-ignore lint/suspicious/noArrayIndexKey: text segments per turn are append-only — i IS identity
                      key={`text-${i}`}
                      className="bscode-chat-md"
                      style={{
                        fontSize: 12,
                        color: "#c9d1d9",
                        lineHeight: 1.7,
                        wordBreak: "break-word",
                      }}
                    >
                      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
                    </div>
                  );
                })
              ) : (
                // No cards — render as inline Markdown so headings, lists,
                // bold, tables, code spans all show formatted instead of as
                // raw `**foo**` / `## bar` text. The 2026-06-17 fix to stop
                // auto-upgrading rich Markdown into card:markdown blocks
                // depends on this — chat replies need a real Markdown
                // renderer here, otherwise users see raw syntax.
                <div
                  className="bscode-chat-md"
                  style={{
                    background: "#161b22",
                    border: "1px solid #30363d",
                    borderRadius: 6,
                    padding: "10px 12px",
                    fontSize: 12,
                    color: "#c9d1d9",
                    lineHeight: 1.7,
                    wordBreak: "break-word" as const,
                    maxHeight: 600,
                    overflowY: "auto",
                  }}
                >
                  <Markdown remarkPlugins={[remarkGfm]}>{upgradedText}</Markdown>
                </div>
              )}
            </div>
          ) : isActive && !thinkingText ? (
            <div style={{ color: theme.textMuted, fontSize: 12 }}>
              <span style={{ animation: "pulse 1.2s infinite" }}>Thinking…</span>
            </div>
          ) : null}

          {/* Action buttons */}
          {!isActive && turn.status !== "running" && (
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              {displayText && (
                <button
                  type="button"
                  onClick={async () => {
                    // Copy the raw final answer (Markdown source, NOT the
                    // rendered HTML) — that's what users typically want
                    // when pasting into a doc/editor. Cards' raw fenced
                    // syntax is included; the parser on the receiving end
                    // can render them too.
                    try {
                      await navigator.clipboard.writeText(displayText);
                    } catch {
                      // Clipboard API blocked (insecure context, perm denied).
                      // Fall back to creating a textarea + execCommand.
                      const ta = document.createElement("textarea");
                      ta.value = displayText;
                      ta.style.position = "fixed";
                      ta.style.opacity = "0";
                      document.body.appendChild(ta);
                      ta.select();
                      try {
                        document.execCommand("copy");
                      } catch {
                        // best-effort
                      }
                      document.body.removeChild(ta);
                    }
                  }}
                  title="Copy reply Markdown to clipboard"
                  style={{
                    padding: "4px 10px",
                    borderRadius: 4,
                    border: "1px solid #30363d",
                    background: "transparent",
                    color: theme.textMuted,
                    fontSize: 11,
                    cursor: "pointer",
                    fontFamily: "JetBrains Mono, monospace",
                  }}
                >
                  📋 Copy
                </button>
              )}
              {onFix && (
                <button
                  type="button"
                  onClick={onFix}
                  style={{
                    padding: "4px 10px",
                    borderRadius: 4,
                    border: "1px solid #f8514944",
                    background: "transparent",
                    color: "#f85149",
                    fontSize: 11,
                    cursor: "pointer",
                    fontFamily: "JetBrains Mono, monospace",
                  }}
                >
                  ⚡ Fix
                </button>
              )}
              <button
                type="button"
                onClick={onRetry}
                style={{
                  padding: "4px 10px",
                  borderRadius: 4,
                  border: "1px solid #30363d",
                  background: "transparent",
                  color: theme.textMuted,
                  fontSize: 11,
                  cursor: "pointer",
                  fontFamily: "JetBrains Mono, monospace",
                }}
              >
                ↺ Retry
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

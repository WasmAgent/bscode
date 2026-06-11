"use client";
import type { CSSProperties } from "react";
import type { TokenStats } from "@/hooks/useAgent";
import { theme } from "@/lib/theme";

interface TokenMeterProps {
  stats: TokenStats;
  /** Compact single-line inline mode for embedding in the input bar */
  compact?: boolean;
}

// All colours sourced from the central theme module — see lib/theme.ts for
// rationale and contrast targets. Resist the urge to reintroduce inline hex.

function hitStyle(pct: number): CSSProperties {
  return {
    color: pct > 50 ? theme.statusOk : pct > 20 ? theme.statusWarn : theme.textMuted,
    fontWeight: 600,
  };
}

function fillStyle(pct: number): CSSProperties {
  return {
    height: "100%",
    width: `${pct}%`,
    background: pct > 50 ? theme.statusOk : pct > 20 ? theme.statusWarn : theme.textMuted,
    borderRadius: 2,
    transition: "width 0.3s ease",
  };
}

const barStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 16,
  padding: "6px 16px",
  background: theme.bgPanel,
  borderTop: `1px solid ${theme.borderDefault}`,
  fontSize: 11,
  color: theme.textMuted,
  flexWrap: "wrap",
};
const statStyle: CSSProperties = { display: "flex", gap: 4, alignItems: "center" };
const valStyle: CSSProperties = { color: theme.textPrimary, fontWeight: 600 };
const trackStyle: CSSProperties = {
  width: 60,
  height: 4,
  background: theme.borderDefault,
  borderRadius: 2,
  overflow: "hidden",
};

export function TokenMeter({ stats, compact }: TokenMeterProps) {
  const total = stats.inputTokens + stats.cacheReadTokens;
  const hitRate = total > 0 ? Math.round((stats.cacheReadTokens / total) * 100) : 0;
  const usd = stats.accumulatedUsd ?? 0;

  // Compact inline mode — shows just key stats in one short line.
  if (compact) {
    if (!stats.calls) return null;
    return (
      <span
        style={{
          fontSize: 10,
          color: theme.textMuted,
          display: "flex",
          gap: 8,
          alignItems: "center",
        }}
      >
        <span>
          {stats.calls} call{stats.calls !== 1 ? "s" : ""}
        </span>
        <span style={{ color: theme.textPrimary }}>
          {(stats.inputTokens + stats.outputTokens).toLocaleString()} tok
        </span>
        {hitRate > 0 && (
          <span style={{ color: hitRate > 50 ? theme.statusOk : theme.statusWarn }}>
            {hitRate}% cache
          </span>
        )}
        {usd > 0 && (
          <span
            title={
              stats.lastModelId
                ? `Cost computed with ${stats.lastModelId} pricing`
                : "Cumulative cost across calls"
            }
            style={{ color: theme.accentCost, fontWeight: 600 }}
          >
            ~${usd.toFixed(4)}
          </span>
        )}
      </span>
    );
  }

  return (
    <div style={barStyle}>
      <span style={statStyle}>
        <span>Calls</span>
        <span style={valStyle}>{stats.calls}</span>
      </span>
      <span style={statStyle}>
        <span>In</span>
        <span style={valStyle}>{stats.inputTokens.toLocaleString()}</span>
      </span>
      <span style={statStyle}>
        <span>Out</span>
        <span style={valStyle}>{stats.outputTokens.toLocaleString()}</span>
      </span>
      <span style={statStyle}>
        <span>Cache read</span>
        <span style={valStyle}>{stats.cacheReadTokens.toLocaleString()}</span>
      </span>
      <span style={statStyle}>
        <span>Cache hit</span>
        <span style={hitStyle(hitRate)}>{hitRate}%</span>
        <span style={trackStyle}>
          <span style={fillStyle(hitRate)} />
        </span>
      </span>
      {usd > 0 && (
        <span
          title={
            stats.lastModelId
              ? `Cost computed with ${stats.lastModelId} pricing`
              : "Cumulative cost across calls"
          }
          style={{ ...statStyle, marginLeft: "auto", color: theme.accentCost, fontWeight: 600 }}
        >
          est. ~${usd.toFixed(4)}
        </span>
      )}
    </div>
  );
}

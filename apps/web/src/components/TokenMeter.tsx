"use client";
import type { CSSProperties } from "react";
import type { TokenStats } from "@/hooks/useAgent";

interface TokenMeterProps {
  stats: TokenStats;
  /** Compact single-line inline mode for embedding in the input bar */
  compact?: boolean;
}

function hitStyle(pct: number): CSSProperties {
  return {
    color: pct > 50 ? "#3fb950" : pct > 20 ? "#e3b341" : "#8b949e",
    fontWeight: 600,
  };
}

function fillStyle(pct: number): CSSProperties {
  return {
    height: "100%",
    width: `${pct}%`,
    background: pct > 50 ? "#3fb950" : pct > 20 ? "#e3b341" : "#8b949e",
    borderRadius: 2,
    transition: "width 0.3s ease",
  };
}

const barStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 16,
  padding: "6px 16px",
  background: "#161b22",
  borderTop: "1px solid #30363d",
  fontSize: 11,
  color: "#8b949e",
  flexWrap: "wrap",
};
const statStyle: CSSProperties = { display: "flex", gap: 4, alignItems: "center" };
const valStyle: CSSProperties = { color: "#c9d1d9", fontWeight: 600 };
const trackStyle: CSSProperties = {
  width: 60,
  height: 4,
  background: "#30363d",
  borderRadius: 2,
  overflow: "hidden",
};

export function TokenMeter({ stats, compact }: TokenMeterProps) {
  const total = stats.inputTokens + stats.cacheReadTokens;
  const hitRate = total > 0 ? Math.round((stats.cacheReadTokens / total) * 100) : 0;

  // Compact inline mode — shows just key stats in one short line
  if (compact) {
    if (!stats.calls) return null;
    return (
      <span style={{ fontSize: 10, color: "#484f58", display: "flex", gap: 8, alignItems: "center" }}>
        <span>{stats.calls} call{stats.calls !== 1 ? "s" : ""}</span>
        <span>{(stats.inputTokens + stats.outputTokens).toLocaleString()} tok</span>
        {hitRate > 0 && <span style={{ color: hitRate > 50 ? "#3fb950" : "#e3b341" }}>{hitRate}% cache</span>}
        {stats.inputTokens > 0 && (
          <span>~${((stats.inputTokens * 3 + stats.outputTokens * 15) / 1_000_000).toFixed(4)}</span>
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
      {stats.inputTokens > 0 && (
        <span style={{ ...statStyle, marginLeft: "auto", color: "#8b949e" }}>
          est. ~${((stats.inputTokens * 3 + stats.outputTokens * 15) / 1_000_000).toFixed(4)}
        </span>
      )}
    </div>
  );
}

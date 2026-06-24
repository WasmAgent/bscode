"use client";
import type { AgentConfig } from "@/hooks/useAgent";
import { theme } from "@/lib/theme";

const iconBtn = (color = theme.textMuted): React.CSSProperties => ({
  padding: "4px 8px",
  borderRadius: 3,
  border: "none",
  background: "transparent",
  color,
  fontSize: 11,
  cursor: "pointer",
  whiteSpace: "nowrap" as const,
});

interface GitHubUser {
  login: string;
  avatar_url: string;
}

interface NavBarProps {
  config: AgentConfig;
  onConfigChange: (update: Partial<AgentConfig>) => void;
  importing: boolean;
  isDownloading: boolean;
  pushing: boolean;
  user: GitHubUser | null;
  onImportDir: () => void;
  onImportZip: () => void;
  onDownloadZip: () => void;
  onGitHub: () => void;
  onOpenApiMap: () => void;
  onOpenSettings: () => void;
}

export function NavBar({
  config,
  onConfigChange,
  importing,
  isDownloading,
  pushing,
  user,
  onImportDir,
  onImportZip,
  onDownloadZip,
  onGitHub,
  onOpenApiMap,
  onOpenSettings,
}: NavBarProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
        rowGap: 6,
        padding: "0 16px",
        minHeight: 44,
        background: "#161b22",
        borderBottom: "1px solid #30363d",
        flexShrink: 0,
      }}
    >
      {/* Left: logo + mode */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ color: "#58a6ff", fontWeight: 700, fontSize: 14, letterSpacing: 1 }}>
          BSCode
        </span>
        {/* B-D1 (2026-06): unified funnel CTA. The same string lives in
            README.md so both surfaces send the same signal. The
            source=ui-pill query param distinguishes UI clicks from
            README-link / deploy-button traffic in any aggregation. */}
        <a
          href="https://www.npmjs.com/package/@wasmagent/core?source=bscode-ui-pill"
          target="_blank"
          rel="noopener noreferrer"
          title="bscode is a thin template; the framework lives at @wasmagent/core"
          style={{
            fontSize: 10,
            padding: "2px 7px",
            borderRadius: 999,
            background: "#3fb95022",
            color: "#3fb950",
            textDecoration: "none",
            border: "1px solid #3fb95044",
            whiteSpace: "nowrap",
          }}
        >
          npm add @wasmagent/core →
        </a>
        {/* Direction 6 reverse-funnel entry: "their framework + our kernel".
            Visible alongside the npm pill so a visitor on Vercel AI SDK 6 /
            Cloudflare codemode / Mastra / Anthropic / OpenAI Agents JS
            sees the runtime pitch immediately, not only after exploring
            the CodeAgent demo. */}
        <a
          href="/recipes?source=bscode-ui-recipes-pill"
          title="Drop the WasmAgent kernel into the framework you already use"
          style={{
            fontSize: 10,
            padding: "2px 7px",
            borderRadius: 999,
            background: "#9b9bff22",
            color: "#9b9bff",
            textDecoration: "none",
            border: "1px solid #9b9bff44",
            whiteSpace: "nowrap",
          }}
        >
          their framework + our kernel →
        </a>
        {/* Mode toggle */}
        <div style={{ display: "flex", gap: 3 }}>
          {(["code", "tool"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => onConfigChange({ agentMode: mode, framework: null })}
              style={{
                padding: "3px 8px",
                borderRadius: 3,
                fontSize: 10,
                border: "none",
                cursor: "pointer",
                background:
                  config.agentMode === mode && !config.framework ? "#1f6feb33" : "transparent",
                color:
                  config.agentMode === mode && !config.framework ? "#58a6ff" : theme.textMuted,
                fontWeight: 600,
              }}
            >
              {mode === "code" ? "Code" : "Tool"}
            </button>
          ))}
          {/*
            2026-06-18 (revised same day): the manual 🎯 Goal toggle was
            removed. The classifier (`POST /classify`) now emits a
            `loop: "single" | "verify"` axis; useAgent maps `loop=verify`
            + non-framework mode onto agentMode="goalDirected" without
            user intervention. The agentMode value is still threaded all
            the way through to the worker, so any caller that sets it
            explicitly (the `wasmagent goal` CLI, raw POST /run, future
            advanced UI) keeps working — UI users just don't see a dial.
            The mode badge shown by TurnBlock carries a "🎯" suffix when
            loop=verify so the classifier's choice stays visible.
          */}
          <button
            type="button"
            onClick={() =>
              onConfigChange({
                agentMode: "tool",
                framework: config.framework ? null : "react",
              })
            }
            style={{
              padding: "3px 8px",
              borderRadius: 3,
              fontSize: 10,
              border: "none",
              cursor: "pointer",
              background: config.framework ? "#23863622" : "transparent",
              color: config.framework ? "#3fb950" : theme.textMuted,
              fontWeight: 600,
            }}
          >
            {config.framework ? `⚡ ${config.framework}` : "Framework"}
          </button>
        </div>
        {/* Framework selector */}
        {config.framework && (
          <div style={{ display: "flex", gap: 3 }}>
            {(["react", "vue", "svelte", "vanilla"] as const).map((fw) => (
              <button
                key={fw}
                type="button"
                onClick={() => onConfigChange({ framework: fw })}
                style={{
                  padding: "2px 7px",
                  borderRadius: 3,
                  fontSize: 10,
                  border: "none",
                  cursor: "pointer",
                  background: config.framework === fw ? "#3fb95022" : "transparent",
                  color: config.framework === fw ? "#3fb950" : theme.textMuted,
                }}
              >
                {fw === "react"
                  ? "React"
                  : fw === "vue"
                    ? "Vue"
                    : fw === "svelte"
                      ? "Svelte"
                      : "Vanilla"}
              </button>
            ))}
          </div>
        )}
        {/* Auto-detect badge */}
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            cursor: "pointer",
            fontSize: 10,
            color: theme.textMuted,
          }}
        >
          <input
            type="checkbox"
            checked={config.autoMode ?? true}
            onChange={(e) => onConfigChange({ autoMode: e.target.checked })}
            style={{ accentColor: "#58a6ff", width: 11, height: 11 }}
          />
          Auto-detect
        </label>
      </div>

      {/* Right: model + tools */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <select
          id="bscode-model-select"
          name="model"
          aria-label="Model"
          title="Select language model"
          value={config.modelId}
          onChange={(e) => onConfigChange({ modelId: e.target.value })}
          style={{
            background: "#21262d",
            border: "1px solid #30363d",
            borderRadius: 4,
            color: "#c9d1d9",
            fontSize: 11,
            padding: "3px 6px",
            cursor: "pointer",
          }}
        >
          <option value="claude-sonnet-4-6">Sonnet 4.6</option>
          <option value="claude-opus-4-8">Opus 4.8</option>
          <option value="claude-haiku-4-5-20251001">Haiku 4.5</option>
        </select>
        <button
          type="button"
          onClick={onImportDir}
          disabled={importing}
          style={iconBtn(importing ? theme.textMuted : "#c9d1d9")}
          title="Import from directory"
        >
          ⬆ Dir
        </button>
        <button
          type="button"
          onClick={onImportZip}
          disabled={importing}
          style={iconBtn(importing ? theme.textMuted : "#c9d1d9")}
          title="Import ZIP"
        >
          ⬆ ZIP
        </button>
        <button
          type="button"
          onClick={onDownloadZip}
          disabled={isDownloading}
          style={iconBtn("#58a6ff")}
          title="Download ZIP"
        >
          ⬇ ZIP
        </button>
        <button
          type="button"
          onClick={onGitHub}
          disabled={pushing}
          style={{
            ...iconBtn(user ? "#3fb950" : theme.textMuted),
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
          title={user ? `Push to GitHub (${user.login})` : "Connect GitHub"}
        >
          {user ? (
            // biome-ignore lint/performance/noImgElement: avatar from GitHub CDN — using next/image would require remotePatterns config and adds no perf benefit for a 13×13 px image
            <img
              src={user.avatar_url}
              alt={user.login}
              width={13}
              height={13}
              style={{ borderRadius: "50%" }}
            />
          ) : null}
          {pushing ? "…" : user ? "Push" : "GitHub"}
        </button>
        <button
          type="button"
          onClick={onOpenApiMap}
          style={iconBtn(theme.textMuted)}
          title="What you see ↔ what you can copy (B1, 2026-06)"
        >
          ?
        </button>
        <button
          type="button"
          onClick={onOpenSettings}
          style={iconBtn(theme.textMuted)}
          title="Settings"
        >
          ⚙
        </button>
      </div>
    </div>
  );
}

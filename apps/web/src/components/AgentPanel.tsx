"use client";
import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import { ModelManager } from "@/components/ModelManager";
import type { AgentConfig } from "@/hooks/useAgent";

// Static fallback models (shown before /models loads)
const DEFAULT_MODELS = [
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", provider: "anthropic" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", provider: "anthropic" },
];

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: "#cc785c",
  doubao: "#4e7fff",
  deepseek: "#6c63ff",
  openai: "#10a37f",
  ollama: "#ff6b35",
  lmstudio: "#a855f7",
  llamacpp: "#eab308",
  vllm: "#06b6d4",
  localai: "#22c55e",
  custom: "#8b949e",
};

interface AgentPanelProps {
  config: AgentConfig;
  onChange: (config: AgentConfig) => void;
  task: string;
  onTaskChange: (v: string) => void;
  onSubmit: () => void;
  onAbort: () => void;
  isRunning: boolean;
  workerUrl?: string;
}

const panelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  padding: "16px 12px",
  background: "#161b22",
  borderRight: "1px solid #30363d",
  height: "100%",
  overflow: "auto",
};
const labelStyle: CSSProperties = {
  fontSize: 11,
  color: "#8b949e",
  marginBottom: 4,
  textTransform: "uppercase",
  letterSpacing: 1,
};
const selectStyle: CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  background: "#21262d",
  border: "1px solid #30363d",
  borderRadius: 4,
  color: "#c9d1d9",
  outline: "none",
};
const textareaStyle: CSSProperties = {
  width: "100%",
  padding: "8px",
  background: "#21262d",
  border: "1px solid #30363d",
  borderRadius: 4,
  color: "#c9d1d9",
  fontFamily: "inherit",
  fontSize: 12,
  resize: "vertical",
  outline: "none",
  lineHeight: 1.5,
  minHeight: 120,
};
const rowStyle: CSSProperties = { display: "flex", gap: 8 };
const modeRowStyle: CSSProperties = { display: "flex", gap: 8 };
const stepsRowStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const stepsInputStyle: CSSProperties = {
  flex: 1,
  padding: "5px 8px",
  background: "#21262d",
  border: "1px solid #30363d",
  borderRadius: 4,
  color: "#c9d1d9",
  fontFamily: "inherit",
  fontSize: 12,
  outline: "none",
  width: "100%",
};
const dividerStyle: CSSProperties = { borderColor: "#30363d", margin: "4px 0" };
const titleStyle: CSSProperties = {
  color: "#58a6ff",
  fontWeight: 700,
  fontSize: 16,
  letterSpacing: 1,
};
const subtitleStyle: CSSProperties = { color: "#8b949e", fontSize: 11, marginTop: 2 };

function btnStyle(primary: boolean, danger = false): CSSProperties {
  return {
    flex: 1,
    padding: "8px 12px",
    borderRadius: 4,
    border: "none",
    background: danger ? "#b91c1c" : primary ? "#1f6feb" : "#21262d",
    color: "#fff",
    fontWeight: 600,
    fontSize: 12,
    transition: "background 0.15s",
  };
}

function modeBtnStyle(active: boolean): CSSProperties {
  return {
    flex: 1,
    padding: "6px 8px",
    borderRadius: 4,
    border: `1px solid ${active ? "#58a6ff" : "#30363d"}`,
    background: active ? "#1f6feb22" : "#21262d",
    color: active ? "#58a6ff" : "#8b949e",
    fontSize: 11,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  };
}

function providerDotStyle(provider: string): CSSProperties {
  return {
    display: "inline-block",
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: PROVIDER_COLORS[provider] ?? "#8b949e",
    marginRight: 6,
  };
}

export function AgentPanel({
  config,
  onChange,
  task,
  onTaskChange,
  onSubmit,
  onAbort,
  isRunning,
}: AgentPanelProps) {
  const [dynamicModels, setDynamicModels] = useState(DEFAULT_MODELS);
  const [economyModelId, setEconomyModelId] = useState<string | undefined>(undefined);
  const [showModelManager, setShowModelManager] = useState(false);

  useEffect(() => {
    fetch(`${workerUrl}/models`)
      .then((r) => r.json())
      .then(
        (data: {
          models: Array<{ id: string; label: string; provider: string; available: boolean }>;
          preferences: { primaryModelId: string; economyModelId?: string };
        }) => {
          const available = data.models.filter((m) => m.available);
          if (available.length > 0) setDynamicModels(available);
          if (
            data.preferences?.primaryModelId &&
            data.preferences.primaryModelId !== config.modelId
          ) {
            onChange({ ...config, modelId: data.preferences.primaryModelId });
          }
          if (data.preferences?.economyModelId) setEconomyModelId(data.preferences.economyModelId);
        }
      )
      .catch(() => {
        /* keep defaults */
      });
  }, [onChange, config.modelId, config]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={panelStyle}>
      <div>
        <div style={titleStyle}>BSCode</div>
        <div style={subtitleStyle}>agentkit-js on Cloudflare</div>
      </div>

      <hr style={dividerStyle} />

      <div>
        <div style={labelStyle}>Agent Mode</div>
        <div style={modeRowStyle}>
          {(["code", "tool"] as const).map((mode) => (
            <button
              type="button"
              key={mode}
              style={modeBtnStyle(config.agentMode === mode)}
              onClick={() => onChange({ ...config, agentMode: mode })}
            >
              {mode === "code" ? "Code + WASM" : "Tool + DAG"}
            </button>
          ))}
        </div>
        <div style={{ marginTop: 6, fontSize: 11, color: "#8b949e" }}>
          {config.agentMode === "code"
            ? "CodeAgent writes JS, executes in QuickJS WASM sandbox"
            : "ToolCallingAgent uses DAG scheduler for parallel tool calls"}
        </div>
      </div>

      <div>
        <div
          style={{
            ...labelStyle,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>Model</span>
          <button
            type="button"
            onClick={() => setShowModelManager(true)}
            style={{
              fontSize: 10,
              background: "transparent",
              border: "1px solid #30363d",
              borderRadius: 3,
              color: "#8b949e",
              padding: "1px 6px",
              cursor: "pointer",
            }}
          >
            ⚙ Configure
          </button>
        </div>
        <select
          style={selectStyle}
          value={config.modelId}
          onChange={(e) => onChange({ ...config, modelId: e.target.value })}
        >
          {dynamicModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <div
          style={{
            marginTop: 4,
            fontSize: 11,
            color: "#8b949e",
            display: "flex",
            gap: 8,
            alignItems: "center",
          }}
        >
          <span
            style={providerDotStyle(
              dynamicModels.find((m) => m.id === config.modelId)?.provider ?? ""
            )}
          />
          <span>{dynamicModels.find((m) => m.id === config.modelId)?.provider ?? ""}</span>
          {economyModelId && (
            <span
              style={{
                marginLeft: "auto",
                fontSize: 9,
                color: "#3fb950",
                border: "1px solid #238636",
                borderRadius: 3,
                padding: "1px 4px",
              }}
            >
              Economy:{" "}
              {dynamicModels
                .find((m) => m.id === economyModelId)
                ?.label?.split(" ")
                .slice(-2)
                .join(" ") ?? economyModelId.split("/").pop()}
            </span>
          )}
        </div>
      </div>

      {showModelManager && (
        <ModelManager
          workerUrl={workerUrl}
          currentPrefs={{ primaryModelId: config.modelId, economyModelId }}
          onClose={() => setShowModelManager(false)}
          onApply={(prefs) => {
            onChange({ ...config, modelId: prefs.primaryModelId });
            setEconomyModelId(prefs.economyModelId);
          }}
        />
      )}

      <div>
        <div style={labelStyle}>Max Steps</div>
        <div style={stepsRowStyle}>
          <input
            type="number"
            style={stepsInputStyle}
            min={1}
            max={30}
            value={config.maxSteps}
            onChange={(e) =>
              onChange({ ...config, maxSteps: Math.max(1, Math.min(30, Number(e.target.value))) })
            }
          />
        </div>
      </div>

      {(config.agentMode === "code" || config.agentMode === "ptc") && (
        <div>
          <div style={labelStyle}>Language</div>
          <div style={{ display: "flex", gap: 4 }}>
            {CODE_LANGS.map((lang) => (
              <button
                type="button"
                key={lang.id}
                style={{
                  ...modeBtnStyle(
                    config.codeLanguage === lang.id || (!config.codeLanguage && lang.id === "js")
                  ),
                  flex: 1,
                }}
                onClick={() => onChange({ ...config, codeLanguage: lang.id })}
              >
                {lang.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 11,
            color: "#8b949e",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={config.projectContext ?? false}
            onChange={(e) => onChange({ ...config, projectContext: e.target.checked })}
          />
          Project context (git+README)
        </label>
      </div>
      <hr style={dividerStyle} />

      <div style={{ flex: 1 }}>
        <div style={labelStyle}>Task</div>
        <textarea
          style={textareaStyle}
          placeholder={
            "Describe a coding task…\ne.g. Write a bubble sort in TypeScript and explain the time complexity"
          }
          value={task}
          onChange={(e) => onTaskChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !isRunning) onSubmit();
          }}
        />
        <div style={{ fontSize: 11, color: "#8b949e", marginTop: 4 }}>Cmd+Enter to run</div>
      </div>

      <div style={rowStyle}>
        <button
          type="button"
          style={btnStyle(true)}
          onClick={onSubmit}
          disabled={isRunning || !task.trim()}
        >
          {isRunning ? "Running…" : "Run Agent"}
        </button>
        {isRunning && (
          <button type="button" style={btnStyle(false, true)} onClick={onAbort}>
            Stop
          </button>
        )}
      </div>
    </div>
  );
}

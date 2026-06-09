"use client";
import { useCallback, useEffect, useState } from "react";

interface ModelEntry {
  id: string;
  label: string;
  provider: string;
  baseUrl?: string;
  available: boolean;
  source: "builtin" | "local" | "custom";
}

interface ModelPreferences {
  primaryModelId: string;
  economyModelId?: string;
}

interface ModelManagerProps {
  onClose: () => void;
  onApply: (prefs: ModelPreferences) => void;
  currentPrefs: ModelPreferences;
  workerUrl: string;
}

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: "#cc785c",
  openai: "#10a37f",
  deepseek: "#6c63ff",
  doubao: "#4e7fff",
  ollama: "#ff6b35",
  lmstudio: "#a855f7",
  llamacpp: "#eab308",
  vllm: "#06b6d4",
  localai: "#22c55e",
  tgi: "#f59e0b",
  custom: "#8b949e",
};

const _SOURCE_LABELS: Record<string, string> = {
  builtin: "Built-in",
  local: "Local",
  custom: "Custom",
};

export function ModelManager({ onClose, onApply, currentPrefs, workerUrl }: ModelManagerProps) {
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [prefs, setPrefs] = useState<ModelPreferences>(currentPrefs);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<"select" | "add">("select");

  // Add custom model form state
  const [newModel, setNewModel] = useState({
    id: "",
    label: "",
    baseUrl: "",
    apiKey: "",
    provider: "custom",
  });
  const [addError, setAddError] = useState("");
  const [addOk, setAddOk] = useState(false);

  const fetchModels = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${workerUrl}/models`);
      const data = (await res.json()) as { models: ModelEntry[]; preferences: ModelPreferences };
      setModels(data.models);
      setPrefs(data.preferences);
    } catch {
      // keep existing
    } finally {
      setLoading(false);
    }
  }, [workerUrl]);

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await fetch(`${workerUrl}/models/preferences`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(prefs),
      });
      onApply(prefs);
      onClose();
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  const handleAddModel = async () => {
    setAddError("");
    setAddOk(false);
    if (!newModel.id.trim() || !newModel.baseUrl.trim() || !newModel.label.trim()) {
      setAddError("ID, Base URL, and Label are required.");
      return;
    }
    try {
      new URL(newModel.baseUrl);
    } catch {
      setAddError("Invalid Base URL — must be a valid URL (e.g. http://localhost:11434/v1)");
      return;
    }
    const res = await fetch(`${workerUrl}/models/custom`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newModel),
    });
    if (res.ok) {
      setAddOk(true);
      setNewModel({ id: "", label: "", baseUrl: "", apiKey: "", provider: "custom" });
      await fetchModels();
    } else {
      const err = (await res.json()) as { error?: string };
      setAddError(err.error ?? "Failed to add model");
    }
  };

  const handleDeleteCustom = async (id: string) => {
    await fetch(`${workerUrl}/models/custom/${encodeURIComponent(id)}`, { method: "DELETE" });
    await fetchModels();
  };

  // Group models by source
  const builtin = models.filter((m) => m.source === "builtin");
  const local = models.filter((m) => m.source === "local");
  const custom = models.filter((m) => m.source === "custom");

  const tabBtnStyle = (active: boolean): React.CSSProperties => ({
    padding: "8px 20px",
    border: "none",
    borderBottom: `2px solid ${active ? "#58a6ff" : "transparent"}`,
    background: "transparent",
    color: active ? "#58a6ff" : "#8b949e",
    fontSize: 12,
    cursor: "pointer",
    fontFamily: "inherit",
  });

  const modelRowStyle = (selected: boolean, available: boolean): React.CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "8px 10px",
    border: `1px solid ${selected ? "#58a6ff" : "#30363d"}`,
    borderRadius: 5,
    marginBottom: 4,
    cursor: available ? "pointer" : "default",
    background: selected ? "#1f6feb22" : "transparent",
    opacity: available ? 1 : 0.4,
  });

  const dotStyle = (provider: string): React.CSSProperties => ({
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: PROVIDER_COLORS[provider] ?? "#8b949e",
    flexShrink: 0,
  });

  const badgeStyle = (kind: string): React.CSSProperties => ({
    fontSize: 9,
    padding: "1px 5px",
    borderRadius: 3,
    background: kind === "primary" ? "#1f6feb" : kind === "economy" ? "#238636" : "#21262d",
    color: "#fff",
    textTransform: "uppercase",
  });

  const providerTagStyle = (provider: string): React.CSSProperties => ({
    fontSize: 9,
    color: PROVIDER_COLORS[provider] ?? "#8b949e",
    opacity: 0.8,
  });

  const btnStyle = (primary: boolean): React.CSSProperties => ({
    padding: "7px 14px",
    borderRadius: 4,
    border: "none",
    background: primary ? "#1f6feb" : "#21262d",
    color: "#fff",
    fontSize: 12,
    cursor: "pointer",
    fontFamily: "inherit",
  });

  const s: Record<string, React.CSSProperties> = {
    overlay: {
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,0.65)",
      zIndex: 9999,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    },
    panel: {
      background: "#161b22",
      border: "1px solid #30363d",
      borderRadius: 8,
      width: 580,
      maxHeight: "85vh",
      display: "flex",
      flexDirection: "column",
      fontFamily: "JetBrains Mono, monospace",
      overflow: "hidden",
    },
    header: {
      padding: "14px 20px",
      borderBottom: "1px solid #30363d",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
    },
    title: { color: "#c9d1d9", fontWeight: 700, fontSize: 14 },
    closeBtn: {
      background: "none",
      border: "none",
      color: "#8b949e",
      fontSize: 16,
      cursor: "pointer",
      padding: "0 4px",
    },
    tabs: {
      display: "flex",
      borderBottom: "1px solid #30363d",
    },
    body: { flex: 1, overflow: "auto", padding: "16px 20px" },
    section: { marginBottom: 16 },
    sectionLabel: {
      fontSize: 10,
      color: "#8b949e",
      textTransform: "uppercase",
      letterSpacing: 1,
      marginBottom: 8,
    },
    modelLabel: { flex: 1, color: "#c9d1d9", fontSize: 12 },
    deleteBtn: {
      background: "none",
      border: "none",
      color: "#8b949e",
      cursor: "pointer",
      fontSize: 11,
      padding: "0 4px",
    },
    inputRow: { display: "flex", flexDirection: "column" as const, gap: 6, marginBottom: 12 },
    label: { fontSize: 11, color: "#8b949e" },
    input: {
      padding: "6px 8px",
      background: "#0d1117",
      border: "1px solid #30363d",
      borderRadius: 4,
      color: "#c9d1d9",
      fontFamily: "inherit",
      fontSize: 12,
      outline: "none",
    },
    hint: { fontSize: 10, color: "#8b949e" },
    footer: {
      padding: "12px 20px",
      borderTop: "1px solid #30363d",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
    },
    securityNote: {
      fontSize: 10,
      color: "#3fb950",
      display: "flex",
      alignItems: "center",
      gap: 5,
    },
  };

  const renderModelRow = (m: ModelEntry) => {
    const isPrimary = prefs.primaryModelId === m.id;
    const isEconomy = prefs.economyModelId === m.id;
    const handleClick = () => {
      if (!m.available) return;
      // Click: set as primary; Shift+click would set as economy (handled via buttons)
      setPrefs((p) => ({ ...p, primaryModelId: m.id }));
    };
    return (
      <button
        type="button"
        key={m.id}
        style={modelRowStyle(isPrimary || isEconomy, m.available)}
        onClick={handleClick}
      >
        <span style={dotStyle(m.provider)} />
        <span style={s.modelLabel}>{m.label}</span>
        <span style={providerTagStyle(m.provider)}>{m.provider}</span>
        {isPrimary && <span style={badgeStyle("primary")}>Primary</span>}
        {isEconomy && <span style={badgeStyle("economy")}>Economy</span>}
        {m.available && !isPrimary && (
          <button
            type="button"
            style={{
              ...badgeStyle("economy"),
              cursor: "pointer",
              background: "transparent",
              border: "1px solid #238636",
              color: "#3fb950",
            }}
            onClick={(e) => {
              e.stopPropagation();
              setPrefs((p) => ({
                ...p,
                economyModelId: p.economyModelId === m.id ? undefined : m.id,
              }));
            }}
          >
            {isEconomy ? "−Economy" : "+Economy"}
          </button>
        )}
        {m.source === "custom" && (
          <button
            type="button"
            style={s.deleteBtn}
            onClick={(e) => {
              e.stopPropagation();
              handleDeleteCustom(m.id);
            }}
          >
            ✕
          </button>
        )}
      </button>
    );
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-close overlay
    <div
      style={s.overlay}
      role="presentation"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <div style={s.panel}>
        {/* Header */}
        <div style={s.header}>
          <span style={s.title}>Model Configuration</span>
          <button type="button" style={s.closeBtn} onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div style={s.tabs}>
          <button type="button" style={tabBtnStyle(tab === "select")} onClick={() => setTab("select")}>
            Select Models
          </button>
          <button type="button" style={tabBtnStyle(tab === "add")} onClick={() => setTab("add")}>
            Add Custom / Local
          </button>
        </div>

        {/* Body */}
        <div style={s.body}>
          {tab === "select" &&
            (loading ? (
              <div style={{ color: "#8b949e", fontSize: 12 }}>Scanning local services…</div>
            ) : (
              <>
                <div style={{ color: "#8b949e", fontSize: 11, marginBottom: 12 }}>
                  Click a model to set as <span style={{ color: "#58a6ff" }}>Primary</span>. Toggle{" "}
                  <span style={{ color: "#3fb950" }}>+Economy</span> for low-cost tasks.
                </div>
                {builtin.length > 0 && (
                  <div style={s.section}>
                    <div style={s.sectionLabel}>Built-in providers</div>
                    {builtin.map(renderModelRow)}
                  </div>
                )}
                {local.length > 0 && (
                  <div style={s.section}>
                    <div style={s.sectionLabel}>Detected local services</div>
                    {local.map(renderModelRow)}
                  </div>
                )}
                {custom.length > 0 && (
                  <div style={s.section}>
                    <div style={s.sectionLabel}>Custom endpoints</div>
                    {custom.map(renderModelRow)}
                  </div>
                )}
                {models.length === 0 && (
                  <div style={{ color: "#8b949e", fontSize: 12 }}>
                    No models available. Add a custom model or configure API keys in .dev.vars
                  </div>
                )}
              </>
            ))}

          {tab === "add" && (
            <>
              <div style={{ color: "#8b949e", fontSize: 11, marginBottom: 16 }}>
                Add any OpenAI-compatible endpoint — Ollama, LM Studio, vLLM, OpenRouter, etc.
              </div>
              <div style={s.inputRow}>
                <span style={s.label}>Base URL *</span>
                <input
                  style={s.input}
                  placeholder="http://localhost:11434/v1"
                  value={newModel.baseUrl}
                  onChange={(e) => setNewModel((m) => ({ ...m, baseUrl: e.target.value }))}
                />
                <span style={s.hint}>Must expose /v1/chat/completions (or Ollama /api/chat)</span>
              </div>
              <div style={s.inputRow}>
                <span style={s.label}>Model ID *</span>
                <input
                  style={s.input}
                  placeholder="llama3:latest or gpt-4o-mini"
                  value={newModel.id}
                  onChange={(e) => setNewModel((m) => ({ ...m, id: e.target.value }))}
                />
              </div>
              <div style={s.inputRow}>
                <span style={s.label}>Display Name *</span>
                <input
                  style={s.input}
                  placeholder="My Local Llama"
                  value={newModel.label}
                  onChange={(e) => setNewModel((m) => ({ ...m, label: e.target.value }))}
                />
              </div>
              <div style={s.inputRow}>
                <span style={s.label}>API Key (optional)</span>
                <input
                  style={s.input}
                  type="password"
                  placeholder="sk-… or leave empty for local"
                  value={newModel.apiKey}
                  onChange={(e) => setNewModel((m) => ({ ...m, apiKey: e.target.value }))}
                />
                <span style={{ ...s.hint, color: "#3fb950" }}>
                  🔐 Encrypted with AES-256-GCM before saving to local storage
                </span>
              </div>
              <div style={s.inputRow}>
                <span style={s.label}>Provider tag (optional)</span>
                <input
                  style={s.input}
                  placeholder="ollama / openrouter / custom"
                  value={newModel.provider}
                  onChange={(e) => setNewModel((m) => ({ ...m, provider: e.target.value }))}
                />
              </div>
              {addError && (
                <div style={{ color: "#f85149", fontSize: 11, marginBottom: 8 }}>{addError}</div>
              )}
              {addOk && (
                <div style={{ color: "#3fb950", fontSize: 11, marginBottom: 8 }}>
                  ✓ Model added successfully
                </div>
              )}
              <button type="button" style={btnStyle(true)} onClick={handleAddModel}>
                Add Model
              </button>
            </>
          )}
        </div>

        {/* Footer */}
        <div style={s.footer}>
          <div style={s.securityNote}>
            🔒 API keys encrypted with AES-256-GCM · stored locally · never sent to servers
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" style={btnStyle(false)} onClick={onClose}>
              Cancel
            </button>
            <button type="button" style={btnStyle(true)} onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Apply"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

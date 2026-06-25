"use client";
import { useEffect, useState } from "react";
import { theme } from "@/lib/theme";
import { refreshWorkerUrl } from "@/lib/workerUrl";

const LS_WORKER_URL = "bscode:workerUrl";
const LS_MODEL_PREF = "bscode:modelPreference";
const LS_DATA_MODE = "bscode:dataMode";
const LS_DATA_RETENTION = "bscode:dataRetentionDays";

export type DataCollectionMode = "demo" | "evidence" | "training";

export interface SettingsDrawerProps {
  onClose: () => void;
}

export function SettingsDrawer({ onClose }: SettingsDrawerProps) {
  const [workerUrl, setWorkerUrl] = useState("");
  const [modelPref, setModelPref] = useState("");
  const [savedFlash, setSavedFlash] = useState(false);
  const [dataMode, setDataMode] = useState<DataCollectionMode>("demo");
  const [retentionDays, setRetentionDays] = useState("90");
  const [deleteFlash, setDeleteFlash] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);

  useEffect(() => {
    setWorkerUrl(localStorage.getItem(LS_WORKER_URL) ?? "http://localhost:8788");
    setModelPref(localStorage.getItem(LS_MODEL_PREF) ?? "claude-sonnet-4-6");
    setDataMode((localStorage.getItem(LS_DATA_MODE) as DataCollectionMode | null) ?? "demo");
    setRetentionDays(localStorage.getItem(LS_DATA_RETENTION) ?? "90");
  }, []);

  const onSave = () => {
    localStorage.setItem(LS_WORKER_URL, workerUrl.trim() || "http://localhost:8788");
    localStorage.setItem(LS_MODEL_PREF, modelPref.trim() || "claude-sonnet-4-6");
    localStorage.setItem(LS_DATA_MODE, dataMode);
    localStorage.setItem(LS_DATA_RETENTION, retentionDays);
    refreshWorkerUrl();
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1200);
  };

  const onDeleteSessionData = async () => {
    try {
      const workerBase = localStorage.getItem(LS_WORKER_URL) ?? "http://localhost:8788";
      await fetch(`${workerBase}/rollouts/export`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });
    } catch {
      // best-effort
    }
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("bscode:session:")) localStorage.removeItem(key);
    }
    setDeleteFlash(true);
    setTimeout(() => setDeleteFlash(false), 1800);
  };

  return (
    <>
      <button
        type="button"
        aria-label="Close settings"
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.55)",
          border: "none",
          cursor: "default",
          zIndex: 999,
        }}
      />
      <div
        role="dialog"
        aria-label="Settings"
        style={{
          position: "fixed",
          top: 60,
          right: 12,
          width: 380,
          maxHeight: "calc(100vh - 80px)",
          background: "#161b22",
          border: "1px solid #30363d",
          borderRadius: 8,
          padding: 16,
          zIndex: 1000,
          color: "#c9d1d9",
          fontFamily: "JetBrains Mono, monospace",
          fontSize: 12,
          boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
          overflow: "auto",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 16,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 14, color: "#e6edf3" }}>Settings</h2>
          <button
            type="button"
            onClick={onClose}
            style={{ background: "none", border: "none", color: theme.textMuted, cursor: "pointer", fontSize: 16 }}
            title="Close"
          >
            ✕
          </button>
        </div>

        <label style={fieldLabel}>
          Worker URL
          <input
            id="bscode-settings-worker-url"
            name="workerUrl"
            type="url"
            value={workerUrl}
            onChange={(e) => setWorkerUrl(e.target.value)}
            placeholder="http://localhost:8788"
            style={fieldInput}
          />
          <span style={hint}>Where the bscode worker is reachable. Reload to apply.</span>
        </label>

        <label style={fieldLabel}>
          Default model
          <select
            id="bscode-settings-default-model"
            name="defaultModel"
            value={modelPref}
            onChange={(e) => setModelPref(e.target.value)}
            style={fieldInput}
          >
            <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
            <option value="claude-opus-4-8">claude-opus-4-8</option>
            <option value="claude-haiku-4-5-20251001">claude-haiku-4-5</option>
          </select>
          <span style={hint}>Initial selection in the model dropdown.</span>
        </label>

        {/* ── Data Collection Mode ─────────────────────────────────────── */}
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid #30363d" }}>
          <div style={{ fontSize: 11, color: theme.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
            Data Collection Mode
          </div>

          {(["demo", "evidence", "training"] as DataCollectionMode[]).map((mode) => (
            <label
              key={mode}
              style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 8, cursor: "pointer" }}
            >
              <input
                type="radio"
                name="dataMode"
                value={mode}
                checked={dataMode === mode}
                onChange={() => {
                  setDataMode(mode);
                  if (mode !== "training") setConsentChecked(false);
                }}
                style={{ marginTop: 2, cursor: "pointer" }}
              />
              <div>
                <span style={{ color: "#e6edf3", fontWeight: 600 }}>
                  {mode === "demo" ? "Demo" : mode === "evidence" ? "Evidence" : "Training Data"}
                </span>{" "}
                <span style={{ color: theme.textDim }}>
                  {mode === "demo" && "— no persistence, showcase only"}
                  {mode === "evidence" && "— saves build results and job metadata for audit"}
                  {mode === "training" && "— exports sanitised rollout JSONL for training (requires consent)"}
                </span>
              </div>
            </label>
          ))}

          {dataMode === "training" && (
            <label
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                marginTop: 8,
                marginBottom: 8,
                cursor: "pointer",
                padding: "8px 10px",
                background: "#0d1117",
                borderRadius: 4,
                border: "1px solid #30363d",
              }}
            >
              <input
                type="checkbox"
                checked={consentChecked}
                onChange={(e) => setConsentChecked(e.target.checked)}
                style={{ marginTop: 2, cursor: "pointer" }}
              />
              <div style={{ fontSize: 11, color: "#c9d1d9", lineHeight: 1.5 }}>
                I consent to session trajectories being exported as training data.
                Data will be PII-redacted before export. I can delete my data at
                any time using the button below.
              </div>
            </label>
          )}

          {dataMode !== "demo" && (
            <label style={{ ...fieldLabel, marginTop: 8 }}>
              Data retention (days)
              <input
                type="number"
                min={1}
                max={3650}
                value={retentionDays}
                onChange={(e) => setRetentionDays(e.target.value)}
                style={{ ...fieldInput, width: 80 }}
              />
              <span style={hint}>Session data older than this is eligible for deletion.</span>
            </label>
          )}
        </div>

        <div style={{ marginTop: 16, display: "flex", gap: 8, alignItems: "center" }}>
          <button
            type="button"
            onClick={onSave}
            disabled={dataMode === "training" && !consentChecked}
            style={{
              ...primaryBtn,
              opacity: dataMode === "training" && !consentChecked ? 0.45 : 1,
              cursor: dataMode === "training" && !consentChecked ? "not-allowed" : "pointer",
            }}
            title={dataMode === "training" && !consentChecked ? "Consent required" : undefined}
          >
            Save
          </button>
          {savedFlash && <span style={{ color: "#3fb950" }}>Saved ✓</span>}
        </div>

        {dataMode !== "demo" && (
          <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
            <button
              type="button"
              onClick={onDeleteSessionData}
              style={dangerBtn}
              title="Delete all session trajectories stored by the worker"
            >
              Delete my session data
            </button>
            {deleteFlash && <span style={{ color: "#f85149" }}>Deleted ✓</span>}
          </div>
        )}

        <div
          style={{
            marginTop: 18,
            paddingTop: 12,
            borderTop: "1px solid #30363d",
            color: theme.textMuted,
            lineHeight: 1.6,
          }}
        >
          <strong style={{ color: "#c9d1d9" }}>Note:</strong> API keys are configured server-side
          via Wrangler secrets (<code style={code}>.dev.vars</code> for local dev,{" "}
          <code style={code}>wrangler secret put</code> for prod). They are intentionally not
          exposed in the browser.
        </div>
      </div>
    </>
  );
}

const fieldLabel: React.CSSProperties = {
  display: "block",
  marginBottom: 12,
  fontSize: 11,
  color: theme.textMuted,
  textTransform: "uppercase",
  letterSpacing: 0.5,
};
const fieldInput: React.CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: 4,
  padding: "6px 8px",
  background: "#0d1117",
  color: "#c9d1d9",
  border: "1px solid #30363d",
  borderRadius: 4,
  fontFamily: "inherit",
  fontSize: 12,
  boxSizing: "border-box",
};
const hint: React.CSSProperties = {
  display: "block",
  marginTop: 4,
  fontSize: 10,
  color: theme.textDim,
  textTransform: "none",
  letterSpacing: 0,
};
const primaryBtn: React.CSSProperties = {
  background: "#238636",
  color: "#fff",
  border: "none",
  borderRadius: 4,
  padding: "6px 14px",
  fontSize: 12,
  fontFamily: "inherit",
  cursor: "pointer",
};
const dangerBtn: React.CSSProperties = {
  background: "transparent",
  color: "#f85149",
  border: "1px solid #f85149",
  borderRadius: 4,
  padding: "5px 12px",
  fontSize: 11,
  fontFamily: "inherit",
  cursor: "pointer",
};
const code: React.CSSProperties = {
  background: "#0d1117",
  padding: "1px 4px",
  borderRadius: 3,
  fontSize: 11,
};

"use client";
import { useEffect, useState } from "react";
import { theme } from "@/lib/theme";
import { refreshWorkerUrl } from "@/lib/workerUrl";

/**
 * Minimal settings drawer.
 *
 * Surfaces the worker URL + model preference for a quick override
 * without round-tripping through env vars. Persists to localStorage so
 * a refresh keeps the choice. The settings here are advisory — a
 * production deployment should bind worker URL via `NEXT_PUBLIC_WORKER_URL`
 * at build time and ignore client overrides.
 */

const LS_WORKER_URL = "bscode:workerUrl";
const LS_MODEL_PREF = "bscode:modelPreference";

export interface SettingsDrawerProps {
  onClose: () => void;
}

export function SettingsDrawer({ onClose }: SettingsDrawerProps) {
  const [workerUrl, setWorkerUrl] = useState("");
  const [modelPref, setModelPref] = useState("");
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    setWorkerUrl(localStorage.getItem(LS_WORKER_URL) ?? "http://localhost:8788");
    setModelPref(localStorage.getItem(LS_MODEL_PREF) ?? "claude-sonnet-4-6");
  }, []);

  const onSave = () => {
    localStorage.setItem(LS_WORKER_URL, workerUrl.trim() || "http://localhost:8788");
    localStorage.setItem(LS_MODEL_PREF, modelPref.trim() || "claude-sonnet-4-6");
    // Re-read so subsequent fetches in the same session see the new URL.
    // Existing component closures still hold the old value until reload —
    // hence the "Reload to apply" hint stays accurate for those.
    refreshWorkerUrl();
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1200);
  };

  return (
    <>
      {/* Click-out overlay */}
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
            style={{
              background: "none",
              border: "none",
              color: theme.textMuted,
              cursor: "pointer",
              fontSize: 16,
            }}
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

        <div style={{ marginTop: 16, display: "flex", gap: 8, alignItems: "center" }}>
          <button type="button" onClick={onSave} style={primaryBtn}>
            Save
          </button>
          {savedFlash && <span style={{ color: "#3fb950" }}>Saved ✓</span>}
        </div>

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
const code: React.CSSProperties = {
  background: "#0d1117",
  padding: "1px 4px",
  borderRadius: 3,
  fontSize: 11,
};

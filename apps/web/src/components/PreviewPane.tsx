"use client";
import type { AgentMessage } from "@wasmagent/react";
import type { CardBlock } from "@wasmagent/ui-cards";
import { type PreviewContent, Terminal } from "@/components/Terminal";
import { theme } from "@/lib/theme";

type PreviewView = "messages" | "events" | "preview";
type WcStatus = "idle" | "booting" | "installing" | "starting" | "ready" | "error";

interface AgentEventMinimal {
  event: string;
  data: Record<string, unknown>;
}

interface PreviewPaneProps {
  messages: AgentMessage[];
  rawEvents: AgentEventMinimal[];
  isRunning: boolean;
  previewView: PreviewView;
  onViewChange: (view: PreviewView) => void;
  preview: PreviewContent | undefined;
  selectedCard: CardBlock | null;
  wcLines: string[];
  wcStatus: WcStatus | null;
  previewUrl: string | null | undefined;
  streamingArtifacts: Map<string, { path?: string; content: string; done: boolean }> | undefined;
  onClear: () => void;
}

export function PreviewPane({
  messages,
  rawEvents,
  isRunning,
  previewView,
  onViewChange,
  preview,
  selectedCard,
  wcLines,
  wcStatus,
  previewUrl,
  streamingArtifacts,
  onClear,
}: PreviewPaneProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Preview header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 12px",
          height: 36,
          background: "#161b22",
          borderBottom: "1px solid #30363d",
          flexShrink: 0,
          fontSize: 11,
          color: theme.textMuted,
        }}
      >
        <span style={{ textTransform: "uppercase", letterSpacing: 0.8 }}>
          Preview
          {!isRunning && wcStatus === "installing" && (
            <span
              style={{
                marginLeft: 8,
                color: "#e3b341",
                animation: "pulse 1.2s ease-in-out infinite",
              }}
            >
              ● installing
            </span>
          )}
          {!isRunning && wcStatus === "starting" && (
            <span
              style={{
                marginLeft: 8,
                color: "#e3b341",
                animation: "pulse 1.2s ease-in-out infinite",
              }}
            >
              ● starting
            </span>
          )}
          {!isRunning && wcStatus === "ready" && previewUrl && (
            <span style={{ marginLeft: 8, color: "#3fb950" }}>● live</span>
          )}
        </span>
        <div style={{ display: "flex", gap: 4 }}>
          {(["preview", "messages", "events"] as const).map((v) => {
            const hasPreview = !!(
              preview?.html ||
              preview?.url ||
              preview?.card ||
              (preview?.cards?.length ?? 0) > 0 ||
              selectedCard ||
              (preview?.logs?.length ?? 0) > 0 ||
              preview?.output
            );
            return (
              <button
                key={v}
                type="button"
                onClick={() => onViewChange(v)}
                style={{
                  padding: "3px 8px",
                  borderRadius: 3,
                  border: "none",
                  background: previewView === v ? "#1f6feb33" : "transparent",
                  color:
                    previewView === v
                      ? "#58a6ff"
                      : v === "preview" && hasPreview && previewView !== "preview"
                        ? "#e3b341"
                        : theme.textMuted,
                  fontSize: 10,
                  cursor: "pointer",
                  fontWeight: previewView === v ? 600 : 400,
                }}
              >
                {v.charAt(0).toUpperCase() + v.slice(1)}
                {v === "preview" && hasPreview && previewView !== "preview" ? " ●" : ""}
              </button>
            );
          })}
          <button
            type="button"
            onClick={onClear}
            style={{
              padding: "3px 8px",
              borderRadius: 3,
              border: "none",
              background: "transparent",
              color: "#f85149",
              fontSize: 10,
              cursor: "pointer",
            }}
          >
            Clear
          </button>
        </div>
      </div>
      <div style={{ flex: 1, overflow: "hidden" }}>
        <Terminal
          messages={messages}
          rawEvents={rawEvents}
          isRunning={isRunning}
          viewMode={previewView}
          preview={selectedCard ? { ...preview, card: selectedCard } : preview}
          wcLines={wcLines}
          wcStatus={wcStatus ?? undefined}
          streamingArtifacts={streamingArtifacts}
        />
      </div>
    </div>
  );
}

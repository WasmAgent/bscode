"use client";

interface ErrorBannerProps {
  error: string;
  onFix: () => void;
}

export function ErrorBanner({ error, onFix }: ErrorBannerProps) {
  return (
    <div
      style={{
        marginBottom: 10,
        background: "#1a0a0a",
        border: "1px solid #f8514933",
        borderRadius: 6,
        padding: "8px 12px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
      }}
    >
      <span
        style={{
          fontSize: 11,
          color: "#f85149",
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        ✗ {error.slice(0, 120)}
        {error.length > 120 ? "…" : ""}
      </span>
      <button
        type="button"
        onClick={onFix}
        style={{
          flexShrink: 0,
          padding: "4px 12px",
          borderRadius: 4,
          border: "none",
          background: "#f85149",
          color: "#fff",
          fontSize: 11,
          fontWeight: 700,
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        ⚡ Fix Error
      </button>
    </div>
  );
}

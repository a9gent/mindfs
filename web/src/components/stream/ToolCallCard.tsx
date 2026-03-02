import React, { useEffect, useState } from "react";
import type { ToolCallLocation } from "../../services/session";

type ToolCallCardProps = {
  kind?: string;
  title?: string;
  callId: string;
  status: string;
  result?: string;
  locations?: ToolCallLocation[];
  defaultExpanded?: boolean;
};

const toolIcons: Record<string, string> = {
  read: "📖",
  edit: "📝",
  delete: "🗑️",
  move: "📦",
  search: "🔎",
  execute: "⌨️",
  think: "💭",
  fetch: "🌐",
  switch_mode: "🔁",
  other: "🔧",
};

const statusColors: Record<string, string> = {
  running: "#f59e0b",
  in_progress: "#f59e0b",
  complete: "#22c55e",
  success: "#22c55e",
  failed: "#ef4444",
  error: "#ef4444",
};

export function ToolCallCard({
  kind,
  title,
  callId: _callId,
  status,
  result,
  locations,
  defaultExpanded = false,
}: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const labelKind = (kind || "").trim();
  const labelTitle = (title || "").trim();
  const normalizedKind = labelKind.toLowerCase();
  const icon = toolIcons[normalizedKind] || toolIcons.other;
  const label = [labelKind, labelTitle].filter(Boolean).join(" ").trim() || labelKind || labelTitle || "tool";
  const normalizedStatus = (status || "").toLowerCase();
  const isRunning = normalizedStatus === "running" || normalizedStatus === "in_progress";
  const isComplete = normalizedStatus === "complete" || normalizedStatus === "success";
  const isFailed = normalizedStatus === "failed" || normalizedStatus === "error";
  useEffect(() => {
    if (!isRunning) {
      setExpanded(false);
    }
  }, [isRunning]);
  
  const statusColor = statusColors[normalizedStatus] || "#9ca3af";

  return (
    <div
      style={{
        width: "100%",
        minWidth: 0,
        borderRadius: "8px",
        border: "1px solid var(--border-color)",
        background: "var(--content-bg)",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-start",
          padding: "8px 10px",
          background: "none",
          border: "none",
          cursor: "pointer",
          fontSize: "12px",
          gap: "8px",
          minWidth: 0,
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0, flex: 1 }}>
          <span>{icon}</span>
          <span style={{ fontWeight: 500, color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {label}
          </span>
        </span>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: "4px",
            flexShrink: 0,
            whiteSpace: "nowrap",
          }}
        >
          {isRunning && (
            <span
              style={{
                width: "6px",
                height: "6px",
                borderRadius: "50%",
                background: "#f59e0b",
                animation: "pulse 1s infinite",
              }}
            />
          )}
          {isFailed && (
            <span style={{ color: statusColor, fontSize: "12px", lineHeight: 1 }}>
              ✕
            </span>
          )}
        </span>
        <span
          style={{
            flexShrink: 0,
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 0.2s",
            color: "var(--text-secondary)",
            display: "inline-flex",
            alignItems: "center",
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>
      </button>

      {expanded && ((locations && locations.length > 0) || result) && (
        <div
          style={{
            padding: "0 10px 10px",
            borderTop: "1px solid var(--border-color)",
          }}
        >
          {locations && locations.length > 0 && (
            <div
              style={{
                marginTop: "8px",
                fontSize: "11px",
                color: "var(--text-secondary)",
                display: "flex",
                flexDirection: "column",
                gap: "2px",
                minWidth: 0,
              }}
            >
              {locations.slice(0, 3).map((loc, idx) => (
                <div
                  key={`${loc.path}-${loc.line ?? 0}-${idx}`}
                  style={{ wordBreak: "break-all", whiteSpace: "normal" }}
                >
                  {loc.path}
                  {typeof loc.line === "number" ? `:${loc.line}` : ""}
                </div>
              ))}
              {locations.length > 3 && <div>... +{locations.length - 3} 处</div>}
            </div>
          )}
          {result && (
          <div
            style={{
              marginTop: "8px",
              padding: "8px",
              borderRadius: "6px",
              background: "rgba(0,0,0,0.02)",
              fontSize: "11px",
              fontFamily: "monospace",
              lineHeight: 1.4,
              color: "var(--text-secondary)",
              whiteSpace: "pre",
              maxHeight: "150px",
              overflowX: "auto",
              overflowY: "auto",
            }}
          >
            {result}
          </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  );
}

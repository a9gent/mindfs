import React, { useState } from "react";

type ToolCallCardProps = {
  tool: string;
  callId: string;
  status: string;
  result?: string;
  defaultExpanded?: boolean;
};

const toolIcons: Record<string, string> = {
  Bash: "⌨️",
  Read: "📖",
  Write: "✏️",
  Edit: "📝",
  Glob: "🔍",
  Grep: "🔎",
  Task: "📋",
  WebFetch: "🌐",
  WebSearch: "🔍",
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
  tool,
  callId,
  status,
  result,
  defaultExpanded = false,
}: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const icon = toolIcons[tool] || "🔧";
  const normalizedStatus = (status || "").toLowerCase();
  const isRunning = normalizedStatus === "running" || normalizedStatus === "in_progress";
  const isComplete = normalizedStatus === "complete" || normalizedStatus === "success";
  const isFailed = normalizedStatus === "failed" || normalizedStatus === "error";
  
  const statusColor = statusColors[normalizedStatus] || "#9ca3af";

  return (
    <div
      style={{
        borderRadius: "8px",
        border: "1px solid var(--border-color)",
        background: "#fff",
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
          gap: "8px",
          padding: "8px 10px",
          background: "none",
          border: "none",
          cursor: "pointer",
          fontSize: "12px",
        }}
      >
        <span>{icon}</span>
        <span style={{ fontWeight: 500, color: "var(--text-primary)" }}>
          {tool}
        </span>
        <span
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: "4px",
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
          <span style={{ color: statusColor, fontSize: "11px" }}>
            {isRunning ? "执行中" : isComplete ? "完成" : isFailed ? "失败" : normalizedStatus}
          </span>
        </span>
        <span
          style={{
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 0.2s",
            color: "var(--text-secondary)",
          }}
        >
          ▶
        </span>
      </button>

      {expanded && result && (
        <div
          style={{
            padding: "0 10px 10px",
            borderTop: "1px solid var(--border-color)",
          }}
        >
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
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: "150px",
              overflow: "auto",
            }}
          >
            {result}
          </div>
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

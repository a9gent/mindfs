import React from "react";
import { InlineTokenText } from "./InlineTokenText";

type SessionInfo = {
  key: string;
  name: string;
  type: "chat" | "plugin";
  agent: string;
  model?: string;
  mode?: string;
  effort?: string;
  pending?: boolean;
};

type Exchange = {
  role: "user" | "agent";
  content: string;
  timestamp?: string;
};

type SessionHistoryProps = {
  session: SessionInfo | null;
  exchanges?: Exchange[];
  relatedFiles?: { path: string; name: string }[];
  onRestore?: () => void;
  onFileClick?: (path: string) => void;
  onClose?: () => void;
};

const typeLabels: Record<string, string> = {
  chat: "对话",
  plugin: "视图插件",
  skill: "对话",
};

export function SessionHistory({
  session,
  exchanges = [],
  relatedFiles = [],
  onRestore,
  onFileClick,
  onClose,
}: SessionHistoryProps) {
  if (!session) return null;

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: "#fff",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "16px 20px",
          borderBottom: "1px solid var(--border-color)",
          display: "flex",
          alignItems: "center",
          gap: "12px",
          background: "rgba(0,0,0,0.02)",
        }}
      >
        <span style={{ fontSize: "20px" }}>
          {session.type === "plugin" ? "🧩" : "💬"}
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: "16px", fontWeight: 600 }}>
            {session.name || `Session ${session.key.slice(0, 8)}`}
          </div>
          <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
            {typeLabels[session.type]} · {session.agent || "-"} · 已关闭
          </div>
        </div>
        <button
          onClick={onRestore}
          style={{
            padding: "8px 16px",
            borderRadius: "8px",
            border: "1px solid #3b82f6",
            background: "#fff",
            color: "#3b82f6",
            fontSize: "13px",
            fontWeight: 500,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: "6px",
          }}
        >
          ↻ 恢复
        </button>
        {onClose && (
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: "18px",
              color: "var(--text-secondary)",
              padding: "4px 8px",
            }}
          >
            ✕
          </button>
        )}
      </div>

      {/* Content */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          padding: "20px",
        }}
      >
        {/* 对话历史 */}
        <div style={{ marginBottom: "24px" }}>
          <div
            style={{
              fontSize: "14px",
              fontWeight: 600,
              marginBottom: "16px",
              color: "var(--text-primary)",
            }}
          >
            对话历史
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            {exchanges.map((ex, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "4px",
                }}
              >
                <div
                  style={{
                    fontSize: "11px",
                    color: "var(--text-secondary)",
                    fontWeight: 500,
                  }}
                >
                  {ex.role === "user" ? "用户" : "Agent"}
                  {ex.timestamp && ` · ${ex.timestamp}`}
                </div>
                <div
                  style={{
                    padding: "12px 16px",
                    borderRadius: ex.role === "user" ? "12px 12px 12px 4px" : "12px 12px 4px 12px",
                    background: ex.role === "user" ? "rgba(148,163,184,0.14)" : "rgba(0,0,0,0.05)",
                    color: "var(--text-primary)",
                    fontSize: "13px",
                    lineHeight: 1.6,
                    whiteSpace: "pre-wrap",
                    maxWidth: "85%",
                    alignSelf: ex.role === "user" ? "flex-start" : "flex-start",
                  }}
                >
                  {ex.role === "user" ? (
                    <InlineTokenText content={ex.content} variant="inverse" />
                  ) : (
                    ex.content
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 关联文件 */}
        {relatedFiles.length > 0 && (
          <div>
            <div
              style={{
                fontSize: "14px",
                fontWeight: 600,
                marginBottom: "12px",
                color: "var(--text-primary)",
              }}
            >
              关联文件
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {relatedFiles.map((file, i) => (
                <button
                  key={i}
                  onClick={() => onFileClick?.(file.path)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    padding: "10px 12px",
                    background: "rgba(0,0,0,0.02)",
                    border: "1px solid var(--border-color)",
                    borderRadius: "8px",
                    cursor: "pointer",
                    textAlign: "left",
                    transition: "background 0.15s",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "rgba(0,0,0,0.05)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "rgba(0,0,0,0.02)";
                  }}
                >
                  <span style={{ fontSize: "14px" }}>📄</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: "13px",
                        fontWeight: 500,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {file.name}
                    </div>
                    <div
                      style={{
                        fontSize: "11px",
                        color: "var(--text-secondary)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {file.path}
                    </div>
                  </div>
                  <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>→</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

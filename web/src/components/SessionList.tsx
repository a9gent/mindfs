import React from "react";
import { AgentIcon } from "./AgentIcon";

export type SessionType = "chat" | "plugin" | "skill";

export type SessionItem = {
  key: string;
  type: SessionType;
  agent?: string;
  name: string;
  created_at: string;
  updated_at: string;
  closed_at?: string;
  related_files?: Array<{ path: string }>;
};

type SessionListProps = {
  sessions: SessionItem[];
  selectedKey?: string;
  onSelect?: (session: SessionItem) => void;
  onRestore?: (session: SessionItem) => void;
};

const typeIcons: Record<SessionType, string> = {
  chat: "💬",
  plugin: "🧩",
  skill: "⚡",
};

export function SessionList({
  sessions,
  selectedKey = "",
  onSelect,
  onRestore,
}: SessionListProps) {
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "transparent" }}>
      {/* 统一的 Header 边栏 */}
      <div
        style={{
          height: "36px",
          display: "flex",
          alignItems: "center",
          padding: "0 16px",
          borderBottom: "1px solid var(--border-color)",
          flexShrink: 0,
          boxSizing: "border-box",
        }}
      >
        <h3
          style={{
            margin: 0,
            fontSize: "11px",
            fontWeight: 700,
            color: "var(--text-secondary)",
            letterSpacing: "0.5px",
            textTransform: "uppercase",
          }}
        >
          SESSIONS
        </h3>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "8px" }}>
        {!sessions.length ? (
          <div style={{ fontSize: "12px", color: "var(--text-secondary)", padding: "12px 8px" }}>
            暂无会话记录
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
            {sessions.map((session) => (
              <SessionCard
                key={session.key}
                session={session}
                selected={session.key === selectedKey}
                onSelect={onSelect}
                onRestore={onRestore}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SessionCard({ session, selected, onSelect, onRestore }: { session: SessionItem; selected: boolean; onSelect?: (session: SessionItem) => void; onRestore?: (session: SessionItem) => void }) {
  const isClosed = !!session.closed_at;
  const displayName = session.name || `Session ${session.key.slice(0, 8)}`;
  const fileCount = session.related_files?.length || 0;

  return (
    <button
      type="button"
      onClick={() => onSelect?.(session)}
      style={{
        textAlign: "left",
        padding: "7px 10px",
        borderRadius: "8px",
        border: "1px solid transparent",
        background: selected ? "rgba(59, 130, 246, 0.1)" : "transparent",
        cursor: "pointer",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        gap: "2px",
        transition: "all 0.15s ease",
        position: "relative"
      }}
      onMouseEnter={(e) => { if(!selected) e.currentTarget.style.background = "rgba(0,0,0,0.03)"; }}
      onMouseLeave={(e) => { if(!selected) e.currentTarget.style.background = "transparent"; }}
    >
      {/* 第一行：标题 */}
      <div style={{ 
        fontSize: "13px", 
        fontWeight: selected ? 600 : 500, 
        color: selected ? "var(--accent-color)" : "var(--text-primary)",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        width: "100%"
      }}>
        {displayName}
      </div>

      {/* 第二行：混合辅助信息 */}
      <div style={{ 
        display: "flex", 
        alignItems: "center", 
        gap: "4px", 
        fontSize: "10px", 
        color: "var(--text-secondary)",
        width: "100%",
        opacity: 0.8
      }}>
        <span>{typeIcons[session.type]}</span>
        <AgentIcon agentName={session.agent || ""} style={{ width: "12px", height: "12px", flexShrink: 0 }} />
        <span>•</span>
        <span style={{ flexShrink: 0 }}>{formatTime(isClosed && session.closed_at ? session.closed_at : session.updated_at)}</span>
        
        {fileCount > 0 && (
          <>
            <span>•</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
              <span style={{ opacity: 0.7 }}>📎</span>{fileCount}
            </span>
          </>
        )}

        {isClosed && onRestore && (
          <div 
            style={{ marginLeft: "auto" }}
            onClick={(e) => { e.stopPropagation(); onRestore(session); }}
          >
            <span style={{ color: "var(--accent-color)", cursor: "pointer", fontWeight: 500 }}>恢复</span>
          </div>
        )}
      </div>
    </button>
  );
}

function formatTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  if (now.getFullYear() === date.getFullYear()) {
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }
  return `${date.getFullYear() % 100}/${date.getMonth() + 1}`;
}

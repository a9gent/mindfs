import React from "react";

export type SessionStatus = "active" | "idle" | "closed";
export type SessionType = "chat" | "view" | "skill";

export type SessionItem = {
  key: string;
  type: SessionType;
  agent: string;
  name: string;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
  closed_at?: string;
  summary?: {
    title: string;
    description: string;
  };
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
  view: "🎨",
  skill: "⚡",
};

const statusColors: Record<SessionStatus, string> = {
  active: "#22c55e",
  idle: "#f59e0b",
  closed: "#9ca3af",
};

export function SessionList({
  sessions,
  selectedKey = "",
  onSelect,
  onRestore,
}: SessionListProps) {
  if (!sessions.length) {
    return (
      <div style={{ fontSize: "12px", color: "var(--text-secondary)", padding: "8px 0" }}>
        暂无会话记录
      </div>
    );
  }

  const activeSessions = sessions.filter((s) => s.status === "active" || s.status === "idle");
  const closedSessions = sessions.filter((s) => s.status === "closed");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {activeSessions.length > 0 && (
        <div>
          <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "8px", textTransform: "uppercase", letterSpacing: "0.5px" }}>进行中</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            {activeSessions.map((session) => (
              <SessionCard key={session.key} session={session} selected={session.key === selectedKey} onSelect={onSelect} />
            ))}
          </div>
        </div>
      )}

      {closedSessions.length > 0 && (
        <div>
          <div style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)", marginBottom: "8px", textTransform: "uppercase", letterSpacing: "0.5px" }}>已结束</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            {closedSessions.map((session) => (
              <SessionCard key={session.key} session={session} selected={session.key === selectedKey} onSelect={onSelect} onRestore={onRestore} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SessionCard({ session, selected, onSelect, onRestore }: { session: SessionItem; selected: boolean; onSelect?: (session: SessionItem) => void; onRestore?: (session: SessionItem) => void }) {
  const isClosed = session.status === "closed";
  const displayName = session.summary?.title || session.name || `Session ${session.key.slice(0, 8)}`;
  const fileCount = session.related_files?.length || 0;

  return (
    <button
      type="button"
      onClick={() => onSelect?.(session)}
      style={{
        textAlign: "left",
        padding: "10px 12px",
        borderRadius: "10px",
        border: "1px solid transparent",
        background: selected ? "rgba(59, 130, 246, 0.1)" : "transparent",
        cursor: "pointer",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        gap: "4px",
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
        gap: "6px", 
        fontSize: "11px", 
        color: "var(--text-secondary)",
        width: "100%",
        opacity: 0.8
      }}>
        <span style={{ 
          width: "6px", 
          height: "6px", 
          borderRadius: "50%", 
          background: statusColors[session.status],
          flexShrink: 0,
          marginRight: "2px"
        }} />
        <span>{typeIcons[session.type]}</span>
        <span style={{ fontWeight: 500 }}>{session.agent}</span>
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

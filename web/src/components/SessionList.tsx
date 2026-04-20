import React, { useEffect, useRef, useState } from "react";
import { AgentIcon } from "./AgentIcon";

export type SessionType = "chat" | "plugin";

export type SessionItem = {
  key: string;
  session_key?: string;
  type?: SessionType;
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
  headerAction?: React.ReactNode;
  onSelect?: (session: SessionItem) => void;
  onRestore?: (session: SessionItem) => void;
  onDelete?: (session: SessionItem) => void;
  onLoadOlder?: () => void;
  loadingOlder?: boolean;
  hasMore?: boolean;
};

const typeIcons: Record<SessionType, string> = {
  chat: "💬",
  plugin: "🧩",
};

export function SessionList({
  sessions,
  selectedKey = "",
  headerAction,
  onSelect,
  onDelete,
  onLoadOlder,
  loadingOlder = false,
  hasMore = false,
}: SessionListProps) {
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: "transparent",
      }}
    >
      {/* 统一的 Header 边栏 */}
      <div
        style={{
          height: "36px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
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
        {headerAction ? (
          <div style={{ display: "inline-flex", alignItems: "center" }}>
            {headerAction}
          </div>
        ) : null}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "8px" }}>
        {!sessions.length ? (
          <div
            style={{
              fontSize: "12px",
              color: "var(--text-secondary)",
              padding: "12px 8px",
            }}
          >
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
                onDelete={onDelete}
              />
            ))}
            {hasMore ? (
              <button
                type="button"
                onClick={onLoadOlder}
                disabled={loadingOlder}
                style={{
                  marginTop: "8px",
                  border: "1px solid var(--border-color)",
                  background: "transparent",
                  color: "var(--text-secondary)",
                  borderRadius: "8px",
                  padding: "8px 10px",
                  cursor: loadingOlder ? "default" : "pointer",
                  fontSize: "12px",
                }}
              >
                {loadingOlder ? "加载中..." : "加载更多"}
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function SessionCard({
  session,
  selected,
  onSelect,
  onDelete,
}: {
  session: SessionItem;
  selected: boolean;
  onSelect?: (session: SessionItem) => void;
  onDelete?: (session: SessionItem) => void;
}) {
  const isClosed = !!session.closed_at;
  const displayName = session.name || `Session ${session.key.slice(0, 8)}`;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [menuOpen]);

  return (
    <div
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: "2px",
        padding: "2px 0",
        borderRadius: "8px",
        position: "relative",
      }}
    >
      <button
        type="button"
        onClick={() => onSelect?.(session)}
        style={{
          textAlign: "left",
          padding: "7px 10px 7px 6px",
          borderRadius: "8px",
          border: "1px solid transparent",
          background: selected ? "rgba(59, 130, 246, 0.1)" : "transparent",
          cursor: "pointer",
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          gap: "8px",
          transition: "all 0.15s ease",
        }}
        onMouseEnter={(e) => {
          if (!selected) e.currentTarget.style.background = "rgba(0,0,0,0.03)";
        }}
        onMouseLeave={(e) => {
          if (!selected) e.currentTarget.style.background = "transparent";
        }}
      >
        <span
          style={{
            position: "relative",
            width: "18px",
            height: "18px",
            flexShrink: 0,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <span style={{ fontSize: "14px", lineHeight: 1 }}>
            {typeIcons[session.type || "chat"]}
          </span>
          <span
            style={{
              position: "absolute",
              right: "-2px",
              bottom: "-2px",
              width: "10px",
              height: "10px",
              borderRadius: "999px",
              background: "var(--content-bg, #fff)",
              border: "1px solid rgba(255,255,255,0.9)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
            }}
          >
            <AgentIcon
              agentName={session.agent || ""}
              style={{ width: "10px", height: "10px", display: "block" }}
            />
          </span>
        </span>

        <div
          style={{
            minWidth: 0,
            flex: 1,
            fontSize: "13px",
            fontWeight: selected ? 600 : 500,
            color: selected ? "var(--accent-color)" : "var(--text-primary)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {displayName}
        </div>

        <span
          style={{
            flexShrink: 0,
            fontSize: "10px",
            color: "var(--text-secondary)",
            opacity: 0.8,
          }}
        >
          {formatTime(
            isClosed && session.closed_at
              ? session.closed_at
              : session.updated_at,
          )}
        </span>
      </button>

      <div ref={menuRef} style={{ position: "relative", flexShrink: 0 }}>
        <button
          type="button"
          aria-label="会话菜单"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((open) => !open);
          }}
          style={{
            width: "28px",
            height: "28px",
            borderRadius: "8px",
            border: "none",
            background: menuOpen ? "rgba(0, 0, 0, 0.06)" : "transparent",
            color: "var(--text-secondary)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            outline: "none",
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <circle cx="12" cy="5" r="1.8" />
            <circle cx="12" cy="12" r="1.8" />
            <circle cx="12" cy="19" r="1.8" />
          </svg>
        </button>
        {menuOpen ? (
          <div
            style={{
              position: "absolute",
              top: "calc(100% + 6px)",
              right: 0,
              minWidth: "120px",
              padding: "6px",
              borderRadius: "10px",
              border: "1px solid var(--border-color)",
              background: "var(--menu-bg)",
              boxShadow: "0 12px 30px rgba(15, 23, 42, 0.14)",
              zIndex: 20,
            }}
          >
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen(false);
                onDelete?.(session);
              }}
              style={{
                width: "100%",
                border: "none",
                background: "transparent",
                color: "#dc2626",
                borderRadius: "8px",
                padding: "8px 10px",
                display: "flex",
                alignItems: "center",
                gap: "8px",
                textAlign: "left",
                cursor: "pointer",
                fontSize: "12px",
                fontWeight: 500,
              }}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14H6L5 6" />
                <path d="M10 11v6" />
                <path d="M14 11v6" />
                <path d="M9 6V4h6v2" />
              </svg>
              删除
            </button>
          </div>
        ) : null}
      </div>
    </div>
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

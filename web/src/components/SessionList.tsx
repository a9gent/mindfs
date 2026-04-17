import React, { useEffect, useRef, useState } from "react";
import { AgentIcon } from "./AgentIcon";

export type SessionType = "chat" | "plugin";

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
  headerAction?: React.ReactNode;
  onSelect?: (session: SessionItem) => void;
  onRestore?: (session: SessionItem) => void;
  onRename?: (session: SessionItem, nextName: string) => Promise<boolean> | boolean;
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
  onRename,
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
                onRename={onRename}
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
  onRename,
  onDelete,
}: {
  session: SessionItem;
  selected: boolean;
  onSelect?: (session: SessionItem) => void;
  onRename?: (session: SessionItem, nextName: string) => Promise<boolean> | boolean;
  onDelete?: (session: SessionItem) => void;
}) {
  const isClosed = !!session.closed_at;
  const displayName = session.name || `Session ${session.key.slice(0, 8)}`;
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(displayName);
  const [saving, setSaving] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const composingRef = useRef(false);
  const submittingRef = useRef(false);

  useEffect(() => {
    if (!editing) {
      setDraftName(displayName);
    }
  }, [displayName, editing]);

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

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    if (!input) return;
    const atEnd = input.selectionStart === input.value.length;
    if (atEnd) {
      input.scrollLeft = input.scrollWidth;
    }
  }, [draftName, editing]);

  const cancelEditing = () => {
    setEditing(false);
    setSaving(false);
    setDraftName(displayName);
  };

  const submitRename = async () => {
    if (submittingRef.current) return;
    const trimmed = draftName.trim();
    if (!trimmed) {
      cancelEditing();
      return;
    }
    if (trimmed === displayName.trim()) {
      cancelEditing();
      return;
    }
    if (!onRename) {
      cancelEditing();
      return;
    }
    submittingRef.current = true;
    setSaving(true);
    try {
      const ok = await onRename(session, trimmed);
      if (ok === false) {
        inputRef.current?.focus();
        inputRef.current?.select();
        return;
      }
      setEditing(false);
    } finally {
      submittingRef.current = false;
      setSaving(false);
    }
  };

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
      <div
        style={{
          textAlign: "left" as const,
          padding: "7px 10px 7px 6px",
          borderRadius: "8px",
          border: "1px solid transparent",
          background: selected ? "rgba(59, 130, 246, 0.1)" : "transparent",
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          gap: "8px",
          transition: "all 0.15s ease",
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
            {typeIcons[session.type]}
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

        {editing ? (
          <input
            ref={inputRef}
            value={draftName}
            disabled={saving}
            onChange={(e) => {
              setDraftName(e.target.value);
              e.currentTarget.scrollLeft = e.currentTarget.scrollWidth;
            }}
            onClick={(e) => e.stopPropagation()}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") {
                e.preventDefault();
                cancelEditing();
                return;
              }
              if (e.key !== "Enter") {
                return;
              }
              const nativeEvent = e.nativeEvent as KeyboardEvent;
              const isComposing =
                composingRef.current ||
                nativeEvent.isComposing ||
                nativeEvent.keyCode === 229;
              if (isComposing) {
                return;
              }
              e.preventDefault();
              void submitRename();
            }}
            style={{
              minWidth: 0,
              flex: 1,
              height: "28px",
              borderRadius: "6px",
              border: "1px solid var(--accent-color)",
              background: "var(--content-bg, #fff)",
              color: "var(--text-primary)",
              fontSize: "13px",
              fontWeight: 600,
              padding: "0 10px 0 8px",
              outline: "none",
              boxSizing: "border-box",
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => onSelect?.(session)}
            style={{
              minWidth: 0,
              flex: 1,
              border: "none",
              background: "transparent",
              padding: 0,
              cursor: "pointer",
              textAlign: "left",
              fontSize: "13px",
              fontWeight: selected ? 600 : 500,
              color: selected ? "var(--accent-color)" : "var(--text-primary)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            onMouseEnter={(e) => {
              const container = e.currentTarget.parentElement;
              if (container && !selected) {
                container.style.background = "rgba(0,0,0,0.03)";
              }
            }}
            onMouseLeave={(e) => {
              const container = e.currentTarget.parentElement;
              if (container && !selected) {
                container.style.background = "transparent";
              }
            }}
          >
            {displayName}
          </button>
        )}

        {editing ? (
          <div
            style={{
              flexShrink: 0,
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
            }}
          >
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                cancelEditing();
              }}
              disabled={saving}
              aria-label="取消重命名"
              style={{
                ...inlineActionStyle,
                opacity: saving ? 0.6 : 1,
                cursor: saving ? "default" : "pointer",
              }}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        ) : null}

        {!editing ? (
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
        ) : null}
      </div>

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
                setDraftName(displayName);
                setEditing(true);
              }}
              style={{
                ...menuItemStyle,
                color: "var(--text-primary)",
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
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
              </svg>
              重命名
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen(false);
                onDelete?.(session);
              }}
              style={{
                ...menuItemStyle,
                color: "#dc2626",
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

const menuItemStyle: React.CSSProperties = {
  width: "100%",
  border: "none",
  background: "transparent",
  borderRadius: "8px",
  padding: "8px 10px",
  display: "flex",
  alignItems: "center",
  gap: "8px",
  textAlign: "left",
  cursor: "pointer",
  fontSize: "12px",
  fontWeight: 500,
};

const inlineActionStyle: React.CSSProperties = {
  width: "24px",
  height: "24px",
  border: "none",
  borderRadius: "6px",
  background: "transparent",
  color: "var(--text-secondary)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
};

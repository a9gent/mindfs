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
  search_seq?: number;
  search_snippet?: string;
  search_match_type?: "name" | "user" | "reply";
};

type SessionListProps = {
  sessions: SessionItem[];
  selectedKey?: string;
  headerAction?: React.ReactNode;
  searchOpen?: boolean;
  searchResultsMode?: boolean;
  searchQuery?: string;
  searchLoading?: boolean;
  emptyText?: string;
  onSearchToggle?: () => void;
  onSearchBack?: () => void;
  onSearchQueryChange?: (query: string) => void;
  onSearchSubmit?: () => void;
  onSearchBlur?: () => void;
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
  searchOpen = false,
  searchResultsMode = false,
  searchQuery = "",
  searchLoading = false,
  emptyText = "暂无会话记录",
  onSearchToggle,
  onSearchBack,
  onSearchQueryChange,
  onSearchSubmit,
  onSearchBlur,
  onSelect,
  onRename,
  onDelete,
  onLoadOlder,
  loadingOlder = false,
  hasMore = false,
}: SessionListProps) {
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchBlurTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!searchOpen) return;
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, [searchOpen]);

  useEffect(() => {
    return () => {
      if (searchBlurTimerRef.current) {
        window.clearTimeout(searchBlurTimerRef.current);
      }
    };
  }, []);

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
          padding: searchResultsMode ? "0 10px 0 4px" : "0 10px 0 16px",
          borderBottom: "1px solid var(--border-color)",
          flexShrink: 0,
          boxSizing: "border-box",
        }}
      >
        {searchResultsMode ? (
          <button
            type="button"
            onClick={onSearchBack}
            aria-label="返回会话列表"
            style={iconButtonStyle(false)}
          >
            <ChevronLeftIcon />
          </button>
        ) : (
          <div style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
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
            {onSearchToggle ? (
              <button
                type="button"
                aria-label={searchOpen ? "关闭会话搜索" : "搜索会话"}
                title={searchOpen ? "关闭会话搜索" : "搜索会话"}
                onClick={onSearchToggle}
                style={{
                  width: "34px",
                  height: "34px",
                  minWidth: "34px",
                  border: "none",
                  borderRadius: "8px",
                  padding: 0,
                  background: "transparent",
                  color: searchOpen ? "var(--accent-color)" : "var(--text-secondary)",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                }}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
                  <path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5A6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5S14 7.01 14 9.5S11.99 14 9.5 14" />
                </svg>
              </button>
            ) : null}
          </div>
        )}
        {headerAction ? (
          <div style={{ display: "inline-flex", alignItems: "center" }}>
            {headerAction}
          </div>
        ) : null}
      </div>

      {searchOpen ? (
        <div
          style={{
            padding: "10px 12px",
            borderBottom: "1px solid var(--border-color)",
            flexShrink: 0,
            background: "transparent",
          }}
        >
          <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            border: "1px solid rgba(148,163,184,0.22)",
            borderRadius: "10px",
            padding: "0 10px",
            height: "34px",
            background: "transparent",
          }}
        >
            {searchLoading ? (
              <span
                aria-label="搜索中"
                style={{
                  width: "14px",
                  height: "14px",
                  borderRadius: "50%",
                  border: "1.5px solid rgba(100,116,139,0.45)",
                  borderTopColor: "var(--accent-color)",
                  display: "inline-block",
                  flexShrink: 0,
                  animation: "spin 0.8s linear infinite",
                }}
              />
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" style={{ color: "var(--text-secondary)", flexShrink: 0 }}>
                <path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5A6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5S14 7.01 14 9.5S11.99 14 9.5 14" />
              </svg>
            )}
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              placeholder="搜索标题或对话内容"
              onChange={(e) => onSearchQueryChange?.(e.target.value)}
              onBlur={() => {
                if (searchResultsMode) {
                  return;
                }
                if (searchBlurTimerRef.current) {
                  window.clearTimeout(searchBlurTimerRef.current);
                }
                searchBlurTimerRef.current = window.setTimeout(() => {
                  onSearchBlur?.();
                }, 120);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onSearchSubmit?.();
                }
              }}
              style={{
                flex: 1,
                minWidth: 0,
                border: "none",
                outline: "none",
                background: "transparent",
                color: "var(--text-primary)",
                fontSize: "13px",
              }}
            />
            {searchQuery ? (
              <button
                type="button"
                onClick={() => onSearchQueryChange?.("")}
                onMouseDown={(e) => e.preventDefault()}
                aria-label="清空搜索"
                style={{
                  width: "18px",
                  height: "18px",
                  border: "none",
                  borderRadius: "999px",
                  padding: 0,
                  background: "rgba(148,163,184,0.18)",
                  color: "var(--text-secondary)",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "8px" }}>
        {!sessions.length ? (
          emptyText ? (
            <div
              style={{
                fontSize: "12px",
                color: "var(--text-secondary)",
                padding: "12px 8px",
              }}
            >
              {emptyText}
            </div>
          ) : null
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
            {sessions.map((session) => (
              <SessionCard
                key={session.key}
                session={session}
                selected={session.key === selectedKey}
                highlightQuery={searchResultsMode ? searchQuery : ""}
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
  highlightQuery,
  onSelect,
  onRename,
  onDelete,
}: {
  session: SessionItem;
  selected: boolean;
  highlightQuery?: string;
  onSelect?: (session: SessionItem) => void;
  onRename?: (session: SessionItem, nextName: string) => Promise<boolean> | boolean;
  onDelete?: (session: SessionItem) => void;
}) {
  const isClosed = !!session.closed_at;
  const displayName = session.name || `Session ${session.key.slice(0, 8)}`;
  const snippet = (session.search_snippet || "").trim();
  const isSearchResult = !!session.search_match_type;
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
        gap: 0,
        padding: "2px 0",
        borderRadius: "8px",
        position: "relative",
      }}
    >
      <div
        style={{
          textAlign: "left" as const,
          padding: "7px 4px 7px 6px",
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
{!isSearchResult ? (
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
        ) : null}

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
              color: selected ? "var(--accent-color)" : "var(--text-primary)",
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
            <span
              style={{
                display: "block",
                fontSize: "13px",
                fontWeight: selected ? 600 : 500,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {renderHighlightedText(displayName, highlightQuery, {
                color: selected ? "var(--accent-color)" : "var(--text-primary)",
              })}
            </span>
            {snippet ? (
              <span
                style={{
                  marginTop: "2px",
                  display: "block",
                  fontSize: "11px",
                  lineHeight: 1.45,
                  color: "var(--text-secondary)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {renderHighlightedText(snippet, highlightQuery, {
                  color: "var(--text-secondary)",
                })}
              </span>
            ) : null}
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

      </div>

      {!editing ? (
        <div
          style={{
            flexShrink: 0,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            paddingLeft: "2px",
          }}
        >
          <span
            style={{
              fontSize: "10px",
              color: "var(--text-secondary)",
              opacity: 0.8,
              whiteSpace: "nowrap",
              textAlign: "right",
            }}
          >
            {formatTime(
              isClosed && session.closed_at
                ? session.closed_at
                : session.updated_at,
            )}
          </span>
        </div>
      ) : null}

      <div
        ref={menuRef}
        style={{ position: "relative", flexShrink: 0, marginLeft: "2px" }}
      >
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

function renderHighlightedText(
  text: string,
  query?: string,
  palette?: { color?: string },
): React.ReactNode {
  const source = String(text || "");
  const needle = String(query || "").trim();
  if (!source || !needle) {
    return source;
  }
  const lowerSource = source.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;

  for (;;) {
    const index = lowerSource.indexOf(lowerNeedle, cursor);
    if (index < 0) {
      break;
    }
    if (index > cursor) {
      parts.push(source.slice(cursor, index));
    }
    const match = source.slice(index, index + needle.length);
    parts.push(
      <mark
        key={`${index}:${match}`}
        style={{
          background: "transparent",
          color: "var(--accent-color)",
          padding: 0,
        }}
      >
        {match}
      </mark>,
    );
    cursor = index + needle.length;
  }

  if (cursor < source.length) {
    parts.push(source.slice(cursor));
  }
  return parts.length ? parts : source;
}

function iconButtonStyle(withGap: boolean): React.CSSProperties {
  return {
    border: "none",
    background: "transparent",
    color: "var(--text-secondary)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: withGap ? "2px" : 0,
    height: "28px",
    minWidth: "28px",
    borderRadius: "8px",
    cursor: "pointer",
    padding: withGap ? "0 6px" : 0,
  };
}

function ChevronLeftIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
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

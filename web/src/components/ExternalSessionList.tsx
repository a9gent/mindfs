import React, { useEffect, useRef, useState } from "react";
import type { SessionItem } from "./SessionList";

type ExternalSessionListProps = {
  sessions: SessionItem[];
  selectedKey?: string;
  selectedAgent?: string;
  importingKey?: string;
  filterBound?: boolean;
  headerAction?: React.ReactNode;
  onBack?: () => void;
  onSelect?: (session: SessionItem) => void;
  onImport?: (session: SessionItem) => void;
  onLoadOlder?: () => void;
  loading?: boolean;
  loadingOlder?: boolean;
  hasMore?: boolean;
};

export function ExternalSessionList({
  sessions,
  selectedKey = "",
  selectedAgent = "",
  importingKey = "",
  filterBound = true,
  headerAction,
  onBack,
  onSelect,
  onImport,
  onLoadOlder,
  loading = false,
  loadingOlder = false,
  hasMore = false,
}: ExternalSessionListProps) {
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
      <div
        style={{
          height: "36px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 10px 0 4px",
          borderBottom: "1px solid var(--border-color)",
          background: "var(--mindfs-topbar-bg, transparent)",
          flexShrink: 0,
          boxSizing: "border-box",
        }}
      >
        <button
          type="button"
          onClick={onBack}
          aria-label="退出导入模式"
          style={iconButtonStyle(false)}
        >
          <ChevronLeftIcon />
        </button>
        {headerAction ? (
          <div style={{ display: "inline-flex", alignItems: "center" }}>
            {headerAction}
          </div>
        ) : null}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "8px" }}>
        {loading ? (
          <div style={emptyStyle}>正在加载可导入会话...</div>
        ) : !selectedAgent ? (
          <div style={emptyStyle}>选择一个 Agent 查看可导入会话</div>
        ) : !sessions.length ? (
          <div style={emptyStyle}>
            {filterBound
              ? "没有找到可导入会话，或当前结果都已导入"
              : "没有找到可导入会话"}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
            {sessions.map((session) => (
              <ExternalSessionCard
                key={session.key}
                session={session}
                selected={session.key === selectedKey}
                importing={String(session.key || "") === importingKey}
                importDisabled={Boolean(importingKey)}
                onSelect={onSelect}
                onImport={onImport}
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

function ExternalSessionCard({
  session,
  selected,
  importing,
  importDisabled,
  onSelect,
  onImport,
}: {
  session: SessionItem;
  selected: boolean;
  importing: boolean;
  importDisabled: boolean;
  onSelect?: (session: SessionItem) => void;
  onImport?: (session: SessionItem) => void;
}) {
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

  const displayName = session.name || session.key || "External Session";
  const subtitle = formatTime(session.updated_at || session.created_at || "");

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
          padding: "7px 6px 7px 6px",
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
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
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
          {subtitle ? (
            <div
              style={{
                fontSize: "10px",
                color: "var(--text-secondary)",
                marginTop: "2px",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                minWidth: 0,
              }}
            >
              <span
                style={{
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {subtitle}
              </span>
              {importing ? <SpinnerIcon /> : null}
            </div>
          ) : null}
        </div>
      </button>

      <div ref={menuRef} style={{ position: "relative", flexShrink: 0 }}>
        <button
          type="button"
          aria-label="外部会话菜单"
          onClick={(e) => {
            e.stopPropagation();
            if (importDisabled) return;
            setMenuOpen((open) => !open);
          }}
          disabled={importDisabled}
          style={{
            width: "24px",
            height: "24px",
            borderRadius: "8px",
            border: "none",
            background: menuOpen ? "rgba(0, 0, 0, 0.06)" : "transparent",
            color: importDisabled
              ? "rgba(100, 116, 139, 0.55)"
              : "var(--text-secondary)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: importDisabled ? "default" : "pointer",
          }}
        >
          <DotsIcon />
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
                if (importDisabled) return;
                setMenuOpen(false);
                onImport?.(session);
              }}
              disabled={importDisabled}
              style={{
                ...menuItemStyle,
                color: importDisabled
                  ? "rgba(100, 116, 139, 0.55)"
                  : "var(--text-primary)",
                cursor: importDisabled ? "default" : "pointer",
              }}
            >
              <ImportActionIcon
                style={{
                  width: "14px",
                  height: "14px",
                  color: importDisabled
                    ? "rgba(100, 116, 139, 0.55)"
                    : "#16a34a",
                  flexShrink: 0,
                }}
              />
              {importing ? "导入中..." : "导入"}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function formatTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

const emptyStyle: React.CSSProperties = {
  fontSize: "12px",
  color: "var(--text-secondary)",
  padding: "12px 8px",
};

const menuItemStyle: React.CSSProperties = {
  width: "100%",
  border: "none",
  background: "transparent",
  color: "var(--text-primary)",
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

function DotsIcon() {
  return (
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
  );
}

function SpinnerIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r="5.5"
        stroke="currentColor"
        strokeOpacity="0.22"
        strokeWidth="1.5"
        fill="none"
      />
      <path
        d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
      >
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 8 8"
          to="360 8 8"
          dur="0.8s"
          repeatCount="indefinite"
        />
      </path>
    </svg>
  );
}

function ImportActionIcon({ style }: { style?: React.CSSProperties }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      style={style}
    >
      <path d="M1 12h9.8L8.3 9.5l1.4-1.4l4.9 4.9l-4.9 4.9l-1.4-1.4l2.5-2.5H1zM21 2H3c-1.1 0-2 .9-2 2v6.1h2V6h18v14H3v-4H1v4c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2" />
    </svg>
  );
}

import React from "react";
import type { SessionItem } from "./SessionList";

type ExternalSessionListProps = {
  sessions: SessionItem[];
  selectedKey?: string;
  selectedAgent?: string;
  importingKey?: string;
  importingKeys?: Set<string>;
  selectedImportKeys?: Set<string>;
  filterBound?: boolean;
  headerAction?: React.ReactNode;
  onBack?: () => void;
  onSelect?: (session: SessionItem) => void;
  onToggleImport?: (session: SessionItem) => void;
  onToggleSelectAllImport?: (checked: boolean) => void;
  onConfirmImport?: () => void;
  onLoadOlder?: () => void;
  loading?: boolean;
  error?: string;
  loadingOlder?: boolean;
  confirmingImport?: boolean;
  hasMore?: boolean;
};

export function ExternalSessionList({
  sessions,
  selectedKey = "",
  selectedAgent = "",
  importingKey = "",
  importingKeys,
  selectedImportKeys,
  filterBound = true,
  headerAction,
  onBack,
  onSelect,
  onToggleImport,
  onToggleSelectAllImport,
  onConfirmImport,
  onLoadOlder,
  loading = false,
  error = "",
  loadingOlder = false,
  confirmingImport = false,
  hasMore = false,
}: ExternalSessionListProps) {
  const selectedCount = selectedImportKeys?.size || 0;
  const busy = confirmingImport || Boolean(importingKey) || Boolean(importingKeys?.size);
  const importableKeys = sessions.map(externalSessionKey).filter(Boolean);
  const selectedVisibleCount = importableKeys.filter((key) =>
    selectedImportKeys?.has(key),
  ).length;
  const allVisibleSelected =
    importableKeys.length > 0 && selectedVisibleCount === importableKeys.length;
  const partiallySelected =
    selectedVisibleCount > 0 && selectedVisibleCount < importableKeys.length;
  const selectAllRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = partiallySelected;
    }
  }, [partiallySelected]);

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
        ) : error && !sessions.length ? (
          <div style={errorStyle}>{error}</div>
        ) : !sessions.length ? (
          <div style={emptyStyle}>
            {filterBound
              ? "没有找到可导入会话，或当前结果都已导入"
              : "没有找到可导入会话"}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
            {error ? <div style={errorStyle}>{error}</div> : null}
            {sessions.map((session) => (
              <ExternalSessionCard
                key={session.key}
                session={session}
                selected={session.key === selectedKey}
                checked={Boolean(selectedImportKeys?.has(externalSessionKey(session)))}
                importing={
                  String(session.key || "") === importingKey ||
                  Boolean(importingKeys?.has(externalSessionKey(session)))
                }
                importDisabled={busy}
                onSelect={onSelect}
                onToggleImport={onToggleImport}
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
      {selectedAgent && sessions.length ? (
        <div
          style={{
            flexShrink: 0,
            borderTop: "1px solid var(--border-color)",
            padding: "8px 10px",
            background: "var(--mindfs-topbar-bg, transparent)",
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <label
            style={{
              height: "36px",
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              flexShrink: 0,
              color: "var(--text-secondary)",
              fontSize: "12px",
              fontWeight: 500,
              cursor: busy ? "not-allowed" : "pointer",
              opacity: busy ? 0.64 : 1,
              userSelect: "none",
              whiteSpace: "nowrap",
            }}
          >
            <input
              ref={selectAllRef}
              type="checkbox"
              checked={allVisibleSelected}
              disabled={busy || !importableKeys.length}
              onChange={(event) =>
                onToggleSelectAllImport?.(event.currentTarget.checked)
              }
              style={{
                width: "14px",
                height: "14px",
                margin: 0,
                accentColor: "var(--accent-color)",
                cursor: busy ? "not-allowed" : "pointer",
              }}
            />
            全选
          </label>
          <button
            type="button"
            disabled={!selectedCount || busy}
            onClick={onConfirmImport}
            style={{
              flex: 1,
              minWidth: 0,
              border: "1px solid var(--border-color)",
              borderRadius: "10px",
              background: "var(--accent-color)",
              color: "#fff",
              padding: "10px 12px",
              fontSize: "12px",
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "8px",
              cursor: !selectedCount || busy ? "not-allowed" : "pointer",
              opacity: !selectedCount || busy ? 0.72 : 1,
              whiteSpace: "nowrap",
            }}
          >
            {busy ? "导入中..." : `确认导入 ${selectedCount} 项`}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ExternalSessionCard({
  session,
  selected,
  checked,
  importing,
  importDisabled,
  onSelect,
  onToggleImport,
}: {
  session: SessionItem;
  selected: boolean;
  checked: boolean;
  importing: boolean;
  importDisabled: boolean;
  onSelect?: (session: SessionItem) => void;
  onToggleImport?: (session: SessionItem) => void;
}) {
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
        onClick={() => {
          if (onToggleImport && !importDisabled) {
            onToggleImport(session);
            return;
          }
          onSelect?.(session);
        }}
        style={{
          textAlign: "left",
          padding: "7px 6px 7px 6px",
          borderRadius: "8px",
          border: "1px solid transparent",
          background: checked
            ? "var(--selection-bg)"
            : selected
              ? "rgba(59, 130, 246, 0.1)"
              : "transparent",
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
              color:
                checked || selected
                  ? "var(--accent-color)"
                  : "var(--text-primary)",
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

      {importing ? (
        <div style={{ flexShrink: 0, color: "var(--text-secondary)" }}>
          <SpinnerIcon />
        </div>
      ) : null}
    </div>
  );
}

function externalSessionKey(session: SessionItem): string {
  return String((session as any)?.agent_session_id || session.key || "").trim();
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

const errorStyle: React.CSSProperties = {
  ...emptyStyle,
  color: "var(--danger-color, #b42318)",
  whiteSpace: "pre-wrap",
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

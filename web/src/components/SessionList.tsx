import React, { useEffect, useMemo, useRef, useState } from "react";
import { AgentIcon } from "./AgentIcon";
import { ModeIcon } from "./ModeIcon";
import { rootBadgeButtonStyle, rootBadgeStyle } from "./rootBadgeStyle";

export type SessionType = "chat" | "plugin" | "command";

export type SessionItem = {
  key: string;
  session_key: string;
  root_id?: string;
  type?: SessionType;
  parent_session_key?: string;
  parent_tool_call_id?: string;
  source?: string;
  task_id?: string;
  agent?: string;
  shell?: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
  closed_at?: string;
  pending?: boolean;
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
  emptyText?: React.ReactNode;
  onSearchToggle?: () => void;
  onSearchBack?: () => void;
  onSearchQueryChange?: (query: string) => void;
  onSearchSubmit?: () => void;
  onSearchBlur?: () => void;
  syncingSessionKeys?: Set<string>;
  onSelect?: (session: SessionItem) => void;
  onRestore?: (session: SessionItem) => void;
  onSync?: (session: SessionItem) => Promise<void> | void;
  onRename?: (session: SessionItem, nextName: string) => Promise<boolean> | boolean;
  onDelete?: (session: SessionItem) => void;
  onLoadChildren?: (
    session: SessionItem,
    options?: { beforeTime?: string },
  ) => Promise<{ hasMore?: boolean } | void> | { hasMore?: boolean } | void;
  onLoadOlder?: () => void;
  loadingOlder?: boolean;
  hasMore?: boolean;
};

const COLLAPSED_CHILD_SESSION_LIMIT = 3;
const MULTI_PROJECT_VISIBLE_LIMIT = 6;
const MAIN_SESSION_ICON_OFFSET = "2px";
const SUB_SESSION_ICON_OFFSET = "0px";
const PINNED_PROJECTS_STORAGE_KEY = "mindfs-pinned-session-projects";

type VisibleSessionRow =
  | { type: "session"; session: SessionItem }
  | {
      type: "child-toggle";
      parent: SessionItem;
      loadedChildCount: number;
      hiddenCount: number;
      expanded: boolean;
    };

export type ProjectSessionGroup = {
  rootId: string;
  rootName: string;
  latestSessionTime?: string;
  sessions: SessionItem[];
  totalCount: number;
};

type ProjectSessionListProps = {
  groups: ProjectSessionGroup[];
  selectedKey?: string;
  selectedRootId?: string;
  headerAction?: React.ReactNode;
  loading?: boolean;
  emptyText?: React.ReactNode;
  syncingSessionKeys?: Set<string>;
  onSearchToggle?: () => void;
  onSelect?: (session: SessionItem) => void;
  onSync?: (session: SessionItem) => Promise<void> | void;
  onRename?: (session: SessionItem, nextName: string) => Promise<boolean> | boolean;
  onDelete?: (session: SessionItem) => void;
  onProjectClick?: (rootId: string) => void;
  onLoadMoreProject?: (group: ProjectSessionGroup) => Promise<void> | void;
  onLoadChildren?: (
    session: SessionItem,
    options?: { beforeTime?: string },
  ) => Promise<{ hasMore?: boolean } | void> | { hasMore?: boolean } | void;
};

function ToggleRowButton({
  label,
  loading,
  marginLeft,
  showExpandIcon = false,
  showCollapseIcon = false,
  onClick,
  onCollapse,
}: {
  label: string;
  loading?: boolean;
  marginLeft: string;
  showExpandIcon?: boolean;
  showCollapseIcon?: boolean;
  onClick: () => void;
  onCollapse?: () => void;
}) {
  const icon = (rotate = false) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="1em"
      height="1em"
      viewBox="0 0 16 16"
      aria-hidden="true"
      style={{
        width: "13px",
        height: "13px",
        flexShrink: 0,
        transform: rotate ? "rotate(180deg)" : "none",
      }}
    >
      <path d="M0 0h16v16H0z" fill="none" />
      <path fill="currentColor" d="M12.146 7.146a.5.5 0 0 1 .708.708l-4.5 4.5a.5.5 0 0 1-.708 0l-4.5-4.5a.5.5 0 1 1 .708-.708L8 11.293zm0-4a.5.5 0 0 1 .708.708l-4.5 4.5a.5.5 0 0 1-.708 0l-4.5-4.5a.5.5 0 1 1 .708-.708L8 7.293z" />
    </svg>
  );

  return (
    <button
      type="button"
      disabled={loading}
      onClick={onClick}
      style={{
        marginLeft,
        marginTop: "-2px",
        border: "none",
        background: "transparent",
        color: "var(--text-primary)",
        borderRadius: 0,
        padding: 0,
        minHeight: "13px",
        width: `calc(100% - ${marginLeft})`,
        boxSizing: "border-box",
        cursor: loading ? "default" : "pointer",
        fontSize: "11px",
        lineHeight: 1.1,
        textAlign: "center",
        opacity: loading ? 0.6 : 1,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "6px", minWidth: 0, flexShrink: 1 }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
        {showExpandIcon ? icon(false) : null}
        {showCollapseIcon ? (
          <span
            role="button"
            tabIndex={0}
            aria-label="收起"
            title="收起"
            onClick={(event) => {
              event.stopPropagation();
              onCollapse?.();
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") {
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              onCollapse?.();
            }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: loading ? "default" : "pointer",
            }}
          >
            {icon(true)}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function PinIcon({ pinned }: { pinned: boolean }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M0 0h24v24H0z" fill="none" />
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="m16.219 4.838l2.964 2.967c2.012 2.014 3.018 3.021 2.784 4.107c-.235 1.085-1.567 1.585-4.23 2.586l-1.845.693c-.713.268-1.07.402-1.345.64q-.181.158-.322.352c-.212.297-.313.664-.515 1.4c-.46 1.672-.69 2.508-1.239 2.821c-.23.132-.492.2-.758.2c-.63 0-1.243-.614-2.469-1.84l-1.466-1.468l-1.079-1.08L5.285 14.8c-1.218-1.219-1.827-1.828-1.83-2.455a1.53 1.53 0 0 1 .203-.773c.313-.543 1.143-.772 2.803-1.23c.737-.203 1.105-.304 1.402-.517q.199-.144.36-.332c.236-.278.368-.637.63-1.355l.669-1.823c.987-2.693 1.48-4.04 2.568-4.28s2.102.774 4.129 2.803"
        clipRule="evenodd"
        opacity={pinned ? 1 : 0.5}
      />
      <path fill="currentColor" d="m3.302 21.776l4.476-4.48l-1.079-1.08l-4.476 4.48a.764.764 0 0 0 1.08 1.08" />
    </svg>
  );
}

function shellBadgeLabel(shell?: string): string {
  const normalized = String(shell || "").trim().replace(/\\/g, "/");
  const base = (normalized.split("/").filter(Boolean).pop() || normalized || "sh").toLowerCase();
  if (base === "powershell.exe") return "ps";
  if (base === "pwsh.exe") return "pwsh";
  if (base === "cmd.exe") return "cmd";
  if (base.endsWith(".exe")) return base.slice(0, -4);
  return base;
}

type ForkSessionSource = {
  sessionKey: string;
  seq: number;
};

function parseForkSessionSource(source?: string): ForkSessionSource | null {
  const value = String(source || "").trim();
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as {
      type?: unknown;
      session_key?: unknown;
      seq?: unknown;
    };
    if (parsed?.type !== "fork") return null;
    return {
      sessionKey: String(parsed.session_key || "").trim(),
      seq: Number(parsed.seq || 0),
    };
  } catch {
    if (!value.includes('"type":"fork"') && !value.includes('"type": "fork"')) {
      return null;
    }
    return { sessionKey: "", seq: 0 };
  }
}

function forkSessionDisplayName(
  storedName: string,
  source: ForkSessionSource | null,
  sessionByKey: Map<string, SessionItem>,
  rootId?: string,
): string {
  if (!source) return storedName;
  const parentName = String(
    sessionByKey.get(rootId ? `${rootId}:${source.sessionKey}` : source.sessionKey)?.name ||
      sessionByKey.get(source.sessionKey)?.name ||
      "",
  ).trim();
  const fallbackName = storedName.replace(/\s+fork\s+@\d+\s*$/i, "").trim();
  const base = parentName || fallbackName || storedName;
  return source.seq > 0 ? `${base}#${source.seq}` : base;
}

function isSessionSyncing(
  session: SessionItem,
  syncingSessionKeys?: Set<string>,
): boolean {
  if (!syncingSessionKeys || syncingSessionKeys.size === 0) {
    return false;
  }
  const key = session.key || session.session_key || "";
  if (!key) {
    return false;
  }
  const rootId = session.root_id || "";
  return (
    syncingSessionKeys.has(key) ||
    (!!rootId && syncingSessionKeys.has(`${rootId}::${key}`))
  );
}

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
  syncingSessionKeys,
  onSelect,
  onSync,
  onRename,
  onDelete,
  onLoadChildren,
  onLoadOlder,
  loadingOlder = false,
  hasMore = false,
}: SessionListProps) {
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchBlurTimerRef = useRef<number | null>(null);
  const [expandedChildren, setExpandedChildren] = useState<Record<string, boolean>>({});
  const [loadingChildren, setLoadingChildren] = useState<Record<string, boolean>>({});
  const [childrenHasMore, setChildrenHasMore] = useState<Record<string, boolean>>({});
  const visibleSessions = useMemo(() => {
    if (searchResultsMode) {
      return sessions.map((session): VisibleSessionRow => ({ type: "session", session }));
    }
    const childrenByParent = new Map<string, SessionItem[]>();
    const topLevel: SessionItem[] = [];
    const keys = new Set(sessions.map((item) => item.key));
    const parentByKey = new Map<string, string>();
    for (const item of sessions) {
      const parentKey = String(item.parent_session_key || "").trim();
      if (parentKey && keys.has(parentKey)) {
        const children = childrenByParent.get(parentKey) || [];
        children.push(item);
        childrenByParent.set(parentKey, children);
        parentByKey.set(item.key, parentKey);
      } else {
        topLevel.push(item);
      }
    }
    const activeParentKeys = new Set<string>();
    if (selectedKey) {
      activeParentKeys.add(selectedKey);
      let parentKey = parentByKey.get(selectedKey) || "";
      while (parentKey) {
        activeParentKeys.add(parentKey);
        parentKey = parentByKey.get(parentKey) || "";
      }
    }
    const out: VisibleSessionRow[] = [];
    const append = (item: SessionItem) => {
      out.push({ type: "session", session: item });
      const children = childrenByParent.get(item.key) || [];
      const active = activeParentKeys.has(item.key);
      const expanded = !!expandedChildren[item.key];
      const visibleChildren = active
        ? expanded
          ? children
          : children.slice(0, COLLAPSED_CHILD_SESSION_LIMIT)
        : [];
      for (const child of visibleChildren) {
        append(child);
      }
      const hiddenCount = Math.max(0, children.length - COLLAPSED_CHILD_SESSION_LIMIT);
      if (active && (children.length > COLLAPSED_CHILD_SESSION_LIMIT || expanded || childrenHasMore[item.key])) {
        out.push({
          type: "child-toggle",
          parent: item,
          loadedChildCount: children.length,
          hiddenCount,
          expanded,
        });
      }
    };
    topLevel.forEach((item) => append(item));
    return out;
  }, [childrenHasMore, expandedChildren, searchResultsMode, selectedKey, sessions]);
  const childCountByParent = useMemo(() => {
    const counts = new Map<string, number>();
    const keys = new Set(sessions.map((item) => item.key));
    for (const item of sessions) {
      const parentKey = String(item.parent_session_key || "").trim();
      if (parentKey && keys.has(parentKey)) {
        counts.set(parentKey, (counts.get(parentKey) || 0) + 1);
      }
    }
    return counts;
  }, [sessions]);
  const selectedParentKey = useMemo(() => {
    if (!selectedKey) return "";
    return sessions.find((item) => item.key === selectedKey)?.parent_session_key || "";
  }, [selectedKey, sessions]);
  const sessionByKey = useMemo(() => {
    const byKey = new Map<string, SessionItem>();
    for (const item of sessions) {
      byKey.set(item.key, item);
    }
    return byKey;
  }, [sessions]);

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

  const loadChildren = async (parent: SessionItem, beforeTime?: string) => {
    if (!onLoadChildren || loadingChildren[parent.key]) {
      return;
    }
    setLoadingChildren((prev) => ({ ...prev, [parent.key]: true }));
    try {
      const result = await onLoadChildren(parent, beforeTime ? { beforeTime } : undefined);
      setChildrenHasMore((prev) => ({ ...prev, [parent.key]: !!result?.hasMore }));
    } finally {
      setLoadingChildren((prev) => ({ ...prev, [parent.key]: false }));
    }
  };

  const handleChildToggle = async (row: Extract<VisibleSessionRow, { type: "child-toggle" }>) => {
    const parentKey = row.parent.key;
    if (!row.expanded) {
      setExpandedChildren((prev) => ({ ...prev, [parentKey]: true }));
      await loadChildren(row.parent);
      return;
    }
    if (childrenHasMore[parentKey]) {
      const lastChild = sessions
        .filter((item) => item.parent_session_key === parentKey)
        .sort((left, right) => (Date.parse(left.updated_at || "") || 0) - (Date.parse(right.updated_at || "") || 0))[0];
      await loadChildren(row.parent, lastChild?.updated_at);
    } else {
      setExpandedChildren((prev) => ({ ...prev, [parentKey]: false }));
    }
  };

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
          padding: searchResultsMode ? "0 10px 0 4px" : "0 10px 0 2px",
          borderBottom: "1px solid var(--border-color)",
          background: "var(--mindfs-topbar-bg, transparent)",
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
            background: "var(--mindfs-topbar-bg, transparent)",
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
                minHeight: "100%",
                padding: "12px 18px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                textAlign: "center",
                lineHeight: 1.6,
              }}
            >
              {emptyText}
            </div>
          ) : null
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
            {visibleSessions.map((row) => {
              if (row.type === "child-toggle") {
                const loading = !!loadingChildren[row.parent.key];
                const hasMoreChildren = !!childrenHasMore[row.parent.key];
                const label = loading
                  ? "加载中..."
                  : row.expanded
                    ? hasMoreChildren
                      ? "加载更多子会话"
                      : "收起"
                    : row.hiddenCount > 0
                      ? `还有 ${row.hiddenCount} 个子会话`
                      : "展开子会话";
                return (
                  <ToggleRowButton
                    key={`children-toggle-${row.parent.key}`}
                    loading={loading}
                    label={label}
                    showExpandIcon={!loading && (!row.expanded || hasMoreChildren)}
                    showCollapseIcon={!loading && row.expanded}
                    marginLeft={SUB_SESSION_ICON_OFFSET}
                    onClick={() => void handleChildToggle(row)}
                    onCollapse={() =>
                      setExpandedChildren((prev) => ({
                        ...prev,
                        [row.parent.key]: false,
                      }))
                    }
                  />
                );
              }
              const session = row.session;
              return (
                <SessionCard
                  key={session.key}
                  session={session}
                  sessionByKey={sessionByKey}
                  selected={session.key === selectedKey}
                  parentHighlighted={!!selectedParentKey && session.key === selectedParentKey}
                  highlightQuery={searchResultsMode ? searchQuery : ""}
                  syncing={isSessionSyncing(session, syncingSessionKeys)}
                  childCount={childCountByParent.get(session.key) || 0}
                  onSelect={onSelect}
                  onSync={onSync}
                  onRename={onRename}
                  onDelete={onDelete}
                />
              );
            })}
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
      <style>{`
        @keyframes mindfs-bound-pulse {
          0%, 100% { opacity: 1; box-shadow: 0 0 0 1.5px rgba(37,99,235,0.14); }
          50% { opacity: 0.18; box-shadow: 0 0 0 4px rgba(37,99,235,0.08); }
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

export function MultiProjectSessionList({
  groups,
  selectedKey = "",
  selectedRootId = "",
  headerAction,
  loading = false,
  emptyText = "暂无会话记录",
  syncingSessionKeys,
  onSearchToggle,
  onSelect,
  onSync,
  onRename,
  onDelete,
  onProjectClick,
  onLoadMoreProject,
  onLoadChildren,
}: ProjectSessionListProps) {
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [loadingProjects, setLoadingProjects] = useState<Record<string, boolean>>({});
  const [expandedChildren, setExpandedChildren] = useState<Record<string, boolean>>({});
  const [loadingChildren, setLoadingChildren] = useState<Record<string, boolean>>({});
  const [childrenHasMore, setChildrenHasMore] = useState<Record<string, boolean>>({});
  const [pinnedProjects, setPinnedProjects] = useState<Record<string, number>>(() => {
    if (typeof window === "undefined") {
      return {};
    }
    try {
      const parsed = JSON.parse(window.localStorage.getItem(PINNED_PROJECTS_STORAGE_KEY) || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      const next: Record<string, number> = {};
      for (const [key, value] of Object.entries(parsed)) {
        const timestamp = Number(value);
        if (key && Number.isFinite(timestamp) && timestamp > 0) {
          next[key] = timestamp;
        }
      }
      return next;
    } catch {
      return {};
    }
  });
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(PINNED_PROJECTS_STORAGE_KEY, JSON.stringify(pinnedProjects));
  }, [pinnedProjects]);
  const orderedGroups = useMemo(
    () =>
      groups.slice().sort((left, right) => {
        const leftPinnedAt = pinnedProjects[left.rootId] || 0;
        const rightPinnedAt = pinnedProjects[right.rootId] || 0;
        if (leftPinnedAt || rightPinnedAt) {
          if (leftPinnedAt !== rightPinnedAt) {
            return rightPinnedAt - leftPinnedAt;
          }
        }
        return 0;
      }),
    [groups, pinnedProjects],
  );
  const togglePinnedProject = (rootId: string) => {
    setPinnedProjects((prev) => {
      const next = { ...prev };
      if (next[rootId]) {
        delete next[rootId];
      } else {
        next[rootId] = Date.now();
      }
      return next;
    });
  };
  const sessionByKey = useMemo(() => {
    const byKey = new Map<string, SessionItem>();
    for (const group of groups) {
      for (const item of group.sessions) {
        const sessionRoot = item.root_id || group.rootId;
        byKey.set(`${sessionRoot}:${item.key}`, item);
        byKey.set(item.key, item);
      }
    }
    return byKey;
  }, [groups]);
  const childStateKey = (session: SessionItem, fallbackRootId = "") => `${session.root_id || fallbackRootId}:${session.key}`;

  const loadChildren = async (parent: SessionItem, beforeTime?: string) => {
    const stateKey = childStateKey(parent);
    if (!onLoadChildren || loadingChildren[stateKey]) {
      return;
    }
    setLoadingChildren((prev) => ({ ...prev, [stateKey]: true }));
    try {
      const result = await onLoadChildren(parent, beforeTime ? { beforeTime } : undefined);
      setChildrenHasMore((prev) => ({ ...prev, [stateKey]: !!result?.hasMore }));
    } finally {
      setLoadingChildren((prev) => ({ ...prev, [stateKey]: false }));
    }
  };

  const buildRows = (sessions: SessionItem[], fallbackRootId: string): VisibleSessionRow[] => {
    const childrenByParent = new Map<string, SessionItem[]>();
    const topLevel: SessionItem[] = [];
    const keys = new Set(sessions.map((item) => item.key));
    const parentByKey = new Map<string, string>();
    for (const item of sessions) {
      const parentKey = String(item.parent_session_key || "").trim();
      if (parentKey && keys.has(parentKey)) {
        const children = childrenByParent.get(parentKey) || [];
        children.push(item);
        childrenByParent.set(parentKey, children);
        parentByKey.set(item.key, parentKey);
      } else {
        topLevel.push(item);
      }
    }
    const activeParentKeys = new Set<string>();
    if (selectedKey && selectedRootId === fallbackRootId) {
      activeParentKeys.add(selectedKey);
      let parentKey = parentByKey.get(selectedKey) || "";
      while (parentKey) {
        activeParentKeys.add(parentKey);
        parentKey = parentByKey.get(parentKey) || "";
      }
    }
    const out: VisibleSessionRow[] = [];
    const append = (item: SessionItem) => {
      out.push({ type: "session", session: item });
      const children = childrenByParent.get(item.key) || [];
      const stateKey = childStateKey(item, fallbackRootId);
      const active = activeParentKeys.has(item.key);
      const expanded = !!expandedChildren[stateKey];
      const visibleChildren = active
        ? expanded
          ? children
          : children.slice(0, COLLAPSED_CHILD_SESSION_LIMIT)
        : [];
      for (const child of visibleChildren) {
        append(child);
      }
      const hiddenCount = Math.max(0, children.length - COLLAPSED_CHILD_SESSION_LIMIT);
      if (active && (children.length > COLLAPSED_CHILD_SESSION_LIMIT || expanded || childrenHasMore[stateKey])) {
        out.push({
          type: "child-toggle",
          parent: item,
          loadedChildCount: children.length,
          hiddenCount,
          expanded,
        });
      }
    };
    topLevel.forEach((item) => append(item));
    return out;
  };

  const handleChildToggle = async (
    row: Extract<VisibleSessionRow, { type: "child-toggle" }>,
    groupSessions: SessionItem[],
    fallbackRootId: string,
  ) => {
    const parentKey = row.parent.key;
    const stateKey = childStateKey(row.parent, fallbackRootId);
    if (!row.expanded) {
      setExpandedChildren((prev) => ({ ...prev, [stateKey]: true }));
      await loadChildren(row.parent);
      return;
    }
    if (childrenHasMore[stateKey]) {
      const lastChild = groupSessions
        .filter((item) => item.parent_session_key === parentKey)
        .sort((left, right) => (Date.parse(left.updated_at || "") || 0) - (Date.parse(right.updated_at || "") || 0))[0];
      await loadChildren(row.parent, lastChild?.updated_at);
    } else {
      setExpandedChildren((prev) => ({ ...prev, [stateKey]: false }));
    }
  };

  const handleProjectToggle = async (group: ProjectSessionGroup) => {
    const expanded = !!expandedProjects[group.rootId];
    const remaining = Math.max(0, group.totalCount - group.sessions.length);
    if (!expanded) {
      setExpandedProjects((prev) => ({ ...prev, [group.rootId]: true }));
      if (remaining > 0 && onLoadMoreProject) {
        setLoadingProjects((prev) => ({ ...prev, [group.rootId]: true }));
        try {
          await onLoadMoreProject(group);
        } finally {
          setLoadingProjects((prev) => ({ ...prev, [group.rootId]: false }));
        }
      }
      return;
    }
    if (remaining > 0 && onLoadMoreProject) {
      setLoadingProjects((prev) => ({ ...prev, [group.rootId]: true }));
      try {
        await onLoadMoreProject(group);
      } finally {
        setLoadingProjects((prev) => ({ ...prev, [group.rootId]: false }));
      }
    } else {
      setExpandedProjects((prev) => ({ ...prev, [group.rootId]: false }));
    }
  };

  const handleProjectCollapse = (rootId: string) => {
    setExpandedProjects((prev) => ({ ...prev, [rootId]: false }));
  };

  const topLevelSessionsForGroup = (sessions: SessionItem[]) =>
    sessions.filter((session) => !String(session.parent_session_key || "").trim());

  const sessionsForTopLevelLimit = (sessions: SessionItem[], limit: number) => {
    const topLevel = topLevelSessionsForGroup(sessions);
    if (limit >= topLevel.length) {
      return sessions;
    }
    const visibleParentKeys = new Set(topLevel.slice(0, limit).map((session) => session.key));
    return sessions.filter((session) => {
      const parentKey = String(session.parent_session_key || "").trim();
      return !parentKey ? visibleParentKeys.has(session.key) : visibleParentKeys.has(parentKey);
    });
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "transparent" }}>
      <div
        style={{
          height: "36px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 10px 0 2px",
          borderBottom: "1px solid var(--border-color)",
          background: "var(--mindfs-topbar-bg, transparent)",
          flexShrink: 0,
          boxSizing: "border-box",
        }}
      >
        <div style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
          {onSearchToggle ? (
            <button
              type="button"
              aria-label="搜索当前项目会话"
              title="搜索当前项目会话"
              onClick={onSearchToggle}
              style={{
                width: "34px",
                height: "34px",
                minWidth: "34px",
                border: "none",
                borderRadius: "8px",
                padding: 0,
                background: "transparent",
                color: "var(--text-secondary)",
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
        {headerAction ? <div style={{ display: "inline-flex", alignItems: "center" }}>{headerAction}</div> : null}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "8px" }}>
        {loading && groups.length === 0 ? (
          <div style={{ fontSize: "12px", color: "var(--text-secondary)", padding: "18px", textAlign: "center" }}>加载中...</div>
        ) : groups.length === 0 ? (
          <div style={{ fontSize: "12px", color: "var(--text-secondary)", minHeight: "100%", padding: "12px 18px", display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", lineHeight: 1.6 }}>
            {emptyText}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "9px" }}>
            {orderedGroups.map((group) => {
              const expanded = !!expandedProjects[group.rootId];
              const pinned = !!pinnedProjects[group.rootId];
              const topLevelSessions = topLevelSessionsForGroup(group.sessions);
              const sessions = expanded
                ? group.sessions
                : sessionsForTopLevelLimit(group.sessions, MULTI_PROJECT_VISIBLE_LIMIT);
              const rows = buildRows(sessions, group.rootId);
              const childCountByParent = new Map<string, number>();
              const sessionKeys = new Set(group.sessions.map((item) => item.key));
              for (const item of group.sessions) {
                const parentKey = String(item.parent_session_key || "").trim();
                if (parentKey && sessionKeys.has(parentKey)) {
                  childCountByParent.set(parentKey, (childCountByParent.get(parentKey) || 0) + 1);
                }
              }
              const remaining = Math.max(0, group.totalCount - topLevelSessions.length);
              const projectLoading = !!loadingProjects[group.rootId];
              return (
                <section key={group.rootId} style={{ minWidth: 0 }}>
                  <div
                    style={{
                      minWidth: 0,
                      height: "22px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "8px",
                      padding: "0 24px 0 2px",
                      background: "transparent",
                      boxSizing: "border-box",
                      position: "relative",
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        height: "1px",
                        flex: 1,
                        minWidth: "12px",
                        background: "var(--border-color)",
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => onProjectClick?.(group.rootId)}
                      style={{
                        ...rootBadgeButtonStyle,
                        flexShrink: 1,
                        maxWidth: "100%",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        cursor: onProjectClick ? "pointer" : "default",
                      }}
                    >
                      {group.rootName || group.rootId}
                    </button>
                    <span
                      aria-hidden="true"
                      style={{
                        height: "1px",
                        flex: 1,
                        minWidth: "12px",
                        background: "var(--border-color)",
                      }}
                    />
                    <button
                      type="button"
                      aria-label={pinned ? "取消置顶项目" : "置顶项目"}
                      title={pinned ? "取消置顶" : "置顶"}
                      onClick={() => togglePinnedProject(group.rootId)}
                      style={{
                        position: "absolute",
                        right: 0,
                        top: "50%",
                        transform: "translateY(-50%)",
                        width: "20px",
                        height: "20px",
                        border: "none",
                        borderRadius: "6px",
                        padding: 0,
                        background: "transparent",
                        color: pinned ? "#4b5563" : "var(--text-secondary)",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        cursor: "pointer",
                        opacity: pinned ? 1 : 0.72,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = "rgba(0,0,0,0.05)";
                        e.currentTarget.style.opacity = "1";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "transparent";
                        e.currentTarget.style.opacity = pinned ? "1" : "0.72";
                      }}
                    >
                      <PinIcon pinned={pinned} />
                    </button>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "2px", paddingTop: 0 }}>
                    {rows.map((row) => {
                      if (row.type === "child-toggle") {
                        const stateKey = childStateKey(row.parent, group.rootId);
                        const loadingChild = !!loadingChildren[stateKey];
                        const hasMoreChildren = !!childrenHasMore[stateKey];
                        const label = loadingChild
                          ? "加载中..."
                          : row.expanded
                            ? hasMoreChildren
                              ? "加载更多子会话"
                              : "收起"
                            : row.hiddenCount > 0
                              ? `还有 ${row.hiddenCount} 个子会话`
                              : "展开子会话";
                        return (
                          <ToggleRowButton
                            key={`children-toggle-${group.rootId}-${row.parent.key}`}
                            loading={loadingChild}
                            label={label}
                            showExpandIcon={!loadingChild && (!row.expanded || hasMoreChildren)}
                            showCollapseIcon={!loadingChild && row.expanded}
                            marginLeft={SUB_SESSION_ICON_OFFSET}
                            onClick={() => void handleChildToggle(row, group.sessions, group.rootId)}
                            onCollapse={() =>
                              setExpandedChildren((prev) => ({
                                ...prev,
                                [childStateKey(row.parent, group.rootId)]: false,
                              }))
                            }
                          />
                        );
                      }
                      const session = row.session;
                      const sessionRoot = session.root_id || group.rootId;
                      return (
                        <SessionCard
                          key={`${sessionRoot}:${session.key}`}
                          session={{ ...session, root_id: sessionRoot }}
                          sessionByKey={sessionByKey}
                          selected={session.key === selectedKey && sessionRoot === selectedRootId}
                          parentHighlighted={false}
                          highlightQuery=""
                          syncing={isSessionSyncing({ ...session, root_id: sessionRoot }, syncingSessionKeys)}
                          childCount={childCountByParent.get(session.key) || 0}
                          onSelect={onSelect}
                          onSync={onSync}
                          onRename={onRename}
                          onDelete={onDelete}
                        />
                      );
                    })}
                    {group.totalCount > MULTI_PROJECT_VISIBLE_LIMIT ? (
                      <ToggleRowButton
                        loading={projectLoading}
                        label={
                          projectLoading
                            ? "加载中..."
                            : expanded
                              ? remaining > 0
                                ? `还有 ${remaining} 个会话`
                                : "收起"
                              : `还有 ${Math.max(0, group.totalCount - MULTI_PROJECT_VISIBLE_LIMIT)} 个会话`
                        }
                        showExpandIcon={!projectLoading && (!expanded || remaining > 0)}
                        showCollapseIcon={!projectLoading && expanded}
                        marginLeft={MAIN_SESSION_ICON_OFFSET}
                        onClick={() => void handleProjectToggle(group)}
                        onCollapse={() => handleProjectCollapse(group.rootId)}
                      />
                    ) : null}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
      <style>{`
        @keyframes mindfs-bound-pulse {
          0%, 100% { opacity: 1; box-shadow: 0 0 0 1.5px rgba(37,99,235,0.14); }
          50% { opacity: 0.18; box-shadow: 0 0 0 4px rgba(37,99,235,0.08); }
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

function SessionCard({
  session,
  sessionByKey,
  selected,
  parentHighlighted,
  highlightQuery,
  syncing = false,
  childCount = 0,
  onSelect,
  onSync,
  onRename,
  onDelete,
}: {
  session: SessionItem;
  sessionByKey: Map<string, SessionItem>;
  selected: boolean;
  parentHighlighted?: boolean;
  highlightQuery?: string;
  syncing?: boolean;
  childCount?: number;
  onSelect?: (session: SessionItem) => void;
  onSync?: (session: SessionItem) => Promise<void> | void;
  onRename?: (session: SessionItem, nextName: string) => Promise<boolean> | boolean;
  onDelete?: (session: SessionItem) => void;
}) {
  const isClosed = !!session.closed_at;
  const isSubagent = !!session.parent_session_key;
  const forkSource = parseForkSessionSource(session.source);
  const isForkSession = !!forkSource;
  const storedName = session.name || `Session ${session.key.slice(0, 8)}`;
  const displayName = isForkSession
    ? forkSessionDisplayName(storedName, forkSource, sessionByKey, session.root_id)
    : storedName;
  const snippet = (session.search_snippet || "").trim();
  const isSearchResult = !!session.search_match_type;
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(storedName);
  const [saving, setSaving] = useState(false);
  const rowBackground = selected
    ? "rgba(59, 130, 246, 0.1)"
    : parentHighlighted
      ? "rgba(0,0,0,0.03)"
      : "transparent";
  const menuRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const composingRef = useRef(false);
  const submittingRef = useRef(false);

  useEffect(() => {
    if (!editing) {
      setDraftName(storedName);
    }
  }, [storedName, editing]);

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
    setDraftName(storedName);
  };

  const submitRename = async () => {
    if (submittingRef.current) return;
    const trimmed = draftName.trim();
    if (!trimmed) {
      cancelEditing();
      return;
    }
    if (trimmed === storedName.trim()) {
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
        paddingLeft: isSubagent ? "10px" : 0,
      }}
    >
      <div
        style={{
          textAlign: "left" as const,
          padding: "7px 4px 7px 2px",
          borderRadius: "8px",
          border: "1px solid transparent",
          background: rowBackground,
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          gap: isSubagent ? "3px" : "6px",
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
            {isSubagent ? (
              isForkSession ? (
                <ForkSessionIcon />
              ) : (
                <SubSessionIcon />
              )
            ) : (
              isForkSession ? (
                <ForkSessionIcon />
              ) : (
                <ModeIcon type={session.task_id ? "task" : session.type || "chat"} size={16} />
              )
            )}
            {!isSubagent && session.type === "command" ? (
              <span
                title={session.shell || "shell"}
                style={{
                  position: "absolute",
                  right: "-8px",
                  bottom: "-4px",
                  minWidth: 0,
                  maxWidth: "26px",
                  height: "auto",
                  padding: "1px 3px",
                  borderRadius: "5px",
                  background: "#1d4ed8",
                  border: "none",
                  color: "#fff",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: "7px",
                  fontWeight: 700,
                  lineHeight: 1.1,
                  letterSpacing: 0,
                }}
              >
                {shellBadgeLabel(session.shell)}
              </span>
            ) : !isSubagent ? (
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
            ) : null}
            {!isSubagent && childCount > 0 ? (
              <span
                title={`${childCount} 个子会话`}
                style={{
                  position: "absolute",
                  right: "-7px",
                  top: "-7px",
                  minWidth: "14px",
                  height: "14px",
                  padding: "0 3px",
                  borderRadius: "999px",
                  background: "var(--accent-color)",
                  border: "1px solid var(--content-bg, #fff)",
                  color: "#fff",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  boxSizing: "border-box",
                  fontSize: "9px",
                  fontWeight: 700,
                  lineHeight: 1,
                  letterSpacing: 0,
                }}
              >
                {childCount > 99 ? "99+" : childCount}
              </span>
            ) : null}
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
              if (container && !selected && !parentHighlighted) {
                container.style.background = "rgba(0,0,0,0.03)";
              }
            }}
            onMouseLeave={(e) => {
              const container = e.currentTarget.parentElement;
              if (container && !selected && !parentHighlighted) {
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
            minWidth: "24px",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            paddingLeft: "2px",
          }}
        >
          {syncing ? (
            <span
              aria-label="同步中"
              title="同步中"
              style={{
                width: "12px",
                height: "12px",
                borderRadius: "50%",
                border: "1.5px solid rgba(100,116,139,0.35)",
                borderTopColor: "var(--accent-color)",
                display: "inline-block",
                flexShrink: 0,
                animation: "spin 0.8s linear infinite",
              }}
            />
          ) : session.pending ? (
            <span
              aria-label="正在回复"
              title="正在回复"
              style={{
                width: "8px",
                height: "8px",
                borderRadius: "999px",
                flexShrink: 0,
                boxSizing: "border-box",
                border: "1.5px solid #2563eb",
                background: "#2563eb",
                animation: "mindfs-bound-pulse 2.2s ease-in-out infinite",
                boxShadow: "0 0 0 1.5px rgba(37,99,235,0.14)",
              }}
            />
          ) : (
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
                  : session.updated_at || "",
              )}
            </span>
          )}
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
              disabled={syncing}
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen(false);
                void onSync?.(session);
              }}
              style={{
                ...menuItemStyle,
                color: "var(--text-primary)",
                opacity: syncing ? 0.55 : 1,
                cursor: syncing ? "default" : "pointer",
              }}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="13"
                height="13"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  fill="currentColor"
                  d="M19.91 15.51h-4.53a1 1 0 0 0 0 2h2.4A8 8 0 0 1 4 12a1 1 0 0 0-2 0a10 10 0 0 0 16.88 7.23V21a1 1 0 0 0 2 0v-4.5a1 1 0 0 0-.97-.99M12 2a10 10 0 0 0-6.88 2.77V3a1 1 0 0 0-2 0v4.5a1 1 0 0 0 1 1h4.5a1 1 0 0 0 0-2h-2.4A8 8 0 0 1 20 12a1 1 0 0 0 2 0A10 10 0 0 0 12 2"
                />
              </svg>
              同步
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen(false);
                setDraftName(storedName);
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

function SubSessionIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 32 32"
      aria-hidden="true"
      style={{ color: "var(--accent-color)", display: "block" }}
    >
      <path d="M0 0h32v32H0z" fill="none" />
      <path
        fill="currentColor"
        d="M23 20c-2.41 0-4.43 1.72-4.9 4H14c-2.21 0-4-1.79-4-4v-8.1A5 5 0 1 0 4 7c0 2.41 1.72 4.43 4 4.9V20c0 3.31 2.69 6 6 6h4.1a5 5 0 1 0 4.9-6M6 7c0-1.65 1.35-3 3-3s3 1.35 3 3s-1.35 3-3 3s-3-1.35-3-3"
      />
    </svg>
  );
}

function ForkSessionIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="22"
      height="22"
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{
        color: "var(--accent-color)",
        display: "block",
        transform: "rotate(180deg) scaleX(-1)",
      }}
    >
      <path d="M0 0h24v24H0z" fill="none" />
      <path
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
        d="M17 7a2 2 0 1 0 0-4a2 2 0 0 0 0 4M7 7a2 2 0 1 0 0-4a2 2 0 0 0 0 4m0 14a2 2 0 1 0 0-4a2 2 0 0 0 0 4M7 7v10M17 7v1c0 2.5-2 3-2 3l-6 2s-2 .5-2 3v1"
      />
      <circle cx="17" cy="5" r="2" fill="currentColor" />
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

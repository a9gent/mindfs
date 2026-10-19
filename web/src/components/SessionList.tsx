import React, { useEffect, useMemo, useRef, useState } from "react";
import { AgentIcon } from "./AgentIcon";
import { PinIcon } from "./PinIcon";
import { ModeIcon } from "./ModeIcon";
import { rootBadgeButtonStyle, rootBadgeStyle } from "./rootBadgeStyle";
import { menuPopoverCapStyle } from "./popoverStyles";
import { useAnchoredPopover } from "./useAnchoredPopover";
import { useI18n, type Locale } from "../i18n";
import { copyText } from "../services/clipboard";
import { reportError } from "../services/error";
import { sessionService } from "../services/session";
import {
  applySessionFilters,
  isSessionFilterActive,
  type SessionFilterState,
} from "../services/sessionFilter";
import { SessionFilterBar } from "./SessionFilterBar";

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
  pinned_at?: string | null;
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
  onAddToKanban?: (session: SessionItem) => void;
  onSearchQueryChange?: (query: string) => void;
  onSearchSubmit?: () => void;
  onSearchBlur?: () => void;
  syncingSessionKeys?: Set<string>;
  onSelect?: (session: SessionItem) => void;
  onSync?: (session: SessionItem) => Promise<void> | void;
  onPin?: (session: SessionItem, pinned: boolean) => Promise<boolean> | boolean;
  onRename?: (session: SessionItem, nextName: string) => Promise<boolean> | boolean;
  onScheduledTask?: (session: SessionItem) => void;
  onDelete?: (session: SessionItem, options?: { keepChildren?: boolean }) => void;
  onSetParent?: (session: SessionItem, parentKey: string) => Promise<boolean> | boolean;
  onHandoffPack?: (session: SessionItem) => void;
  onLoadChildren?: (
    session: SessionItem,
    options?: { beforeTime?: string },
  ) => Promise<{ hasMore?: boolean } | void> | { hasMore?: boolean } | void;
  onLoadOlder?: () => void;
  loadingOlder?: boolean;
  hasMore?: boolean;
  filter?: SessionFilterState;
  onFilterChange?: (filter: SessionFilterState) => void;
};

const COLLAPSED_CHILD_SESSION_LIMIT = 3;
const MAIN_SESSION_ICON_OFFSET = "2px";
const SUB_SESSION_ICON_OFFSET = "0px";
const PINNED_PROJECTS_STORAGE_KEY = "mindfs-pinned-session-projects";
// 记「已展开集合」：缺省（无记录）= 折叠，与现有 expandedProjects 语义一致
const EXPANDED_PROJECTS_STORAGE_KEY = "mindfs-session-projects-expanded";
// 顶层会话 = 没有父会话的条目；多个 memo（flatRows/cleanupCandidates）在组件
// 声明顺序上先于原先的组件内定义，提前提升到模块层避免 TDZ 报错
function topLevelSessionsForGroup(sessions: SessionItem[]): SessionItem[] {
  return sessions.filter((session) => !String(session.parent_session_key || "").trim());
}


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
  error?: string;
  onRetryLoad?: () => void;
  emptyText?: React.ReactNode;
  syncingSessionKeys?: Set<string>;
  onSearchToggle?: () => void;
  onSelect?: (session: SessionItem) => void;
  onSync?: (session: SessionItem) => Promise<void> | void;
  onPin?: (session: SessionItem, pinned: boolean) => Promise<boolean> | boolean;
  onRename?: (session: SessionItem, nextName: string) => Promise<boolean> | boolean;
  onScheduledTask?: (session: SessionItem) => void;
  onDelete?: (session: SessionItem, options?: { keepChildren?: boolean }) => void;
  onSetParent?: (session: SessionItem, parentKey: string) => Promise<boolean> | boolean;
  onHandoffPack?: (session: SessionItem) => void;
  onAddToKanban?: (session: SessionItem) => void;
  onProjectClick?: (rootId: string) => void;
  onLoadMoreProject?: (group: ProjectSessionGroup) => Promise<void> | void;
  onLoadChildren?: (
    session: SessionItem,
    options?: { beforeTime?: string },
  ) => Promise<{ hasMore?: boolean } | void> | { hasMore?: boolean } | void;
  filter?: SessionFilterState;
  onFilterChange?: (filter: SessionFilterState) => void;
  flatMode?: boolean;
  /** 项目组折叠时预览显示的会话数量：0 = 完整折叠（默认），可选 1/2/3 */
  collapsedPreviewCount?: number;
  onBatchDelete?: (sessions: SessionItem[]) => Promise<void> | void;
  currentSessionKey?: string;
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
  const { t } = useI18n();
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
            aria-label={t("common.collapse")}
            title={t("common.collapse")}
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
  // The persisted name is authoritative, including user edits to fork titles.
  if (storedName.trim()) return storedName;
  if (!source) return storedName;
  const parentName = String(
    sessionByKey.get(rootId ? `${rootId}:${source.sessionKey}` : source.sessionKey)?.name ||
      sessionByKey.get(source.sessionKey)?.name ||
      "",
  ).trim();
  const base = parentName || "Fork";
  return source.seq > 0 ? `${base}#${source.seq}` : base;
}

// A fork is a user-visible session that happens to hang off another session, so
// it must show up without the parent being selected. Subagent sessions are
// internal detail and stay collapsed until their parent is active.
function shouldExpandChildren(
  active: boolean,
  children: SessionItem[],
): boolean {
  return active || children.some((child) => !!parseForkSessionSource(child.source));
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
  emptyText = "",
  onSearchToggle,
  onSearchBack,
  onAddToKanban,
  onSearchQueryChange,
  onSearchSubmit,
  onSearchBlur,
  syncingSessionKeys,
  onSelect,
  onSync,
  onPin,
  onRename,
  onScheduledTask,
  onDelete,
  onSetParent,
  onHandoffPack,
  onLoadChildren,
  onLoadOlder,
  loadingOlder = false,
  hasMore = false,
  filter,
  onFilterChange,
}: SessionListProps) {
  const { locale, t } = useI18n();
  const effectiveEmptyText = emptyText || t("sessionList.empty");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchBlurTimerRef = useRef<number | null>(null);
  const [expandedChildren, setExpandedChildren] = useState<Record<string, boolean>>({});
  const [loadingChildren, setLoadingChildren] = useState<Record<string, boolean>>({});
  const [childrenHasMore, setChildrenHasMore] = useState<Record<string, boolean>>({});
  const filterActive = !!filter && !!onFilterChange && !searchResultsMode && isSessionFilterActive(filter);
  const filteredSessions = useMemo(() => {
    if (!filter || !filterActive) {
      return null;
    }
    return applySessionFilters(sessions, filter);
  }, [filter, filterActive, sessions]);
  // 筛空提示的数据源用未过滤列表：空态里告诉用户"最近的一条其实在多久之前"
  const nearestSession = useMemo(() => latestSessionOf(sessions), [sessions]);
  const effectiveSessions = useMemo(
    () => (filteredSessions ? [...filteredSessions.running, ...filteredSessions.rest] : sessions),
    [filteredSessions, sessions],
  );
  const visibleSessions = useMemo(() => {
    if (searchResultsMode) {
      return sessions.map((session): VisibleSessionRow => ({ type: "session", session }));
    }
    const childrenByParent = new Map<string, SessionItem[]>();
    const topLevel: SessionItem[] = [];
    const keys = new Set(effectiveSessions.map((item) => item.key));
    const parentByKey = new Map<string, string>();
    for (const item of effectiveSessions) {
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
      const showChildren = shouldExpandChildren(active, children);
      const visibleChildren = showChildren
        ? expanded
          ? children
          : children.slice(0, COLLAPSED_CHILD_SESSION_LIMIT)
        : [];
      for (const child of visibleChildren) {
        append(child);
      }
      const hiddenCount = Math.max(0, children.length - COLLAPSED_CHILD_SESSION_LIMIT);
      if (showChildren && (children.length > COLLAPSED_CHILD_SESSION_LIMIT || expanded || childrenHasMore[item.key])) {
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
  }, [childrenHasMore, effectiveSessions, expandedChildren, searchResultsMode, selectedKey, sessions]);
  const childCountByParent = useMemo(() => {
    const counts = new Map<string, number>();
    const keys = new Set(effectiveSessions.map((item) => item.key));
    for (const item of effectiveSessions) {
      const parentKey = String(item.parent_session_key || "").trim();
      if (parentKey && keys.has(parentKey)) {
        counts.set(parentKey, (counts.get(parentKey) || 0) + 1);
      }
    }
    return counts;
  }, [effectiveSessions]);
  const selectedParentKey = useMemo(() => {
    if (!selectedKey) return "";
    return effectiveSessions.find((item) => item.key === selectedKey)?.parent_session_key || "";
  }, [selectedKey, effectiveSessions]);
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
        width: "100%",
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: "transparent",
      }}
    >
      {/* 统一的 Header 边栏 */}
      <div
        data-onboarding="session-actions"
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
            aria-label={t("sessionList.back")}
            style={iconButtonStyle(false)}
          >
            <ChevronLeftIcon />
          </button>
        ) : (
          <div style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
            {onSearchToggle ? (
              <button
                type="button"
                aria-label={searchOpen ? t("sessionList.closeSearch") : t("sessionList.search")}
                title={searchOpen ? t("sessionList.closeSearch") : t("sessionList.search")}
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
                aria-label={t("sessionList.searching")}
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
              placeholder={t("sessionList.searchPlaceholder")}
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
                aria-label={t("sessionList.clearSearch")}
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

      {filter && onFilterChange && !searchResultsMode ? (
        <SessionFilterBar filter={filter} onChange={onFilterChange} />
      ) : null}

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "8px" }}>
        {!effectiveSessions.length ? (
          filterActive && sessions.length ? (
            <div
              style={{
                fontSize: "12px",
                color: "var(--text-secondary)",
                minHeight: "100%",
                padding: "12px 18px",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                textAlign: "center",
                lineHeight: 1.6,
              }}
            >
              <div>{t("sessionList.noFilterMatch")}</div>
              {nearestSession ? (
                <div style={{ marginTop: "8px" }}>
                  {t("sessionList.filterNearestHint", {
                    name: nearestSession.name || `Session ${nearestSession.session_key.slice(0, 8)}`,
                    time: formatTime(
                      nearestSession.updated_at || nearestSession.created_at || "",
                      locale,
                      t("time.justNow"),
                    ),
                  })}
                </div>
              ) : null}
              <div style={{ marginTop: "6px", opacity: 0.75 }}>{t("sessionList.filterEmptyGuide")}</div>
            </div>
          ) : emptyText ? (
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
              {effectiveEmptyText}
            </div>
          ) : null
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
            {filterActive && filteredSessions && filteredSessions.running.length > 0 ? (
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "4px 6px 6px",
                  fontSize: "11px",
                  color: "var(--text-secondary)",
                  letterSpacing: "0.02em",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: "6px",
                    height: "6px",
                    borderRadius: "50%",
                    background: "#ef4444",
                    flexShrink: 0,
                  }}
                />
                {t("sessionList.runningSection", { count: filteredSessions.running.length })}
              </div>
            ) : null}
            {visibleSessions.map((row) => {
              if (row.type === "child-toggle") {
                const loading = !!loadingChildren[row.parent.key];
                const hasMoreChildren = !!childrenHasMore[row.parent.key];
                const label = loading
                  ? t("sessionList.loading")
                  : row.expanded
                    ? hasMoreChildren
                      ? t("sessionList.loadMoreChildren")
                      : t("common.collapse")
                    : row.hiddenCount > 0
                      ? t("sessionList.remainingChildren", { count: row.hiddenCount })
                      : t("sessionList.expandChildren");
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
                  onPin={onPin}
                  onRename={onRename}
                  onScheduledTask={onScheduledTask}
                  onDelete={onDelete}
                  onSetParent={onSetParent}
                  onHandoffPack={onHandoffPack}
                  onAddToKanban={onAddToKanban}
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
                {loadingOlder ? t("sessionList.loading") : t("sessionList.loadMore")}
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
  error = "",
  onRetryLoad,
  emptyText = "",
  syncingSessionKeys,
  onSearchToggle,
  onSelect,
  onSync,
  onPin,
  onRename,
  onScheduledTask,
  onDelete,
  onSetParent,
  onProjectClick,
  onLoadMoreProject,
  onLoadChildren,
  onHandoffPack,
  onAddToKanban,
  filter,
  onFilterChange,
  flatMode = false,
  collapsedPreviewCount = 0,
  onBatchDelete,
  currentSessionKey = "",
}: ProjectSessionListProps) {
  const { locale, t } = useI18n();
  const effectiveEmptyText = emptyText || t("sessionList.empty");
  const waitForEncryptionText = t("sessionList.waitForEncryption");
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>(() => {
    if (typeof window === "undefined") {
      return {};
    }
    try {
      const parsed = JSON.parse(window.localStorage.getItem(EXPANDED_PROJECTS_STORAGE_KEY) || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      const next: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (key && value === true) {
          next[key] = true;
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
    window.localStorage.setItem(EXPANDED_PROJECTS_STORAGE_KEY, JSON.stringify(expandedProjects));
  }, [expandedProjects]);
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
  const filterActive = !!filter && !!onFilterChange && isSessionFilterActive(filter);
  const filteredGroups = useMemo(() => {
    if (!filter || !filterActive) {
      return null;
    }
    const now = Date.now();
    return groups
      .map((group) => {
        const result = applySessionFilters(group.sessions, filter, now);
        const matchCount = result.running.length + result.rest.length;
        const unloaded = Math.max(0, group.totalCount - group.sessions.length);
        return {
          ...group,
          sessions: [...result.running, ...result.rest],
          // 剩余计数基于「未加载 + 命中」，避免被移到置顶区的运行中会话被重复计入
          totalCount: unloaded + matchCount,
        };
      })
      .filter((group) => group.sessions.length > 0 || group.totalCount > group.sessions.length);
  }, [filter, filterActive, groups]);
  const effectiveGroups = filteredGroups ?? groups;
  // 筛空提示：跨所有已加载分组找最近一条（与过滤无关，专供空态展示）
  const nearestSession = useMemo(
    () => latestSessionOf(groups.flatMap((group) => group.sessions)),
    [groups],
  );
  // 筛选态下「加载更多/剩余计数」必须用未过滤的原始分组，否则分页游标错位
  const originalGroupByRootId = useMemo(() => {
    const byRoot = new Map<string, ProjectSessionGroup>();
    for (const group of groups) {
      byRoot.set(group.rootId, group);
    }
    return byRoot;
  }, [groups]);
  const loadTargetGroup = (group: ProjectSessionGroup): ProjectSessionGroup =>
    originalGroupByRootId.get(group.rootId) ?? group;
  const orderedGroups = useMemo(
    () =>
      effectiveGroups.slice().sort((left, right) => {
        const leftPinnedAt = pinnedProjects[left.rootId] || 0;
        const rightPinnedAt = pinnedProjects[right.rootId] || 0;
        if (leftPinnedAt || rightPinnedAt) {
          if (leftPinnedAt !== rightPinnedAt) {
            return rightPinnedAt - leftPinnedAt;
          }
        }
        return 0;
      }),
    [effectiveGroups, pinnedProjects],
  );
  // ---- 平铺模式：已置顶专区之下，普通会话按项目分组展示（保留置顶父会话的子会话） ----
  const flatGroups = useMemo(() => {
    if (!flatMode) return null;
    const sortAsc = filter?.sortAsc ?? false;
    const tsOf = (session: SessionItem) =>
      Date.parse(session.updated_at || session.created_at || "") || 0;
    return orderedGroups.map((group) => {
      const topLevel = topLevelSessionsForGroup(group.sessions);
      const pinned = topLevel.filter((session) => !!session.pinned_at);
      const unpinned = topLevel.filter((session) => !session.pinned_at);
      // 置顶父会话的子会话保留在组内（与分组模式 unpinnedSessions 管线一致）
      const childrenOfPinned = pinned.length
        ? group.sessions.filter((session) => {
            const parentKey = String(session.parent_session_key || "").trim();
            return parentKey && pinned.some((pinnedSession) => pinnedSession.key === parentKey);
          })
        : [];
      // 平铺模式只从顶层会话起排，但 fork 链的子会话必须跟着父会话一起进来：
      // 少了它们，列表里就只剩父会话，fork 看起来像"没生成"。
      const roots = [...unpinned, ...childrenOfPinned];
      const included = new Set(roots.map((session) => session.key));
      const descendants: SessionItem[] = [];
      let grew = true;
      while (grew) {
        grew = false;
        for (const session of group.sessions) {
          if (included.has(session.key)) continue;
          const parentKey = String(session.parent_session_key || "").trim();
          if (parentKey && included.has(parentKey)) {
            included.add(session.key);
            descendants.push(session);
            grew = true;
          }
        }
      }
      const sessions = [...roots, ...descendants].sort((left, right) =>
        sortAsc ? tsOf(left) - tsOf(right) : tsOf(right) - tsOf(left),
      );
      return { group, sessions, latestTs: sessions.reduce((acc, s) => Math.max(acc, tsOf(s)), 0) };
    }).sort((left, right) => right.latestTs - left.latestTs);
  }, [flatMode, orderedGroups, filter?.sortAsc]);
  const flatPinnedRows = useMemo(() => {
    if (!flatMode) return [];
    const sortAsc = filter?.sortAsc ?? false;
    const rows = orderedGroups.flatMap((group) =>
      topLevelSessionsForGroup(group.sessions)
        .filter((session) => !!session.pinned_at)
        .map((session) => ({
          session: { ...session, root_id: session.root_id || group.rootId },
          rootName: group.rootName || group.rootId,
        })),
    );
    rows.sort((left, right) => {
      const leftTs = Date.parse(left.session.pinned_at || left.session.updated_at || "") || 0;
      const rightTs = Date.parse(right.session.pinned_at || right.session.updated_at || "") || 0;
      return sortAsc ? leftTs - rightTs : rightTs - leftTs;
    });
    return rows;
  }, [flatMode, orderedGroups, filter?.sortAsc]);

  // ---- 清理闲置：多选模式状态 ----
  const [cleanupMode, setCleanupMode] = useState(false);
  const [cleanupAgeDays, setCleanupAgeDays] = useState<0 | 3 | 5 | 7>(7);
  const [cleanupOldestFirst, setCleanupOldestFirst] = useState(true);
  const [cleanupSelected, setCleanupSelected] = useState<Set<string>>(new Set());
  const [cleanupConfirmOpen, setCleanupConfirmOpen] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);

  // 清理候选：顶层、已加载、非运行中、未绑定看板任务、非当前打开
  const cleanupCandidates = useMemo(() => {
    if (!cleanupMode) return [] as { session: SessionItem; rootName: string }[];
    const cutoff = cleanupAgeDays > 0 ? Date.now() - cleanupAgeDays * 86400000 : 0;
    const list = orderedGroups.flatMap((group) =>
      topLevelSessionsForGroup(group.sessions)
        .map((session) => ({ ...session, root_id: session.root_id || group.rootId }))
        .filter((session) => {
          if (session.pending) return false;
          if (session.task_id) return false;
          if (session.key && session.key === currentSessionKey) return false;
          if (cleanupAgeDays > 0) {
            const ts = Date.parse(session.updated_at || session.created_at || "") || 0;
            if (!ts || ts > cutoff) return false;
          }
          return true;
        })
        .map((session) => ({ session, rootName: group.rootName || group.rootId })),
    );
    list.sort((left, right) => {
      const leftTs = Date.parse(left.session.updated_at || left.session.created_at || "") || 0;
      const rightTs = Date.parse(right.session.updated_at || right.session.created_at || "") || 0;
      return cleanupOldestFirst ? leftTs - rightTs : rightTs - leftTs;
    });
    return list;
  }, [cleanupMode, cleanupAgeDays, cleanupOldestFirst, orderedGroups, currentSessionKey]);

  useEffect(() => {
    if (!cleanupMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setCleanupMode(false);
        setCleanupSelected(new Set());
        setCleanupConfirmOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cleanupMode]);

  const exitCleanupMode = () => {
    setCleanupMode(false);
    setCleanupSelected(new Set());
    setCleanupConfirmOpen(false);
  };

  const toggleCleanupSession = (rootId: string, key: string) => {
    const id = `${rootId}:${key}`;
    setCleanupSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runBatchDelete = async () => {
    if (!onBatchDelete || cleanupBusy) return;
    const targets = cleanupCandidates.filter((item) =>
      cleanupSelected.has(`${item.session.root_id}:${item.session.key}`),
    );
    if (targets.length === 0) return;
    setCleanupBusy(true);
    try {
      await onBatchDelete(targets.map((item) => item.session));
    } finally {
      setCleanupBusy(false);
      exitCleanupMode();
    }
  };

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
  const togglePinnedProjectExpanded = (rootId: string) => {
    setExpandedProjects((prev) => {
      const next = { ...prev };
      if (next[rootId]) {
        delete next[rootId];
      } else {
        next[rootId] = true;
      }
      return next;
    });
  };
  const sessionByKey = useMemo(() => {
    const byKey = new Map<string, SessionItem>();
    // 用未过滤的原始分组：fork 名/父会话查找不应随筛选结果缩水
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
      const showChildren = shouldExpandChildren(active, children);
      const visibleChildren = showChildren
        ? expanded
          ? children
          : children.slice(0, COLLAPSED_CHILD_SESSION_LIMIT)
        : [];
      for (const child of visibleChildren) {
        append(child);
      }
      const hiddenCount = Math.max(0, children.length - COLLAPSED_CHILD_SESSION_LIMIT);
      if (showChildren && (children.length > COLLAPSED_CHILD_SESSION_LIMIT || expanded || childrenHasMore[stateKey])) {
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
    // 用原始分组算剩余（未加载）数：筛选副本的 sessions 是命中子集；
    // 置顶会话已在顶部专区展示但仍算已加载，不参与剩余数
    const source = loadTargetGroup(group);
    const remaining = Math.max(
      0,
      source.totalCount - topLevelSessionsForGroup(source.sessions).length,
    );
    if (!expanded) {
      setExpandedProjects((prev) => ({ ...prev, [group.rootId]: true }));
      if (remaining > 0 && onLoadMoreProject) {
        setLoadingProjects((prev) => ({ ...prev, [group.rootId]: true }));
        try {
          await onLoadMoreProject(source);
        } finally {
          setLoadingProjects((prev) => ({ ...prev, [group.rootId]: false }));
        }
      }
      return;
    }
    if (remaining > 0 && onLoadMoreProject) {
      setLoadingProjects((prev) => ({ ...prev, [group.rootId]: true }));
      try {
        await onLoadMoreProject(source);
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

  const sessionsForTopLevelLimit = (sessions: SessionItem[], limit: number) => {
    const topLevel = topLevelSessionsForGroup(sessions);
    if (limit >= topLevel.length) {
      return sessions;
    }
    const included = new Set(topLevel.slice(0, limit).map((session) => session.key));
    // Take the whole descendant closure, not just direct children: a fork chain
    // (main → fork → fork2) is three levels deep, and keeping only one level
    // hides exactly the newest session the user cares about.
    let grew = true;
    while (grew) {
      grew = false;
      for (const session of sessions) {
        if (included.has(session.key)) continue;
        const parentKey = String(session.parent_session_key || "").trim();
        if (parentKey && included.has(parentKey)) {
          included.add(session.key);
          grew = true;
        }
      }
    }
    return sessions.filter((session) => included.has(session.key));
  };

  // 折叠预览：取前 limit 个顶层会话（含其子会话）；limit=0 返回空数组（完整折叠）
  const collapsedPreviewSessions = (sessions: SessionItem[], limit: number) => {
    if (limit <= 0) return [] as SessionItem[];
    return sessionsForTopLevelLimit(sessions, limit);
  };

  return (
    <div style={{ flex: 1, width: "100%", minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", background: "transparent" }}>
      <div
        data-onboarding="session-actions"
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
          {onBatchDelete && orderedGroups.length > 0 ? (
            <button
              type="button"
              aria-label={cleanupMode ? t("sessionList.cleanupExit") : t("sessionList.cleanupIdle")}
              title={cleanupMode ? t("sessionList.cleanupExit") : t("sessionList.cleanupIdle")}
              onClick={() => {
                if (cleanupMode) exitCleanupMode();
                else setCleanupMode(true);
              }}
              style={{
                width: "34px",
                height: "34px",
                minWidth: "34px",
                border: "none",
                borderRadius: "8px",
                padding: 0,
                background: cleanupMode ? "var(--selection-bg)" : "transparent",
                color: cleanupMode ? "var(--accent-color)" : "var(--text-secondary)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              {cleanupMode ? (
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14H6L5 6" />
                  <path d="M10 11v6" />
                  <path d="M14 11v6" />
                </svg>
              )}
            </button>
          ) : null}
          {cleanupMode ? (
            <div style={{ display: "inline-flex", alignItems: "center", gap: "4px", flex: 1, minWidth: 0, overflow: "auto" }}>
              {(() => {
                // 三档合并为一个循环按钮：7 天 → 5 天 → 3 天 → 7 天（默认 7）。
                const cycleNext = cleanupAgeDays === 7 ? 5 : cleanupAgeDays === 5 ? 3 : 7;
                return (
                  <button
                    type="button"
                    title={t("sessionList.cleanupAgeCycle")}
                    onClick={() => { setCleanupAgeDays(cycleNext); setCleanupSelected(new Set()); }}
                    style={{
                      border: "1px solid var(--accent-color)",
                      background: "var(--selection-bg)",
                      color: "var(--accent-color)",
                      borderRadius: "999px",
                      padding: "2px 8px",
                      fontSize: "11px",
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                    }}
                  >
                    {cleanupAgeDays === 7
                      ? t("sessionList.cleanupAge7")
                      : cleanupAgeDays === 5
                        ? t("sessionList.cleanupAge5")
                        : cleanupAgeDays === 3
                          ? t("sessionList.cleanupAge3")
                          : t("sessionList.cleanupAgeAll")}
                  </button>
                );
              })()}
              <button
                type="button"
                onClick={() => { setCleanupAgeDays(0); setCleanupSelected(new Set()); }}
                style={{
                  border: "1px solid",
                  borderColor: cleanupAgeDays === 0 ? "var(--accent-color)" : "var(--border-color)",
                  background: cleanupAgeDays === 0 ? "var(--selection-bg)" : "transparent",
                  color: cleanupAgeDays === 0 ? "var(--accent-color)" : "var(--text-secondary)",
                  borderRadius: "999px",
                  padding: "2px 8px",
                  fontSize: "11px",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {t("sessionList.cleanupAgeAll")}
              </button>
              <button
                type="button"
                title={cleanupOldestFirst ? t("sessionList.cleanupOldestFirst") : t("sessionList.cleanupNewestFirst")}
                onClick={() => { setCleanupOldestFirst((prev) => !prev); setCleanupSelected(new Set()); }}
                style={{
                  border: "1px solid var(--border-color)",
                  background: "transparent",
                  color: "var(--text-secondary)",
                  borderRadius: "999px",
                  padding: "2px 8px",
                  fontSize: "11px",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {cleanupOldestFirst ? "↑" : "↓"}
              </button>
              <button
                type="button"
                onClick={() => {
                  const allSelected = cleanupCandidates.length > 0
                    && cleanupSelected.size >= cleanupCandidates.length;
                  setCleanupSelected(allSelected
                    ? new Set()
                    : new Set(cleanupCandidates.map((item) => `${item.session.root_id}:${item.session.key}`)));
                }}
                disabled={cleanupCandidates.length === 0}
                style={{
                  border: "1px solid var(--border-color)",
                  background: "transparent",
                  color: "var(--text-secondary)",
                  borderRadius: "999px",
                  padding: "2px 8px",
                  fontSize: "11px",
                  cursor: cleanupCandidates.length ? "pointer" : "default",
                  opacity: cleanupCandidates.length ? 1 : 0.5,
                  whiteSpace: "nowrap",
                }}
              >
                {cleanupSelected.size > 0 && cleanupSelected.size >= cleanupCandidates.length && cleanupCandidates.length > 0
                  ? t("sessionList.cleanupDeselectAll")
                  : t("sessionList.cleanupSelectAll")}
              </button>
              <button
                type="button"
                onClick={exitCleanupMode}
                style={{
                  border: "1px solid var(--border-color)",
                  background: "transparent",
                  color: "var(--text-secondary)",
                  borderRadius: "999px",
                  padding: "2px 8px",
                  fontSize: "11px",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {t("sessionList.cleanupExit")}
              </button>
            </div>
          ) : null}
          {orderedGroups.length > 1 ? (
            (() => {
              const anyExpanded = orderedGroups.some((group) => !!expandedProjects[group.rootId]);
              const collapseAll = () => {
                setExpandedProjects({});
              };
              const expandAll = () => {
                setExpandedProjects((prev) => {
                  const next = { ...prev };
                  for (const group of orderedGroups) {
                    next[group.rootId] = true;
                  }
                  return next;
                });
              };
              return (
                <button
                  type="button"
                  aria-label={anyExpanded ? t("sessionList.collapseAllProjects") : t("sessionList.expandAllProjects")}
                  title={anyExpanded ? t("sessionList.collapseAllProjects") : t("sessionList.expandAllProjects")}
                  onClick={() => {
                    if (anyExpanded) {
                      collapseAll();
                    } else {
                      void (async () => {
                        // 全部展开时把有未加载剩余的组也拉满，避免展开后只看到 6 条
                        setExpandedProjects((prev) => {
                          const next = { ...prev };
                          for (const group of orderedGroups) {
                            next[group.rootId] = true;
                          }
                          return next;
                        });
                        for (const group of orderedGroups) {
                          const source = loadTargetGroup(group);
                          const remaining = Math.max(
                            0,
                            source.totalCount - topLevelSessionsForGroup(source.sessions).length,
                          );
                          if (remaining > 0 && onLoadMoreProject && !loadingProjects[group.rootId]) {
                            setLoadingProjects((prev) => ({ ...prev, [group.rootId]: true }));
                            try {
                              await onLoadMoreProject(source);
                            } finally {
                              setLoadingProjects((prev) => ({ ...prev, [group.rootId]: false }));
                            }
                          }
                        }
                      })();
                    }
                  }}
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
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    {anyExpanded ? (
                      <>
                        <rect x="3" y="3" width="7" height="7" rx="1" />
                        <rect x="14" y="3" width="7" height="7" rx="1" />
                        <rect x="3" y="14" width="7" height="7" rx="1" />
                        <rect x="14" y="14" width="7" height="7" rx="1" />
                      </>
                    ) : (
                      <>
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                        <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
                      </>
                    )}
                  </svg>
                </button>
              );
            })()
          ) : null}
            <button
              type="button"
              aria-label={t("sessionList.searchCurrentProject")}
              title={t("sessionList.searchCurrentProject")}
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
          </div>
        {headerAction ? <div style={{ display: "inline-flex", alignItems: "center" }}>{headerAction}</div> : null}
      </div>
      {filter && onFilterChange ? (
        <SessionFilterBar filter={filter} onChange={onFilterChange} />
      ) : null}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "8px" }}>
        {cleanupMode ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
            {cleanupCandidates.length === 0 ? (
              <div style={{ fontSize: "12px", color: "var(--text-secondary)", padding: "18px", textAlign: "center" }}>
                {t("sessionList.noFilterMatch")}
              </div>
            ) : (
              cleanupCandidates.map(({ session, rootName }) => {
                const id = `${session.root_id}:${session.key}`;
                const checked = cleanupSelected.has(id);
                return (
                  <button
                    key={`cleanup:${id}`}
                    type="button"
                    onClick={() => toggleCleanupSession(session.root_id || "", session.key)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      width: "100%",
                      border: "none",
                      background: checked ? "rgba(59, 130, 246, 0.1)" : "transparent",
                      borderRadius: "8px",
                      padding: "7px 6px",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        width: "16px",
                        height: "16px",
                        flexShrink: 0,
                        borderRadius: "4px",
                        border: checked ? "none" : "1px solid var(--border-color)",
                        background: checked ? "var(--accent-color)" : "transparent",
                        color: "#fff",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: "11px",
                      }}
                    >
                      {checked ? "✓" : ""}
                    </span>
                    <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "12px", color: "var(--text-primary)" }}>
                      {session.name || `Session ${session.key.slice(0, 8)}`}
                    </span>
                    <span style={{ flexShrink: 0, fontSize: "10px", color: "var(--text-secondary)", padding: "0 4px", borderRadius: "5px", background: "var(--border-color)" }}>
                      {rootName}
                    </span>
                    <span style={{ flexShrink: 0, fontSize: "11px", color: "var(--text-secondary)" }}>
                      {formatTime(session.updated_at || "", locale, t("time.justNow"))}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        ) : loading && groups.length === 0 ? (
          <div style={{ fontSize: "12px", color: "var(--text-secondary)", padding: "18px", textAlign: "center" }}>{t("sessionList.loading")}</div>
        ) : !loading && groups.length === 0 && error ? (
          <div style={{ fontSize: "12px", color: "var(--text-secondary)", padding: "18px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: "8px" }}>
            <div>{error}</div>
            {error !== waitForEncryptionText && onRetryLoad ? (
              <button
                type="button"
                onClick={onRetryLoad}
                style={{
                  border: "1px solid var(--border-color)",
                  background: "transparent",
                  color: "var(--text-primary)",
                  borderRadius: "8px",
                  padding: "4px 12px",
                  fontSize: "12px",
                  cursor: "pointer",
                }}
              >
                {t("sessionList.retryLoad")}
              </button>
            ) : null}
          </div>
        ) : flatMode ? (
          <>
            {(() => {
              const pinnedRows = flatPinnedRows;
              const flatSections = flatGroups ?? [];
              const hasContent = pinnedRows.length > 0 || flatSections.some((entry) => entry.sessions.length > 0);
              if (!hasContent) {
                return (
                  <div style={{ fontSize: "12px", color: "var(--text-secondary)", padding: "12px", textAlign: "center" }}>
                    {error || effectiveEmptyText}
                  </div>
                );
              }              const renderCard = (session: SessionItem, rootId: string, rootName: string, keyPrefix: string) => (
                <SessionCard
                  key={`${keyPrefix}:${rootId}:${session.key}`}
                  session={{ ...session, root_id: session.root_id || rootId }}
                  sessionByKey={sessionByKey}
                  selected={session.key === selectedKey && (session.root_id || rootId) === selectedRootId}
                  parentHighlighted={false}
                  highlightQuery=""
                  syncing={isSessionSyncing({ ...session, root_id: session.root_id || rootId }, syncingSessionKeys)}
                  projectBadge={rootName}
                  onSelect={onSelect}
                  onSync={onSync}
                  onPin={onPin}
                  onRename={onRename}
                  onScheduledTask={onScheduledTask}
                  onDelete={onDelete}
                  onHandoffPack={onHandoffPack}
                  onAddToKanban={onAddToKanban}
                />
              );
              return (
                <>
                  {pinnedRows.length > 0 ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: "2px", paddingBottom: "6px" }}>
                      <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", padding: "4px 6px 6px", fontSize: "11px", color: "var(--text-secondary)", letterSpacing: "0.02em" }}>
                        <PinIcon pinned={true} />
                        {t("sessionList.pinnedSection")}
                      </div>
                      {pinnedRows.map(({ session, rootName }) => renderCard(session, session.root_id || "", rootName, "flat-pinned"))}
                    </div>
                  ) : null}
                  {flatSections.map(({ group, sessions }) => {
                const expanded = !!expandedProjects[group.rootId];
                const groupTopLevel = topLevelSessionsForGroup(group.sessions);
                const sourceGroup = loadTargetGroup(group);
                const remaining = Math.max(
                  0,
                  sourceGroup.totalCount - groupTopLevel.length,
                );
                const projectLoading = !!loadingProjects[group.rootId];
                const childCountByParent = new Map<string, number>();
                const sessionKeys = new Set(group.sessions.map((item) => item.key));
                for (const item of group.sessions) {
                  const parentKey = String(item.parent_session_key || "").trim();
                  if (parentKey && sessionKeys.has(parentKey)) {
                    childCountByParent.set(parentKey, (childCountByParent.get(parentKey) || 0) + 1);
                  }
                }
                // 平铺 = 真平铺：不按父子嵌套，全部会话平铺到项目标题下
                // （服务端 appendChildSessions 已随父会话带出全部子会话，
                //  load-more 也以 includeChildren 重新拉取，这里不会丢子会话）
                const visibleSessions = expanded
                  ? sessions
                  : collapsedPreviewSessions(sessions, collapsedPreviewCount);
                const rows: VisibleSessionRow[] = visibleSessions.map((session) => ({
                  type: "session" as const,
                  session,
                }));
                return (
                  <section key={`flat-group:${group.rootId}`} style={{ minWidth: 0 }}>
                    <div
                      style={{
                        minWidth: 0,
                        height: "22px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: "8px",
                        padding: "0 46px 0 2px",
                        background: "transparent",
                        boxSizing: "border-box",
                        position: "relative",
                      }}
                    >
                      <span
                        aria-hidden="true"
                        style={{ height: "1px", flex: 1, minWidth: "12px", background: "var(--border-color)" }}
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
                        style={{ height: "1px", flex: 1, minWidth: "12px", background: "var(--border-color)" }}
                      />
                      <button
                        type="button"
                        aria-label={expanded ? t("sessionList.collapseGroup") : t("sessionList.expandGroup")}
                        title={expanded ? t("sessionList.collapseGroup") : t("sessionList.expandGroup")}
                        onClick={() => togglePinnedProjectExpanded(group.rootId)}
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
                          color: "var(--text-secondary)",
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          cursor: "pointer",
                        }}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
                          style={{ transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s ease" }}
                        >
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                      </button>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: "2px", paddingTop: 0 }}>
                      {rows.map((row) => {
                        if (row.type === "child-toggle") {
                          const stateKey = childStateKey(row.parent, group.rootId);
                          const loadingChild = !!loadingChildren[stateKey];
                          const hasMoreChildren = !!childrenHasMore[stateKey];
                          const label = loadingChild
                            ? t("sessionList.loading")
                            : row.expanded
                              ? hasMoreChildren
                                ? t("sessionList.loadMoreChildren")
                                : t("common.collapse")
                              : row.hiddenCount > 0
                                ? t("sessionList.remainingChildren", { count: row.hiddenCount })
                                : t("sessionList.expandChildren");
                          return (
                            <ToggleRowButton
                              key={`flat-children-toggle-${group.rootId}-${row.parent.key}`}
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
                        return renderCard(row.session, group.rootId, group.rootName || group.rootId, "flat");
                      })}
                      {group.totalCount > Math.max(collapsedPreviewCount, 1) ? (
                        <ToggleRowButton
                          loading={projectLoading}
                          label={
                            projectLoading
                              ? t("sessionList.loading")
                              : expanded
                                ? remaining > 0
                                  ? t("sessionList.remainingSessions", { count: remaining })
                                  : t("common.collapse")
                                : t("sessionList.remainingSessions", {
                                    count: Math.max(0, group.totalCount - groupTopLevel.length),
                                  })
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
                })
                }
                </>
              );
            })()}
          </>
        ) : !flatMode && loading && groups.length === 0 ? (
          <div style={{ fontSize: "12px", color: "var(--text-secondary)", padding: "18px", textAlign: "center" }}>{t("sessionList.loading")}</div>
        ) : effectiveGroups.length === 0 ? (
          <div style={{ fontSize: "12px", color: "var(--text-secondary)", minHeight: "100%", padding: "12px 18px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", lineHeight: 1.6 }}>
            <div>{groups.length === 0 ? effectiveEmptyText : t("sessionList.noFilterMatch")}</div>
            {groups.length > 0 && nearestSession ? (
              <div style={{ marginTop: "8px" }}>
                {t("sessionList.filterNearestHint", {
                  name: nearestSession.name || `Session ${nearestSession.session_key.slice(0, 8)}`,
                  time: formatTime(
                    nearestSession.updated_at || nearestSession.created_at || "",
                    locale,
                    t("time.justNow"),
                  ),
                })}
              </div>
            ) : null}
            {groups.length > 0 ? (
              <div style={{ marginTop: "6px", opacity: 0.75 }}>{t("sessionList.filterEmptyGuide")}</div>
            ) : null}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "9px" }}>
            {orderedGroups.some((group) =>
              topLevelSessionsForGroup(group.sessions).some((session) => !!session.pinned_at),
            ) ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "2px", paddingBottom: "4px" }}>
                <div
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    padding: "4px 6px 6px",
                    fontSize: "11px",
                    color: "var(--text-secondary)",
                    letterSpacing: "0.02em",
                  }}
                >
                  <PinIcon pinned={true} />
                  {t("sessionList.pinnedSection")}
                </div>
                {orderedGroups.flatMap((group) =>
                  topLevelSessionsForGroup(group.sessions)
                    .filter((session) => !!session.pinned_at)
                    .map((session) => (
                      <SessionCard
                        key={`pinned:${group.rootId}:${session.key}`}
                        session={{ ...session, root_id: session.root_id || group.rootId }}
                        sessionByKey={sessionByKey}
                        selected={session.key === selectedKey && (session.root_id || group.rootId) === selectedRootId}
                        parentHighlighted={false}
                        highlightQuery=""
                        syncing={isSessionSyncing({ ...session, root_id: session.root_id || group.rootId }, syncingSessionKeys)}
                        projectBadge={group.rootName || group.rootId}
                        onSelect={onSelect}
                        onSync={onSync}
                        onPin={onPin}
                        onRename={onRename}
                        onScheduledTask={onScheduledTask}
                        onDelete={onDelete}
                        onHandoffPack={onHandoffPack}
                  onAddToKanban={onAddToKanban}
                      />
                    )),
                )}
              </div>
            ) : null}
            {orderedGroups.map((group) => {
              const expanded = !!expandedProjects[group.rootId];
              const pinned = !!pinnedProjects[group.rootId];
              const topLevelSessions = topLevelSessionsForGroup(group.sessions);
              // 会话级置顶（pinned_at）：抽到顶部「已置顶」专区，组内不再重复显示；
              // 置顶父会话的子会话保留在组内原位（跟随置顶父卡渲染在专区）
              const pinnedInGroup = topLevelSessions.filter((session) => !!session.pinned_at);
              const unpinnedSessions = pinnedInGroup.length > 0
                ? [
                    ...topLevelSessions.filter((session) => !session.pinned_at),
                    ...group.sessions.filter((session) => {
                      const parentKey = String(session.parent_session_key || "").trim();
                      if (!parentKey) return false;
                      return pinnedInGroup.some((pinnedSession) => pinnedSession.key === parentKey);
                    }),
                  ]
                : group.sessions;
              const sessions = expanded
                ? unpinnedSessions
                : collapsedPreviewSessions(unpinnedSessions, collapsedPreviewCount);
              const rows = buildRows(sessions, group.rootId);
              const childCountByParent = new Map<string, number>();
              const sessionKeys = new Set(group.sessions.map((item) => item.key));
              for (const item of group.sessions) {
                const parentKey = String(item.parent_session_key || "").trim();
                if (parentKey && sessionKeys.has(parentKey)) {
                  childCountByParent.set(parentKey, (childCountByParent.get(parentKey) || 0) + 1);
                }
              }
              // 剩余数用原始分组的顶层会话数推：筛选副本会把子会话混进计数。
              // 置顶会话仍属于已加载会话（只是在顶部专区展示），不计入剩余
              const sourceGroup = loadTargetGroup(group);
              const remaining = Math.max(
                0,
                sourceGroup.totalCount
                  - topLevelSessionsForGroup(sourceGroup.sessions).length,
              );
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
                      aria-label={pinned ? t("sessionList.unpinProject") : t("sessionList.pinProject")}
                      title={pinned ? t("sessionList.unpin") : t("sessionList.pin")}
                      onClick={() => togglePinnedProject(group.rootId)}
                      style={{
                        position: "absolute",
                        right: "22px",
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
                    <button
                      type="button"
                      aria-label={expanded ? t("sessionList.collapseGroup") : t("sessionList.expandGroup")}
                      title={expanded ? t("sessionList.collapseGroup") : t("sessionList.expandGroup")}
                      onClick={() => togglePinnedProjectExpanded(group.rootId)}
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
                        color: "var(--text-secondary)",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        cursor: "pointer",
                      }}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
                        style={{ transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s ease" }}
                      >
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "2px", paddingTop: 0 }}>
                    {rows.map((row) => {
                      if (row.type === "child-toggle") {
                        const stateKey = childStateKey(row.parent, group.rootId);
                        const loadingChild = !!loadingChildren[stateKey];
                        const hasMoreChildren = !!childrenHasMore[stateKey];
                        const label = loadingChild
                          ? t("sessionList.loading")
                          : row.expanded
                            ? hasMoreChildren
                              ? t("sessionList.loadMoreChildren")
                              : t("common.collapse")
                            : row.hiddenCount > 0
                              ? t("sessionList.remainingChildren", { count: row.hiddenCount })
                              : t("sessionList.expandChildren");
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
                          onPin={onPin}
                          onRename={onRename}
                          onScheduledTask={onScheduledTask}
                          onDelete={onDelete}
                          onSetParent={onSetParent}
                          onHandoffPack={onHandoffPack}
                  onAddToKanban={onAddToKanban}
                        />
                      );
                    })}
                    {group.totalCount > Math.max(collapsedPreviewCount, 1) ? (
                      <ToggleRowButton
                        loading={projectLoading}
                        label={
                          projectLoading
                            ? t("sessionList.loading")
                            : expanded
                              ? remaining > 0
                                ? t("sessionList.remainingSessions", { count: remaining })
                                : t("common.collapse")
                              : t("sessionList.remainingSessions", {
                                  count: Math.max(
                                    0,
                                    // 减实际渲染的顶层会话数而非固定上限：筛选后可见数可能不足 6
                                    (filterActive ? group.totalCount : sourceGroup.totalCount)
                                      - topLevelSessionsForGroup(group.sessions).length,
                                  ),
                                })
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
      {cleanupMode && cleanupSelected.size > 0 ? (
        <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "8px 12px", borderTop: "1px solid var(--border-color)", flexShrink: 0, background: "var(--menu-bg, transparent)" }}>
          <span style={{ fontSize: "12px", color: "var(--text-primary)", flex: 1 }}>
            {t("sessionList.cleanupSelected", { count: cleanupSelected.size })}
          </span>
          <button
            type="button"
            disabled={cleanupBusy}
            onClick={() => setCleanupConfirmOpen(true)}
            style={{
              border: "none",
              borderRadius: "8px",
              padding: "6px 14px",
              background: "#dc2626",
              color: "#fff",
              fontSize: "12px",
              cursor: cleanupBusy ? "default" : "pointer",
              opacity: cleanupBusy ? 0.6 : 1,
            }}
          >
            {t("sessionList.cleanupDelete")}
          </button>
        </div>
      ) : null}
      {cleanupConfirmOpen ? (
        <div
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setCleanupConfirmOpen(false);
          }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            zIndex: 3000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            role="dialog"
            aria-label={t("sessionList.cleanupConfirmTitle")}
            style={{
              width: "min(92vw, 360px)",
              borderRadius: "12px",
              border: "1px solid var(--border-color)",
              background: "var(--menu-bg)",
              padding: "16px",
              boxShadow: "0 12px 30px rgba(15, 23, 42, 0.2)",
            }}
          >
            <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
              {t("sessionList.cleanupConfirmTitle")}
            </div>
            <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "8px", lineHeight: 1.6 }}>
              {t("sessionList.cleanupConfirmBody", {
                count: cleanupCandidates.filter((item) => cleanupSelected.has(`${item.session.root_id}:${item.session.key}`)).length,
              })}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "14px" }}>
              <button
                type="button"
                onClick={() => setCleanupConfirmOpen(false)}
                style={{ border: "1px solid var(--border-color)", background: "transparent", borderRadius: "8px", padding: "6px 12px", fontSize: "12px", color: "var(--text-primary)", cursor: "pointer" }}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                disabled={cleanupBusy}
                onClick={() => void runBatchDelete()}
                style={{ border: "none", borderRadius: "8px", padding: "6px 12px", fontSize: "12px", background: "#dc2626", color: "#fff", cursor: cleanupBusy ? "default" : "pointer", opacity: cleanupBusy ? 0.6 : 1 }}
              >
                {cleanupBusy ? t("sessionList.cleanupDeleting") : t("common.delete")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
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
  projectBadge,
  onSelect,
  onSync,
  onPin,
  onRename,
  onScheduledTask,
  onDelete,
  onSetParent,
  onHandoffPack,
  onAddToKanban,
}: {
  session: SessionItem;
  sessionByKey: Map<string, SessionItem>;
  selected: boolean;
  parentHighlighted?: boolean;
  highlightQuery?: string;
  syncing?: boolean;
  childCount?: number;
  projectBadge?: string;
  onSelect?: (session: SessionItem) => void;
  onSync?: (session: SessionItem) => Promise<void> | void;
  onPin?: (session: SessionItem, pinned: boolean) => Promise<boolean> | boolean;
  onRename?: (session: SessionItem, nextName: string) => Promise<boolean> | boolean;
  onScheduledTask?: (session: SessionItem) => void;
  onDelete?: (session: SessionItem, options?: { keepChildren?: boolean }) => void;
  onSetParent?: (session: SessionItem, parentKey: string) => Promise<boolean> | boolean;
  onHandoffPack?: (session: SessionItem) => void;
  onAddToKanban?: (session: SessionItem) => void;
}) {
  const { locale, t } = useI18n();
  const isClosed = !!session.closed_at;
  const isPinned = !!session.pinned_at;
  const isSubagent = !!session.parent_session_key;
  const forkSource = parseForkSessionSource(session.source);
  const isForkSession = !!forkSource;
  const storedName = session.name || `Session ${session.key.slice(0, 8)}`;
  const displayName = isForkSession
    ? forkSessionDisplayName(session.name || "", forkSource, sessionByKey, session.root_id)
    : storedName;
  const snippet = (session.search_snippet || "").trim();
  const isSearchResult = !!session.search_match_type;
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyingPath, setCopyingPath] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(storedName);
  const [saving, setSaving] = useState(false);
  const rowBackground = selected
    ? "rgba(59, 130, 246, 0.1)"
    : parentHighlighted
      ? "rgba(0,0,0,0.03)"
      : "transparent";
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuPopoverRef = useRef<HTMLDivElement | null>(null);
  const menuPlacement = useAnchoredPopover(menuRef, menuPopoverRef, menuOpen);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const composingRef = useRef(false);
  const submittingRef = useRef(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copySessionValue = (value: string) => {
    setMenuOpen(false);
    setCopied(false);
    void copyText(value)
      .then(() => setCopied(true))
      .catch((err) => {
        reportError("clipboard.write_failed", String((err as Error)?.message || t("session.copyFailed")));
      });
  };

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
          padding: editing ? "7px 0 7px 2px" : "7px 4px 7px 2px",
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
                title={t("sessionList.childCount", { count: childCount })}
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
              {projectBadge ? (
                <span
                  style={{
                    display: "inline-block",
                    marginRight: "6px",
                    padding: "1px 6px",
                    borderRadius: "6px",
                    fontSize: "10px",
                    lineHeight: "16px",
                    verticalAlign: "middle",
                    color: "var(--accent-color)",
                    background: "color-mix(in srgb, var(--accent-color) 12%, transparent)",
                    whiteSpace: "nowrap",
                    maxWidth: "88px",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {projectBadge}
                </span>
              ) : null}
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
              gap: 0,
            }}
          >
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                void submitRename();
              }}
              disabled={saving}
              aria-label={t("sessionList.confirmRename")}
              style={{
                ...inlineActionStyle,
                width: "18px",
                color: "var(--accent-color)",
                opacity: saving ? 0.6 : 1,
                cursor: saving ? "default" : "pointer",
              }}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                cancelEditing();
              }}
              disabled={saving}
              aria-label={t("sessionList.cancelRename")}
              style={{
                ...inlineActionStyle,
                width: "18px",
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
              aria-label={t("sessionList.syncing")}
              title={t("sessionList.syncing")}
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
              aria-label={t("sessionList.replying")}
              title={t("sessionList.replying")}
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
                locale,
                t("time.justNow"),
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
          aria-label={t("sessionList.menu")}
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
            position: "relative",
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
          {isPinned ? (
            <span
              aria-hidden="true"
              style={{
                position: "absolute",
                top: "1px",
                right: "1px",
                width: "12px",
                height: "12px",
                borderRadius: "999px",
                background: "var(--menu-bg)",
                color: selected ? "var(--accent-color)" : "var(--text-secondary)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                pointerEvents: "none",
                boxShadow: "0 0 0 1px var(--content-bg, #fff)",
              }}
            >
              <span style={{ width: "9px", height: "9px", display: "inline-flex" }}>
                <PinIcon pinned />
              </span>
            </span>
          ) : null}
        </button>
        {copied ? (
          <span role="status" style={{ position: "absolute", right: 0, top: "100%", whiteSpace: "nowrap", padding: "4px 8px", borderRadius: "6px", background: "var(--menu-bg)", color: "var(--text-primary)", fontSize: "12px", zIndex: 21 }}>
            {t("session.copied")}
          </span>
        ) : null}
        {menuOpen ? (
          <div
            ref={menuPopoverRef}
            style={{
              position: "absolute",
              ...(menuPlacement.placement === "above"
                ? { bottom: "calc(100% + 6px)" }
                : { top: "calc(100% + 6px)" }),
              right: 0,
              minWidth: "170px",
              padding: "6px",
              borderRadius: "10px",
              border: "1px solid var(--border-color)",
              background: "var(--menu-bg)",
              boxShadow: "0 12px 30px rgba(15, 23, 42, 0.14)",
              zIndex: 20,
              ...sessionMenuPopoverCapStyle,
              maxHeight: menuPlacement.maxHeight || undefined,
            }}
          >
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen(false);
                void onPin?.(session, !isPinned);
              }}
              style={{
                ...menuItemStyle,
                color: "var(--text-primary)",
              }}
            >
              <span style={{ width: "13px", height: "13px", display: "inline-flex" }}>
                <PinIcon pinned={isPinned} />
              </span>
              {isPinned ? t("sessionList.unpin") : t("sessionList.pin")}
            </button>
            {onScheduledTask && !session.pending && (!session.type || session.type === "chat") ? (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setMenuOpen(false);
                  onScheduledTask(session);
                }}
                style={{ ...menuItemStyle, color: "var(--text-primary)" }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
                </svg>
                {t("scheduled.title")}
              </button>
            ) : null}
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
              {t("sessionList.sync")}
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
              {t("sessionList.rename")}
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                copySessionValue(session.session_key || session.key);
              }}
              style={{ ...menuItemStyle, color: "var(--text-primary)", whiteSpace: "nowrap" }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <rect x="9" y="9" width="12" height="12" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              {t("sessionList.copyId")}
            </button>
            <button
              type="button"
              disabled={copyingPath || !session.root_id || session.pending}
              onClick={(e) => {
                e.stopPropagation();
                if (!session.root_id || copyingPath) return;
                setCopyingPath(true);
                void sessionService.getSessionLogPath(session.root_id, session.session_key || session.key)
                  .then(({ path }) => copySessionValue(path))
                  .catch((err) => {
                    reportError("clipboard.write_failed", String((err as Error)?.message || t("session.copyFailed")));
                  })
                  .finally(() => setCopyingPath(false));
              }}
              style={{ ...menuItemStyle, color: "var(--text-primary)", whiteSpace: "nowrap", opacity: copyingPath || !session.root_id || session.pending ? 0.55 : 1 }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <path d="M14 2v6h6M8 13h8M8 17h8" />
              </svg>
              {copyingPath ? t("common.loading") : t("sessionList.copyPath")}
            </button>
            {onHandoffPack ? (
              <button
                type="button"
                disabled={!session.root_id || session.pending}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  onHandoffPack(session);
                }}
                style={{ ...menuItemStyle, color: "var(--text-primary)", whiteSpace: "nowrap", opacity: !session.root_id || session.pending ? 0.55 : 1 }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                  <path d="M10 17l5-5-5-5" />
                  <path d="M15 12H3" />
                </svg>
                {t("sessionList.handoffPack")}
              </button>
            ) : null}
            {onAddToKanban && !session.task_id && !session.pending && !session.parent_session_key ? (
              <button
                type="button"
                disabled={!session.root_id || session.pending}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  onAddToKanban(session);
                }}
                style={{ ...menuItemStyle, color: "var(--text-primary)", whiteSpace: "nowrap", opacity: !session.root_id || session.pending ? 0.55 : 1 }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path d="M3 9h18" />
                  <path d="M9 21V9" />
                </svg>
                {t("sessionList.addToKanban")}
              </button>
            ) : null}
            {onSetParent && (isSubagent || (isForkSession && !!forkSource?.sessionKey)) ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  void onSetParent(
                    session,
                    isSubagent ? "" : String(forkSource?.sessionKey || ""),
                  );
                }}
                style={{ ...menuItemStyle, color: "var(--text-primary)", whiteSpace: "nowrap" }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M9 17H7A5 5 0 0 1 7 7h2" />
                  <path d="M15 7h2a5 5 0 0 1 0 10h-2" />
                  <line x1="8" y1="12" x2="16" y2="12" />
                </svg>
                {isSubagent ? t("sessionList.detachFromParent") : t("sessionList.attachToParent")}
              </button>
            ) : null}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen(false);
                // Never decide here whether the subtree survives: the loaded
                // list may hide children (filters, search results, pagination),
                // and guessing "no children" cascades an entire branch. The
                // server refuses the ambiguous delete and the app asks.
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
              {t("common.delete")}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function formatTime(isoString: string, locale: Locale, justNow: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  if (diff < 60000) return justNow;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  if (now.getFullYear() === date.getFullYear()) {
    return new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" }).format(date);
  }
  return new Intl.DateTimeFormat(locale, { year: "2-digit", month: "numeric" }).format(date);
}

// 时间窗筛空时给用户指路：从（未过滤的）列表里找最近一条，告诉用户"差多少"
function latestSessionOf(items: readonly SessionItem[]): SessionItem | null {
  let latest: SessionItem | null = null;
  let latestTs = 0;
  for (const item of items) {
    const ts = Date.parse(item.updated_at || item.created_at || "") || 0;
    if (ts > latestTs) {
      latestTs = ts;
      latest = item;
    }
  }
  return latest;
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

// 会话行右键菜单条目多，矮屏下会伸到视口外、被抽屉 overflow:hidden 裁掉。
// 与 FileTree 顶栏弹层同一处理：视口内限高 + 内部滚动。
const sessionMenuPopoverCapStyle: React.CSSProperties = menuPopoverCapStyle;

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

import React from "react";
import { rootBadgeStyle } from "./rootBadgeStyle";
import { SymlinkBadge } from "./SymlinkBadge";
import {
  DIRECTORY_SORT_OPTIONS,
  type DirectorySortMode,
  type FileEntry,
  sortDirectoryEntries,
} from "../services/directorySort";

type DirectorySortControlValue = DirectorySortMode | "inherit";

const ChevronRight = ({ isOpen }: { isOpen: boolean }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{
      transform: isOpen ? "rotate(90deg)" : "rotate(0deg)",
      transition: "transform 0.15s cubic-bezier(0.4, 0, 0.2, 1)",
      color: isOpen ? "var(--text-primary)" : "#9ca3af",
    }}
  >
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

type DefaultListViewProps = {
  root?: string;
  path?: string;
  entries: FileEntry[];
  errorMessage?: string;
  topContent?: React.ReactNode;
  showHiddenFiles?: boolean;
  sortMode: DirectorySortMode;
  sortControlValue: DirectorySortControlValue;
  onItemClick?: (entry: FileEntry) => void;
  onPathClick?: (path: string) => void;
  onSortModeChange?: (mode: DirectorySortControlValue) => void;
  onUploadFiles?: (files: File[]) => void | Promise<void>;
  onRenameRoot?: (nextName: string) => Promise<boolean> | boolean;
  onRemoveRoot?: () => void;
  isGitRepo?: boolean;
  isGitWorktree?: boolean;
  showGitHistory?: boolean;
  enableGitHistoryToggle?: boolean;
  onToggleGitHistory?: () => void;
  onCreateWorktree?: () => void;
  onSwitchWorktree?: () => void;
  onRemoveWorktree?: () => void;
  onOpenScheduledAgentTasks?: () => void;
  menuOverlay?: React.ReactNode;
};

function formatCompactTime(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hours = `${date.getHours()}`.padStart(2, "0");
  const minutes = `${date.getMinutes()}`.padStart(2, "0");
  if (sameYear) {
    return `${month}-${day} ${hours}:${minutes}`;
  }
  return `${date.getFullYear()}-${month}-${day}`;
}

function formatCompactSize(size?: number): string {
  if (!size || size < 0) return "";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const fractionDigits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(fractionDigits).replace(/\.0+$|(\.\d*[1-9])0+$/, "$1")} ${units[unitIndex]}`;
}

function FileEntryIcon({ entry }: { entry: FileEntry }) {
  const showSymlinkBadge = entry.is_dir && entry.is_symlink;

  return (
    <div
      style={{
        position: "relative",
        width: "18px",
        height: "18px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      {entry.is_dir ? (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--accent-color)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2z" />
        </svg>
      ) : (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--text-secondary)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
          <polyline points="13 2 13 9 20 9" />
        </svg>
      )}
      {showSymlinkBadge ? <SymlinkBadge /> : null}
    </div>
  );
}

function GitBranchMenuIcon({
  marker,
}: {
  marker?: "plus" | "minus" | "switch";
}) {
  const markerPath =
    marker === "plus"
      ? "M19 16v6M16 19h6"
      : marker === "minus"
        ? "M16 19h6"
        : "M21 17.5h-7M18 14.5l3 3M13.8 21h7M13.8 21l3 3";
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <path
        fill="currentColor"
        d="M7 5a2 2 0 1 1 3.763.945h.58a4 4 0 0 1 4 4v1.28a2 2 0 0 1-1.02 3.72a2 2 0 0 1-.98-3.745V9.945a2 2 0 0 0-2-2H10v9.323A2 2 0 0 1 9 21a2 2 0 0 1-1-3.732V6.732A2 2 0 0 1 7 5"
      />
      {marker ? (
        <path
          d={markerPath}
          stroke="currentColor"
          strokeWidth={marker === "switch" ? "1.7" : "2.6"}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
    </svg>
  );
}

// 路径导航组件
function Breadcrumbs({
  root,
  path,
  onPathClick,
  editingRoot = false,
  rootDraft = "",
  rootRenaming = false,
  inputRef,
  onRootDraftChange,
  onRootRenameSubmit,
  onRootRenameCancel,
}: {
  root?: string;
  path: string;
  onPathClick?: (path: string) => void;
  editingRoot?: boolean;
  rootDraft?: string;
  rootRenaming?: boolean;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  onRootDraftChange?: (value: string) => void;
  onRootRenameSubmit?: () => void;
  onRootRenameCancel?: () => void;
}) {
  const normalizedPath =
    root && path.startsWith(root)
      ? path.slice(root.length).replace(/^\/+/, "")
      : path;
  const parts = normalizedPath.split("/").filter(Boolean);

  const getPathAt = (index: number) => {
    return parts.slice(0, index + 1).join("/");
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "4px",
        fontSize: "13px",
        color: "var(--text-secondary)",
        overflow: "hidden",
        whiteSpace: "nowrap",
        flex: 1,
        justifyContent: "flex-start",
      }}
    >
      {root && (
        <>
          {editingRoot ? (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                minWidth: 0,
                maxWidth: "min(320px, 60vw)",
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  position: "relative",
                  minWidth: 0,
                  maxWidth: "100%",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    visibility: "hidden",
                    display: "block",
                    whiteSpace: "pre",
                    height: "24px",
                    border: "1px solid transparent",
                    fontSize: "13px",
                    fontWeight: 700,
                    padding: "0 10px",
                    boxSizing: "border-box",
                  }}
                >
                  {rootDraft || " "}
                </span>
                <input
                  ref={inputRef}
                  value={rootDraft}
                  disabled={rootRenaming}
                  onChange={(event) => {
                    const input = event.currentTarget;
                    onRootDraftChange?.(event.target.value);
                    window.requestAnimationFrame(() => {
                      if (input.scrollWidth <= input.clientWidth + 1) {
                        input.scrollLeft = 0;
                      }
                    });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      onRootRenameCancel?.();
                      return;
                    }
                    if (event.key === "Enter") {
                      event.preventDefault();
                      onRootRenameSubmit?.();
                    }
                  }}
                  style={{
                    position: "absolute",
                    inset: 0,
                    minWidth: 0,
                    width: "100%",
                    maxWidth: "100%",
                    height: "24px",
                    borderRadius: "6px",
                    border: "1px solid var(--accent-color)",
                    background: "var(--content-bg, #fff)",
                    color: "var(--text-primary)",
                    fontSize: "13px",
                    fontWeight: 700,
                    padding: "0 8px",
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                />
              </span>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={onRootRenameCancel}
                disabled={rootRenaming}
                aria-label="取消项目重命名"
                style={{
                  width: "22px",
                  height: "22px",
                  borderRadius: "6px",
                  border: "none",
                  background: "transparent",
                  color: "var(--text-secondary)",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: rootRenaming ? "default" : "pointer",
                  opacity: rootRenaming ? 0.6 : 1,
                  padding: 0,
                  flexShrink: 0,
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
            </span>
          ) : (
            <span
              onClick={() => onPathClick?.(".")}
              style={{
                ...rootBadgeStyle,
                cursor: "pointer",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.textDecoration = "underline";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.textDecoration = "none";
              }}
            >
              {root}
            </span>
          )}
          {parts.length > 0 && (
            <span style={{ opacity: 0.4, fontSize: "10px", flexShrink: 0 }}>
              ❯
            </span>
          )}
        </>
      )}
      {parts.map((part, index) => (
        <React.Fragment key={index}>
          <span
            onClick={() => onPathClick?.(getPathAt(index))}
            style={{
              fontWeight: index === parts.length - 1 ? 600 : 400,
              color:
                index === parts.length - 1 ? "var(--text-primary)" : "inherit",
              cursor: "pointer",
              flexShrink: index === parts.length - 1 ? 0 : 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.textDecoration = "underline";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.textDecoration = "none";
            }}
          >
            {part}
          </span>
          {index < parts.length - 1 && (
            <span style={{ opacity: 0.4, fontSize: "10px", flexShrink: 0 }}>
              ❯
            </span>
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

export function DefaultListView({
  root,
  path = "",
  entries,
  errorMessage,
  topContent,
  showHiddenFiles = false,
  sortMode,
  sortControlValue,
  onItemClick,
  onPathClick,
  onSortModeChange,
  onUploadFiles,
  onRenameRoot,
  onRemoveRoot,
  isGitRepo = false,
  isGitWorktree = false,
  showGitHistory = true,
  enableGitHistoryToggle = true,
  onToggleGitHistory,
  onCreateWorktree,
  onSwitchWorktree,
  onRemoveWorktree,
  onOpenScheduledAgentTasks,
  menuOverlay = null,
}: DefaultListViewProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const rootNameInputRef = React.useRef<HTMLInputElement>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  const [isMenuOpen, setIsMenuOpen] = React.useState(false);
  const [isSortMenuOpen, setIsSortMenuOpen] = React.useState(false);
  const [editingRoot, setEditingRoot] = React.useState(false);
  const [rootDraft, setRootDraft] = React.useState(root || "");
  const [rootRenaming, setRootRenaming] = React.useState(false);
  const sortedEntries = React.useMemo(() => {
    const visibleEntries = showHiddenFiles
      ? entries
      : entries.filter((entry) => !entry.name.startsWith("."));
    return sortDirectoryEntries(visibleEntries, sortMode);
  }, [entries, showHiddenFiles, sortMode]);
  const showCompactMeta =
    sortMode === "mtime-desc" ||
    sortMode === "mtime-asc" ||
    sortMode === "size-desc" ||
    sortMode === "size-asc";
  const isRootView = !!root && (!!path ? path === root : true);

  React.useEffect(() => {
    if (!editingRoot) {
      setRootDraft(root || "");
    }
  }, [editingRoot, root]);

  React.useEffect(() => {
    if (!editingRoot) {
      return;
    }
    rootNameInputRef.current?.focus();
    rootNameInputRef.current?.select();
  }, [editingRoot]);

  React.useEffect(() => {
    if (!isMenuOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setIsMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [isMenuOpen]);

  const cancelRootRename = React.useCallback(() => {
    setEditingRoot(false);
    setRootRenaming(false);
    setRootDraft(root || "");
  }, [root]);

  const submitRootRename = React.useCallback(async () => {
    if (rootRenaming) {
      return;
    }
    const trimmed = rootDraft.trim();
    if (!trimmed || trimmed === String(root || "").trim()) {
      cancelRootRename();
      return;
    }
    if (!onRenameRoot) {
      cancelRootRename();
      return;
    }
    setRootRenaming(true);
    try {
      const ok = await onRenameRoot(trimmed);
      if (ok === false) {
        rootNameInputRef.current?.focus();
        rootNameInputRef.current?.select();
        return;
      }
      setEditingRoot(false);
    } finally {
      setRootRenaming(false);
    }
  }, [cancelRootRename, onRenameRoot, root, rootDraft, rootRenaming]);

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
      <header
        style={{
          height: "36px",
          padding: "0 3px 0 16px",
          borderBottom: "1px solid var(--border-color)",
          display: "flex",
          alignItems: "center",
          background: "var(--mindfs-topbar-bg, transparent)",
          boxSizing: "border-box",
          zIndex: 10,
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            overflow: "hidden",
            flex: 1,
          }}
        >
          <Breadcrumbs
            root={root}
            path={path || ""}
            onPathClick={onPathClick}
            editingRoot={editingRoot}
            rootDraft={rootDraft}
            rootRenaming={rootRenaming}
            inputRef={rootNameInputRef}
            onRootDraftChange={setRootDraft}
            onRootRenameSubmit={() => {
              void submitRootRename();
            }}
            onRootRenameCancel={cancelRootRename}
          />
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            flexShrink: 0,
          }}
        >
          <div
            style={{
              fontSize: "11px",
              color: "var(--text-secondary)",
              opacity: 0.6,
            }}
          >
            {sortedEntries.length}项
          </div>
          <div ref={menuRef} style={{ position: "relative" }}>
            <button
              type="button"
              onClick={() => {
                setIsMenuOpen((open) => {
                  const nextOpen = !open;
                  if (nextOpen) {
                    setIsSortMenuOpen(false);
                  }
                  return nextOpen;
                });
              }}
              aria-label="打开目录菜单"
              style={{
                width: "28px",
                height: "28px",
                borderRadius: "8px",
                border: "none",
                background: isMenuOpen ? "rgba(0, 0, 0, 0.06)" : "transparent",
                color: "var(--text-secondary)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                outline: "none",
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <circle cx="12" cy="5" r="1.8" />
                <circle cx="12" cy="12" r="1.8" />
                <circle cx="12" cy="19" r="1.8" />
              </svg>
            </button>
            {isMenuOpen ? (
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 6px)",
                  right: 0,
                  minWidth: "176px",
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
                  onClick={() => setIsSortMenuOpen((open) => !open)}
                  style={{
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
                  }}
                  aria-expanded={isSortMenuOpen}
                >
                  <span style={{ flex: 1 }}>当前排序</span>
                  <span
                    style={{ color: "var(--text-secondary)", fontSize: "11px" }}
                  >
                    {sortControlValue === "inherit"
                      ? "跟随全局"
                      : DIRECTORY_SORT_OPTIONS.find(
                          (option) => option.value === sortControlValue,
                        )?.label || "默认"}
                  </span>
                  <ChevronRight isOpen={isSortMenuOpen} />
                </button>
                {isSortMenuOpen ? (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        onSortModeChange?.("inherit");
                        setIsMenuOpen(false);
                        setIsSortMenuOpen(false);
                      }}
                      style={{
                        width: "100%",
                        border: "none",
                        background:
                          sortControlValue === "inherit"
                            ? "var(--selection-bg)"
                            : "transparent",
                        color:
                          sortControlValue === "inherit"
                            ? "var(--accent-color)"
                            : "var(--text-primary)",
                        borderRadius: "8px",
                        padding: "8px 10px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        textAlign: "left",
                        cursor: "pointer",
                        fontSize: "12px",
                      }}
                    >
                      <span>跟随全局</span>
                      <span
                        style={{
                          fontSize: "11px",
                          opacity: sortControlValue === "inherit" ? 1 : 0,
                        }}
                      >
                        ✓
                      </span>
                    </button>
                    {DIRECTORY_SORT_OPTIONS.map((option) => {
                      const active = sortControlValue === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => {
                            onSortModeChange?.(
                              option.value as DirectorySortControlValue,
                            );
                            setIsMenuOpen(false);
                            setIsSortMenuOpen(false);
                          }}
                          style={{
                            width: "100%",
                            border: "none",
                            background: active
                              ? "var(--selection-bg)"
                              : "transparent",
                            color: active
                              ? "var(--accent-color)"
                              : "var(--text-primary)",
                            borderRadius: "8px",
                            padding: "8px 10px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            textAlign: "left",
                            cursor: "pointer",
                            fontSize: "12px",
                          }}
                        >
                          <span>{option.label}</span>
                          <span
                            style={{
                              fontSize: "11px",
                              opacity: active ? 1 : 0,
                            }}
                          >
                            ✓
                          </span>
                        </button>
                      );
                    })}
                  </>
                ) : null}
                <div
                  style={{
                    height: "1px",
                    background: "var(--border-color)",
                    margin: "6px 4px",
                  }}
                />
                {isRootView ? (
                  <>
                    {isGitRepo && enableGitHistoryToggle ? (
                      <button
                        type="button"
                        onClick={() => {
                          onToggleGitHistory?.();
                        }}
                        style={{
                          width: "100%",
                          border: "none",
                          background: showGitHistory
                            ? "var(--selection-bg)"
                            : "transparent",
                          color: showGitHistory
                            ? "var(--accent-color)"
                            : "var(--text-primary)",
                          borderRadius: "8px",
                          padding: "8px 10px",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "12px",
                          textAlign: "left",
                          cursor: "pointer",
                          fontSize: "12px",
                        }}
                      >
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "8px",
                            minWidth: 0,
                          }}
                        >
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="15"
                            height="15"
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                            style={{ flexShrink: 0 }}
                          >
                            <path
                              fill="none"
                              stroke="currentColor"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth="2"
                              d="M4.266 16.06a8.92 8.92 0 0 0 3.915 3.978a8.7 8.7 0 0 0 5.471.832a8.8 8.8 0 0 0 4.887-2.64a9.07 9.07 0 0 0 2.388-5.079a9.14 9.14 0 0 0-1.044-5.53a8.9 8.9 0 0 0-4.069-3.815a8.7 8.7 0 0 0-5.5-.608c-1.85.401-3.366 1.313-4.62 2.755c-.151.16-.735.806-1.22 1.781M7.5 8l-3.609.72L3 5m9 4v4l3 2"
                            />
                          </svg>
                          <span>Git 历史</span>
                        </span>
                        <span
                          style={{
                            fontSize: "11px",
                            opacity: showGitHistory ? 1 : 0,
                          }}
                        >
                          ✓
                        </span>
                      </button>
                    ) : null}
                    {isGitRepo ? (
                      <button
                        type="button"
                        onClick={() => {
                          onCreateWorktree?.();
                          setIsMenuOpen(false);
                        }}
                        style={{
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
                        }}
                      >
                        <GitBranchMenuIcon marker="plus" />
                        <span>创建 worktree</span>
                      </button>
                    ) : null}
                    {isGitRepo ? (
                      <button
                        type="button"
                        onClick={() => {
                          onSwitchWorktree?.();
                          setIsMenuOpen(false);
                        }}
                        style={{
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
                        }}
                      >
                        <GitBranchMenuIcon marker="switch" />
                        <span>切换 worktree</span>
                      </button>
                    ) : null}
                    {isGitWorktree ? (
                      <button
                        type="button"
                        onClick={() => {
                          onRemoveWorktree?.();
                          setIsMenuOpen(false);
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
                        }}
                      >
                        <GitBranchMenuIcon marker="minus" />
                        <span>移除 worktree</span>
                      </button>
                    ) : null}
                    {isGitRepo || isGitWorktree ? (
                      <div
                        style={{
                          height: "1px",
                          background: "var(--border-color)",
                          margin: "6px 4px",
                        }}
                      />
                    ) : null}
                    <button
                      type="button"
                      onClick={() => {
                        onOpenScheduledAgentTasks?.();
                        setIsMenuOpen(false);
                      }}
                      style={{
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
                      }}
                    >
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
                        <circle cx="12" cy="12" r="9" />
                        <path d="M12 7v5l3 2" />
                      </svg>
                      <span>定时任务</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRootDraft(root || "");
                        setEditingRoot(true);
                        setIsMenuOpen(false);
                      }}
                      style={{
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
                      }}
                    >
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
                        <path d="M12 20h9" />
                        <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                      </svg>
                      <span>项目重命名</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onRemoveRoot?.();
                        setIsMenuOpen(false);
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
                      }}
                    >
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
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5.2a2 2 0 0 1 1.4.58l1.82 1.84A2 2 0 0 0 13.84 6H20a2 2 0 0 1 2 2z" />
                        <path d="M9 14h6" />
                      </svg>
                      <span>移除项目</span>
                    </button>
                    <div
                      style={{
                        height: "1px",
                        background: "var(--border-color)",
                        margin: "6px 4px",
                      }}
                    />
                  </>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    inputRef.current?.click();
                    setIsMenuOpen(false);
                  }}
                  disabled={!root}
                  style={{
                    width: "100%",
                    border: "none",
                    background: "transparent",
                    color: root
                      ? "var(--text-primary)"
                      : "var(--text-secondary)",
                    borderRadius: "8px",
                    padding: "8px 10px",
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    textAlign: "left",
                    cursor: root ? "pointer" : "not-allowed",
                    fontSize: "12px",
                    opacity: root ? 1 : 0.45,
                  }}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                  >
                    <path d="M12 5v14" />
                    <path d="M5 12h14" />
                  </svg>
                  <span>上传到当前目录</span>
                </button>
              </div>
            ) : null}
            {menuOverlay ? (
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 6px)",
                  right: 0,
                  zIndex: 30,
                }}
              >
                {menuOverlay}
              </div>
            ) : null}
          </div>
          <input
            ref={inputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(event) => {
              const files = Array.from(event.target.files || []);
              if (files.length > 0) {
                void onUploadFiles?.(files);
              }
              event.currentTarget.value = "";
            }}
          />
        </div>
      </header>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {topContent ? (
          <div style={{ padding: "24px 16px 0" }}>{topContent}</div>
        ) : null}
        <div style={{ padding: topContent ? "4px 16px 24px" : "24px 16px" }}>
          {errorMessage ? (
            <div
              style={{
                padding: "18px 16px",
                borderRadius: "12px",
                border: "1px solid rgba(245, 158, 11, 0.28)",
                background: "rgba(245, 158, 11, 0.08)",
                color: "var(--text-primary)",
              }}
            >
              <div
                style={{
                  fontSize: "14px",
                  fontWeight: 600,
                  marginBottom: "6px",
                }}
              >
                当前目录无法访问
              </div>
              <div
                style={{
                  fontSize: "12px",
                  color: "var(--text-secondary)",
                  lineHeight: 1.5,
                }}
              >
                {errorMessage}
              </div>
            </div>
          ) : null}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "4px",
              width: "100%",
            }}
          >
            {sortedEntries.map((entry) => (
              <div
                key={entry.path}
                onClick={() => onItemClick?.(entry)}
                style={{
                  background: "transparent",
                  border: "1px solid transparent",
                  borderRadius: "8px",
                  padding: "6px 10px",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
                  cursor: "pointer",
                  transform: "translateZ(0)",
                  willChange: "background-color",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(0, 0, 0, 0.03)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
              >
                <FileEntryIcon entry={entry} />
                <div
                  style={{
                    minWidth: 0,
                    flex: 1,
                    fontWeight: 500,
                    fontSize: "13px",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    color: "var(--text-primary)",
                  }}
                >
                  {entry.name}
                </div>
                {showCompactMeta ? (
                  <div
                    style={{
                      flexShrink: 0,
                      minWidth: "76px",
                      textAlign: "right",
                      fontSize: "11px",
                      color: "var(--text-secondary)",
                      opacity: 0.88,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {sortMode === "mtime-desc" || sortMode === "mtime-asc"
                      ? formatCompactTime(entry.mtime)
                      : !entry.is_dir
                        ? formatCompactSize(entry.size)
                        : ""}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

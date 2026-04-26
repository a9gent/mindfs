import React from "react";
import { rootBadgeStyle } from "./rootBadgeStyle";
import {
  DIRECTORY_SORT_OPTIONS,
  type DirectorySortMode,
  type FileEntry,
  sortDirectoryEntries,
} from "../services/directorySort";

type DirectorySortControlValue = DirectorySortMode | "inherit";

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
  onRemoveRoot?: () => void;
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

// 路径导航组件
function Breadcrumbs({ root, path, onPathClick }: { root?: string; path: string; onPathClick?: (path: string) => void }) {
  const normalizedPath = root && path.startsWith(root) ? path.slice(root.length).replace(/^\/+/, "") : path;
  const parts = normalizedPath.split('/').filter(Boolean);
  
  const getPathAt = (index: number) => {
    return parts.slice(0, index + 1).join('/');
  };

  return (
    <div style={{ 
      display: 'flex', 
      alignItems: 'center', 
      gap: '4px', 
      fontSize: '13px', 
      color: 'var(--text-secondary)',
      overflow: 'hidden',
      whiteSpace: 'nowrap',
      flex: 1,
      justifyContent: 'flex-start'
    }}>
      {root && (
        <>
          <span
            onClick={() => onPathClick?.(".")}
            style={{
              ...rootBadgeStyle,
              cursor: "pointer",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.textDecoration = "underline"; }}
            onMouseLeave={(e) => { e.currentTarget.style.textDecoration = "none"; }}
          >
            {root}
          </span>
          {parts.length > 0 && <span style={{ opacity: 0.4, fontSize: '10px', flexShrink: 0 }}>❯</span>}
        </>
      )}
      {parts.map((part, index) => (
        <React.Fragment key={index}>
          <span 
            onClick={() => onPathClick?.(getPathAt(index))}
            style={{ 
              fontWeight: index === parts.length - 1 ? 600 : 400,
              color: index === parts.length - 1 ? 'var(--text-primary)' : 'inherit',
              cursor: 'pointer',
              flexShrink: index === parts.length - 1 ? 0 : 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis'
            }}
            onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; }}
            onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}
          >
            {part}
          </span>
          {index < parts.length - 1 && (
            <span style={{ opacity: 0.4, fontSize: '10px', flexShrink: 0 }}>❯</span>
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
  onRemoveRoot,
}: DefaultListViewProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  const [isMenuOpen, setIsMenuOpen] = React.useState(false);
  const sortedEntries = React.useMemo(() => {
    const visibleEntries = showHiddenFiles ? entries : entries.filter((entry) => !entry.name.startsWith("."));
    return sortDirectoryEntries(visibleEntries, sortMode);
  }, [entries, showHiddenFiles, sortMode]);
  const showCompactMeta = sortMode === "mtime-desc" || sortMode === "mtime-asc" || sortMode === "size-desc" || sortMode === "size-asc";
  const isRootView = !!root && (!!path ? path === root : true);

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

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "transparent" }}>
      <header
        style={{
          height: "36px",
          padding: "0 3px 0 16px",
          borderBottom: "1px solid var(--border-color)",
          display: "flex",
          alignItems: "center",
          background: "transparent",
          boxSizing: "border-box",
          zIndex: 10,
          flexShrink: 0
        }}
      >
        <div style={{ display: "flex", alignItems: "center", overflow: "hidden", flex: 1 }}>
          <Breadcrumbs root={root} path={path || ""} onPathClick={onPathClick} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexShrink: 0 }}>
          <div style={{ fontSize: "11px", color: "var(--text-secondary)", opacity: 0.6 }}>
            {sortedEntries.length}项
          </div>
          <div ref={menuRef} style={{ position: "relative" }}>
            <button
              type="button"
              onClick={() => setIsMenuOpen((open) => !open)}
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
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
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
                <div style={{ padding: "4px 8px", fontSize: "11px", color: "var(--text-secondary)" }}>当前目录排序</div>
                <button
                  type="button"
                  onClick={() => {
                    onSortModeChange?.("inherit");
                    setIsMenuOpen(false);
                  }}
                  style={{
                    width: "100%",
                    border: "none",
                    background: sortControlValue === "inherit" ? "var(--selection-bg)" : "transparent",
                    color: sortControlValue === "inherit" ? "var(--accent-color)" : "var(--text-primary)",
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
                  <span style={{ fontSize: "11px", opacity: sortControlValue === "inherit" ? 1 : 0 }}>✓</span>
                </button>
                {DIRECTORY_SORT_OPTIONS.map((option) => {
                  const active = sortControlValue === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => {
                        onSortModeChange?.(option.value as DirectorySortControlValue);
                        setIsMenuOpen(false);
                      }}
                      style={{
                        width: "100%",
                        border: "none",
                        background: active ? "var(--selection-bg)" : "transparent",
                        color: active ? "var(--accent-color)" : "var(--text-primary)",
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
                      <span style={{ fontSize: "11px", opacity: active ? 1 : 0 }}>✓</span>
                    </button>
                  );
                })}
                <div style={{ height: "1px", background: "var(--border-color)", margin: "6px 4px" }} />
                {isRootView ? (
                  <>
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
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5.2a2 2 0 0 1 1.4.58l1.82 1.84A2 2 0 0 0 13.84 6H20a2 2 0 0 1 2 2z" />
                        <path d="M9 14h6" />
                      </svg>
                      <span>移除项目</span>
                    </button>
                    <div style={{ height: "1px", background: "var(--border-color)", margin: "6px 4px" }} />
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
                    color: root ? "var(--text-primary)" : "var(--text-secondary)",
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
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                    <path d="M12 5v14" />
                    <path d="M5 12h14" />
                  </svg>
                  <span>上传到当前目录</span>
                </button>
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
          <div style={{ padding: "24px 16px 0" }}>
            {topContent}
          </div>
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
            <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "6px" }}>
              当前目录无法访问
            </div>
            <div style={{ fontSize: "12px", color: "var(--text-secondary)", lineHeight: 1.5 }}>
              {errorMessage}
            </div>
          </div>
        ) : null}
        <div style={{ display: "flex", flexDirection: "column", gap: "4px", width: "100%" }}>
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
              <div
                style={{
                  width: "18px",
                  height: "18px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                {entry.is_dir ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-color)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2z"/></svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
                )}
              </div>
              <div style={{ minWidth: 0, flex: 1, fontWeight: 500, fontSize: "13px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: "var(--text-primary)" }}>
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

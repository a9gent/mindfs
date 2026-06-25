import React, { useEffect, useState } from "react";
import {
  fetchGitCommitFiles,
  type GitHistoryItem,
  type GitStatusItem,
} from "../services/git";

type GitHistoryPanelProps = {
  rootId: string;
  items: GitHistoryItem[];
  loading?: boolean;
  loadingMore?: boolean;
  hasMore?: boolean;
  compact?: boolean;
  expandedCommits?: Record<string, boolean>;
  onToggleCommit?: (hash: string) => void;
  onLoadMore?: () => void;
  onSelectFile?: (commit: GitHistoryItem, item: GitStatusItem) => void;
};

function renderStatusColor(status: string): string {
  switch (status) {
    case "A":
      return "#15803d";
    case "D":
      return "#b91c1c";
    case "R":
      return "#1d4ed8";
    case "??":
      return "#7c3aed";
    default:
      return "#b45309";
  }
}

function renderLineStat(value: number, prefix: "+" | "-"): React.ReactNode {
  const color = prefix === "+" ? "#15803d" : "#b91c1c";
  return (
    <span style={{ color, fontVariantNumeric: "tabular-nums" }}>
      {prefix}{value}
    </span>
  );
}

function formatCommitTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
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

export function GitHistoryPanel({
  rootId,
  items,
  loading = false,
  loadingMore = false,
  hasMore = false,
  compact = false,
  expandedCommits = {},
  onToggleCommit,
  onLoadMore,
  onSelectFile,
}: GitHistoryPanelProps) {
  const [filesByCommit, setFilesByCommit] = useState<Record<string, GitStatusItem[]>>({});
  const [loadingFiles, setLoadingFiles] = useState<Record<string, boolean>>({});

  if (!loading && items.length === 0) {
    return null;
  }

  const loadCommitFiles = (commit: GitHistoryItem) => {
    if (filesByCommit[commit.hash] || loadingFiles[commit.hash]) {
      return;
    }
    setLoadingFiles((prev) => ({ ...prev, [commit.hash]: true }));
    void fetchGitCommitFiles(rootId, commit.hash)
      .then((payload) => {
        setFilesByCommit((prev) => ({ ...prev, [commit.hash]: payload.items || [] }));
      })
      .catch((err) => {
        console.error("[git.commit.files] failed", { rootId, commit: commit.hash, err });
        setFilesByCommit((prev) => ({ ...prev, [commit.hash]: [] }));
      })
      .finally(() => {
        setLoadingFiles((prev) => ({ ...prev, [commit.hash]: false }));
      });
  };

  useEffect(() => {
    items.forEach((commit) => {
      if (expandedCommits[commit.hash]) {
        loadCommitFiles(commit);
      }
    });
  }, [expandedCommits, items]);

  const toggleCommit = (commit: GitHistoryItem) => {
    onToggleCommit?.(commit.hash);
    if (!expandedCommits[commit.hash]) {
      loadCommitFiles(commit);
    }
  };

  return (
    <section style={{ padding: 0, flexShrink: 0, minWidth: 0 }}>
      {loading ? (
        <div style={{ fontSize: "12px", color: "var(--text-secondary)", padding: "6px 10px 6px 14px" }}>正在加载 git 历史...</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "2px", paddingLeft: compact ? 0 : "4px", minWidth: 0 }}>
          {items.map((commit, index) => {
            const isExpanded = expandedCommits[commit.hash] === true;
            const files = filesByCommit[commit.hash] || [];
            const dotColor = commit.remote === true ? "#7c3aed" : "#2563eb";
            return (
              <div key={commit.hash} style={{ display: "grid", gridTemplateColumns: "8px minmax(0, 1fr)", columnGap: "2px", position: "relative" }}>
                {index < items.length - 1 || hasMore ? (
                  <span
                    aria-hidden="true"
                    style={{
                      position: "absolute",
                      left: "3.5px",
                      top: "18px",
                      bottom: "-8px",
                      width: "1px",
                      background: "rgba(148, 163, 184, 0.34)",
                    }}
                  />
                ) : null}
                <span style={{ height: "30px", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1 }}>
                  <span
                    title={commit.remote === true ? "远端 commit" : "本地 commit"}
                    aria-label={commit.remote === true ? "远端 commit" : "本地 commit"}
                    style={{
                      width: "7px",
                      height: "7px",
                      borderRadius: "999px",
                      background: dotColor,
                    }}
                  />
                </span>
                <div style={{ display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 }}>
                  <button
                    type="button"
                    onClick={() => toggleCommit(commit)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: compact ? "6px" : "8px",
                      width: "100%",
                      border: "none",
                      background: isExpanded ? "var(--selection-bg)" : "transparent",
                      padding: compact ? "6px 7px" : "6px 10px",
                      cursor: "pointer",
                      textAlign: "left",
                      borderRadius: "8px",
                      transition: "background 0.15s",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--selection-bg)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = isExpanded ? "var(--selection-bg)" : "transparent"; }}
                  >
                    <span style={{ flex: 1, minWidth: 0, fontSize: "12px", color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {commit.message || commit.hash.slice(0, 8)}
                    </span>
                    <span title={commit.commit_time} style={{ fontSize: "11px", color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                      {formatCommitTime(commit.commit_time)}
                    </span>
                  </button>
                {isExpanded ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: "4px", marginLeft: 0, minWidth: 0 }}>
                    {loadingFiles[commit.hash] ? (
                      <div style={{ fontSize: "12px", color: "var(--text-secondary)", padding: "4px 10px" }}>正在加载文件...</div>
                    ) : files.length === 0 ? (
                      <div style={{ fontSize: "12px", color: "var(--text-secondary)", padding: "4px 10px" }}>无文件变更</div>
                    ) : files.map((file) => (
                      <button
                        key={`${commit.hash}:${file.status}:${file.path}`}
                        type="button"
                        onClick={() => onSelectFile?.(commit, file)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: compact ? "6px" : "10px",
                          width: "100%",
                          border: "none",
                          background: "linear-gradient(180deg, rgba(59, 130, 246, 0.08), rgba(59, 130, 246, 0.03))",
                          padding: compact ? "5px 7px" : "5px 10px",
                          cursor: "pointer",
                          textAlign: "left",
                          borderRadius: "8px",
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = "linear-gradient(180deg, rgba(59, 130, 246, 0.12), rgba(59, 130, 246, 0.05))"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = "linear-gradient(180deg, rgba(59, 130, 246, 0.08), rgba(59, 130, 246, 0.03))"; }}
                      >
                        <span style={{ width: compact ? "18px" : "24px", color: renderStatusColor(file.status), fontSize: "12px", fontWeight: 700, flexShrink: 0 }}>
                          {file.status === "??" ? "U" : file.status}
                        </span>
                        <span style={{ flex: 1, minWidth: 0, fontSize: "12px", color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {file.path}
                        </span>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: compact ? "4px" : "8px", fontSize: "11px", color: "var(--text-secondary)", flexShrink: 0 }}>
                          {renderLineStat(file.additions, "+")}
                          {renderLineStat(file.deletions, "-")}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null}
                </div>
              </div>
            );
          })}
          {hasMore ? (
            <div style={{ display: "grid", gridTemplateColumns: "8px minmax(0, 1fr)", columnGap: "2px", position: "relative" }}>
              <span style={{ height: "30px", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1 }}>
                <span
                  aria-hidden="true"
                  style={{
                    width: "7px",
                    height: "7px",
                    borderRadius: "999px",
                    border: "1.5px solid rgba(148, 163, 184, 0.8)",
                    background: "var(--background-color)",
                    boxSizing: "border-box",
                  }}
                />
              </span>
              <button
                type="button"
                aria-label={loadingMore ? "加载中" : "加载更多 git 历史"}
                title={loadingMore ? "加载中" : "加载更多"}
                disabled={loadingMore}
                onClick={onLoadMore}
                style={{
                  alignSelf: "stretch",
                  width: "100%",
                  height: "30px",
                  border: "none",
                  background: "var(--menu-active-bg)",
                  color: "var(--text-primary)",
                  padding: 0,
                  borderRadius: "8px",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: loadingMore ? "default" : "pointer",
                  opacity: loadingMore ? 0.6 : 1,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--selection-bg)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--menu-active-bg)";
                }}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48" aria-hidden="true" style={{ width: "28px", height: "28px" }}>
                  <circle cx="12" cy="24" r="3" fill="currentColor" />
                  <circle cx="24" cy="24" r="3" fill="currentColor" />
                  <circle cx="36" cy="24" r="3" fill="currentColor" />
                </svg>
              </button>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

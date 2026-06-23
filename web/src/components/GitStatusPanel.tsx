import React, { useEffect, useRef, useState } from "react";
import {
  fetchGitBranches,
  type GitBranchItem,
  type GitStatusItem,
  type GitStatusPayload,
} from "../services/git";

type GitStatusPanelProps = {
  rootId?: string;
  status: GitStatusPayload | null;
  loading?: boolean;
  isFiltered?: boolean;
  expanded?: boolean;
  onSelectItem?: (item: GitStatusItem) => void;
  onSwitchBranch?: (branch: string) => void | Promise<void>;
  onExpandedChange?: (expanded: boolean) => void;
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

function renderStatusLabel(status: string): string {
  if (status === "??") {
    return "U";
  }
  return status;
}

export function GitStatusPanel({ rootId, status, loading = false, isFiltered = false, expanded = true, onSelectItem, onSwitchBranch, onExpandedChange }: GitStatusPanelProps) {
  const branchMenuRef = useRef<HTMLDivElement | null>(null);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [branches, setBranches] = useState<GitBranchItem[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [switchingBranch, setSwitchingBranch] = useState("");

  useEffect(() => {
    if (!branchMenuOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (!branchMenuRef.current?.contains(event.target as Node)) {
        setBranchMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [branchMenuOpen]);

  useEffect(() => {
    if (!branchMenuOpen || !rootId) {
      return;
    }
    let cancelled = false;
    setBranchesLoading(true);
    void fetchGitBranches(rootId)
      .then((payload) => {
        if (!cancelled) {
          setBranches(payload.branches || []);
        }
      })
      .catch((err) => {
        console.error("[git.branches] failed", { rootId, err });
        if (!cancelled) {
          setBranches([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setBranchesLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [branchMenuOpen, rootId]);

  if (!loading && (!status || status.available !== true)) {
    return null;
  }

  const items = status?.items || [];
  if (!loading && items.length === 0) {
    return null;
  }

  return (
    <section style={{ padding: 0, flexShrink: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", marginBottom: "10px", padding: "0 10px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
          <span
            title="Git 变更"
            aria-label="Git 变更"
            style={{
              width: "18px",
              height: "18px",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-primary)",
              flexShrink: 0,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                fill="currentColor"
                d="M7 5a2 2 0 1 1 3.763.945h.58a4 4 0 0 1 4 4v1.28a2 2 0 0 1-1.02 3.72a2 2 0 0 1-.98-3.745V9.945a2 2 0 0 0-2-2H10v9.323A2 2 0 0 1 9 21a2 2 0 0 1-1-3.732V6.732A2 2 0 0 1 7 5"
              />
            </svg>
          </span>
          {status?.branch ? (
            <div ref={branchMenuRef} style={{ position: "relative", minWidth: 0 }}>
              <button
                type="button"
                onClick={() => setBranchMenuOpen((open) => !open)}
                disabled={!rootId || !onSwitchBranch}
                style={{
                  border: "none",
                  background: branchMenuOpen ? "rgba(15, 23, 42, 0.06)" : "transparent",
                  color: "var(--text-primary)",
                  borderRadius: "7px",
                  padding: "3px 6px",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                  minWidth: 0,
                  maxWidth: "180px",
                  cursor: rootId && onSwitchBranch ? "pointer" : "default",
                }}
              >
                <span style={{ fontSize: "12px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {status.branch}
                </span>
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  aria-hidden="true"
                  style={{
                    color: "var(--text-secondary)",
                    flexShrink: 0,
                    transform: branchMenuOpen ? "rotate(180deg)" : "rotate(0deg)",
                    transition: "transform 0.15s",
                  }}
                >
                  <path
                    fillRule="evenodd"
                    d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.17l3.71-3.94a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
              {branchMenuOpen ? (
                <div
                  style={{
                    position: "absolute",
                    top: "calc(100% + 6px)",
                    left: 0,
                    minWidth: "180px",
                    maxWidth: "260px",
                    maxHeight: "260px",
                    overflow: "auto",
                    padding: "6px",
                    borderRadius: "10px",
                    border: "1px solid var(--border-color)",
                    background: "var(--menu-bg)",
                    boxShadow: "0 12px 30px rgba(15, 23, 42, 0.14)",
                    zIndex: 25,
                  }}
                >
                  {branchesLoading ? (
                    <div style={{ padding: "8px 10px", fontSize: "12px", color: "var(--text-secondary)" }}>加载中...</div>
                  ) : branches.length === 0 ? (
                    <div style={{ padding: "8px 10px", fontSize: "12px", color: "var(--text-secondary)" }}>无可切换分支</div>
                  ) : branches.map((branch) => {
                    const active = branch.name === status.branch;
                    const busy = switchingBranch === branch.name;
                    return (
                      <button
                        key={branch.name}
                        type="button"
                        disabled={active || !!switchingBranch}
                        onClick={async () => {
                          setSwitchingBranch(branch.name);
                          try {
                            await onSwitchBranch?.(branch.name);
                            setBranchMenuOpen(false);
                          } finally {
                            setSwitchingBranch("");
                          }
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
                          gap: "12px",
                          textAlign: "left",
                          cursor: active || switchingBranch ? "default" : "pointer",
                          fontSize: "12px",
                          opacity: switchingBranch && !busy ? 0.58 : 1,
                        }}
                      >
                        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {branch.name}
                        </span>
                        <span style={{ fontSize: "11px", color: "var(--text-secondary)", flexShrink: 0 }}>
                          {busy ? "..." : active ? "✓" : ""}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 }}>
          <div style={{ fontSize: "11px", fontWeight: 700, color: "var(--text-secondary)" }}>
            {loading ? "..." : items.length}
          </div>
          <button
            type="button"
            aria-label={expanded ? "收起 Git 变更" : "展开 Git 变更"}
            title={expanded ? "收起" : "展开"}
            onClick={() => onExpandedChange?.(!expanded)}
            style={{
              width: "22px",
              height: "22px",
              border: "none",
              borderRadius: "7px",
              background: "transparent",
              color: "var(--text-secondary)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              padding: 0,
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
              style={{
                transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
                transition: "transform 0.15s",
              }}
            >
              <path
                fillRule="evenodd"
                d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.17l3.71-3.94a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>
      </div>

      {!expanded ? null : loading ? (
        <div style={{ fontSize: "12px", color: "var(--text-secondary)", padding: "6px 10px" }}>正在加载 git 变更...</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px", paddingLeft: "14px" }}>
          {items.map((item) => (
            <button
              key={`${item.status}:${item.path}`}
              type="button"
              disabled={item.is_dir === true}
              onClick={() => {
                if (item.is_dir !== true) {
                  onSelectItem?.(item);
                }
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                width: "100%",
                border: "none",
                background: "linear-gradient(180deg, rgba(59, 130, 246, 0.08), rgba(59, 130, 246, 0.03))",
                padding: "6px 10px",
                cursor: item.is_dir === true ? "default" : "pointer",
                textAlign: "left",
                borderRadius: "8px",
                transition: "background 0.15s",
                opacity: item.is_dir === true ? 0.72 : 1,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "linear-gradient(180deg, rgba(59, 130, 246, 0.12), rgba(59, 130, 246, 0.05))"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "linear-gradient(180deg, rgba(59, 130, 246, 0.08), rgba(59, 130, 246, 0.03))"; }}
            >
              <span style={{ width: "24px", color: renderStatusColor(item.status), fontSize: "12px", fontWeight: 700, flexShrink: 0 }}>
                {renderStatusLabel(item.status)}
              </span>
              <span style={{ flex: 1, minWidth: 0, fontSize: "12px", color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {item.display_path || item.path}
              </span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "11px", color: "var(--text-secondary)", flexShrink: 0 }}>
                {renderLineStat(item.additions, "+")}
                {renderLineStat(item.deletions, "-")}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

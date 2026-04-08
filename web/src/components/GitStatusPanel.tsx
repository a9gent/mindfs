import React from "react";
import type { GitStatusItem, GitStatusPayload } from "../services/git";

type GitStatusPanelProps = {
  status: GitStatusPayload | null;
  loading?: boolean;
  isFiltered?: boolean;
  onSelectItem?: (item: GitStatusItem) => void;
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

export function GitStatusPanel({ status, loading = false, isFiltered = false, onSelectItem }: GitStatusPanelProps) {
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
            <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-primary)" }}>
              {status.branch}
            </span>
          ) : null}
        </div>
        <div style={{ fontSize: "11px", fontWeight: 700, color: "var(--text-secondary)", flexShrink: 0 }}>
          {loading ? "..." : items.length}
        </div>
      </div>

      {loading ? (
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

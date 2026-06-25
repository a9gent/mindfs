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
  compact?: boolean;
  showHeader?: boolean;
  showHeaderActions?: boolean;
  showExpandedToggle?: boolean;
  enableBranchMenu?: boolean;
  onSelectItem?: (item: GitStatusItem) => void;
  onOpenItem?: (item: GitStatusItem) => void;
  onDiscardItem?: (item: GitStatusItem) => void | Promise<void>;
  onStageItem?: (item: GitStatusItem) => void | Promise<void>;
  onPull?: () => void | Promise<void>;
  onPush?: () => void | Promise<void>;
  onCommit?: (message: string) => void | Promise<void>;
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

function compactPath(path: string): string {
  const normalized = String(path || "").replace(/\\/g, "/").replace(/\/+$/g, "");
  return normalized.split("/").filter(Boolean).pop() || normalized || path;
}

function GitPullIcon() {
  return (
    <svg width="1em" height="1em" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M0 0h16v16H0z" fill="none" />
      <g fill="currentColor">
        <path d="M4.85 6.15a.48.48 0 0 0-.7 0a.48.48 0 0 0 0 .7l3 3a.48.48 0 0 0 .7 0l3-3a.48.48 0 0 0 0-.7a.48.48 0 0 0-.7 0L8 8.29V1.5c0-.28-.22-.5-.5-.5s-.5.22-.5.5v6.79z" />
        <path fillRule="evenodd" d="M9.95 13h2.55c.28 0 .5.22.5.5s-.22.5-.5.5H9.95a2.5 2.5 0 0 1-4.9 0H2.5c-.28 0-.5-.22-.5-.5s.22-.5.5-.5h2.55a2.5 2.5 0 0 1 4.9 0m-3.86 1a1.495 1.495 0 0 0 2.82 0c.06-.16.09-.32.09-.5s-.03-.34-.09-.5a1.495 1.495 0 0 0-2.82 0c-.06.16-.09.32-.09.5s.03.34.09.5" clipRule="evenodd" />
      </g>
    </svg>
  );
}

function GitPushIcon() {
  return (
    <svg width="1em" height="1em" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M0 0h16v16H0z" fill="none" />
      <g fill="currentColor">
        <path d="M4.85 4.85a.48.48 0 0 1-.7 0a.48.48 0 0 1 0-.7l3-3a.48.48 0 0 1 .7 0l3 3a.48.48 0 0 1 0 .7a.48.48 0 0 1-.7 0L8 2.71V9.5c0 .28-.22.5-.5.5S7 9.78 7 9.5V2.71z" />
        <path fillRule="evenodd" d="M9.95 13h2.55c.28 0 .5.22.5.5s-.22.5-.5.5H9.95a2.5 2.5 0 0 1-4.9 0H2.5c-.28 0-.5-.22-.5-.5s.22-.5.5-.5h2.55a2.5 2.5 0 0 1 4.9 0m-3.86 1a1.495 1.495 0 0 0 2.82 0c.06-.16.09-.32.09-.5s-.03-.34-.09-.5a1.495 1.495 0 0 0-2.82 0c-.06.16-.09.32-.09.5s.03.34.09.5" clipRule="evenodd" />
      </g>
    </svg>
  );
}

function GitCommitIcon() {
  return (
    <svg width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M0 0h24v24H0z" fill="none" />
      <path fill="currentColor" d="M22 11h-6.141a3.981 3.981 0 0 0-7.718 0H2v2h6.141a3.981 3.981 0 0 0 7.718 0H22Z" />
    </svg>
  );
}

function CommitSubmitIcon() {
  return (
    <svg width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M0 0h24v24H0z" fill="none" />
      <g fill="none" fillRule="evenodd">
        <path d="m12.593 23.258l-.011.002l-.071.035l-.02.004l-.014-.004l-.071-.035q-.016-.005-.024.005l-.004.01l-.017.428l.005.02l.01.013l.104.074l.015.004l.012-.004l.104-.074l.012-.016l.004-.017l-.017-.427q-.004-.016-.017-.018m.265-.113l-.013.002l-.185.093l-.01.01l-.003.011l.018.43l.005.012l.008.007l.201.093q.019.005.029-.008l.004-.014l-.034-.614q-.005-.018-.02-.022m-.715.002a.02.02 0 0 0-.027.006l-.006.014l-.034.614q.001.018.017.024l.015-.002l.201-.093l.01-.008l.004-.011l.017-.43l-.003-.012l-.01-.01z" />
        <path fill="currentColor" d="M21.546 5.111a1.5 1.5 0 0 1 0 2.121L10.303 18.475a1.6 1.6 0 0 1-2.263 0L2.454 12.89a1.5 1.5 0 1 1 2.121-2.121l4.596 4.596L19.424 5.111a1.5 1.5 0 0 1 2.122 0" />
      </g>
    </svg>
  );
}

function OpenFileIcon() {
  return (
    <svg width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M0 0h24v24H0z" fill="none" />
      <path fill="currentColor" d="M6.616 21q-.691 0-1.153-.462T5 19.385V4.615q0-.69.463-1.152T6.616 3H14.5L19 7.5v7h-1V8h-4V4H6.616q-.231 0-.424.192T6 4.615v14.77q0 .23.192.423t.423.192H15.5v1zm15.334.663l-3.45-3.45v2.956h-1V16.5h4.67v1h-2.982l3.45 3.45zM6 20V4z" />
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg width="1em" height="1em" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M0 0h16v16H0z" fill="none" />
      <path fill="currentColor" d="M3.001 2.5a.5.5 0 1 1 1 0v3.843l3.171-3.171a4 4 0 0 1 5.657 5.656l-5.025 5.026a.5.5 0 0 1-.707-.708l5.025-5.025A3 3 0 0 0 7.879 3.88L4.758 7H8.5a.5.5 0 0 1 0 1H3.6a.6.6 0 0 1-.6-.6z" />
    </svg>
  );
}

function StageIcon() {
  return (
    <svg width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M0 0h24v24H0z" fill="none" />
      <path fill="currentColor" d="M11 13H6q-.425 0-.712-.288T5 12t.288-.712T6 11h5V6q0-.425.288-.712T12 5t.713.288T13 6v5h5q.425 0 .713.288T19 12t-.288.713T18 13h-5v5q0 .425-.288.713T12 19t-.712-.288T11 18z" />
    </svg>
  );
}

function UnstageIcon() {
  return (
    <svg width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M0 0h24v24H0z" fill="none" />
      <path fill="currentColor" d="M6 13q-.425 0-.712-.288T5 12t.288-.712T6 11h12q.425 0 .713.288T19 12t-.288.713T18 13z" />
    </svg>
  );
}

function GitIconButton({
  title,
  disabled,
  children,
  onClick,
}: {
  title: string;
  disabled?: boolean;
  children: React.ReactNode;
  onClick?: () => void | Promise<void>;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        void onClick?.();
      }}
      style={{
        width: "18px",
        height: "18px",
        border: "none",
        borderRadius: "5px",
        background: "transparent",
        color: "var(--text-secondary)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: disabled ? "not-allowed" : "pointer",
        padding: 0,
        opacity: disabled ? 0.45 : 1,
        fontSize: "13px",
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}

export function GitStatusPanel({
  rootId,
  status,
  loading = false,
  isFiltered = false,
  expanded = true,
  compact = false,
  showHeader = true,
  showHeaderActions = true,
  showExpandedToggle = true,
  enableBranchMenu = true,
  onSelectItem,
  onOpenItem,
  onDiscardItem,
  onStageItem,
  onPull,
  onPush,
  onCommit,
  onSwitchBranch,
  onExpandedChange,
}: GitStatusPanelProps) {
  const branchMenuRef = useRef<HTMLDivElement | null>(null);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [branches, setBranches] = useState<GitBranchItem[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [switchingBranch, setSwitchingBranch] = useState("");
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [actionBusy, setActionBusy] = useState("");
  const [selectedActionPath, setSelectedActionPath] = useState("");
  const [hoveredActionPath, setHoveredActionPath] = useState("");

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

  const runPanelAction = async (key: string, action?: () => void | Promise<void>) => {
    if (!action || actionBusy) {
      return;
    }
    setActionBusy(key);
    try {
      await action();
    } catch {
      // The caller owns user-facing error reporting; keep local button state consistent.
    } finally {
      setActionBusy("");
    }
  };

  const submitCommit = async () => {
    const message = commitMessage.trim();
    if (!message || !onCommit || actionBusy) {
      return;
    }
    await runPanelAction("commit", async () => {
      await onCommit(message);
      setCommitMessage("");
      setCommitOpen(false);
    });
  };

  if (!loading && (!status || status.available !== true)) {
    return null;
  }

  const items = status?.items || [];
  const hasStatusItems = items.length > 0;
  const headerMarginBottom = commitOpen
    ? "6px"
    : expanded && (loading || hasStatusItems)
      ? "10px"
      : 0;

  return (
    <section style={{ padding: 0, flexShrink: 0, minWidth: 0 }}>
      {showHeader ? (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: compact ? "6px" : "12px", marginBottom: headerMarginBottom, padding: compact ? "0 4px 0 0" : "0 10px", minWidth: 0 }}>
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
                onClick={() => {
                  if (enableBranchMenu && rootId && onSwitchBranch) {
                    setBranchMenuOpen((open) => !open);
                  }
                }}
                disabled={!enableBranchMenu || !rootId || !onSwitchBranch}
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
                  cursor: enableBranchMenu && rootId && onSwitchBranch ? "pointer" : "default",
                }}
              >
                <span style={{ fontSize: "12px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {status.branch}
                </span>
                {enableBranchMenu && onSwitchBranch ? (
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
                ) : null}
              </button>
              {enableBranchMenu && branchMenuOpen ? (
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
        <div style={{ display: "flex", alignItems: "center", gap: "1px", flexShrink: 0 }}>
          {showHeaderActions ? (
            <>
              <GitIconButton
                title={actionBusy === "pull" ? "pull 中" : "Git pull"}
                disabled={!onPull || !!actionBusy}
                onClick={() => runPanelAction("pull", onPull)}
              >
                <GitPullIcon />
              </GitIconButton>
              <GitIconButton
                title={actionBusy === "push" ? "push 中" : "Git push"}
                disabled={!onPush || !!actionBusy}
                onClick={() => runPanelAction("push", onPush)}
              >
                <GitPushIcon />
              </GitIconButton>
              <GitIconButton
                title="Git commit"
                disabled={!onCommit || !!actionBusy}
                onClick={() => setCommitOpen((open) => !open)}
              >
                <GitCommitIcon />
              </GitIconButton>
            </>
          ) : null}
          <div style={{ fontSize: "11px", fontWeight: 700, color: "var(--text-secondary)" }}>
            {loading ? "..." : items.length}
          </div>
          {showExpandedToggle ? (
          <button
            type="button"
            aria-label={expanded ? "收起 Git 变更" : "展开 Git 变更"}
            title={expanded ? "收起" : "展开"}
            onClick={() => onExpandedChange?.(!expanded)}
            style={{
              width: "20px",
              height: "20px",
              border: "none",
              borderRadius: "5px",
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
          ) : null}
        </div>
      </div>
      ) : null}

      {showHeaderActions && commitOpen ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            marginBottom: "10px",
            padding: compact ? "0 4px 0 0" : "0 10px",
          }}
        >
          <input
            value={commitMessage}
            disabled={actionBusy === "commit"}
            autoFocus
            placeholder="输入提交消息"
            onChange={(event) => setCommitMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submitCommit();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setCommitOpen(false);
              }
            }}
            style={{
              flex: 1,
              minWidth: 0,
              height: "26px",
              border: "1px solid var(--border-color)",
              borderRadius: "7px",
              background: "transparent",
              color: "var(--text-primary)",
              padding: "0 8px",
              fontSize: "12px",
              outline: "none",
            }}
          />
          <button
            type="button"
            title={actionBusy === "commit" ? "提交中" : "提交"}
            aria-label={actionBusy === "commit" ? "提交中" : "提交"}
            disabled={!commitMessage.trim() || actionBusy === "commit"}
            onClick={() => void submitCommit()}
            style={{
              width: "26px",
              height: "26px",
              border: "none",
              borderRadius: "7px",
              background: "var(--accent-color)",
              color: "#fff",
              padding: 0,
              fontSize: "15px",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              cursor: !commitMessage.trim() || actionBusy === "commit" ? "not-allowed" : "pointer",
              opacity: !commitMessage.trim() || actionBusy === "commit" ? 0.55 : 1,
            }}
          >
            <CommitSubmitIcon />
          </button>
        </div>
      ) : null}

      {!expanded ? null : loading ? (
        <div style={{ fontSize: "12px", color: "var(--text-secondary)", padding: "6px 10px" }}>正在加载 git 变更...</div>
      ) : !hasStatusItems ? null : (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px", paddingLeft: compact ? 0 : "14px", minWidth: 0 }}>
          {items.map((item) => {
            const actionKey = `${item.status}:${item.path}`;
            const showActions = selectedActionPath === actionKey || hoveredActionPath === actionKey;
            return (
              <div
                key={actionKey}
                role="button"
                tabIndex={item.is_dir === true ? -1 : 0}
                onClick={() => {
                  setSelectedActionPath(actionKey);
                  if (item.is_dir !== true && !actionBusy) {
                    onSelectItem?.(item);
                  }
                }}
                onKeyDown={(event) => {
                  if ((event.key === "Enter" || event.key === " ") && item.is_dir !== true && !actionBusy) {
                    event.preventDefault();
                    setSelectedActionPath(actionKey);
                    onSelectItem?.(item);
                  }
                }}
                style={{
                  position: "relative",
                  display: "flex",
                  alignItems: "center",
                  gap: compact ? "6px" : "10px",
                  width: "100%",
                  border: "none",
                  background: selectedActionPath === actionKey
                    ? "linear-gradient(180deg, rgba(59, 130, 246, 0.14), rgba(59, 130, 246, 0.06))"
                    : "linear-gradient(180deg, rgba(59, 130, 246, 0.08), rgba(59, 130, 246, 0.03))",
                  padding: compact ? "6px 7px" : "6px 10px",
                  cursor: item.is_dir === true ? "default" : "pointer",
                  textAlign: "left",
                  borderRadius: "8px",
                  transition: "background 0.15s",
                  opacity: item.is_dir === true ? 0.72 : 1,
                }}
                onMouseEnter={(e) => {
                  setHoveredActionPath(actionKey);
                  e.currentTarget.style.background = "linear-gradient(180deg, rgba(59, 130, 246, 0.12), rgba(59, 130, 246, 0.05))";
                }}
                onMouseLeave={(e) => {
                  setHoveredActionPath((current) => current === actionKey ? "" : current);
                  e.currentTarget.style.background = selectedActionPath === actionKey
                    ? "linear-gradient(180deg, rgba(59, 130, 246, 0.14), rgba(59, 130, 246, 0.06))"
                    : "linear-gradient(180deg, rgba(59, 130, 246, 0.08), rgba(59, 130, 246, 0.03))";
                }}
              >
                <span style={{ width: compact ? "18px" : "24px", color: renderStatusColor(item.status), fontSize: "12px", fontWeight: 700, flexShrink: 0 }}>
                  {renderStatusLabel(item.status)}
                </span>
                <span title={item.display_path || item.path} style={{ flex: 1, minWidth: 0, fontSize: "12px", color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {compactPath(item.display_path || item.path)}
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: compact ? "2px" : "8px", fontSize: "11px", color: "var(--text-secondary)", flexShrink: 0 }}>
                  {renderLineStat(item.additions, "+")}
                  {renderLineStat(item.deletions, "-")}
                </span>
                {showActions ? (
                  <span
                    style={{
                      position: "absolute",
                      top: "50%",
                      right: "4px",
                      transform: "translateY(-50%)",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 0,
                      padding: "2px",
                      borderRadius: "7px",
                      border: "1px solid var(--border-color)",
                      background: "var(--menu-bg)",
                      boxShadow: "0 6px 16px rgba(15, 23, 42, 0.14)",
                      zIndex: 3,
                    }}
                  >
                    <GitIconButton
                      title="打开文件"
                      disabled={!onOpenItem || item.is_dir === true || !!actionBusy}
                      onClick={() => onOpenItem?.(item)}
                    >
                      <OpenFileIcon />
                    </GitIconButton>
                    <GitIconButton
                      title="撤销变更"
                      disabled={!onDiscardItem || !!actionBusy}
                      onClick={() => {
                        if (item.status === "??") {
                          const ok = window.confirm(`确认删除未跟踪文件“${item.path}”？`);
                          if (!ok) {
                            return;
                          }
                        }
                        return runPanelAction(`discard:${item.path}`, () => onDiscardItem?.(item));
                      }}
                    >
                      <UndoIcon />
                    </GitIconButton>
                    <GitIconButton
                      title={item.staged === true ? "取消暂存" : "暂存变更"}
                      disabled={!onStageItem || !!actionBusy}
                      onClick={() => runPanelAction(`${item.staged === true ? "unstage" : "stage"}:${item.path}`, () => onStageItem?.(item))}
                    >
                      {item.staged === true ? <UnstageIcon /> : <StageIcon />}
                    </GitIconButton>
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

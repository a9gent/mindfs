import React, { useEffect, useRef, useState } from "react";
import type { GitBranchItem } from "../services/git";
import { useI18n } from "../i18n";

type WorktreeBranchSelectorProps = {
  branchMode: "new" | "existing";
  branch: string;
  branches: GitBranchItem[];
  disabled?: boolean;
  height?: number;
  maxWidth?: number;
  menuAlign?: "left" | "right";
  menuPlacement?: "top" | "bottom";
  onChange: (branchMode: "new" | "existing", branch: string) => void;
};

export function WorktreeBranchSelector({
  branchMode,
  branch,
  branches,
  disabled = false,
  height = 24,
  maxWidth = 240,
  menuAlign = "right",
  menuPlacement = "bottom",
  onChange,
}: WorktreeBranchSelectorProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedBranch = branches.find((item) => item.name === branch);
  const label =
    branchMode === "new"
      ? t("worktree.createBranch")
      : selectedBranch?.name || branch;

  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  useEffect(() => {
    if (!open) return;

    const handlePointerOutside = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const selectBranch = (nextMode: "new" | "existing", nextBranch: string) => {
    onChange(nextMode, nextBranch);
    setOpen(false);
  };

  const renderCheck = (selected: boolean) => (
    <span
      aria-hidden="true"
      style={{
        width: "18px",
        height: "18px",
        flex: "0 0 18px",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: selected ? "var(--accent-color)" : "transparent",
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
        <path d="m5 12.5 4.1 4L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );

  return (
    <div ref={containerRef} style={{ position: "relative", minWidth: 0, maxWidth: "100%" }}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        style={{
          width: "100%",
          minWidth: "92px",
          maxWidth: `${maxWidth}px`,
          height: `${height}px`,
          borderRadius: "6px",
          border: open ? "1px solid var(--accent-color)" : "1px solid var(--border-color)",
          background: "var(--menu-bg)",
          color: "var(--text-primary)",
          display: "flex",
          alignItems: "center",
          gap: "5px",
          padding: "0 7px 0 9px",
          outline: "none",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.72 : 1,
          boxShadow: open ? "0 0 0 2px color-mix(in srgb, var(--accent-color) 14%, transparent)" : "none",
        }}
      >
        <span
          style={{
            minWidth: 0,
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            textAlign: "left",
            fontSize: height > 24 ? "12px" : "11px",
            fontWeight: 700,
          }}
        >
          {label}
        </span>
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
          style={{
            flex: "0 0 auto",
            color: "var(--text-secondary)",
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 160ms ease",
          }}
        >
          <path d="m7 10 5 5 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open ? (
        <div
          role="listbox"
          aria-label={t("worktree.createBranch")}
          style={{
            position: "absolute",
            ...(menuPlacement === "top"
              ? { bottom: "calc(100% + 7px)" }
              : { top: "calc(100% + 7px)" }),
            ...(menuAlign === "left" ? { left: 0 } : { right: 0 }),
            zIndex: 1200,
            width: "max-content",
            minWidth: "220px",
            maxWidth: "min(300px, calc(100vw - 24px))",
            maxHeight: "min(46dvh, 292px)",
            overflowY: "auto",
            overscrollBehavior: "contain",
            padding: "6px",
            border: "1px solid var(--menu-border)",
            borderRadius: "12px",
            background: "var(--menu-bg)",
            boxShadow: "0 14px 36px rgba(15, 23, 42, 0.18)",
          }}
        >
          <button
            type="button"
            role="option"
            aria-selected={branchMode === "new"}
            onClick={() => selectBranch("new", "")}
            style={{
              width: "100%",
              minHeight: "38px",
              padding: "7px 9px",
              border: "none",
              borderRadius: "8px",
              background: branchMode === "new" ? "rgba(59, 130, 246, 0.10)" : "transparent",
              color: branchMode === "new" ? "var(--accent-color)" : "var(--text-primary)",
              display: "flex",
              alignItems: "center",
              gap: "7px",
              textAlign: "left",
              cursor: "pointer",
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: "24px",
                height: "24px",
                flex: "0 0 24px",
                borderRadius: "7px",
                background: "color-mix(in srgb, var(--accent-color) 12%, transparent)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--accent-color)",
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                <path d="M6 3v12a4 4 0 0 0 4 4h2M6 7h4a4 4 0 0 1 4 4v1m4-3v6m-3-3h6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span style={{ minWidth: 0, flex: 1, fontSize: "13px", fontWeight: 700 }}>
              {t("worktree.createBranch")}
            </span>
            {renderCheck(branchMode === "new")}
          </button>

          {branches.length > 0 ? (
            <div
              aria-hidden="true"
              style={{
                height: "1px",
                margin: "5px 7px",
                background: "var(--menu-border)",
              }}
            />
          ) : null}

          {branches.map((item) => {
            const selected = branchMode === "existing" && branch === item.name;
            return (
              <button
                key={item.name}
                type="button"
                role="option"
                aria-selected={selected}
                title={item.name}
                onClick={() => selectBranch("existing", item.name)}
                style={{
                  width: "100%",
                  minHeight: "38px",
                  padding: "7px 9px",
                  border: "none",
                  borderRadius: "8px",
                  background: selected ? "rgba(59, 130, 246, 0.10)" : "transparent",
                  color: selected ? "var(--accent-color)" : "var(--text-primary)",
                  display: "flex",
                  alignItems: "center",
                  gap: "7px",
                  textAlign: "left",
                  cursor: "pointer",
                }}
              >
                <span
                  style={{
                    minWidth: 0,
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: "13px",
                    fontWeight: selected ? 700 : 550,
                  }}
                >
                  {item.name}
                </span>
                {item.current ? (
                  <span
                    style={{
                      flex: "0 0 auto",
                      padding: "2px 6px",
                      borderRadius: "999px",
                      background: "rgba(100, 116, 139, 0.11)",
                      color: "var(--text-secondary)",
                      fontSize: "10px",
                      fontWeight: 700,
                    }}
                  >
                    {t("worktree.current")}
                  </span>
                ) : null}
                {renderCheck(selected)}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

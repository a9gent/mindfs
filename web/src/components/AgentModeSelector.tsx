import React, { useEffect, useRef, useState } from "react";
import type { AgentStatus } from "../services/agents";

type AgentModeSelectorProps = {
  agent?: AgentStatus | null;
  mode?: string;
  onModeChange?: (mode?: string) => void;
  compact?: boolean;
  menuPlacement?: "top" | "bottom";
  maxButtonWidth?: string;
};

/** Agent 模式选择器：独立选择运行模式，与模型/思考等级/Fast 配置解耦。 */
export function AgentModeSelector({
  agent,
  mode = "",
  onModeChange,
  compact = false,
  menuPlacement = "top",
  maxButtonWidth = "min(30vw, 132px)",
}: AgentModeSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const modes = agent?.modes ?? [];
  const displayedMode = mode || agent?.current_mode_id || "";
  // 从 modes 中找到当前模式的 name 用于展示
  const currentMode = modes.find((item) => item.id === displayedMode);
  const displayName = currentMode?.name || currentMode?.id || displayedMode || "模式";

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerOutside = (event: PointerEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerOutside);
    return () => document.removeEventListener("pointerdown", handlePointerOutside);
  }, [isOpen]);

  useEffect(() => setIsOpen(false), [agent?.name]);

  const closeMenu = () => setIsOpen(false);

  if (modes.length === 0) return null;

  return (
    <div ref={dropdownRef} style={{ position: "relative", minWidth: 0 }}>
      <button
        type="button"
        onClick={() => setIsOpen((previous) => !previous)}
        title={currentMode?.description || currentMode?.id || ""}
        aria-label={`选择模式，当前为 ${displayName}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "4px",
          maxWidth: maxButtonWidth,
          height: compact ? "28px" : "32px",
          padding: compact ? "0 5px" : "0 8px",
          border: "none",
          borderRadius: "10px",
          background: isOpen ? "rgba(59,130,246,0.08)" : "transparent",
          color: "var(--text-primary)",
          cursor: "pointer",
          outline: "none",
        }}
      >
        <span
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: "12px",
            fontWeight: 600,
          }}
        >
          {displayName}
        </span>
        <SelectorChevron expanded={isOpen} />
      </button>

      {isOpen ? (
        <div
          style={{
            position: "absolute",
            ...(menuPlacement === "bottom"
              ? { top: "calc(100% + 8px)" }
              : { bottom: "calc(100% + 8px)" }),
            right: 0,
            width: "min(280px, calc(100vw - 16px))",
            maxHeight: "360px",
            overflowY: "auto",
            padding: "8px 0",
            border: "1px solid var(--menu-border)",
            borderRadius: "12px",
            background: "var(--menu-bg)",
            boxShadow: "0 8px 32px rgba(0,0,0,0.15)",
            zIndex: 1000,
          }}
        >
          {modes.map((item, index) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onModeChange?.(item.id);
                closeMenu();
              }}
              title={item.description || item.id}
              style={sectionItemStyle(item.id === displayedMode, index > 0)}
            >
              <span style={{ fontSize: "13px", fontWeight: 600 }}>{item.name || item.id}</span>
              {item.description ? <span style={descriptionStyle}>{item.description}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const descriptionStyle: React.CSSProperties = {
  fontSize: "11px",
  color: "var(--text-secondary)",
  whiteSpace: "normal",
  overflowWrap: "anywhere",
  wordBreak: "break-word",
};

function SelectorChevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      style={{
        flexShrink: 0,
        color: expanded ? "#3b82f6" : "var(--text-secondary)",
        transform: expanded ? "rotate(180deg)" : "none",
        transition: "transform 0.16s ease",
      }}
    >
      <path d="m2.5 4 3.5 4 3.5-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function sectionItemStyle(selected: boolean, topBorder = false): React.CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "2px",
    width: "100%",
    minWidth: 0,
    padding: "10px 12px",
    border: "none",
    borderTop: topBorder ? "1px solid var(--menu-divider)" : "none",
    background: selected ? "rgba(59,130,246,0.08)" : "transparent",
    color: selected ? "#3b82f6" : "var(--text-primary)",
    textAlign: "left",
    cursor: "pointer",
  };
}

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { AgentStatus } from "../services/agents";

type ModelSelectorProps = {
  agent?: AgentStatus | null;
  model?: string;
  onModelChange: (model: string) => void;
  compact?: boolean;
  menuPlacement?: "top" | "bottom";
  maxButtonWidth?: string;
};

/** 模型选择器：独立选择模型，不包含运行参数（模式/思考等级/Fast）。 */
export function ModelSelector({
  agent,
  model = "",
  onModelChange,
  compact = false,
  menuPlacement = "top",
  maxButtonWidth = "min(30vw, 132px)",
}: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const models = agent?.models ?? [];
  const selectedModel = useMemo(() => {
    const fallback = agent?.default_model_id || agent?.current_model_id || "";
    const target = model || fallback;
    return models.find((item) => item.id === target) ?? null;
  }, [agent, model, models]);
  const displayName = selectedModel?.name || selectedModel?.id || model || "模型";
  const hasModelContent = models.length > 0;

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

  if (!agent && !model) return null;

  return (
    <div ref={dropdownRef} style={{ position: "relative", minWidth: 0 }}>
      <button
        type="button"
        disabled={!hasModelContent || !agent?.available}
        onClick={() => setIsOpen((previous) => !previous)}
        title={selectedModel?.description || selectedModel?.id || model || "当前 Agent 未提供模型"}
        aria-label={`选择模型，当前为 ${displayName}`}
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
          color: agent?.available === false ? "var(--text-secondary)" : "var(--text-primary)",
          cursor: hasModelContent && agent?.available !== false ? "pointer" : "default",
          opacity: hasModelContent ? 1 : 0.58,
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
          {models.map((item, index) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onModelChange(item.id);
                closeMenu();
              }}
              title={item.description || item.id}
              style={sectionItemStyle(item.id === selectedModel?.id, index > 0, item.hidden ? 0.66 : 1)}
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

function sectionItemStyle(selected: boolean, topBorder = false, opacity = 1): React.CSSProperties {
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
    opacity,
  };
}

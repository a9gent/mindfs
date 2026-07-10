import React from "react";
import type { AgentStatus } from "../services/agents";

type FastServiceSelectorProps = {
  agent?: AgentStatus | null;
  fastService?: "" | "on" | "off";
  onFastServiceChange?: (fastService?: "" | "on" | "off") => void;
  compact?: boolean;
};

/** Fast 模式开关：灰色关闭，蓝色开启，点击直接切换。 */
export function FastServiceSelector({
  agent,
  fastService = "",
  onFastServiceChange,
  compact = false,
}: FastServiceSelectorProps) {
  const supportsFastService = !!agent?.supports_fast_service;
  const fastModeEnabled = (fastService || agent?.default_fast_service || "") === "on";

  if (!supportsFastService) return null;

  return (
    <button
      type="button"
      onClick={() => onFastServiceChange?.(fastModeEnabled ? "off" : "on")}
      aria-label={`Fast 模式，当前为 ${fastModeEnabled ? "开启" : "关闭"}`}
      title={`Fast 模式：${fastModeEnabled ? "开启" : "关闭"}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        height: compact ? "28px" : "32px",
        padding: compact ? "0 5px" : "0 8px",
        border: "none",
        borderRadius: "10px",
        background: fastModeEnabled ? "rgba(59,130,246,0.15)" : "transparent",
        color: fastModeEnabled ? "#3b82f6" : "var(--text-secondary)",
        cursor: "pointer",
        outline: "none",
        fontSize: "12px",
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      <span>Fast</span>
    </button>
  );
}

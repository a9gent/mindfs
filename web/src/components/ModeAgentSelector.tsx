import React, { useState, useRef, useEffect, useCallback } from "react";

export type SessionMode = "chat" | "view" | "skill";

type AgentStatus = {
  name: string;
  available: boolean;
  version?: string;
};

type ModeAgentSelectorProps = {
  mode: SessionMode;
  agent: string;
  agents: AgentStatus[];
  onModeChange: (mode: SessionMode) => void;
  onAgentChange: (agent: string) => void;
};

const modeLabels: Record<SessionMode, string> = {
  chat: "对话",
  view: "生成视图",
  skill: "执行技能",
};

const modeIcons: Record<SessionMode, string> = {
  chat: "💬",
  view: "🎨",
  skill: "⚡",
};

export function ModeAgentSelector({
  mode,
  agent,
  agents,
  onModeChange,
  onAgentChange,
}: ModeAgentSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  const handleModeSelect = useCallback(
    (newMode: SessionMode) => {
      onModeChange(newMode);
    },
    [onModeChange]
  );

  const handleAgentSelect = useCallback(
    (newAgent: string) => {
      onAgentChange(newAgent);
      setIsOpen(false);
    },
    [onAgentChange]
  );

  const currentAgent = agents.find((a) => a.name === agent);

  return (
    <div ref={dropdownRef} style={{ position: "relative" }}>
      {/* 触发按钮 */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          padding: "8px 12px",
          borderRadius: "8px",
          border: "1px solid var(--border-color)",
          background: "#fff",
          cursor: "pointer",
          fontSize: "13px",
          fontWeight: 500,
          color: "var(--text-primary)",
          minWidth: "140px",
        }}
      >
        <span>{modeIcons[mode]}</span>
        <span>{modeLabels[mode]}</span>
        <span style={{ color: "var(--text-secondary)", margin: "0 2px" }}>·</span>
        <span
          style={{
            color: currentAgent?.available ? "var(--text-primary)" : "var(--text-secondary)",
          }}
        >
          {agent || "未选择"}
        </span>
        {currentAgent && !currentAgent.available && (
          <span
            style={{
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              background: "#ef4444",
            }}
          />
        )}
        <span
          style={{
            marginLeft: "auto",
            fontSize: "10px",
            color: "var(--text-secondary)",
            transform: isOpen ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 0.15s",
          }}
        >
          ▼
        </span>
      </button>

      {/* 下拉面板 */}
      {isOpen && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            background: "#fff",
            border: "1px solid var(--border-color)",
            borderRadius: "12px",
            boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
            zIndex: 100,
            display: "flex",
            overflow: "hidden",
            minWidth: "320px",
          }}
        >
          {/* 左侧: 模式列表 */}
          <div
            style={{
              borderRight: "1px solid var(--border-color)",
              padding: "8px 0",
              minWidth: "140px",
            }}
          >
            <div
              style={{
                padding: "6px 12px",
                fontSize: "11px",
                fontWeight: 600,
                color: "var(--text-secondary)",
                textTransform: "uppercase",
              }}
            >
              模式
            </div>
            {(["chat", "view", "skill"] as SessionMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => handleModeSelect(m)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  width: "100%",
                  padding: "10px 12px",
                  border: "none",
                  background: m === mode ? "rgba(59, 130, 246, 0.08)" : "transparent",
                  cursor: "pointer",
                  fontSize: "13px",
                  color: m === mode ? "#3b82f6" : "var(--text-primary)",
                  fontWeight: m === mode ? 500 : 400,
                  textAlign: "left",
                }}
                onMouseEnter={(e) => {
                  if (m !== mode) e.currentTarget.style.background = "rgba(0,0,0,0.03)";
                }}
                onMouseLeave={(e) => {
                  if (m !== mode) e.currentTarget.style.background = "transparent";
                }}
              >
                <span>{modeIcons[m]}</span>
                <span>{modeLabels[m]}</span>
                {m === mode && (
                  <span style={{ marginLeft: "auto", fontSize: "12px" }}>✓</span>
                )}
              </button>
            ))}
          </div>

          {/* 右侧: Agent 列表 */}
          <div style={{ padding: "8px 0", minWidth: "160px" }}>
            <div
              style={{
                padding: "6px 12px",
                fontSize: "11px",
                fontWeight: 600,
                color: "var(--text-secondary)",
                textTransform: "uppercase",
              }}
            >
              Agent
            </div>
            {agents.map((a) => (
              <button
                key={a.name}
                type="button"
                onClick={() => a.available && handleAgentSelect(a.name)}
                disabled={!a.available}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  width: "100%",
                  padding: "10px 12px",
                  border: "none",
                  background: a.name === agent ? "rgba(59, 130, 246, 0.08)" : "transparent",
                  cursor: a.available ? "pointer" : "not-allowed",
                  fontSize: "13px",
                  color: !a.available
                    ? "var(--text-secondary)"
                    : a.name === agent
                    ? "#3b82f6"
                    : "var(--text-primary)",
                  fontWeight: a.name === agent ? 500 : 400,
                  textAlign: "left",
                  opacity: a.available ? 1 : 0.6,
                }}
                onMouseEnter={(e) => {
                  if (a.available && a.name !== agent)
                    e.currentTarget.style.background = "rgba(0,0,0,0.03)";
                }}
                onMouseLeave={(e) => {
                  if (a.available && a.name !== agent)
                    e.currentTarget.style.background = "transparent";
                }}
              >
                <span
                  style={{
                    width: "8px",
                    height: "8px",
                    borderRadius: "50%",
                    background: a.available ? "#22c55e" : "#ef4444",
                  }}
                />
                <span>{a.name}</span>
                {a.version && (
                  <span
                    style={{
                      fontSize: "10px",
                      color: "var(--text-secondary)",
                      marginLeft: "auto",
                    }}
                  >
                    {a.version}
                  </span>
                )}
                {a.name === agent && a.available && (
                  <span style={{ marginLeft: "auto", fontSize: "12px" }}>✓</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

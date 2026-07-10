import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentIcon } from "./AgentIcon";
import type { AgentStatus } from "../services/agents";

type AgentSelectorProps = {
  agent: string;
  agents: AgentStatus[];
  onAgentChange: (agent: string) => void;
  onAgentRestart?: (agent: string) => void | Promise<void>;
  compact?: boolean;
  warnUnavailable?: boolean;
  menuPlacement?: "top" | "bottom";
  showChevron?: boolean;
};

function parseAgentErrorMessage(error?: string): string {
  const raw = String(error || "").trim();
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as { message?: unknown };
    return typeof parsed.message === "string" && parsed.message.trim()
      ? parsed.message.trim()
      : raw;
  } catch {
    return raw;
  }
}

function parseAgentErrorDetails(error?: string): string[] {
  const raw = String(error || "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { data?: unknown };
    if (parsed.data === undefined) return [];
    if (Array.isArray(parsed.data)) {
      return parsed.data.map((item) => String(item)).filter(Boolean);
    }
    if (parsed.data && typeof parsed.data === "object") {
      const authMethods = (parsed.data as { authMethods?: unknown }).authMethods;
      if (Array.isArray(authMethods)) {
        return (authMethods as Array<{ name?: unknown; description?: unknown }>)
          .map((item) => {
            const name = typeof item?.name === "string" ? item.name.trim() : "";
            const description =
              typeof item?.description === "string" ? item.description.trim() : "";
            return name && description ? `${name}: ${description}` : name || description;
          })
          .filter(Boolean);
      }
      return Object.entries(parsed.data as Record<string, unknown>).map(
        ([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
      );
    }
    return [String(parsed.data)];
  } catch {
    return [];
  }
}

/** Agent 下拉只负责 Agent 本身；模型与运行参数由相邻的 ModelSelector 管理。 */
export function AgentSelector({
  agent,
  agents,
  onAgentChange,
  onAgentRestart,
  compact = false,
  warnUnavailable = false,
  menuPlacement = "top",
  showChevron = false,
}: AgentSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [errorAgent, setErrorAgent] = useState<string | null>(null);
  const [restartingAgent, setRestartingAgent] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const errorAgentStatus = useMemo(
    () => agents.find((item) => item.name === errorAgent) ?? null,
    [agents, errorAgent],
  );

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerOutside = (event: PointerEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setErrorAgent(null);
      }
    };
    document.addEventListener("pointerdown", handlePointerOutside);
    return () => document.removeEventListener("pointerdown", handlePointerOutside);
  }, [isOpen]);

  const handleAgentSelect = useCallback(
    (nextAgent: string) => {
      onAgentChange(nextAgent);
      setIsOpen(false);
      setErrorAgent(null);
    },
    [onAgentChange],
  );

  const handleAgentRestart = useCallback(
    async (targetAgent: string) => {
      if (!onAgentRestart || restartingAgent) return;
      setRestartingAgent(targetAgent);
      try {
        await onAgentRestart(targetAgent);
      } finally {
        setRestartingAgent((current) => (current === targetAgent ? null : current));
      }
    },
    [onAgentRestart, restartingAgent],
  );

  return (
    <div ref={dropdownRef} style={{ position: "relative" }}>
      <style>{`
        @keyframes agent-refresh-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
      <button
        type="button"
        onClick={() => {
          setIsOpen((previous) => !previous);
          setErrorAgent(null);
        }}
        title={warnUnavailable ? `当前会话的 Agent（${agent}）不可用` : agent || "选择 Agent"}
        aria-label={`选择 Agent，当前为 ${agent || "未选择"}`}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "4px",
          padding: compact ? "4px" : "6px 8px",
          borderRadius: "12px",
          border: "none",
          background: "transparent",
          color: "var(--text-primary)",
          cursor: "pointer",
          outline: "none",
          position: "relative",
        }}
      >
        <AgentIcon agentName={agent} style={{ width: "16px", height: "16px" }} />
        {showChevron ? <SelectorChevron expanded={isOpen} /> : null}
        {warnUnavailable ? (
          <span
            style={{
              position: "absolute",
              top: "1px",
              right: "1px",
              minWidth: "11px",
              height: "11px",
              borderRadius: "50%",
              background: "#d97706",
              color: "#fff",
              fontSize: "9px",
              lineHeight: "11px",
              fontWeight: 700,
              textAlign: "center",
            }}
          >
            !
          </span>
        ) : null}
      </button>

      {isOpen ? (
        <div
          style={{
            position: "absolute",
            ...(menuPlacement === "bottom"
              ? { top: "calc(100% + 8px)" }
              : { bottom: "calc(100% + 8px)" }),
            right: 0,
            display: "flex",
            maxWidth: "calc(100vw - 16px)",
            maxHeight: "360px",
            padding: "8px 0",
            border: "1px solid var(--menu-border)",
            borderRadius: "12px",
            background: "var(--menu-bg)",
            boxShadow: "0 8px 32px rgba(0,0,0,0.15)",
            zIndex: 1000,
          }}
        >
          <div style={{ width: "min(72vw, 180px)", maxHeight: "344px", overflowY: "auto" }}>
            <div
              style={{
                padding: "6px 12px",
                fontSize: "11px",
                fontWeight: 700,
                color: "var(--text-secondary)",
                textTransform: "uppercase",
              }}
            >
              Agent
            </div>
            {agents.map((item) => {
              const selected = item.name === agent;
              const hasError = !item.available && !!item.error;
              return (
                <div
                  key={item.name}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "20px minmax(0, 1fr) 20px",
                    alignItems: "center",
                    gap: "6px",
                    padding: "10px 12px",
                    background: selected ? "rgba(59, 130, 246, 0.08)" : "transparent",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => handleAgentSelect(item.name)}
                    style={{ display: "contents", cursor: "pointer" }}
                  >
                    <AgentIcon agentName={item.name} style={{ width: "16px", height: "16px" }} />
                    <span
                      style={{
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        color: selected ? "#3b82f6" : "var(--text-primary)",
                        fontSize: "13px",
                        fontWeight: selected ? 600 : 400,
                        textAlign: "left",
                      }}
                    >
                      {item.name}
                    </span>
                  </button>
                  {hasError ? (
                    <button
                      type="button"
                      aria-label={`查看 ${item.name} 错误信息`}
                      onClick={() => setErrorAgent((current) => (current === item.name ? null : item.name))}
                      style={{
                        width: "20px",
                        height: "20px",
                        padding: 0,
                        border: "1px solid var(--menu-border)",
                        borderRadius: "50%",
                        background: errorAgent === item.name ? "rgba(217,119,6,0.12)" : "transparent",
                        color: "#d97706",
                        cursor: "pointer",
                        fontWeight: 700,
                      }}
                    >
                      ?
                    </button>
                  ) : (
                    <span />
                  )}
                </div>
              );
            })}
          </div>

          {errorAgentStatus && parseAgentErrorMessage(errorAgentStatus.error) ? (
            <div
              style={{
                width: "min(44vw, 220px)",
                padding: "12px",
                borderLeft: "1px solid var(--menu-divider)",
                overflowY: "auto",
                boxSizing: "border-box",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
                <span style={{ fontSize: "11px", fontWeight: 700, color: "#d97706" }}>错误信息</span>
                {onAgentRestart ? (
                  <button
                    type="button"
                    title="重启 Agent"
                    disabled={restartingAgent === errorAgentStatus.name}
                    onClick={() => void handleAgentRestart(errorAgentStatus.name)}
                    style={{ border: "none", background: "transparent", color: "#d97706", cursor: "pointer" }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        display: "inline-block",
                        animation: restartingAgent === errorAgentStatus.name ? "agent-refresh-spin 0.9s linear infinite" : undefined,
                      }}
                    >
                      ↻
                    </span>
                  </button>
                ) : null}
              </div>
              <div style={{ marginTop: "8px", fontSize: "12px", lineHeight: 1.5, color: "var(--text-primary)", overflowWrap: "anywhere" }}>
                {parseAgentErrorMessage(errorAgentStatus.error)}
              </div>
              {parseAgentErrorDetails(errorAgentStatus.error).map((detail) => (
                <div key={detail} style={{ marginTop: "8px", fontSize: "11px", lineHeight: 1.5, color: "var(--text-secondary)", overflowWrap: "anywhere" }}>
                  {detail}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

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

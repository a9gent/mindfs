import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { AgentIcon } from "./AgentIcon";
import type { AgentStatus } from "../services/agents";

type AgentSelectorProps = {
  agent: string;
  model?: string;
  agents: AgentStatus[];
  onAgentChange: (agent: string, model?: string) => void;
  compact?: boolean;
  warnUnavailable?: boolean;
};

export function AgentSelector({
  agent,
  model = "",
  agents,
  onAgentChange,
  compact = false,
  warnUnavailable = false,
}: AgentSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [submenuAgent, setSubmenuAgent] = useState<string | null>(null);
  const [menuBodyHeight, setMenuBodyHeight] = useState<number | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const agentColumnRef = useRef<HTMLDivElement>(null);
  const selectedAgent = useMemo(
    () => agents.find((item) => item.name === agent),
    [agents, agent]
  );
  const submenuAgentStatus = useMemo(
    () => agents.find((item) => item.name === submenuAgent) ?? null,
    [agents, submenuAgent]
  );
  const submenuModels = useMemo(
    () => submenuAgentStatus?.models ?? [],
    [submenuAgentStatus]
  );
  const buttonTitle = useMemo(() => {
    if (warnUnavailable) {
      return `当前会话的 Agent（${agent}）不可用`;
    }
    if (agent && model) {
      return `${agent} · ${model}`;
    }
    return undefined;
  }, [agent, model, warnUnavailable]);

  useEffect(() => {
    const handlePointerOutside = (e: PointerEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setSubmenuAgent(null);
        setMenuBodyHeight(null);
      }
    };
    if (isOpen) {
      document.addEventListener("pointerdown", handlePointerOutside);
      return () => document.removeEventListener("pointerdown", handlePointerOutside);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || submenuAgent) {
      return;
    }
    const node = agentColumnRef.current;
    if (!node) {
      return;
    }
    setMenuBodyHeight(Math.min(node.scrollHeight, 344));
  }, [isOpen, submenuAgent, agents.length]);

  const handleAgentSelect = useCallback(
    (newAgent: string, nextModel?: string) => {
      onAgentChange(newAgent, nextModel);
      setIsOpen(false);
      setSubmenuAgent(null);
    },
    [onAgentChange]
  );

  const handleAgentRowClick = useCallback(
    (entry: AgentStatus) => {
      if (!entry.available) {
        return;
      }
      handleAgentSelect(entry.name, "");
    },
    [handleAgentSelect]
  );

  const handleSubmenuToggle = useCallback(
    (entry: AgentStatus) => {
      if (!entry.available || (entry.models?.length ?? 0) === 0) {
        return;
      }
      const node = agentColumnRef.current;
      if (node) {
        setMenuBodyHeight(Math.min(node.scrollHeight, 344));
      }
      setSubmenuAgent((prev) => (prev === entry.name ? null : entry.name));
    },
    []
  );

  const handleDefaultModelSelect = useCallback(
    (entry: AgentStatus) => {
      handleAgentSelect(entry.name, "");
    },
    [handleAgentSelect]
  );

  return (
    <div ref={dropdownRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => {
          setIsOpen((prev) => {
            const next = !prev;
            if (!next) {
              setSubmenuAgent(null);
              setMenuBodyHeight(null);
            }
            return next;
          });
        }}
        title={buttonTitle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "4px",
          padding: compact ? "4px 4px" : "6px 8px",
          borderRadius: "12px",
          border: "none",
          background: "transparent",
          cursor: "pointer",
          fontSize: "16px",
          transition: "background 0.2s",
          outline: "none",
          position: "relative",
        }}
        onMouseEnter={(e) => {
          if (compact) e.currentTarget.style.background = "rgba(0,0,0,0.05)";
        }}
        onMouseLeave={(e) => {
          if (compact) e.currentTarget.style.background = "transparent";
        }}
      >
        <AgentIcon agentName={agent} style={{ width: "16px", height: "16px" }} />
        {warnUnavailable && (
          <span
            style={{
              position: "absolute",
              top: "3px",
              right: "3px",
              minWidth: "11px",
              height: "11px",
              padding: "0 2px",
              borderRadius: "50%",
              background: "#d97706",
              color: "#fff",
              fontSize: "9px",
              lineHeight: "11px",
              fontWeight: 700,
              textAlign: "center",
              boxShadow: "0 0 0 1px rgba(255,255,255,0.95)",
            }}
          >
            !
          </span>
        )}
      </button>

      {isOpen && (
        <div
          style={{
            position: "absolute",
            bottom: "calc(100% + 8px)",
            right: 0,
            background: "var(--menu-bg)",
            border: "1px solid var(--menu-border)",
            borderRadius: "12px",
            boxShadow: "0 8px 32px rgba(0,0,0,0.15)",
            zIndex: 1000,
            width: "max-content",
            minWidth: "0",
            maxWidth: "calc(100vw - 16px)",
            padding: "8px 0",
            display: "flex",
            alignItems: "stretch",
            height: menuBodyHeight ? `${menuBodyHeight + 16}px` : "auto",
            maxHeight: "360px",
          }}
        >
          <div
            ref={agentColumnRef}
            style={{
              width: "fit-content",
              minWidth: "0",
              maxWidth: submenuAgentStatus ? "min(44vw, 180px)" : "min(72vw, 180px)",
              height: menuBodyHeight ? `${menuBodyHeight}px` : "auto",
              maxHeight: "344px",
              overflowY: "auto",
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
              Agent
            </div>
            {agents.map((a) => {
              const hasModels = (a.models?.length ?? 0) > 0;
              const isSelected = a.name === agent;
              const isExpanded = submenuAgent === a.name;
              return (
                <button
                  key={a.name}
                  type="button"
                  onClick={() => handleAgentRowClick(a)}
                  disabled={!a.available}
                  style={{
                    display: "grid",
                    gridTemplateColumns: hasModels ? "20px minmax(0, 1fr) 18px" : "20px max-content",
                    alignItems: "center",
                    columnGap: "4px",
                    rowGap: "4px",
                    width: hasModels ? "100%" : "max-content",
                    minWidth: "100%",
                    padding: "10px 12px",
                    border: "none",
                    background: isExpanded || isSelected ? "rgba(59, 130, 246, 0.08)" : "transparent",
                    cursor: a.available ? "pointer" : "not-allowed",
                    fontSize: "13px",
                    color: !a.available
                      ? "var(--text-secondary)"
                      : isExpanded || isSelected
                      ? "#3b82f6"
                      : "var(--text-primary)",
                    fontWeight: isExpanded || isSelected ? 500 : 400,
                    textAlign: "left",
                    opacity: a.available ? 1 : 0.6,
                    whiteSpace: "nowrap",
                  }}
                >
                  <AgentIcon agentName={a.name} style={{ width: "16px", height: "16px" }} />
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{a.name}</span>
                  {hasModels ? (
                    <span
                      role="button"
                      aria-label={isExpanded ? `收起 ${a.name} 模型列表` : `展开 ${a.name} 模型列表`}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        handleSubmenuToggle(a);
                      }}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: "18px",
                        height: "18px",
                        borderRadius: "6px",
                        color: isExpanded ? "#3b82f6" : "var(--text-secondary)",
                        flexShrink: 0,
                        justifySelf: "end",
                      }}
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 12 12"
                        fill="none"
                        aria-hidden="true"
                      >
                        <path
                          d="M4 2.5 8 6 4 9.5"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>

          <div
            style={{
              width: submenuAgentStatus ? "fit-content" : "0",
              minWidth: submenuAgentStatus ? "0" : "0",
              maxWidth: submenuAgentStatus ? "min(40vw, 180px)" : "0",
              borderLeft: submenuAgentStatus ? "1px solid var(--menu-divider)" : "none",
              height: menuBodyHeight ? `${menuBodyHeight}px` : "auto",
              maxHeight: "344px",
              overflowY: "auto",
              overflowX: "hidden",
              transition: "width 0.16s ease, border-left-color 0.16s ease",
              boxSizing: "border-box",
            }}
          >
            {submenuAgentStatus ? (
              <>
              {submenuAgentStatus.current_model_id ? (
                <button
                  type="button"
                  onClick={() => handleDefaultModelSelect(submenuAgentStatus)}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    gap: "2px",
                    width: "max-content",
                    minWidth: "100%",
                    padding: "10px 12px",
                    border: "none",
                    background: submenuAgentStatus.name === agent && !model ? "rgba(59, 130, 246, 0.08)" : "transparent",
                    color: submenuAgentStatus.name === agent && !model ? "#3b82f6" : "var(--text-primary)",
                    textAlign: "left",
                    cursor: "pointer",
                  }}
                >
                  <span style={{ fontSize: "13px", fontWeight: 500 }}>默认模型</span>
                  <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
                    当前默认: {submenuAgentStatus.current_model_id}
                  </span>
                </button>
              ) : null}
              {submenuModels.map((item) => {
                const isSelected = submenuAgentStatus.name === agent && item.id === model;
                const showTopBorder = !!submenuAgentStatus.current_model_id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleAgentSelect(submenuAgentStatus.name, item.id)}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-start",
                      gap: "2px",
                      width: "max-content",
                      minWidth: "100%",
                      padding: "10px 12px",
                      border: "none",
                      borderTop: showTopBorder ? "1px solid var(--menu-divider)" : "none",
                      background: isSelected ? "rgba(59, 130, 246, 0.08)" : "transparent",
                      color: isSelected ? "#3b82f6" : "var(--text-primary)",
                      textAlign: "left",
                      cursor: "pointer",
                      opacity: item.hidden ? 0.66 : 1,
                    }}
                    title={item.description || item.id}
                  >
                    <span style={{ fontSize: "13px", fontWeight: 500 }}>
                      {item.name || item.id}
                    </span>
                    {item.description ? (
                      <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
                        {item.description}
                      </span>
                    ) : item.hidden ? (
                      <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>
                        hidden
                      </span>
                    ) : null}
                  </button>
                );
              })}
              </>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

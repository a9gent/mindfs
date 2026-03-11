import React, { useState, useRef, useEffect, useCallback } from "react";
import { AgentIcon } from "./AgentIcon";

type AgentStatus = {
  name: string;
  available: boolean;
  version?: string;
};

type AgentSelectorProps = {
  agent: string;
  agents: AgentStatus[];
  onAgentChange: (agent: string) => void;
  compact?: boolean;
  warnUnavailable?: boolean;
};

export function AgentSelector({
  agent,
  agents,
  onAgentChange,
  compact = false,
  warnUnavailable = false,
}: AgentSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePointerOutside = (e: PointerEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener("pointerdown", handlePointerOutside);
      return () => document.removeEventListener("pointerdown", handlePointerOutside);
    }
  }, [isOpen]);

  const handleAgentSelect = useCallback(
    (newAgent: string) => {
      onAgentChange(newAgent);
      setIsOpen(false);
    },
    [onAgentChange]
  );

  return (
    <div ref={dropdownRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        title={warnUnavailable ? `当前会话的 Agent（${agent}）不可用` : undefined}
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
            background: "#fff",
            border: "1px solid var(--border-color)",
            borderRadius: "12px",
            boxShadow: "0 8px 32px rgba(0,0,0,0.15)",
            zIndex: 1000,
            width: "max-content",
            minWidth: "140px",
            maxWidth: "min(80vw, 260px)",
            padding: "8px 0",
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
                whiteSpace: "nowrap",
              }}
            >
              <AgentIcon agentName={a.name} style={{ width: "16px", height: "16px", marginRight: "4px" }} />
              <span>{a.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

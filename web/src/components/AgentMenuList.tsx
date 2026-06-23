import React from "react";
import { AgentIcon } from "./AgentIcon";
import type { AgentStatus } from "../services/agents";

type AgentMenuListProps = {
  agents: AgentStatus[];
  selectedAgent?: string;
  maxHeight?: string;
  onSelect: (agentName: string) => void;
};

export function AgentMenuList({
  agents,
  selectedAgent = "",
  maxHeight = "180px",
  onSelect,
}: AgentMenuListProps) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "4px",
        maxHeight,
        overflow: "auto",
      }}
    >
      {agents.map((item) => {
        const selected = item.name === selectedAgent;
        return (
          <button
            key={item.name}
            type="button"
            onClick={() => onSelect(item.name)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              width: "100%",
              border: "1px solid transparent",
              background: selected ? "rgba(59, 130, 246, 0.1)" : "transparent",
              color: selected ? "var(--accent-color)" : "var(--text-primary)",
              borderRadius: "8px",
              padding: "8px 10px",
              cursor: "pointer",
              textAlign: "left",
              opacity: 1,
            }}
          >
            <AgentIcon
              agentName={item.name}
              style={{ width: "14px", height: "14px", display: "block" }}
            />
            <span
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: "12px",
                fontWeight: 500,
              }}
            >
              {item.name}
            </span>
            {!item.available ? (
              <span
                aria-label="当前未就绪"
                title="当前未就绪"
                style={{
                  minWidth: "11px",
                  height: "11px",
                  padding: "0 2px",
                  borderRadius: "50%",
                  background: "#d97706",
                  color: "#fff",
                  fontSize: "9px",
                  lineHeight: "11px",
                  textAlign: "center",
                  flexShrink: 0,
                  fontWeight: 700,
                }}
              >
                !
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

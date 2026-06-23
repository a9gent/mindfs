import React, { useState, useRef, useEffect, useCallback } from "react";
import { ModeIcon } from "./ModeIcon";

export type SessionMode = "chat" | "plugin" | "command";

type ModeSelectorProps = {
  mode: SessionMode;
  onModeChange: (mode: SessionMode) => void;
  compact?: boolean;
  disabled?: boolean;
};

const modeLabels: Record<SessionMode, string> = {
  chat: "agent 对话",
  plugin: "视图插件",
  command: "命令执行",
};

export function ModeSelector({
  mode,
  onModeChange,
  compact = false,
  disabled = false,
}: ModeSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (disabled) {
      setIsOpen(false);
    }
  }, [disabled]);

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

  const handleModeSelect = useCallback(
    (newMode: SessionMode) => {
      onModeChange(newMode);
      setIsOpen(false);
    },
    [onModeChange]
  );

  return (
    <div ref={dropdownRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => {
          if (!disabled) {
            setIsOpen(!isOpen);
          }
        }}
        disabled={disabled}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "4px",
          padding: compact ? "4px 4px" : "6px 8px",
          borderRadius: "12px",
          border: "none",
          background: "transparent",
          cursor: disabled ? "default" : "pointer",
          fontSize: "16px",
          transition: "background 0.2s",
          outline: "none",
          opacity: disabled ? 0.7 : 1,
        }}
        onMouseEnter={(e) => {
          if (compact && !disabled) e.currentTarget.style.background = "rgba(0,0,0,0.05)";
        }}
        onMouseLeave={(e) => {
          if (compact) e.currentTarget.style.background = "transparent";
        }}
      >
        <div style={{ width: "18px", height: "18px", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <ModeIcon type={mode} size={18} />
        </div>
      </button>

      {isOpen && !disabled && (
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
            模式
          </div>
          {(["chat", "plugin", "command"] as SessionMode[]).map((m) => (
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
                whiteSpace: "nowrap",
              }}
            >
              <ModeIcon
                type={m}
                size={18}
                style={m === "chat" && m !== mode ? { color: "#64748b" } : undefined}
              />
              <span>{modeLabels[m]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

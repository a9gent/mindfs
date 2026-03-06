import React, { useState, useRef, useEffect, useCallback } from "react";

export type SessionMode = "chat" | "plugin" | "skill";

type ModeSelectorProps = {
  mode: SessionMode;
  onModeChange: (mode: SessionMode) => void;
  compact?: boolean;
};

const modeLabels: Record<SessionMode, string> = {
  chat: "对话",
  plugin: "视图插件",
  skill: "执行技能",
};

const modeIcons: Record<SessionMode, string> = {
  chat: "💬",
  plugin: "🧩",
  skill: "⚡",
};

export function ModeSelector({
  mode,
  onModeChange,
  compact = false,
}: ModeSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

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
      setIsOpen(false);
    },
    [onModeChange]
  );

  return (
    <div ref={dropdownRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
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
        }}
        onMouseEnter={(e) => {
          if (compact) e.currentTarget.style.background = "rgba(0,0,0,0.05)";
        }}
        onMouseLeave={(e) => {
          if (compact) e.currentTarget.style.background = "transparent";
        }}
      >
        <div style={{ width: '16px', height: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span>{modeIcons[mode]}</span>
        </div>
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
            模式
          </div>
          {(["chat", "plugin", "skill"] as SessionMode[]).map((m) => (
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
              <span>{modeIcons[m]}</span>
              <span>{modeLabels[m]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

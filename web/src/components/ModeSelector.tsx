import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { ModeIcon } from "./ModeIcon";
import { useI18n, type MessageKey } from "../i18n";

export type SessionMode = "chat" | "plugin" | "command";

type ModeSelectorProps = {
  mode: SessionMode;
  onModeChange: (mode: SessionMode) => void;
  compact?: boolean;
  disabled?: boolean;
  onboardingId?: string;
  viewportMenu?: boolean;
};

const modeLabelKeys: Record<SessionMode, MessageKey> = {
  chat: "mode.chat",
  plugin: "mode.plugin",
  command: "mode.command",
};

export function ModeSelector({
  mode,
  onModeChange,
  compact = false,
  disabled = false,
  onboardingId,
  viewportMenu = false,
}: ModeSelectorProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [viewportMenuPosition, setViewportMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (disabled) {
      setIsOpen(false);
    }
  }, [disabled]);

  useEffect(() => {
    const handlePointerOutside = (e: PointerEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        !menuRef.current?.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener("pointerdown", handlePointerOutside);
      return () => document.removeEventListener("pointerdown", handlePointerOutside);
    }
  }, [isOpen]);

  useLayoutEffect(() => {
    if (!isOpen || !viewportMenu || !dropdownRef.current || !menuRef.current) {
      return;
    }
    const anchor = dropdownRef.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    const viewport = window.visualViewport;
    const viewportLeft = viewport?.offsetLeft ?? 0;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportWidth = viewport?.width ?? window.innerWidth;
    const margin = 8;
    const left = Math.max(
      viewportLeft + margin,
      Math.min(anchor.right - menu.width, viewportLeft + viewportWidth - menu.width - margin),
    );
    const top = Math.max(viewportTop + margin, anchor.top - menu.height - 8);
    setViewportMenuPosition({ top, left });
  }, [isOpen, viewportMenu]);

  const handleModeSelect = useCallback(
    (newMode: SessionMode) => {
      onModeChange(newMode);
      setIsOpen(false);
    },
    [onModeChange]
  );

  const renderMenu = () => (
    <div
      ref={menuRef}
      style={{
        position: viewportMenu ? "fixed" : "absolute",
        ...(viewportMenu
          ? {
              top: viewportMenuPosition?.top ?? 0,
              left: viewportMenuPosition?.left ?? 0,
              visibility: viewportMenuPosition ? "visible" : "hidden",
            }
          : { bottom: "calc(100% + 8px)", right: 0 }),
        background: "var(--menu-bg)",
        border: "1px solid var(--menu-border)",
        borderRadius: "12px",
        boxShadow: "0 8px 32px rgba(0,0,0,0.15)",
        zIndex: viewportMenu ? 10100 : 1000,
        width: "max-content",
        minWidth: "140px",
        maxWidth: "min(80vw, 260px)",
        padding: "8px 0",
      }}
    >
      <div style={{ padding: "6px 12px", fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase" }}>
        {t("mode.title")}
      </div>
      {(["chat", "plugin", "command"] as SessionMode[]).map((m) => (
        <button key={m} type="button" onClick={() => handleModeSelect(m)} style={{ display: "flex", alignItems: "center", gap: "8px", width: "100%", padding: "10px 12px", border: "none", background: m === mode ? "rgba(59, 130, 246, 0.08)" : "transparent", cursor: "pointer", fontSize: "13px", color: m === mode ? "#3b82f6" : "var(--text-primary)", fontWeight: m === mode ? 500 : 400, textAlign: "left", whiteSpace: "nowrap" }}>
          <ModeIcon type={m} size={18} style={m === "chat" && m !== mode ? { color: "#64748b" } : undefined} />
          <span>{t(modeLabelKeys[m])}</span>
        </button>
      ))}
    </div>
  );

  return (
    <div ref={dropdownRef} data-onboarding={onboardingId} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => {
          if (!disabled) {
            setViewportMenuPosition(null);
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

      {isOpen && !disabled
        ? viewportMenu && typeof document !== "undefined"
          ? createPortal(renderMenu(), document.body)
          : renderMenu()
        : null}
    </div>
  );
}

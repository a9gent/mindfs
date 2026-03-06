import React, { useState, useCallback, useEffect, useRef } from "react";
import { type SessionMode } from "./ModeSelector";
import { ModeSelector } from "./ModeSelector";
import { AgentSelector } from "./AgentSelector";
import { fetchAgents, type AgentStatus } from "../services/agents";

type SessionInfo = {
  key: string;
  name: string;
  type: "chat" | "plugin" | "skill";
  agent: string;
  pending?: boolean;
};

type ActionBarProps = {
  status?: string;
  agentsVersion?: number;
  currentSession?: SessionInfo | null;
  onSendMessage?: (message: string, mode: SessionMode, agent: string) => void;
  onCancelCurrentTurn?: (sessionKey: string) => void;
  onNewSession?: () => void;
  onSessionClick?: () => void;
  onToggleLeftSidebar?: () => void;
  onToggleRightSidebar?: () => void;
};

const modePlaceholders: Record<SessionMode, string> = {
  chat: "问点什么...",
  plugin: "描述视图插件...",
  skill: "执行技能...",
};

const MOBILE_BREAKPOINT = 768;

function useResponsive() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const checkSize = () => {
      const width = window.innerWidth;
      setIsMobile(width < MOBILE_BREAKPOINT);
    };
    checkSize();
    window.addEventListener("resize", checkSize);
    return () => window.removeEventListener("resize", checkSize);
  }, []);
  return { isMobile };
}

export function ActionBar({
  status = "Disconnected",
  agentsVersion = 0,
  currentSession,
  onSendMessage,
  onCancelCurrentTurn,
  onNewSession,
  onSessionClick,
  onToggleLeftSidebar,
  onToggleRightSidebar,
}: ActionBarProps) {
  const [mode, setMode] = useState<SessionMode>("chat");
  const [agent, setAgent] = useState("");
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [input, setInput] = useState("");
  const [dragX, setDragX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef(0);
  const DRAG_THRESHOLD = -40;
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [isMultiLine, setIsMultiLine] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [isDark, setIsDark] = useState(window.matchMedia("(prefers-color-scheme: dark)").matches);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);
  const { isMobile } = useResponsive();
  const isConnected = status === "Connected";

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setIsDark(e.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  // 恢复原始 1: Session 同步逻辑
  useEffect(() => {
    if (currentSession) {
      const nextMode =
        currentSession.type === "plugin"
          ? "plugin"
          : currentSession.type === "skill"
          ? "skill"
          : "chat";
      setMode(nextMode);
      setAgent(currentSession.agent);
    }
  }, [currentSession]);

  useEffect(() => {
    if (!currentSession?.pending) {
      setCancelling(false);
    }
  }, [currentSession?.pending]);

  // 恢复原始 2: 初始 Agent 加载逻辑
  useEffect(() => {
    fetchAgents(true) // 强制穿透缓存
      .then(setAgents)
      .catch((err) => console.error("Failed to fetch agents:", err));
  }, [agentsVersion]);

  // 恢复原始 3: 默认 Agent 选中逻辑
  useEffect(() => {
    if (currentSession || agents.length === 0) return;
    const exists = agents.some((a) => a.name === agent);
    if (exists) return;
    const preferred = agents.find((a) => a.available) ?? agents[0];
    if (preferred) setAgent(preferred.name);
  }, [agent, agents, currentSession]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || !isConnected || sending || !agent) return;
    const payload = input.trim();
    setInput("");
    setIsMultiLine(false);
    if (textareaRef.current) {
      textareaRef.current.style.height = "44px";
    }
    setSending(true);
    try {
      await onSendMessage?.(payload, mode, agent);
    } finally {
      setSending(false);
    }
  }, [input, isConnected, sending, agent, mode, onSendMessage]);

  const handleCancel = useCallback(async () => {
    const sessionKey = currentSession?.key;
    if (!sessionKey || cancelling) return;
    setCancelling(true);
    try {
      await onCancelCurrentTurn?.(sessionKey);
    } finally {
      // Reset is driven by currentSession.pending turning false.
    }
  }, [currentSession?.key, cancelling, onCancelCurrentTurn]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const nativeEvent = e.nativeEvent as KeyboardEvent & { isComposing?: boolean; keyCode?: number; };
    if (isComposingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229) {
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !isMobile) {
      e.preventDefault();
      void handleSend();
    }
  };

  const handleInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const target = e.currentTarget;
    const val = target.value;
    if (!val) {
      target.style.height = "44px";
      setIsMultiLine(false);
      return;
    }
    target.style.height = "44px";
    const sh = target.scrollHeight;
    setIsMultiLine(sh > 50);
    const newHeight = Math.min(Math.max(sh, 44), 240);
    target.style.height = `${newHeight}px`;
  };

  const handleDragStart = (e: React.MouseEvent | React.TouchEvent) => {
    const clientX = 'touches' in e ? e.touches[0].clientX : (e as React.MouseEvent).clientX;
    dragStartRef.current = clientX;
    setIsDragging(true);
  };

  const handleDragEnd = useCallback(() => {
    if (!isDragging) return;
    if (dragX <= DRAG_THRESHOLD) onNewSession?.();
    setDragX(0);
    setIsDragging(false);
  }, [isDragging, dragX, onNewSession]);

  useEffect(() => {
    if (isDragging) {
      const move = (e: MouseEvent | TouchEvent) => {
        const clientX = 'touches' in e ? e.touches[0].clientX : (e as MouseEvent).clientX;
        setDragX(Math.min(0, clientX - dragStartRef.current));
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', handleDragEnd);
      window.addEventListener('touchmove', move);
      window.addEventListener('touchend', handleDragEnd);
      return () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', handleDragEnd);
        window.removeEventListener('touchmove', move);
        window.removeEventListener('touchend', handleDragEnd);
      };
    }
  }, [isDragging, handleDragEnd]);

  const isSelectedAgentUnavailable = agents.length > 0 ? agents.find((a) => a.name === agent)?.available === false : false;
  const canSend = input.trim() && isConnected && !sending && agent && !isSelectedAgentUnavailable;
  const hasBoundSession = !!currentSession;
  const isBoundPending = !!currentSession?.pending;
  const showCancel = isBoundPending && !!currentSession?.key;

  return (
    <div style={{ width: "100%", padding: isMobile ? "0" : "0 16px 12px", display: "flex", justifyContent: "center", boxSizing: "border-box", background: "var(--content-bg)" }}>
      <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: isMobile ? "0" : "6px" }}>
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "28px 1fr 28px" : "1fr", alignItems: "center", gap: isMobile ? "1px" : 0, padding: isMobile ? "0 1px" : 0 }}>
          {isMobile ? (
            <button
              type="button"
              onClick={onToggleLeftSidebar}
              style={{ width: "28px", height: "44px", borderRadius: "0", border: "none", background: "transparent", color: "var(--text-secondary)", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", opacity: 0.86, outline: "none", boxShadow: "none", WebkitTapHighlightColor: "transparent" as any, overflow: "visible" }}
              aria-label="打开文件侧栏"
              title="文件侧栏"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none">
                <path fill="currentColor" d="M3 3h6v4H3zm12 7h6v4h-6zm0 7h6v4h-6zm-2-4H7v5h6v2H5V9h2v2h6z" style={{ transform: "scale(1.28)", transformOrigin: "12px 12px" }} />
              </svg>
            </button>
          ) : null}
          <div
            style={{
              background: isMobile ? "#fff" : (isDark ? "rgba(15, 23, 42, 0.95)" : "rgba(255, 255, 255, 0.5)"),
              border: isFocused
                ? "1px solid var(--accent-color)"
                : (isDark ? "1px solid rgba(255, 255, 255, 0.1)" : "1px solid rgba(0, 0, 0, 0.15)"),
              borderRadius: isMobile ? "10px" : "12px",
              boxShadow: isMobile
                ? "none"
                : (isFocused
                    ? (isDark ? "0 0 0 3px rgba(59, 130, 246, 0.2)" : "0 4px 24px rgba(37, 99, 235, 0.1)")
                    : "0 4px 12px rgba(0,0,0,0.02)"),
              display: "flex",
              alignItems: "center",
              position: "relative",
              transition: isDragging ? "none" : "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
              minHeight: "44px",
              backdropFilter: isMobile ? "none" : "blur(8px)",
            }}
            onFocusCapture={() => setIsFocused(true)}
            onBlurCapture={() => setIsFocused(false)}
          >
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
            }}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            placeholder={modePlaceholders[mode]}
            disabled={sending}
            rows={1}
            style={{
              width: "100%",
              border: "none",
              background: "transparent",
              fontSize: "15px",
              color: "var(--text-primary)",
              outline: "none",
              resize: "none",
              padding: isMultiLine ? "12px 14px 36px" : (isMobile ? "12px 96px 12px 14px" : "12px 120px 12px 14px"),
              minHeight: "44px",
              maxHeight: "240px",
              lineHeight: "20px",
              boxSizing: "border-box",
              display: "block",
              fontFamily: "inherit",
              transition: "padding 0.15s cubic-bezier(0.4, 0, 0.2, 1)",
            }}
          />

          <div style={{ position: "absolute", right: isMobile ? "4px" : "8px", bottom: isMultiLine ? "6px" : "50%", transform: isMultiLine ? "none" : "translateY(50%)", display: "flex", alignItems: "center", gap: isMobile ? "0px" : "2px", zIndex: 5, transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)" }}>
            {/* 滑动蓝点 */}
            <div
              onMouseDown={handleDragStart}
              onTouchStart={handleDragStart}
              onClick={() => {
                if (Math.abs(dragX) < 5) {
                  onSessionClick?.();
                }
              }}
              style={{
                width: "28px",
                height: "28px",
                margin: isMobile ? "0 1px" : "0 4px",
                cursor: "pointer",
                transform: `translateX(${dragX}px)`,
                transition: isDragging ? "none" : "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
                position: "relative",
                zIndex: 10,
                opacity: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                touchAction: "none",
              }}
              title="左滑新建会话"
            >
              {!hasBoundSession && (
                <div
                  style={{
                    width: "12px",
                    height: "12px",
                    borderRadius: "50%",
                    background: "transparent",
                    border: "2px solid #94a3b8",
                  }}
                />
              )}
              {hasBoundSession && !isBoundPending && (
                <div
                  style={{
                    width: "12px",
                    height: "12px",
                    borderRadius: "50%",
                    background: "transparent",
                    border: "2px solid #2563eb",
                    boxShadow: "0 0 0 1px rgba(37,99,235,0.08)",
                  }}
                />
              )}
              {hasBoundSession && isBoundPending && (
                <div
                  style={{
                    width: "12px",
                    height: "12px",
                    borderRadius: "50%",
                    background: "#3b82f6",
                    border: "none",
                    boxShadow: "0 0 0 0 rgba(59,130,246,0.5)",
                    animation: "bindPulse 1.2s ease-out infinite",
                  }}
                />
              )}
              {isDragging && dragX < -10 && (
                <div style={{ position: "absolute", right: "100%", top: "50%", transform: "translateY(-50%)", marginRight: "8px", fontSize: "10px", fontWeight: 600, color: dragX <= DRAG_THRESHOLD ? "var(--accent-color)" : "#9ca3af", whiteSpace: "nowrap", opacity: Math.min(1, Math.abs(dragX) / 20), pointerEvents: "none" }}>
                  {dragX <= DRAG_THRESHOLD ? "松开新建" : "左滑新建"}
                </div>
              )}
            </div>

            <ModeSelector mode={mode} onModeChange={setMode} compact={true} />
            <AgentSelector agent={agent} agents={agents} onAgentChange={setAgent} compact={true} warnUnavailable={isSelectedAgentUnavailable} />

            <button
              type="button"
              onClick={showCancel ? handleCancel : handleSend}
              disabled={showCancel ? cancelling : !canSend}
              style={{ width: "28px", height: "28px", borderRadius: "8px", border: "none", background: showCancel ? "rgba(239,68,68,0.14)" : (canSend ? "var(--accent-color)" : "transparent"), color: showCancel ? "#ef4444" : (canSend ? "#fff" : "var(--text-secondary)"), display: "flex", alignItems: "center", justifyContent: "center", cursor: showCancel ? (cancelling ? "wait" : "pointer") : (canSend ? "pointer" : "not-allowed"), transition: "all 0.2s", opacity: showCancel ? 1 : (canSend ? 1 : 0.3) }}
            >
              {sending || cancelling ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1s linear infinite' }}><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
              ) : showCancel ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2.5" /></svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
              )}
            </button>
          </div>
          </div>
          {isMobile ? (
            <button
              type="button"
              onClick={onToggleRightSidebar}
              style={{ width: "28px", height: "44px", borderRadius: "0", border: "none", background: "transparent", color: "var(--text-secondary)", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", opacity: 0.86, outline: "none", boxShadow: "none", WebkitTapHighlightColor: "transparent" as any, overflow: "visible" }}
              aria-label="打开会话侧栏"
              title="会话侧栏"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.8" strokeLinecap="round">
                <line x1="6" y1="4" x2="18" y2="4" />
                <line x1="6" y1="12" x2="18" y2="12" />
                <line x1="6" y1="20" x2="18" y2="20" />
              </svg>
            </button>
          ) : null}
        </div>
      </div>
      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        @keyframes bindPulse {
          0% { box-shadow: 0 0 0 0 rgba(59,130,246,0.5); }
          70% { box-shadow: 0 0 0 7px rgba(59,130,246,0); }
          100% { box-shadow: 0 0 0 0 rgba(59,130,246,0); }
        }
      `}</style>
    </div>
  );
}

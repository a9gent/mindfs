import React, { useState, useCallback, useEffect, useRef } from "react";
import { type SessionMode } from "./ModeSelector";
import { ModeSelector } from "./ModeSelector";
import { AgentSelector } from "./AgentSelector";
import { fetchAgents, type AgentStatus } from "../services/agents";

type SessionInfo = {
  key: string;
  name: string;
  type: "chat" | "view" | "skill";
  agent: string;
  pending?: boolean;
};

type ActionBarProps = {
  status?: string;
  agentsVersion?: number;
  currentSession?: SessionInfo | null;
  onSendMessage?: (message: string, mode: SessionMode, agent: string) => void;
  onNewSession?: () => void;
  onSessionClick?: () => void;
};

const modePlaceholders: Record<SessionMode, string> = {
  chat: "问点什么...",
  view: "描述视图...",
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
  onNewSession,
  onSessionClick,
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
  const [isMultiLine, setIsMultiLine] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [isDark, setIsDark] = useState(window.matchMedia("(prefers-color-scheme: dark)").matches);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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
      setMode(currentSession.type as SessionMode);
      setAgent(currentSession.agent);
    }
  }, [currentSession]);

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
    setSending(true);
    try {
      await onSendMessage?.(input.trim(), mode, agent);
      setInput("");
      setIsMultiLine(false);
      if (textareaRef.current) {
        textareaRef.current.style.height = "44px";
      }
    } finally {
      setSending(false);
    }
  }, [input, isConnected, sending, agent, mode, onSendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
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

  return (
    <div style={{ width: "100%", padding: isMobile ? "0" : "0 16px 12px", display: "flex", justifyContent: "center", boxSizing: "border-box", background: "var(--content-bg)" }}>
      <div style={{ width: "100%", maxWidth: "1000px", display: "flex", flexDirection: "column", gap: isMobile ? "0" : "6px" }}>
        <div
          style={{
            background: isMobile ? "#fff" : (isDark ? "rgba(15, 23, 42, 0.95)" : "rgba(255, 255, 255, 0.5)"),
            border: isFocused
              ? "1px solid var(--accent-color)"
              : (isDark ? "1px solid rgba(255, 255, 255, 0.1)" : "1px solid rgba(0, 0, 0, 0.15)"),
            borderRadius: isMobile ? "0" : "12px",
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
              padding: isMultiLine ? "12px 14px 36px" : "12px 120px 12px 14px",
              minHeight: "44px",
              maxHeight: "240px",
              lineHeight: "20px",
              boxSizing: "border-box",
              display: "block",
              fontFamily: "inherit",
              transition: "padding 0.15s cubic-bezier(0.4, 0, 0.2, 1)",
            }}
          />

          <div style={{ position: "absolute", right: "8px", bottom: isMultiLine ? "6px" : "50%", transform: isMultiLine ? "none" : "translateY(50%)", display: "flex", alignItems: "center", gap: "2px", zIndex: 5, transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)" }}>
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
                margin: "0 4px",
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
              <div
                style={{
                  width: "10px",
                  height: "10px",
                  borderRadius: "50%",
                  background: !currentSession ? "transparent" : (currentSession.pending ? "#3b82f6" : "#2563eb"),
                  border: !currentSession ? "2px solid #9ca3af" : "none",
                  boxShadow: (currentSession && !currentSession.pending) ? "0 0 8px rgba(37, 99, 235, 0.6)" : "none",
                }}
              />
              {isDragging && dragX < -10 && (
                <div style={{ position: "absolute", right: "100%", top: "50%", transform: "translateY(-50%)", marginRight: "8px", fontSize: "10px", fontWeight: 600, color: dragX <= DRAG_THRESHOLD ? "var(--accent-color)" : "#9ca3af", whiteSpace: "nowrap", opacity: Math.min(1, Math.abs(dragX) / 20), pointerEvents: "none" }}>
                  {dragX <= DRAG_THRESHOLD ? "松开新建" : "左滑新建"}
                </div>
              )}
            </div>

            <ModeSelector mode={mode} onModeChange={setMode} compact={true} />
            <AgentSelector agent={agent} agents={agents} onAgentChange={setAgent} compact={true} warnUnavailable={isSelectedAgentUnavailable} />

            <button
              type="button" onClick={handleSend} disabled={!canSend}
              style={{ width: "28px", height: "28px", borderRadius: "8px", border: "none", background: canSend ? "var(--accent-color)" : "transparent", color: canSend ? "#fff" : "var(--text-secondary)", display: "flex", alignItems: "center", justifyContent: "center", cursor: canSend ? "pointer" : "not-allowed", transition: "all 0.2s", opacity: canSend ? 1 : 0.3 }}
            >
              {sending ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1s linear infinite' }}><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

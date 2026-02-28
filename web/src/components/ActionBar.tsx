import React, { useState, useCallback, useEffect, useRef } from "react";
import { type SessionMode } from "./ModeSelector";
import { ModeSelector } from "./ModeSelector";
import { AgentSelector } from "./AgentSelector";
import { fetchAgents, type AgentStatus } from "../services/agents";
import { sessionService } from "../services/session";

type SessionInfo = {
  key: string;
  name: string;
  type: "chat" | "view" | "skill";
  agent: string;
};

type ActionBarProps = {
  status?: string;
  rootId?: string | null;
  currentSession?: SessionInfo | null;
  selectedFileName?: string | null;
  onSendMessage?: (message: string, mode: SessionMode, agent: string) => void;
  onSessionClick?: () => void;
};

const modePlaceholders: Record<SessionMode, string> = {
  chat: "问点什么...",
  view: "描述视图...",
  skill: "执行技能...",
};

export function ActionBar({
  status = "Disconnected",
  rootId,
  currentSession,
  selectedFileName,
  onSendMessage,
  onSessionClick,
}: ActionBarProps) {
  const [mode, setMode] = useState<SessionMode>("chat");
  const [agent, setAgent] = useState("");
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [isMultiLine, setIsMultiLine] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isConnected = status === "Connected";
  const selectedAgentStatus = agents.find((a) => a.name === agent);
  const isSelectedAgentUnavailable = !!agent && !!selectedAgentStatus && !selectedAgentStatus.available;
  const canSend = !!input.trim() && !sending && !!agent && isConnected && !isSelectedAgentUnavailable;

  useEffect(() => {
    if (currentSession) {
      setMode(currentSession.type);
      setAgent(currentSession.agent);
    }
  }, [currentSession]);

  useEffect(() => {
    fetchAgents()
      .then(setAgents)
      .catch((err) => console.error("Failed to fetch agents:", err));
  }, []);

  useEffect(() => {
    const unsubscribe = sessionService.subscribeEvents((event) => {
      if (event.type !== "agent.status.changed") return;
      fetchAgents(true)
        .then(setAgents)
        .catch((err) => console.error("Failed to refresh agents:", err));
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (currentSession || agents.length === 0) return;
    const exists = agents.some((a) => a.name === agent);
    if (exists) return;
    const preferred = agents.find((a) => a.available) ?? agents[0];
    if (preferred) setAgent(preferred.name);
  }, [agent, agents, currentSession]);

  const resetInput = useCallback(() => {
    setInput("");
    setIsMultiLine(false);
    if (textareaRef.current) {
      textareaRef.current.style.height = "44px";
    }
  }, []);

  const handleSend = useCallback(async () => {
    const trimmedInput = input.trim();
    if (!trimmedInput || sending || !agent || !isConnected || isSelectedAgentUnavailable) return;
    
    setSending(true);
    try {
      // 捕获可能的回调错误
      await onSendMessage?.(trimmedInput, mode, agent);
      resetInput();
    } catch (err) {
      console.error("ActionBar handleSend error:", err);
    } finally {
      setSending(false);
    }
  }, [input, sending, mode, agent, isConnected, isSelectedAgentUnavailable, onSendMessage, resetInput]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.nativeEvent as KeyboardEvent).isComposing || e.keyCode === 229) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend]
  );

  const handleInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const target = e.target as HTMLTextAreaElement;
    const val = target.value;
    
    if (!val) {
      setIsMultiLine(false);
      target.style.height = "44px";
      return;
    }

    target.style.height = "44px";
    const sh = target.scrollHeight;
    const multi = sh > 50; 
    setIsMultiLine(multi);
    
    const newHeight = Math.min(Math.max(sh, 44), 240);
    target.style.height = `${newHeight}px`;
  };

  return (
    <div
      style={{
        width: "100%",
        padding: "0",
        display: "flex",
        justifyContent: "center",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "1000px",
          display: "flex",
          flexDirection: "column",
          gap: "6px",
        }}
      >
        <div
          style={{
            background: "rgba(255, 255, 255, 0.4)",
            border: "1px solid rgba(0, 0, 0, 0.08)",
            borderRadius: "12px",
            boxShadow: "0 8px 32px rgba(0,0,0,0.04)",
            display: "flex",
            alignItems: "center",
            position: "relative",
            transition: "all 0.2s ease-in-out",
            minHeight: "44px",
          }}
          onFocusCapture={(e) => {
            e.currentTarget.style.borderColor = "rgba(59,130,246,0.4)";
            e.currentTarget.style.background = "rgba(255, 255, 255, 0.8)";
          }}
          onBlurCapture={(e) => {
            e.currentTarget.style.borderColor = "rgba(0, 0, 0, 0.08)";
            e.currentTarget.style.background = "rgba(255, 255, 255, 0.4)";
          }}
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

        <div
          style={{
            position: "absolute",
            right: "8px",
            bottom: isMultiLine ? "6px" : "50%",
            transform: isMultiLine ? "none" : "translateY(50%)",
            display: "flex",
            alignItems: "center",
            gap: "2px",
            zIndex: 5,
            transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
          }}
        >
          {currentSession && (
            <div 
              onClick={onSessionClick}
              style={{ 
                width: "8px", height: "8px", borderRadius: "50%", 
                background: "#3b82f6",
                margin: "0 6px",
                cursor: "pointer",
                flexShrink: 0
              }} 
            />
          )}

          <ModeSelector
            mode={mode}
            onModeChange={setMode}
            compact={true}
          />
          <AgentSelector
            agent={agent}
            agents={agents}
            onAgentChange={setAgent}
            compact={true}
            warnUnavailable={isSelectedAgentUnavailable}
          />

          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend}
            title={isSelectedAgentUnavailable ? `当前会话的 Agent（${agent}）不可用` : undefined}
            style={{
              width: "28px",
              height: "28px",
              borderRadius: "50%",
              border: "none",
              background: canSend ? "var(--accent-color)" : "transparent",
              color: canSend ? "#fff" : "var(--text-secondary)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: canSend ? "pointer" : "not-allowed",
              transition: "all 0.2s",
              fontSize: "14px",
              opacity: canSend ? 1 : 0.3,
              flexShrink: 0
            }}
          >
            {sending ? "..." : "↑"}
          </button>
        </div>
        </div>
      </div>
    </div>
  );
}

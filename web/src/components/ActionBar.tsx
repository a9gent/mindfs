import React, { useState, useCallback, useEffect, useRef } from "react";
import { ModeAgentSelector, type SessionMode } from "./ModeAgentSelector";
import { fetchAgents, type AgentStatus } from "../services/agents";

type SessionInfo = {
  key: string;
  name: string;
  type: "chat" | "view" | "skill";
  status: "active" | "idle" | "closed";
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
    if (!trimmedInput || sending || !agent) return;
    
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
  }, [input, sending, mode, agent, onSendMessage, resetInput]);

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
        padding: "0 10px 10px",
        display: "flex",
        justifyContent: "center",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "1000px",
          background: "rgba(255, 255, 255, 0.4)", // 极淡的背景
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
            padding: isMultiLine ? "12px 14px 36px" : "12px 100px 12px 14px", 
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
                background: currentSession.status === "active" ? "#3b82f6" : "#f59e0b",
                margin: "0 6px",
                cursor: "pointer",
                flexShrink: 0
              }} 
            />
          )}

          <ModeAgentSelector
            mode={mode}
            agent={agent}
            agents={agents}
            onModeChange={setMode}
            onAgentChange={setAgent}
            compact={true}
            showLabel={false}
          />

          <button
            type="button"
            onClick={handleSend}
            disabled={!input.trim() || sending}
            style={{
              width: "28px",
              height: "28px",
              borderRadius: "50%",
              border: "none",
              background: input.trim() ? "var(--accent-color)" : "transparent",
              color: input.trim() ? "#fff" : "var(--text-secondary)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: !input.trim() || sending ? "not-allowed" : "pointer",
              transition: "all 0.2s",
              fontSize: "14px",
              opacity: input.trim() ? 1 : 0.3,
              flexShrink: 0
            }}
          >
            {sending ? "..." : "↑"}
          </button>
        </div>
      </div>
    </div>
  );
}

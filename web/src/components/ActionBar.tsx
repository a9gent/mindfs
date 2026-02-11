import React, { useState, useCallback, useEffect } from "react";
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
  chat: "输入消息与 Agent 对话...",
  view: "描述你想要的视图...",
  skill: "输入技能参数...",
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

  const isConnected = status === "Connected";

  // 当有活跃 Session 时，同步模式和 Agent
  useEffect(() => {
    if (currentSession) {
      setMode(currentSession.type);
      setAgent(currentSession.agent);
    }
  }, [currentSession]);

  // 加载 Agent 状态
  useEffect(() => {
    fetchAgents()
      .then(setAgents)
      .catch((err) => console.error("Failed to fetch agents:", err));
  }, []);

  // 当无当前 Session 时，如果选中 Agent 不在列表内，自动切到首个可选 Agent
  useEffect(() => {
    if (currentSession || agents.length === 0) return;
    const exists = agents.some((a) => a.name === agent);
    if (exists) return;
    const preferred = agents.find((a) => a.available) ?? agents[0];
    setAgent(preferred.name);
  }, [agent, agents, currentSession]);

  // 发送消息
  const handleSend = useCallback(async () => {
    if (!input.trim() || sending || !agent) return;

    const message = input.trim();
    setInput("");
    setSending(true);

    try {
      await onSendMessage?.(message, mode, agent);
    } catch (err) {
      console.error("Failed to send message:", err);
    } finally {
      setSending(false);
    }
  }, [input, sending, mode, agent, onSendMessage]);

  // 键盘事件
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  return (
    <div style={{ width: "100%", display: "flex", alignItems: "center", gap: "12px" }}>
      {/* 连接状态 / Session 状态 */}
      {currentSession ? (
        <button
          type="button"
          onClick={onSessionClick}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            background:
              currentSession.status === "active"
                ? "rgba(59, 130, 246, 0.1)"
                : "rgba(245, 158, 11, 0.1)",
            color: currentSession.status === "active" ? "#1d4ed8" : "#b45309",
            padding: "6px 12px",
            borderRadius: "99px",
            fontSize: "12px",
            fontWeight: 500,
            border: `1px solid ${
              currentSession.status === "active"
                ? "rgba(59, 130, 246, 0.2)"
                : "rgba(245, 158, 11, 0.2)"
            }`,
            whiteSpace: "nowrap",
            cursor: "pointer",
          }}
        >
          <span>
            {currentSession.type === "chat"
              ? "💬"
              : currentSession.type === "view"
              ? "🎨"
              : "⚡"}
          </span>
          <span
            style={{
              maxWidth: "120px",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {currentSession.name || `Session ${currentSession.key.slice(0, 8)}`}
          </span>
          <span
            style={{
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              background: currentSession.status === "active" ? "#3b82f6" : "#f59e0b",
            }}
          />
        </button>
      ) : (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            background: isConnected ? "rgba(34, 197, 94, 0.1)" : "rgba(100, 116, 139, 0.1)",
            color: isConnected ? "#15803d" : "var(--text-secondary)",
            padding: "6px 12px",
            borderRadius: "99px",
            fontSize: "12px",
            fontWeight: 500,
            border: `1px solid ${isConnected ? "rgba(34, 197, 94, 0.2)" : "transparent"}`,
            whiteSpace: "nowrap",
          }}
        >
          <span
            style={{
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              background: isConnected ? "#22c55e" : "#94a3b8",
              boxShadow: isConnected ? "0 0 8px rgba(34, 197, 94, 0.4)" : "none",
            }}
          />
          {selectedFileName || status}
        </div>
      )}

      {/* 模式+Agent 选择器 */}
      <ModeAgentSelector
        mode={mode}
        agent={agent}
        agents={agents}
        onModeChange={setMode}
        onAgentChange={setAgent}
      />

      {/* 输入框 */}
      <div style={{ position: "relative", flex: 1, display: "flex" }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={modePlaceholders[mode]}
          disabled={sending}
          style={{
            width: "100%",
            padding: "8px 12px",
            borderRadius: "8px",
            border: "1px solid var(--border-color)",
            background: "#fff",
            fontSize: "13px",
            color: "var(--text-primary)",
            outline: "none",
            transition: "border-color 0.1s, box-shadow 0.1s",
          }}
          onFocus={(e) => {
            e.target.style.borderColor = "var(--accent-color)";
            e.target.style.boxShadow = "0 0 0 3px rgba(37, 99, 235, 0.1)";
          }}
          onBlur={(e) => {
            e.target.style.borderColor = "var(--border-color)";
            e.target.style.boxShadow = "none";
          }}
        />
      </div>

      {/* 发送按钮 */}
      <button
        type="button"
        onClick={handleSend}
        disabled={!input.trim() || sending}
        style={{
          padding: "8px 16px",
          borderRadius: "8px",
          border: "none",
          background: "var(--accent-color)",
          color: "#ffffff",
          fontWeight: 500,
          fontSize: "13px",
          cursor: !input.trim() || sending ? "not-allowed" : "pointer",
          opacity: !input.trim() || sending ? 0.6 : 1,
          transition: "background 0.1s, opacity 0.1s",
        }}
        onMouseEnter={(e) => {
          if (input.trim() && !sending) e.currentTarget.style.background = "var(--accent-hover)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "var(--accent-color)";
        }}
      >
        {sending ? "..." : "发送"}
      </button>
    </div>
  );
}

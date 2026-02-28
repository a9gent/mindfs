import React from "react";
import type { SessionInfo } from "./AgentFloatingPanel";

type AgentBubbleProps = {
  session: SessionInfo | null;
  index?: number;
  isStreaming?: boolean;
  onClick?: () => void;
};

export function AgentBubble({ session, index = 0, isStreaming, onClick }: AgentBubbleProps) {
  // 无活跃 Session 时不显示
  if (!session) return null;

  return (
    <button
      onClick={onClick}
      style={{
        position: "absolute",
        bottom: `${24 + index * 58}px`,
        right: "24px",
        display: "flex",
        alignItems: "center",
        gap: "10px",
        width: "180px",
        minHeight: "46px",
        padding: "8px 10px",
        background: "rgba(255, 255, 255, 0.8)",
        backdropFilter: "blur(16px)",
        border: "1px solid rgba(255, 255, 255, 0.4)",
        borderRadius: "12px",
        boxShadow: "0 10px 30px rgba(0,0,0,0.12)",
        cursor: "pointer",
        zIndex: 50,
        transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
        outline: "none",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = "translateY(-4px) scale(1.02)";
        e.currentTarget.style.boxShadow = "0 15px 40px rgba(0,0,0,0.18)";
        e.currentTarget.style.background = "rgba(255, 255, 255, 0.9)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "translateY(0) scale(1)";
        e.currentTarget.style.boxShadow = "0 10px 30px rgba(0,0,0,0.12)";
        e.currentTarget.style.background = "rgba(255, 255, 255, 0.8)";
      }}
    >
      {/* 类型图标 + 状态指示 */}
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontSize: "18px" }}>
          {session.type === "chat" ? "💬" : session.type === "view" ? "🎨" : "⚡"}
        </span>
        <span
          style={{
            position: 'absolute',
            bottom: '-2px',
            right: '-2px',
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            background: "#3b82f6",
            border: "2px solid rgba(255,255,255,0.8)",
            boxShadow: "0 0 8px rgba(59,130,246,0.5)"
          }}
        />
      </div>

      {/* Session 信息 */}
      <div style={{ textAlign: "left", flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: "12px",
            fontWeight: 600,
            color: "var(--text-primary)",
            maxWidth: "78px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {session.name || `Session ${session.key.slice(0, 8)}`}
        </div>
        <div
          style={{
            fontSize: "10px",
            color: "var(--text-secondary)",
            display: "flex",
            alignItems: "center",
            gap: "4px",
            opacity: 0.7
          }}
        >
          {session.agent || "-"}
          {isStreaming && (
            <span style={{ color: "#3b82f6", display: 'flex', marginLeft: '4px' }}>
              <StreamingDots />
            </span>
          )}
        </div>
      </div>

      {/* 展开提示 */}
      <span
        style={{
          fontSize: "12px",
          color: "var(--text-secondary)",
          opacity: 0.4,
          marginLeft: "4px"
        }}
      >
        ↗
      </span>
    </button>
  );
}

// 流式输出动画点
function StreamingDots() {
  return (
    <span style={{ display: "inline-flex", gap: "2px" }}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: "3px",
            height: "3px",
            borderRadius: "50%",
            background: "currentColor",
            animation: `bubbleDot 1.4s ease-in-out ${i * 0.2}s infinite`,
          }}
        />
      ))}
      <style>{`
        @keyframes bubbleDot {
          0%, 80%, 100% { opacity: 0.2; transform: scale(0.8); }
          40% { opacity: 1; transform: scale(1.2); }
        }
      `}</style>
    </span>
  );
}

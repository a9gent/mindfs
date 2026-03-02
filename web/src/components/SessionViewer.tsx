import React, { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useSessionStream, type TimelineItem } from "../hooks/useSessionStream";
import { ThinkingBlock } from "./stream/ThinkingBlock";
import { ToolCallCard } from "./stream/ToolCallCard";
import { AgentIcon } from "./AgentIcon";
import type { ToolCall } from "../services/session";

type RelatedFile = {
  path: string;
  name: string;
  created_at?: string;
};

type SessionItem = {
  key?: string;
  session_key?: string;
  type?: string;
  name?: string;
  agent?: string;
  scope?: string;
  purpose?: string;
  exchanges?: Array<{ role?: string; agent?: string; content?: string; timestamp?: string }>;
  closed_at?: string;
  related_files?: Array<RelatedFile | { path: string; relation?: string; created_by_session?: boolean }>;
};

type SessionViewerProps = {
  session: SessionItem | null;
  interactionMode?: "main" | "floating";
  onFileClick?: (path: string) => void;
};

const formatTime = (isoString?: string) => {
  if (!isoString) return "";
  try {
    const date = new Date(isoString);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    const isThisYear = date.getFullYear() === now.getFullYear();
    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    if (isToday) return timeStr;
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    if (isThisYear) return `${month}-${day} ${timeStr}`;
    return `${date.getFullYear()}-${month}-${day} ${timeStr}`;
  } catch { return ""; }
};

const formatToolCallResult = (toolCall: Partial<ToolCall>): string => {
  const content = toolCall.content;
  const lines: string[] = [];
  if (content && content.length > 0) {
    for (const item of content) {
      if (item.type === "text" && item.text) {
        lines.push(item.text);
        continue;
      }
      if (item.type === "diff") {
        lines.push(`diff: ${item.path || "(unknown)"}`);
        if (item.oldText) lines.push(`- ${item.oldText}`);
        if (item.newText) lines.push(`+ ${item.newText}`);
      }
    }
  }
  const byContent = lines.join("\n").trim();
  if (byContent) return byContent;
  const rawInput = toolCall.meta?.input;
  if (typeof rawInput === "string" && rawInput.trim() !== "") return rawInput;
  const rawOutput = toolCall.meta?.output;
  if (typeof rawOutput === "string" && rawOutput.trim() !== "") return rawOutput;
  return "";
};

export function SessionViewer({ session, interactionMode = "main", onFileClick }: SessionViewerProps) {
  const [showAllFiles, setShowAllFiles] = useState(false);
  const scrollEndRef = useRef<HTMLDivElement>(null);
  const sessionKey = session?.key || session?.session_key || null;
  const exchanges = Array.isArray(session?.exchanges) ? session.exchanges : [];
  const { timeline, isStreaming } = useSessionStream(sessionKey, exchanges);
  const isAwaiting = !!(session as any)?.pending;

  // 自动滚动
  useEffect(() => {
    if (scrollEndRef.current) {
      scrollEndRef.current.scrollIntoView({ behavior: "auto" });
    }
  }, [session?.key, session?.session_key, session?.exchanges, timeline, isStreaming]);

  if (!session) {
    return (
      <div style={{ padding: "40px", textAlign: "center", color: "var(--text-secondary)" }}>
        选择一个会话查看内容
      </div>
    );
  }

  // 解析关联文件
  const rawRelated = session.related_files || (session as any).outputs || [];
  const relatedFiles = (Array.isArray(rawRelated) ? rawRelated : [])
    .map((f: any) => {
      const path = typeof f === "string" ? f : (typeof f?.path === "string" ? f.path : "");
      const name = typeof f?.name === "string" ? f.name : path.split("/").pop() || path;
      return { path, name };
    })
    .filter(f => f.path);

  const displayFiles = showAllFiles ? relatedFiles : relatedFiles.slice(0, 10);
  const hasMoreFiles = relatedFiles.length > 10;
  const displayName = session.name || session.purpose || session.key || session.session_key || "Session";

  const renderTimelineItem = (item: TimelineItem, idx: number) => {
    if (item.type === "thought") {
      return <ThinkingBlock key={item.id || `thought-${idx}`} content={item.content || ""} defaultExpanded={false} />;
    }
    if (item.type === "tool") {
      const tc = item.toolCall || {};
      return (
        <ToolCallCard
          key={item.id || tc.callId || `tool-${idx}`}
          kind={tc.kind}
          title={(tc as any).title || (tc.meta && typeof tc.meta.title === "string" ? (tc.meta.title as string) : "")}
          callId={tc.callId || ""}
          status={tc.status || "running"}
          result={formatToolCallResult(tc)}
          locations={tc.locations}
          defaultExpanded={false}
        />
      );
    }
    const isUser = item.type === "user_text";
    const hideAssistantMeta = !isUser && isStreaming && idx === timeline.length - 1;
    const time = formatTime(item.timestamp);
    return (
      <div key={idx} style={{ alignSelf: isUser ? "flex-end" : "flex-start", width: isUser ? "auto" : "100%", maxWidth: isUser ? "80%" : "100%", position: "relative", display: 'flex', flexDirection: 'column' }}>
        {isUser ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
            <div style={{ padding: "10px 16px", borderRadius: "18px 18px 4px 18px", background: "var(--accent-color)", color: "#fff", fontSize: "14px", lineHeight: "1.5", boxShadow: "0 4px 12px rgba(59,130,246,0.15)" }}>{item.content || ""}</div>
            <span style={{ fontSize: '10px', color: 'var(--text-secondary)', opacity: 0.5 }}>{time}</span>
          </div>
        ) : (
          <div style={{ width: "100%", display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
            <div style={{ color: "var(--text-primary)", fontSize: "15px", lineHeight: "1.7", width: "100%" }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
                p: ({node, ...props}) => <p style={{ margin: "0 0 1em 0" }} {...props} />,
                pre: ({node, ...props}) => <pre style={{ background: "rgba(0,0,0,0.04)", padding: "16px", borderRadius: "8px", overflow: "auto", fontSize: "13px", margin: "1em 0" }} {...props} />
              }}>{item.content || ""}</ReactMarkdown>
            </div>
            {!hideAssistantMeta && (
              <span style={{ alignSelf: 'flex-start', display: "inline-flex", alignItems: "center", gap: "6px", fontSize: '10px', color: 'var(--text-secondary)', opacity: 0.5, marginTop: '-10px', marginBottom: '4px' }}>
                <AgentIcon agentName={item.agent || ""} style={{ width: "12px", height: "12px" }} />
                <span>{time}</span>
              </span>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "transparent" }}>
      {interactionMode === "floating" ? null : (
        <header style={{ height: "36px", padding: "0 16px", borderBottom: "1px solid var(--border-color)", display: "flex", alignItems: "center", background: "transparent", boxSizing: "border-box", zIndex: 10, flexShrink: 0 }}>
          <h1 style={{ fontSize: "14px", fontWeight: 600, margin: 0 }}>{displayName}</h1>
        </header>
      )}

      {/* 滚动容器 */}
      <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", position: "relative" }}>
        <div style={{ 
          width: "100%",
          minHeight: "100%", 
          display: "block", 
          padding: "24px 16px", 
          boxSizing: "border-box",
          overflowX: "hidden",
        }}>
          <div style={{ width: "100%", margin: "0", display: "flex", flexDirection: "column", gap: "16px" }}>
            {timeline.map((item, idx) => renderTimelineItem(item, idx))}
            {(isAwaiting || isStreaming) && (
              <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--text-secondary)" }}>
                <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "var(--accent-color)", animation: "pulse 1s infinite" }} />
                {isStreaming ? "正在生成..." : "已发送，等待响应..."}
              </div>
            )}

            {/* 关联文件区域 */}
            {relatedFiles.length > 0 && (
              <div style={{ marginTop: "12px", padding: "16px 20px", background: "rgba(0,0,0,0.03)", borderRadius: "16px", width: "100%", boxSizing: "border-box", border: "1px solid rgba(0,0,0,0.02)" }}>
                <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "12px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span>关联文件</span>
                    <span style={{ fontSize: '10px', background: 'rgba(0,0,0,0.06)', color: 'var(--text-secondary)', padding: '1px 6px', borderRadius: '10px' }}>{relatedFiles.length}</span>
                  </div>
                  {hasMoreFiles && <button type="button" onClick={() => setShowAllFiles(!showAllFiles)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--accent-color)", fontSize: "12px" }}>{showAllFiles ? "收起" : "查看全部"}</button>}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "8px" }}>
                  {displayFiles.map((file, i) => (
                    <div key={i} onClick={() => onFileClick?.(file.path)} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "8px 12px", background: "#fff", border: "1px solid rgba(0,0,0,0.05)", borderRadius: "8px", cursor: "pointer", transition: "all 0.2s" }} onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent-color)"; e.currentTarget.style.boxShadow = "0 4px 12px rgba(0,0,0,0.05)"; }} onMouseLeave={(e) => { e.currentTarget.style.borderColor = "rgba(0,0,0,0.05)"; e.currentTarget.style.boxShadow = "none"; }}>
                      <img src={`https://api.iconify.design/lucide:file-text.svg?color=%2394a3b8`} alt="file" style={{ width: 16, height: 16 }} />
                      <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: "13px", fontWeight: 500, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.name}</div></div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div ref={scrollEndRef} style={{ height: "1px" }} />
          </div>
        </div>
      </div>
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  );
}

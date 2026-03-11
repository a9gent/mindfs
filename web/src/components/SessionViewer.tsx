import React, { useState, useEffect, useRef } from "react";
import { useSessionStream, type TimelineItem } from "../hooks/useSessionStream";
import { ThinkingBlock } from "./stream/ThinkingBlock";
import { ToolCallCard } from "./stream/ToolCallCard";
import { AgentIcon } from "./AgentIcon";
import { InlineTokenText } from "./InlineTokenText";
import { MarkdownViewer } from "./MarkdownViewer";
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
  rootId?: string | null;
  interactionMode?: "main" | "drawer";
  onFileClick?: (path: string) => void;
};

type UploadAttachment = {
  path: string;
  name: string;
  isImage: boolean;
};

const uploadTokenPattern = /\[read file:\s*([^\]]+)\]/g;

function basename(path: string): string {
  const normalized = (path || "").replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || path;
}

function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(path);
}

function extractUploadAttachments(content: string): UploadAttachment[] {
  const attachments: UploadAttachment[] = [];
  uploadTokenPattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = uploadTokenPattern.exec(content || "")) !== null) {
    const path = match[1].trim();
    attachments.push({
      path,
      name: basename(path),
      isImage: isImagePath(path),
    });
  }
  return attachments;
}

function stripImageAttachmentTokens(content: string): string {
  if (!content) {
    return "";
  }
  const stripped = content.replace(uploadTokenPattern, (fullMatch, rawPath: string) => {
    const path = String(rawPath || "").trim();
    if (!isImagePath(path)) {
      return fullMatch;
    }
    return "";
  });
  return stripped
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[\n\s]+|[\n\s]+$/g, "");
}

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

function normalizeMarkdownContent(content: string): string {
  if (!content) return "";
  // Some historical messages contain fenced code blocks without a leading newline,
  // e.g. "text...```lang". Markdown won't parse that as a block.
  return content.replace(/([^\n])```/g, "$1\n```");
}

export function SessionViewer({ session, rootId, interactionMode = "main", onFileClick }: SessionViewerProps) {
  const [showAllFiles, setShowAllFiles] = useState(false);
  const scrollEndRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sessionKey = session?.key || session?.session_key || null;
  const exchanges = Array.isArray(session?.exchanges) ? session.exchanges : [];
  const { timeline, isStreaming } = useSessionStream(sessionKey, exchanges);
  const isAwaiting = !!(session as any)?.pending;
  const shouldStickToBottomRef = useRef(true);
  const lastSessionKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !scrollEndRef.current) {
      return;
    }
    const nextKey = sessionKey;
    const isSessionChanged = lastSessionKeyRef.current !== nextKey;
    if (isSessionChanged) {
      lastSessionKeyRef.current = nextKey;
      shouldStickToBottomRef.current = true;
    }
    if (shouldStickToBottomRef.current) {
      scrollEndRef.current.scrollIntoView({ behavior: "auto", block: "end" });
    }
  }, [sessionKey, timeline, isStreaming]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const updateStickiness = () => {
      const distanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop;
      shouldStickToBottomRef.current = distanceFromBottom < 32;
    };
    updateStickiness();
    el.addEventListener("scroll", updateStickiness, { passive: true });
    return () => {
      el.removeEventListener("scroll", updateStickiness);
    };
  }, [sessionKey]);

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
    const next = idx + 1 < timeline.length ? timeline[idx + 1] : null;
    const hasFollowingAssistantFlow = !isUser && !!next && next.type !== "user_text";
    const hideAssistantMeta = !isUser && (hasFollowingAssistantFlow || (isStreaming && idx === timeline.length - 1));
    const time = formatTime(item.timestamp);
    const uploadAttachments = isUser ? extractUploadAttachments(item.content || "") : [];
    const imageAttachments = uploadAttachments.filter((attachment) => attachment.isImage);
    const fileAttachments = uploadAttachments.filter((attachment) => !attachment.isImage);
    const displayContent = isUser ? stripImageAttachmentTokens(item.content || "") : (item.content || "");
    const userMessageWidth = imageAttachments.length > 0 ? "min(320px, 100%)" : "auto";
    const hasRichUserAttachments = imageAttachments.length > 0 || fileAttachments.length > 0;
    return (
      <div key={idx} style={{ alignSelf: isUser ? "flex-end" : "flex-start", width: isUser ? userMessageWidth : "100%", maxWidth: isUser ? "80%" : "100%", position: "relative", display: 'flex', flexDirection: 'column' }}>
        {isUser ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '6px', width: userMessageWidth }}>
            {hasRichUserAttachments ? (
              <div
                style={{
                  width: "100%",
                  padding: "8px",
                  borderRadius: "18px 18px 4px 18px",
                  background: "rgba(148,163,184,0.14)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                  boxSizing: "border-box",
                }}
              >
                {imageAttachments.length > 0 ? (
                  <div style={{ display: "grid", gridTemplateColumns: imageAttachments.length > 1 ? "repeat(2, minmax(0, 1fr))" : "minmax(0, 1fr)", gap: "8px", width: "100%" }}>
                    {imageAttachments.map((attachment) => (
                      <button
                        key={attachment.path}
                        type="button"
                        onClick={() => onFileClick?.(attachment.path)}
                        style={{
                          border: "none",
                          padding: 0,
                          background: "transparent",
                          cursor: "pointer",
                          borderRadius: "12px",
                          overflow: "hidden",
                        }}
                        title={attachment.name}
                      >
                        <img
                          src={`/api/file?raw=1&root=${encodeURIComponent(rootId || "")}&path=${encodeURIComponent(attachment.path)}`}
                          alt={attachment.name}
                          style={{ display: "block", width: "100%", maxHeight: "220px", objectFit: "cover", background: "rgba(15,23,42,0.06)" }}
                        />
                      </button>
                    ))}
                  </div>
                ) : null}
                {displayContent ? (
                  <div style={{ padding: imageAttachments.length > 0 ? "2px 6px 0" : "6px 8px", color: "var(--text-primary)", fontSize: "14px", lineHeight: "1.5", whiteSpace: "pre-wrap" }}>
                    <InlineTokenText content={displayContent} isDark={false} variant="inverse" />
                  </div>
                ) : null}
                {fileAttachments.length > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: "6px", width: "100%" }}>
                    {fileAttachments.map((attachment) => (
                      <button
                        key={attachment.path}
                        type="button"
                        onClick={() => onFileClick?.(attachment.path)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                          width: "100%",
                          padding: "8px 10px",
                          borderRadius: "12px",
                          border: "none",
                          background: "rgba(255,255,255,0.46)",
                          color: "var(--text-primary)",
                          cursor: "pointer",
                          textAlign: "left",
                        }}
                        title={attachment.path}
                      >
                        <span style={{ fontSize: "14px" }}>📎</span>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{attachment.name}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            {!hasRichUserAttachments && displayContent ? (
              <div style={{ padding: "10px 16px", borderRadius: "18px 18px 4px 18px", background: "rgba(148,163,184,0.14)", color: "var(--text-primary)", fontSize: "14px", lineHeight: "1.5", boxShadow: "none", whiteSpace: "pre-wrap", alignSelf: "flex-end" }}>
                <InlineTokenText content={displayContent} isDark={false} variant="inverse" />
              </div>
            ) : null}
            <span style={{ fontSize: '10px', color: 'var(--text-secondary)', opacity: 0.5, alignSelf: 'flex-end' }}>{time}</span>
          </div>
        ) : (
          <div style={{ width: "100%", display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
            <div style={{ color: "var(--text-primary)", fontSize: "15px", lineHeight: "1.7", width: "100%" }}>
              <MarkdownViewer
                content={normalizeMarkdownContent(item.content || "")}
                onFileClick={onFileClick}
              />
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
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "transparent" }}>
      {interactionMode === "drawer" ? null : (
        <header style={{ height: "36px", padding: "0 16px", borderBottom: "1px solid var(--border-color)", display: "flex", alignItems: "center", background: "transparent", boxSizing: "border-box", zIndex: 10, flexShrink: 0 }}>
          <h1 style={{ fontSize: "14px", fontWeight: 600, margin: 0, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayName}</h1>
        </header>
      )}

      {/* 滚动容器 */}
      <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", position: "relative", WebkitOverflowScrolling: "touch" }}>
        <div style={{ 
          width: "100%",
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
              <div style={{ marginTop: "4px", width: "100%", boxSizing: "border-box" }}>
                <div style={{ fontSize: "12px", fontWeight: 500, color: "var(--text-secondary)", marginBottom: "6px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span>关联文件 {relatedFiles.length}</span>
                  {hasMoreFiles && <button type="button" onClick={() => setShowAllFiles(!showAllFiles)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--text-secondary)", fontSize: "11px" }}>{showAllFiles ? "收起" : "更多"}</button>}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  {displayFiles.map((file, i) => (
                    <div key={i} onClick={() => onFileClick?.(file.path)} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "3px 6px", borderRadius: "6px", cursor: "pointer", transition: "background 0.15s" }} onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(0,0,0,0.04)"; }} onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                      <img src={`https://api.iconify.design/lucide:file-text.svg?color=%2394a3b8`} alt="file" style={{ width: 13, height: 13, flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0, fontSize: "12px", color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.name}</div>
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

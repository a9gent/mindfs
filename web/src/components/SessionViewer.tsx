import React, { memo, useState, useEffect, useRef } from "react";
import { useSessionStream, type TimelineItem } from "../hooks/useSessionStream";
import { ThinkingBlock } from "./stream/ThinkingBlock";
import { ToolCallCard } from "./stream/ToolCallCard";
import { AgentIcon } from "./AgentIcon";
import { InlineTokenText } from "./InlineTokenText";
import { MarkdownViewer } from "./MarkdownViewer";
import { appURL } from "../services/base";
import type { RelatedFile, ToolCall } from "../services/session";
import { savePrompt } from "../services/prompts";
import { reportError } from "../services/error";

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
  related_files?: RelatedFile[];
};

type SessionViewerProps = {
  session: SessionItem | null;
  rootId?: string | null;
  rootPath?: string | null;
  interactionMode?: "main" | "drawer";
  gitFileStatsByPath?: Record<string, { status: string; additions: number; deletions: number }>;
  onFileClick?: (path: string) => void;
  onRemoveRelatedFile?: (path: string) => void;
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

function stripUploadAttachmentTokens(content: string): string {
  if (!content) {
    return "";
  }
  return content
    .replace(uploadTokenPattern, "")
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

const formatToolCallFallbackResult = (toolCall: Partial<ToolCall>): string => {
  const kind = (toolCall.kind || "").toLowerCase();
  if (kind === "read") return "";
  const rawInput = toolCall.meta?.input;
  if (typeof rawInput === "string" && rawInput.trim() !== "") return rawInput;
  const rawOutput = toolCall.meta?.output;
  if (typeof rawOutput === "string" && rawOutput.trim() !== "") return rawOutput;
  return "";
};

function isAuxiliaryTimelineItem(item: TimelineItem | null): boolean {
  return item?.type === "tool" || item?.type === "thought";
}

function timelineItemSpacing(previous: TimelineItem | null, current: TimelineItem): string {
  if (!previous) {
    return "0";
  }
  if (isAuxiliaryTimelineItem(previous) && isAuxiliaryTimelineItem(current)) {
    return "6px";
  }
  return "16px";
}

function SessionViewerInner({ session, rootId, rootPath, interactionMode = "main", gitFileStatsByPath = {}, onFileClick, onRemoveRelatedFile }: SessionViewerProps) {
  const [showAllFiles, setShowAllFiles] = useState(false);
  const [savedPromptKeys, setSavedPromptKeys] = useState<Record<string, true>>({});
  const [copiedMessageKeys, setCopiedMessageKeys] = useState<Record<string, true>>({});
  const scrollEndRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const useInnerScrollContainer = interactionMode !== "drawer";
  const onFileClickRef = useRef(onFileClick);
  const copyResetTimersRef = useRef<Record<string, number>>({});
  const sessionKey = session?.key || session?.session_key || null;
  const exchanges = Array.isArray(session?.exchanges) ? session.exchanges : [];
  const { timeline, isStreaming, streamVersion } = useSessionStream(sessionKey, exchanges);
  const isAwaiting = !!(session as any)?.pending;
  const shouldStickToBottomRef = useRef(true);
  const lastSessionKeyRef = useRef<string | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  useEffect(() => {
    onFileClickRef.current = onFileClick;
  }, [onFileClick]);

  useEffect(() => {
    setSavedPromptKeys({});
    setCopiedMessageKeys({});
    Object.values(copyResetTimersRef.current).forEach((timer) => window.clearTimeout(timer));
    copyResetTimersRef.current = {};
  }, [sessionKey, useInnerScrollContainer]);

  useEffect(() => {
    return () => {
      Object.values(copyResetTimersRef.current).forEach((timer) => window.clearTimeout(timer));
      copyResetTimersRef.current = {};
    };
  }, []);

  useEffect(() => {
    const container = scrollRef.current;
    if (useInnerScrollContainer && !container) {
      return;
    }
    if (!scrollEndRef.current) {
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
  }, [sessionKey, timeline, isStreaming, streamVersion, useInnerScrollContainer]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!useInnerScrollContainer || !el) {
      shouldStickToBottomRef.current = true;
      setShowJumpToLatest(false);
      return;
    }
    let lastScrollTop = el.scrollTop;
    const updateStickiness = () => {
      const viewportGap = window.visualViewport
        ? window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop
        : 0;
      const rawDistanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop;
      const distanceFromBottom = Math.max(0, rawDistanceFromBottom - viewportGap);
      const isNearBottom = distanceFromBottom < 40;
      const movedUp = el.scrollTop < lastScrollTop;
      const movedDown = el.scrollTop > lastScrollTop;
      if (isNearBottom) {
        shouldStickToBottomRef.current = true;
      } else if (movedUp) {
        shouldStickToBottomRef.current = false;
      } else if (movedDown && distanceFromBottom < 200) {
        shouldStickToBottomRef.current = true;
      }
      setShowJumpToLatest(!shouldStickToBottomRef.current);
      lastScrollTop = el.scrollTop;
    };
    updateStickiness();
    el.addEventListener("scroll", updateStickiness, { passive: true });
    return () => {
      el.removeEventListener("scroll", updateStickiness);
    };
  }, [sessionKey, useInnerScrollContainer]);

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
  const userMetaButtonStyle: React.CSSProperties = {
    width: "18px",
    height: "18px",
    border: "none",
    background: "transparent",
    padding: 0,
    margin: 0,
    color: "#2563eb",
    cursor: "pointer",
    fontSize: "14px",
    fontWeight: 800,
    lineHeight: 1,
    opacity: 1,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "6px",
    flexShrink: 0,
  };

  const makePromptKey = (item: TimelineItem): string => `${'timestamp' in item ? (item as any).timestamp : ""}\n${'content' in item ? (item as any).content : ""}`;

  const renderTimelineItem = (item: TimelineItem, idx: number, spacing: string = "0") => {
    if (item.type === "thought") {
      return (
        <div style={{ marginTop: spacing }}>
          <ThinkingBlock key={item.id || `thought-${idx}`} content={item.content || ""} defaultExpanded={false} />
        </div>
      );
    }
    if (item.type === "tool") {
      const tc = item.toolCall || {};
      return (
        <div style={{ marginTop: spacing }}>
          <ToolCallCard
            key={item.id || tc.callId || `tool-${idx}`}
            kind={tc.kind}
            title={(tc as any).title || (tc.meta && typeof tc.meta.title === "string" ? (tc.meta.title as string) : "")}
            callId={tc.callId || ""}
            status={tc.status || "running"}
            content={tc.content}
            result={formatToolCallFallbackResult(tc)}
            locations={tc.locations}
            rootPath={rootPath || undefined}
            defaultExpanded={false}
          />
        </div>
      );
    }
    const isUser = item.type === "user_text";
    const next = idx + 1 < timeline.length ? timeline[idx + 1] : null;
    const hasFollowingAssistantFlow = !isUser && !!next && next.type !== "user_text";
    const hideAssistantMeta = !isUser && (hasFollowingAssistantFlow || (isStreaming && idx === timeline.length - 1));
    const time = formatTime(item.timestamp);
    const uploadAttachments = isUser ? extractUploadAttachments(item.content || "") : [];
    const imageAttachments = uploadAttachments.filter((attachment) => attachment.isImage);
    const displayContent = isUser ? stripImageAttachmentTokens(item.content || "") : (item.content || "");
    const promptSaveContent = isUser ? stripUploadAttachmentTokens(item.content || "") : "";
    const promptKey = makePromptKey(item);
    const promptSaved = !!savedPromptKeys[promptKey];
    const copySucceeded = !!copiedMessageKeys[promptKey];
    const userMessageWidth = imageAttachments.length > 0 ? "min(320px, 100%)" : "auto";
    const hasRichUserAttachments = imageAttachments.length > 0;
    return (
      <div key={idx} style={{ marginTop: spacing, alignSelf: isUser ? "flex-end" : "flex-start", width: isUser ? userMessageWidth : "100%", maxWidth: isUser ? "80%" : "100%", minWidth: 0, position: "relative", display: "flex", flexDirection: "column" }}>
        {isUser ? (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "stretch", gap: "6px", width: userMessageWidth, maxWidth: "100%", minWidth: 0 }}>
            {hasRichUserAttachments ? (
              <div
                style={{
                  width: "100%",
                  maxWidth: "100%",
                  minWidth: 0,
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
                        onClick={() => onFileClickRef.current?.(attachment.path)}
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
                          src={appURL("/api/file", new URLSearchParams({ raw: "1", root: rootId || "", path: attachment.path }))}
                          alt={attachment.name}
                          style={{ display: "block", width: "100%", maxHeight: "220px", objectFit: "cover", background: "rgba(15,23,42,0.06)" }}
                        />
                      </button>
                    ))}
                  </div>
                ) : null}
                {displayContent ? (
                  <div style={{ padding: imageAttachments.length > 0 ? "2px 6px 0" : "6px 8px", color: "var(--text-primary)", fontSize: "14px", lineHeight: "1.5", whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word" }}>
                    <InlineTokenText content={displayContent} isDark={false} variant="inverse" />
                  </div>
                ) : null}
              </div>
            ) : null}
            {!hasRichUserAttachments && displayContent ? (
              <div style={{ padding: "10px 16px", borderRadius: "18px 18px 4px 18px", background: "rgba(148,163,184,0.14)", color: "var(--text-primary)", fontSize: "14px", lineHeight: "1.5", boxShadow: "none", whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word", alignSelf: "flex-end", maxWidth: "100%", minWidth: 0 }}>
                <InlineTokenText content={displayContent} isDark={false} variant="inverse" />
              </div>
            ) : null}
            <span style={{ fontSize: '10px', color: 'var(--text-secondary)', opacity: 0.5, alignSelf: 'flex-end', display: "inline-flex", alignItems: "center", gap: "4px" }}>
              {item.pendingAck ? (
                <span
                  aria-label="发送中"
                  style={{
                    width: "8px",
                    height: "8px",
                    border: "1px solid var(--text-secondary)",
                    borderTopColor: "transparent",
                    borderRadius: "50%",
                    display: "inline-block",
                    animation: "spin 0.8s linear infinite",
                  }}
                />
              ) : null}
              <span>{time}</span>
              {promptSaved ? (
                <span
                  aria-label="已添加提示词"
                  title="已添加提示词"
                  style={{ ...userMetaButtonStyle, color: "#2563eb", fontSize: "13px" }}
                >
                  ✓
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    if (!promptSaveContent) {
                      reportError("file.write_failed", "消息内容为空，无法加入常用提示词");
                      return;
                    }
                    void savePrompt(promptSaveContent)
                      .then(() => {
                        setSavedPromptKeys((prev) => ({ ...prev, [promptKey]: true }));
                      })
                      .catch((err) => {
                        reportError("file.write_failed", String((err as Error)?.message || "保存提示词失败"));
                      });
                  }}
                  style={userMetaButtonStyle}
                  aria-label="加入常用提示词"
                  title="加入常用提示词"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                    <path fill="currentColor" stroke="currentColor" strokeWidth="0.45" strokeLinejoin="round" d="M1.086 5.183A2.5 2.5 0 0 1 2.854 2.12l3.863-1.035A2.5 2.5 0 0 1 9.78 2.854L10.354 5H9.32l-.506-1.888a1.5 1.5 0 0 0-1.837-1.06L3.112 3.087a1.5 1.5 0 0 0-1.06 1.837l1.035 3.864a1.5 1.5 0 0 0 1.837 1.06L5 9.828v1.028a2.5 2.5 0 0 1-2.879-1.81zM8 6a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h5a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zM7 8a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1zm4 .5a.5.5 0 0 0-1 0V10H8.5a.5.5 0 0 0 0 1H10v1.5a.5.5 0 0 0 1 0V11h1.5a.5.5 0 0 0 0-1H11z"/>
                  </svg>
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  if (!promptSaveContent) {
                    reportError("file.write_failed", "消息内容为空，无法复制");
                    return;
                  }
                  const markCopied = () => {
                    setCopiedMessageKeys((prev) => ({ ...prev, [promptKey]: true }));
                    if (copyResetTimersRef.current[promptKey]) {
                      window.clearTimeout(copyResetTimersRef.current[promptKey]);
                    }
                    copyResetTimersRef.current[promptKey] = window.setTimeout(() => {
                      setCopiedMessageKeys((prev) => {
                        const next = { ...prev };
                        delete next[promptKey];
                        return next;
                      });
                      delete copyResetTimersRef.current[promptKey];
                    }, 1000);
                  };
                  if (navigator.clipboard?.writeText) {
                    void navigator.clipboard.writeText(promptSaveContent)
                      .then(markCopied)
                      .catch((err) => {
                        reportError("file.write_failed", String((err as Error)?.message || "复制失败"));
                      });
                  } else {
                    // fallback：非 HTTPS 环境下使用 execCommand
                    try {
                      const ta = document.createElement("textarea");
                      ta.value = promptSaveContent;
                      ta.style.position = "fixed";
                      ta.style.opacity = "0";
                      document.body.appendChild(ta);
                      ta.focus();
                      ta.select();
                      document.execCommand("copy");
                      document.body.removeChild(ta);
                      markCopied();
                    } catch (err) {
                      reportError("file.write_failed", String((err as Error)?.message || "复制失败"));
                    }
                  }
                }}
                style={userMetaButtonStyle}
                aria-label="复制消息"
                title="复制消息"
              >
                {copySucceeded ? (
                  <span aria-hidden="true" style={{ fontSize: "13px", fontWeight: 800, lineHeight: 1 }}>
                    ✓
                  </span>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
                    <path fill="currentColor" d="M20 2H10c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2m0 12H10V4h10z"/>
                    <path fill="currentColor" d="M14 20H4V10h2V8H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2v-2h-2z"/>
                  </svg>
                )}
              </button>
            </span>
          </div>
        ) : (
          <div style={{ width: "100%", minWidth: 0, display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
            <div style={{ color: "var(--text-primary)", fontSize: "15px", lineHeight: "1.7", width: "100%", minWidth: 0 }}>
              <MarkdownViewer
                content={item.content || ""}
                onFileClick={onFileClickRef.current}
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
    <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column", background: "transparent" }}>
      {interactionMode === "drawer" ? null : (
        <header style={{ height: "36px", padding: "0 16px", borderBottom: "1px solid var(--border-color)", display: "flex", alignItems: "center", background: "transparent", boxSizing: "border-box", zIndex: 10, flexShrink: 0 }}>
          <h1 style={{ fontSize: "14px", fontWeight: 600, margin: 0, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayName}</h1>
        </header>
      )}

      {/* 滚动容器 */}
      <div style={{ flex: 1, minHeight: 0, minWidth: 0, position: "relative" }}>
        <div ref={scrollRef} style={{ flex: 1, minHeight: 0, minWidth: 0, height: "100%", overflowY: useInnerScrollContainer ? "auto" : "visible", overflowX: "hidden", position: "relative", WebkitOverflowScrolling: "touch" }}>
          <div style={{ 
            width: "100%",
            minWidth: 0,
            display: "block", 
            padding: "24px 16px", 
            boxSizing: "border-box",
            overflowX: "hidden",
          }}>
          <div style={{ width: "100%", minWidth: 0, margin: "0", display: "flex", flexDirection: "column" }}>
            {timeline.map((item, idx) => renderTimelineItem(item, idx, timelineItemSpacing(idx > 0 ? timeline[idx - 1] : null, item)))}
            {(isAwaiting || isStreaming) && (
              <div style={{ marginTop: "16px", display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--text-secondary)" }}>
                <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "var(--accent-color)", animation: "pulse 1s infinite" }} />
                {isStreaming ? "正在生成..." : "已发送，等待响应..."}
              </div>
            )}

            {/* 关联文件区域 */}
            {relatedFiles.length > 0 && (
              <div style={{ marginTop: "18px", paddingTop: "14px", borderTop: "1px solid var(--border-color)", width: "100%", boxSizing: "border-box" }}>
                <div style={{ fontSize: "12px", fontWeight: 500, color: "var(--text-secondary)", marginBottom: "6px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span>关联文件 {relatedFiles.length}</span>
                  {hasMoreFiles && <button type="button" onClick={() => setShowAllFiles(!showAllFiles)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--text-secondary)", fontSize: "11px" }}>{showAllFiles ? "收起" : "更多"}</button>}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  {displayFiles.map((file, i) => (
                    <div key={i} onClick={() => onFileClickRef.current?.(file.path)} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "3px 6px", borderRadius: "6px", cursor: "pointer", transition: "background 0.15s" }} onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(0,0,0,0.04)"; }} onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                      <img src={`https://api.iconify.design/lucide:file-text.svg?color=%2394a3b8`} alt="file" style={{ width: 13, height: 13, flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0, fontSize: "12px", color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.name}</div>
                      {gitFileStatsByPath[file.path] ? (
                        <div style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "11px", color: "var(--text-secondary)", flexShrink: 0 }}>
                          <span style={{ color: "#15803d", fontVariantNumeric: "tabular-nums" }}>+{gitFileStatsByPath[file.path].additions}</span>
                          <span style={{ color: "#b91c1c", fontVariantNumeric: "tabular-nums" }}>-{gitFileStatsByPath[file.path].deletions}</span>
                        </div>
                      ) : null}
                      <button
                        type="button"
                        aria-label={`移除关联文件 ${file.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onRemoveRelatedFile?.(file.path);
                        }}
                        style={{
                          border: "none",
                          background: "transparent",
                          color: "#dc2626",
                          cursor: "pointer",
                          fontSize: "14px",
                          lineHeight: 1,
                          padding: "2px 4px",
                          borderRadius: "4px",
                          flexShrink: 0,
                        }}
                      >
                        x
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div ref={scrollEndRef} style={{ height: "1px" }} />
          </div>
          </div>
        </div>
        {showJumpToLatest ? (
          <button
            type="button"
            onClick={() => {
              shouldStickToBottomRef.current = true;
              setShowJumpToLatest(false);
              scrollEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
            }}
            aria-label="回到底部最新消息"
            title="回到底部最新消息"
            style={{
              position: "absolute",
              right: "16px",
              bottom: "16px",
              zIndex: 3,
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              border: "1px solid rgba(37,99,235,0.35)",
              background: "#2563eb",
              color: "#ffffff",
              borderRadius: "999px",
              padding: "8px 12px",
              boxShadow: "0 8px 24px rgba(15, 23, 42, 0.14)",
              cursor: "pointer",
              fontSize: "12px",
            }}
          >
            <ChevronDownSmallIcon />
            <span>回到底部</span>
          </button>
        ) : null}
      </div>
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

function ChevronDownSmallIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export const SessionViewer = memo(SessionViewerInner, (prev, next) => (
  prev.session === next.session &&
  prev.rootId === next.rootId &&
  prev.rootPath === next.rootPath &&
  prev.interactionMode === next.interactionMode &&
  prev.gitFileStatsByPath === next.gitFileStatsByPath
));

import React, { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
  summary?: string | { title?: string; description?: string };
  exchanges?: Array<{ role?: string; content?: string; timestamp?: string }>;
  closed_at?: string;
  related_files?: Array<RelatedFile | { path: string; relation?: string; created_by_session?: boolean }>;
};

type SessionViewerProps = {
  session: SessionItem | null;
  onFileClick?: (path: string) => void;
};

// 时间格式化工具
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
  } catch {
    return "";
  }
};

export function SessionViewer({ session, onFileClick }: SessionViewerProps) {
  const [showAllFiles, setShowAllFiles] = useState(false);

  if (!session) {
    return (
      <div style={{ padding: "40px", textAlign: "center", color: "var(--text-secondary)" }}>
        选择一个会话查看内容
      </div>
    );
  }

  const rawRelated = session.related_files || (session as any).outputs || [];
  const relatedFiles = (Array.isArray(rawRelated) ? rawRelated : [])
    .map((f: any) => {
      const path = typeof f === "string" ? f : (typeof f?.path === "string" ? f.path : "");
      const name = typeof f?.name === "string" ? f.name : path.split("/").pop() || path;
      return { path, name };
    })
    .filter(f => f.path);

  const displayFiles = showAllFiles ? relatedFiles : relatedFiles.slice(0, 10); // 增加默认显示数量
  const hasMoreFiles = relatedFiles.length > 10;
  const exchanges = Array.isArray(session.exchanges) ? session.exchanges : [];
  
  const summaryText =
    typeof session.summary === "string"
      ? session.summary
      : session.summary?.description || "";
  
  const scope = session.type ?? session.scope ?? "chat";
  const displayName = session.name ?? session.purpose ?? session.key ?? session.session_key ?? "Session";

  return (
    <div style={{ 
      padding: "24px 32px", 
      maxWidth: "1000px", 
      width: "100%", 
      margin: "0 auto", 
      display: "flex", 
      flexDirection: "column", 
      gap: "24px", 
      boxSizing: "border-box", 
      background: "transparent",
      transform: "translateZ(0)",
      willChange: "transform"
    }}>
      {/* 顶栏 */}
      <div style={{ 
        height: "36px", 
        padding: "0 16px", 
        borderBottom: "1px solid var(--border-color)", 
        display: "flex", 
        alignItems: "center", 
        gap: "12px", 
        boxSizing: "border-box" 
      }}>
        <h1 style={{ fontSize: "16px", fontWeight: 600, margin: 0 }}>{displayName}</h1>
        <div style={{ fontSize: "11px", color: "var(--text-secondary)", display: "flex", gap: "8px" }}>
          <strong>{session.agent ?? "agent"}</strong>
          <span>•</span>
          <span>{scope}</span>
        </div>
      </div>

      {/* 对话内容 */}
      <div style={{ display: "flex", flexDirection: "column", gap: "32px", width: "100%" }}>
        {exchanges.length > 0 ? (
          exchanges.map((item, idx) => {
            const isUser = (item.role || "").toLowerCase() === "user";
            const time = formatTime(item.timestamp);
            return (
              <div
                key={idx}
                style={{
                  alignSelf: isUser ? "flex-end" : "flex-start",
                  width: isUser ? "auto" : "100%",
                  maxWidth: isUser ? "80%" : "100%",
                  position: 'relative',
                  display: 'flex',
                  flexDirection: 'column',
                  transform: "translateZ(0)"
                }}
              >
                {isUser ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
                    <div
                      style={{
                        padding: "10px 16px",
                        borderRadius: "18px 18px 4px 18px",
                        background: "var(--accent-color)",
                        color: "#fff",
                        fontSize: "14px",
                        lineHeight: "1.5",
                        boxShadow: "0 4px 12px rgba(59,130,246,0.15)",
                      }}
                    >
                      {item.content || ""}
                    </div>
                    <span style={{ fontSize: '10px', color: 'var(--text-secondary)', opacity: 0.5, marginRight: '4px' }}>{time}</span>
                  </div>
                ) : (
                  <div style={{ width: "100%", position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                    <div style={{ color: "var(--text-primary)", fontSize: "15px", lineHeight: "1.7", width: "100%" }}>
                      <ReactMarkdown 
                        remarkPlugins={[remarkGfm]}
                        components={{
                          p: ({node, ...props}) => <p style={{ margin: "0 0 1em 0", width: "100%" }} {...props} />,
                          pre: ({node, ...props}) => (
                            <pre style={{ 
                              background: "rgba(0,0,0,0.04)", 
                              padding: "16px", 
                              borderRadius: "8px", 
                              overflow: "auto",
                              fontSize: "13px",
                              margin: "1.5em 0",
                              width: "100%",
                              boxSizing: "border-box"
                            }} {...props} />
                          )
                        }}
                      >
                        {item.content || ""}
                      </ReactMarkdown>
                    </div>
                    {time && <span style={{ alignSelf: 'flex-start', fontSize: '10px', color: 'var(--text-secondary)', opacity: 0.5, marginTop: '-10px', marginBottom: '4px' }}>{time}</span>}
                  </div>
                )}
              </div>
            );
          })
        ) : summaryText ? (
          <div style={{ 
            color: "var(--text-primary)", 
            lineHeight: "1.7", 
            fontSize: "15px",
            width: "100%",
            background: "rgba(0,0,0,0.02)",
            padding: "20px",
            borderRadius: "12px",
            transform: "translateZ(0)"
          }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{summaryText}</ReactMarkdown>
          </div>
        ) : (
          <div style={{ padding: "40px", textAlign: "center", color: "var(--text-secondary)", fontStyle: "italic" }}>
            暂无对话内容记录
          </div>
        )}
      </div>

      {/* 关联文件展示区域 - 根据截图重构 */}
      {relatedFiles.length > 0 && (
        <div style={{ 
          marginTop: "12px", 
          padding: "16px 20px", 
          background: "rgba(0,0,0,0.03)", 
          borderRadius: "16px", 
          width: "100%", 
          boxSizing: "border-box",
          transform: "translateZ(0)"
        }}>
          <div
            style={{
              fontSize: "14px",
              fontWeight: 600,
              color: "var(--text-primary)",
              marginBottom: "12px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span>关联文件</span>
              <span style={{ 
                fontSize: '10px', 
                background: 'rgba(0,0,0,0.06)', 
                color: 'var(--text-secondary)',
                padding: '1px 6px', 
                borderRadius: '10px', 
                fontWeight: 500 
              }}>{relatedFiles.length}</span>
            </div>
            {hasMoreFiles && (
              <button
                type="button"
                onClick={() => setShowAllFiles(!showAllFiles)}
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  color: "var(--accent-color)",
                  fontSize: "12px",
                }}
              >
                {showAllFiles ? "收起" : "查看全部"}
              </button>
            )}
          </div>
          <div style={{ 
            display: "grid", 
            gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", 
            gap: "8px" 
          }}>
            {displayFiles.map((file, i) => (
              <div
                key={i}
                onClick={() => onFileClick?.(file.path)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                  padding: "8px 12px",
                  background: "#fff",
                  border: "1px solid rgba(0,0,0,0.05)",
                  borderRadius: "8px",
                  cursor: "pointer",
                  transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
                  transform: "translateZ(0)"
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = "var(--accent-color)";
                  e.currentTarget.style.boxShadow = "0 4px 12px rgba(0,0,0,0.05)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = "rgba(0,0,0,0.05)";
                  e.currentTarget.style.boxShadow = "none";
                }}
              >
                <img 
                  src={`https://api.iconify.design/lucide:file-text.svg?color=%2394a3b8`} 
                  alt="file"
                  style={{ width: 16, height: 16, opacity: 0.8 }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: "13px",
                      fontWeight: 500,
                      color: "var(--text-primary)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {file.name}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

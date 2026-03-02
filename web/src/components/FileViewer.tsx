import React, { useEffect } from "react";
import { MarkdownViewer } from "./MarkdownViewer";
import { CodeViewer } from "./CodeViewer";
import { ImageViewer } from "./ImageViewer";
import { BinaryViewer } from "./BinaryViewer";

type FilePayload = {
  name: string;
  path: string;
  content: string;
  encoding: string;
  truncated: boolean;
  size: number;
  ext?: string;
  mime?: string;
  root?: string;
  file_meta?: Array<{
    source_session: string;
    session_name?: string;
    agent?: string;
    created_at?: string;
    updated_at?: string;
    created_by?: string;
  }>;
};

type RelatedSession = {
  source_session: string;
  session_name?: string;
  agent?: string;
};

type FileViewerProps = {
  file?: FilePayload | null;
  onSessionClick?: (sessionKey: string) => void;
  onPathClick?: (path: string) => void;
};

function Breadcrumbs({ root, path, onPathClick }: { root?: string; path: string; onPathClick?: (path: string) => void }) {
  const parts = path.split('/').filter(Boolean);
  const getPathAt = (index: number) => parts.slice(0, index + 1).join('/');

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px', color: 'var(--text-secondary)', overflow: 'hidden', whiteSpace: 'nowrap', flexShrink: 1, justifyContent: 'flex-start' }}>
      {root && (
        <>
          <span
            onClick={() => onPathClick?.(".")}
            style={{ fontWeight: 500, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", cursor: "pointer" }}
            onMouseEnter={(e) => { e.currentTarget.style.textDecoration = "underline"; }}
            onMouseLeave={(e) => { e.currentTarget.style.textDecoration = "none"; }}
          >
            {root}
          </span>
          {parts.length > 0 && <span style={{ opacity: 0.4, fontSize: '10px', flexShrink: 0 }}>❯</span>}
        </>
      )}
      {parts.map((part, index) => (
        <React.Fragment key={index}>
          <span 
            onClick={() => index < parts.length - 1 && onPathClick?.(getPathAt(index))}
            style={{ fontWeight: index === parts.length - 1 ? 600 : 400, color: index === parts.length - 1 ? 'var(--text-primary)' : 'inherit', cursor: index < parts.length - 1 ? 'pointer' : 'default', overflow: 'hidden', textOverflow: 'ellipsis' }}
            onMouseEnter={(e) => { if (index < parts.length - 1) e.currentTarget.style.textDecoration = 'underline'; }}
            onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}
          >
            {part}
          </span>
          {index < parts.length - 1 && <span style={{ opacity: 0.4, fontSize: '10px', flexShrink: 0 }}>❯</span>}
        </React.Fragment>
      ))}
    </div>
  );
}

export function FileViewer({ file, onSessionClick, onPathClick }: FileViewerProps) {
  if (!file) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-secondary)", flexDirection: "column", gap: "12px" }}>
        <div style={{ fontSize: "48px", opacity: 0.2 }}>📄</div>
        <p>Select a file to preview</p>
      </div>
    );
  }

  const ext = file.ext || (file.path.includes(".") ? `.${file.path.split(".").pop()}` : "");
  
  const normalizeRelatedSessions = (raw: unknown): RelatedSession[] => {
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    const normalized = list.map((item) => {
      if (!item || typeof item !== "object") return null;
      const value = item as Record<string, unknown>;
      const source = (typeof value.source_session === "string" && value.source_session) || (typeof value.sourceSession === "string" && value.sourceSession) || (typeof value.session_key === "string" && value.session_key) || "";
      if (!source) return null;
      return { source_session: source, session_name: (typeof value.session_name === "string" && value.session_name) || undefined, agent: typeof value.agent === "string" ? value.agent : undefined };
    }).filter((v): v is RelatedSession => Boolean(v));
    const dedup = new Map<string, RelatedSession>();
    normalized.forEach((item) => { if (!dedup.has(item.source_session)) dedup.set(item.source_session, item); });
    return Array.from(dedup.values());
  };

  const relatedSessions = normalizeRelatedSessions((file as any).file_meta);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "transparent" }}>
      <header style={{ height: "36px", padding: "0 16px", borderBottom: "1px solid var(--border-color)", display: "flex", alignItems: "center", gap: "10px", background: "transparent", boxSizing: "border-box", zIndex: 10, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", overflow: "hidden", flex: 1, minWidth: 0 }}>
          <Breadcrumbs root={file.root} path={file.path} onPathClick={onPathClick} />
          
          {relatedSessions.length > 0 && (
            <div style={{ 
              marginLeft: "16px", 
              display: "flex", 
              alignItems: "center", 
              gap: "6px", 
              minWidth: 0, 
              flexShrink: 0 
            }}>
              {/* 替换文字为图标 */}
              <svg 
                width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" 
                style={{ color: "var(--text-secondary)", opacity: 0.4 }}
              >
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              <div style={{ display: 'flex', gap: '4px', overflowX: 'auto', whiteSpace: 'nowrap', scrollbarWidth: 'none' }}>
                {relatedSessions.map((meta) => (
                  <button
                    key={meta.source_session}
                    type="button"
                    onClick={(e) => {
                      e.preventDefault(); e.stopPropagation();
                      if (meta.source_session) {
                        onSessionClick?.(meta.source_session);
                      }
                    }}
                    style={{ 
                      background: "rgba(0, 0, 0, 0.03)", 
                      border: "1px solid rgba(0, 0, 0, 0.05)", 
                      borderRadius: "6px", 
                      padding: "1px 8px", 
                      cursor: "pointer", 
                      color: "var(--text-secondary)", 
                      fontSize: "11px", 
                      fontWeight: 500, 
                      flexShrink: 0,
                      transition: "all 0.2s ease"
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "rgba(59, 130, 246, 0.08)";
                      e.currentTarget.style.color = "var(--accent-color)";
                      e.currentTarget.style.borderColor = "rgba(59, 130, 246, 0.2)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "rgba(0, 0, 0, 0.03)";
                      e.currentTarget.style.color = "var(--text-secondary)";
                      e.currentTarget.style.borderColor = "rgba(0, 0, 0, 0.05)";
                    }}
                  >
                    {meta.session_name || `Session ${meta.source_session.slice(0, 8)}`}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div style={{ fontSize: "11px", color: "var(--text-secondary)", marginLeft: "6px", flexShrink: 0, opacity: 0.7 }}>{(file.size / 1024).toFixed(1)} KB</div>
      </header>

      <div style={{ flex: 1, overflow: "auto", position: "relative" }}>
        <div style={{ minWidth: "100%", minHeight: "100%", display: "inline-block", background: "transparent" }}>
          {file.mime?.startsWith("image/") || [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext.toLowerCase()) ? (
            <div style={{ padding: "24px 16px" }}><ImageViewer path={file.path} root={file.root} /></div>
          ) : file.encoding === "binary" ? (
            <div style={{ padding: "24px 16px" }}><BinaryViewer /></div>
          ) : ext === ".md" || ext === ".markdown" ? (
            <div style={{ padding: "24px 16px" }}><MarkdownViewer content={file.content} /></div>
          ) : (
            <CodeViewer content={file.content} ext={ext} />
          )}
        </div>
      </div>
    </div>
  );
}

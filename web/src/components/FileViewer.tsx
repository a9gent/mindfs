import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { MarkdownViewer } from "./MarkdownViewer";
import { CodeViewer, supportsLineSelection } from "./CodeViewer";
import { ImageViewer } from "./ImageViewer";
import { BinaryViewer } from "./BinaryViewer";
import { DocumentViewer } from "./DocumentViewer";
import { getDocumentPreviewKind } from "../services/documentPreview";
import { rootBadgeStyle } from "./rootBadgeStyle";
import { downloadFile } from "../services/download";
import { isNativeShellRuntime } from "../services/runtime";
import { useI18n } from "../i18n";

import type { FilePayload } from "../services/file";
import { FileEditStore, fileEditKey, MAX_EDITABLE_FILE_BYTES } from "../services/fileEditing";
import { FileEditor } from "./FileEditor";
import { FileOperationItems, FileMenuIcon, fileMenuItemStyle, MoreMenuButton, moreMenuPopoverStyle, menuOverlayStyle, MoveFilePopover } from "./FileOperations";

function FileViewerMenu({ root, rootPath, path, downloading, onDownload, onEdit, onComplete }: {
  root: string; rootPath?: string; path: string; downloading: boolean; onDownload: () => void;
  onEdit?: () => void; onComplete?: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open && !moveOpen) return;
    const close = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) { setOpen(false); setMoveOpen(false); } };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open, moveOpen]);
  return <div ref={ref} style={{ position: "relative" }} onKeyDown={event => { if (event.key === "Escape") { setOpen(false); setMoveOpen(false); } }}>
    <MoreMenuButton open={open} label={t("fileOperation.menu")} onClick={() => { setMoveOpen(false); setOpen(value => !value); }} />
    {open && <div role="menu" style={moreMenuPopoverStyle}>
      <button type="button" role="menuitem" style={fileMenuItemStyle} disabled={!root || downloading} onClick={() => { setOpen(false); onDownload(); }}><FileMenuIcon action="download" /><span>{t("fileOperation.download")}</span></button>
      {onEdit && <button type="button" role="menuitem" style={fileMenuItemStyle} onClick={() => { setOpen(false); onEdit(); }}><FileMenuIcon action="edit" /><span>{t("fileEditor.edit")}</span></button>}
      {root && !/^(?:\/|[A-Za-z]:)/.test(path) && <FileOperationItems root={root} path={path} onMove={() => { setOpen(false); setMoveOpen(true); }} onComplete={async () => { await onComplete?.(); setOpen(false); }} />}
    </div>}
    {moveOpen && <div style={menuOverlayStyle}><MoveFilePopover root={root} rootPath={rootPath} path={path} onComplete={async () => { setMoveOpen(false); await onComplete?.(); }} /></div>}
  </div>;
}

type RelatedSession = {
  source_session: string;
  session_name?: string;
  agent?: string;
  created_at?: string;
  updated_at?: string;
};

type FileViewerProps = {
  rootPath?: string;
  onFileOperationComplete?: () => void | Promise<void>;
  editStore: FileEditStore;
  onFileUpdated: (file: FilePayload) => void;
  onFileSaved: (file: FilePayload) => void;
  file?: FilePayload | null;
  onSessionClick?: (sessionKey: string) => void;
  onPathClick?: (path: string) => void;
  onFileClick?: (path: string) => void;
  onSelectionChange?: (selection: {
    filePath: string;
    text?: string;
    startLine?: number;
    endLine?: number;
  } | null) => void;
  initialScrollTop?: number;
  onScrollTopChange?: (scrollTop: number) => void;
  isVisible?: boolean;
};

function isSelectionInside(root: Node, range: Range): boolean {
  return root.contains(range.commonAncestorContainer)
    || root.contains(range.startContainer)
    || root.contains(range.endContainer);
}

function countLineAtOffset(content: string, offset: number): number {
  let line = 1;
  const limit = Math.max(0, Math.min(offset, content.length));
  for (let i = 0; i < limit; i += 1) {
    if (content.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

function getSelectionOffsets(root: Node, range: Range): { start: number; end: number } | null {
  try {
    const startRange = document.createRange();
    startRange.selectNodeContents(root);
    startRange.setEnd(range.startContainer, range.startOffset);
    const endRange = document.createRange();
    endRange.selectNodeContents(root);
    endRange.setEnd(range.endContainer, range.endOffset);
    return {
      start: startRange.toString().length,
      end: endRange.toString().length,
    };
  } catch {
    return null;
  }
}

function Breadcrumbs({ root, path, onPathClick }: { root?: string; path: string; onPathClick?: (path: string) => void }) {
  const parts = path.split('/').filter(Boolean);
  const getPathAt = (index: number) => parts.slice(0, index + 1).join('/');

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px', color: 'var(--text-secondary)', overflow: 'hidden', whiteSpace: 'nowrap', flexShrink: 1, justifyContent: 'flex-start' }}>
      {root && (
        <>
          <span
            onClick={() => onPathClick?.(".")}
            style={{
              ...rootBadgeStyle,
              overflow: "hidden",
              textOverflow: "ellipsis",
              cursor: "pointer",
            }}
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

export function FileViewer({ rootPath, onFileOperationComplete, editStore, onFileUpdated, onFileSaved, file, onSessionClick, onPathClick, onFileClick, onSelectionChange, initialScrollTop = 0, onScrollTopChange, isVisible = true }: FileViewerProps) {
  const { t } = useI18n();
  const editKey = fileEditKey(file?.root || "", file?.path || "");
  const editSession = useSyncExternalStore(editStore.subscribe, () => editStore.get(editKey));
  const canEdit = !!file?.root && file.encoding === "utf-8" && file.size <= MAX_EDITABLE_FILE_BYTES
    && !/^(?:\/|[A-Za-z]:)/.test(file.path);
  const [isDownloading, setIsDownloading] = useState(false);
  const [editorActions, setEditorActions] = useState<HTMLSpanElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const restoredScrollKeyRef = useRef("");
  const contentRootRef = useRef<HTMLDivElement | null>(null);
  const codeContentRef = useRef<HTMLElement | null>(null);
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.innerWidth <= 768;
  });

  const fileScrollKey = file ? `${file.root || ""}::${file.path}` : "";

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const media = window.matchMedia("(max-width: 768px)");
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useLayoutEffect(() => {
    if (editSession) { restoredScrollKeyRef.current = ""; return; }
    if (!isVisible) return;
    if (!fileScrollKey || !scrollRef.current) return;
    if (file?.targetLine && file.targetLine > 0) return;
    const savedTop = typeof initialScrollTop === "number" ? initialScrollTop : 0;
    if (savedTop <= 0) return;
    if (restoredScrollKeyRef.current === `${fileScrollKey}:${savedTop}`) return;
    let cancelled = false;
    let frame1 = 0;
    let frame2 = 0;
    const applyScrollTop = () => {
      if (cancelled || !scrollRef.current) return;
      scrollRef.current.scrollTop = savedTop;
    };
    frame1 = window.requestAnimationFrame(() => {
      applyScrollTop();
      frame2 = window.requestAnimationFrame(() => {
        applyScrollTop();
        restoredScrollKeyRef.current = `${fileScrollKey}:${savedTop}`;
      });
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame1);
      window.cancelAnimationFrame(frame2);
    };
  }, [fileScrollKey, file?.targetLine, file?.content, initialScrollTop, isVisible, !!editSession]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !fileScrollKey) return;
    const handleScroll = () => {
      onScrollTopChange?.(node.scrollTop);
    };
    node.addEventListener("scroll", handleScroll, { passive: true });
    return () => node.removeEventListener("scroll", handleScroll);
  }, [fileScrollKey, onScrollTopChange, !!editSession]);

  const ext = file?.ext || (file?.path.includes(".") ? `.${file.path.split(".").pop()}` : "");
  const documentPreviewKind = getDocumentPreviewKind(ext, file?.mime);
  const usesMarkdownViewer = ext === ".md" || ext === ".markdown";
  const lineSelectionEnabled = !editSession && !!file
    && !usesMarkdownViewer
    && file.encoding !== "binary"
    && supportsLineSelection(ext);

  const updateSelection = useCallback(() => {
    if (!file || !onSelectionChange || editSession) {
      return;
    }
    if (file.encoding === "binary" || file.mime?.startsWith("image/")) {
      onSelectionChange(null);
      return;
    }
    const root = (usesMarkdownViewer ? contentRootRef.current : codeContentRef.current) as Node | null;
    const selection = window.getSelection();
    if (!root || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
      onSelectionChange(null);
      return;
    }
    const range = selection.getRangeAt(0);
    if (!isSelectionInside(root, range)) {
      onSelectionChange(null);
      return;
    }
    const text = selection.toString();
    if (!text.trim()) {
      onSelectionChange(null);
      return;
    }
    if (lineSelectionEnabled) {
      const offsets = getSelectionOffsets(root, range);
      if (!offsets) {
        onSelectionChange(null);
        return;
      }
      const startLine = countLineAtOffset(file.content, offsets.start);
      const endLine = countLineAtOffset(file.content, Math.max(offsets.start, offsets.end - 1));
      onSelectionChange({
        filePath: file.path,
        text,
        startLine,
        endLine,
      });
      return;
    }
    onSelectionChange({
      filePath: file.path,
      text,
    });
  }, [file, onSelectionChange, lineSelectionEnabled, usesMarkdownViewer, editSession]);

  useEffect(() => {
    if (!onSelectionChange) {
      return;
    }
    if (editSession || !file || file.encoding === "binary" || file.mime?.startsWith("image/")) {
      onSelectionChange(null);
      return;
    }
    const handleSelectionChange = () => {
      updateSelection();
    };
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
      onSelectionChange(null);
    };
  }, [file, onSelectionChange, updateSelection, editSession]);

  const [downloadToast, setDownloadToast] = useState<{ msg: string; ok: boolean } | null>(null);

  const showToast = useCallback((msg: string, ok: boolean) => {
    setDownloadToast({ msg, ok });
    window.setTimeout(() => setDownloadToast(null), 3000);
  }, []);

  const handleDownload = useCallback(async () => {
    if (!file?.root || !file.path || isDownloading) {
      return;
    }
    try {
      setIsDownloading(true);
      await downloadFile({
        rootId: file.root,
        path: file.path,
        name: file.name,
      });
      showToast(isNativeShellRuntime() ? t("fileViewer.downloadSavedNative") : t("fileViewer.downloadStarted"), true);
    } catch (error) {
      const message = error instanceof Error ? error.message : t("fileViewer.downloadFailed");
      showToast(message, false);
    } finally {
      setIsDownloading(false);
    }
  }, [file, isDownloading, showToast, t]);

  if (!file) {
    return (
      <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-secondary)", flexDirection: "column", gap: "12px" }}>
        <div style={{ fontSize: "48px", opacity: 0.2 }}>📄</div>
        <p>Select a file to preview</p>
      </div>
    );
  }

  const normalizeRelatedSessions = (raw: unknown): RelatedSession[] => {
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    const normalized = list.map((item) => {
      if (!item || typeof item !== "object") return null;
      const value = item as Record<string, unknown>;
      const source = (typeof value.source_session === "string" && value.source_session) || (typeof value.sourceSession === "string" && value.sourceSession) || (typeof value.session_key === "string" && value.session_key) || "";
      if (!source) return null;
      return {
        source_session: source,
        session_name: (typeof value.session_name === "string" && value.session_name) || undefined,
        agent: typeof value.agent === "string" ? value.agent : undefined,
        created_at: typeof value.created_at === "string" ? value.created_at : undefined,
        updated_at: typeof value.updated_at === "string" ? value.updated_at : undefined,
      };
    }).filter((v): v is NonNullable<typeof v> => v !== null) as RelatedSession[];
    const dedup = new Map<string, RelatedSession>();
    normalized.forEach((item) => {
      const existing = dedup.get(item.source_session);
      if (!existing) {
        dedup.set(item.source_session, item);
        return;
      }
      const existingTime = Date.parse(existing.updated_at || existing.created_at || "") || 0;
      const itemTime = Date.parse(item.updated_at || item.created_at || "") || 0;
      if (itemTime >= existingTime) {
        dedup.set(item.source_session, item);
      }
    });
    return Array.from(dedup.values()).sort((left, right) => {
      const leftTime = Date.parse(left.updated_at || left.created_at || "") || 0;
      const rightTime = Date.parse(right.updated_at || right.created_at || "") || 0;
      return rightTime - leftTime;
    });
  };

  const relatedSessions = normalizeRelatedSessions((file as any).file_meta);
  const visibleRelatedSessions = relatedSessions.slice(0, isMobile ? 2 : 3);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, minWidth: 0, background: "transparent" }}>
      {/* 下载结果 toast */}
      {downloadToast && (
        <div style={{
          position: "fixed",
          bottom: "24px",
          left: "50%",
          transform: "translateX(-50%)",
          background: downloadToast.ok ? "rgba(34,197,94,0.92)" : "rgba(239,68,68,0.92)",
          color: "#fff",
          padding: "10px 20px",
          borderRadius: "8px",
          fontSize: "14px",
          fontWeight: 500,
          zIndex: 9999,
          pointerEvents: "none",
          boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
          whiteSpace: "nowrap",
        }}>
          {downloadToast.msg}
        </div>
      )}
      <header style={{ height: "36px", padding: "0 3px 0 16px", borderBottom: "1px solid var(--border-color)", display: "flex", alignItems: "center", gap: "10px", background: "var(--mindfs-topbar-bg, transparent)", boxSizing: "border-box", zIndex: 10, flexShrink: 0 }}>
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
                {visibleRelatedSessions.map((meta) => (
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
                    <span
                      style={{
                        display: "inline-block",
                        maxWidth: isMobile ? "72px" : "120px",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        verticalAlign: "bottom",
                      }}
                      title={meta.session_name || `Session ${meta.source_session.slice(0, 8)}`}
                    >
                      {meta.session_name || `Session ${meta.source_session.slice(0, 8)}`}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "2px", minWidth: 0, flexShrink: 0 }}>
            <div style={{ fontSize: "11px", color: "var(--text-secondary)", marginLeft: "6px", flexShrink: 0, opacity: 0.7 }}>{(file.size / 1024).toFixed(1)} KB</div>
            <span className="file-editor-actions" ref={setEditorActions} />
            {!editSession && <FileViewerMenu key={editKey} root={file.root || ""} rootPath={rootPath} path={file.path} downloading={isDownloading} onDownload={() => { void handleDownload(); }} onEdit={canEdit ? () => { void editStore.open(file.root!, file.path); } : undefined} onComplete={onFileOperationComplete} />}
          </div>
      </header>

      {editSession ? <FileEditor key={editKey} actionsTarget={editorActions} store={editStore} editKey={editKey} session={editSession} isVisible={isVisible} onFileUpdated={onFileUpdated} onFileSaved={onFileSaved} onExitError={(error) => showToast(error, false)} /> : <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflow: documentPreviewKind === "powerpoint" ? "hidden" : "auto", position: "relative", WebkitOverflowScrolling: "touch" }}>
        <div style={{ minWidth: "100%", height: documentPreviewKind === "powerpoint" ? "100%" : undefined, display: "block", background: "transparent" }}>
          {documentPreviewKind ? (
            <DocumentViewer key={`${file.root || ""}:${file.path}`} path={file.path} root={file.root} kind={documentPreviewKind} />
          ) : file.mime?.startsWith("image/") || [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext.toLowerCase()) ? (
            <div style={{ padding: "24px 16px" }}><ImageViewer path={file.path} root={file.root} /></div>
          ) : file.encoding === "binary" ? (
            <div style={{ padding: "24px 16px" }}><BinaryViewer /></div>
          ) : usesMarkdownViewer ? (
            <div ref={contentRootRef} className="markdown-document-shell" style={{ padding: "24px 16px" }}>
              <MarkdownViewer
                content={file.content}
                currentPath={file.path}
                root={file.root}
                onFileClick={onFileClick}
                targetLine={file.targetLine}
                contentRef={contentRootRef}
                scrollContainerRef={scrollRef}
                isVisible={isVisible}
                compactOutline={isMobile}
                showOutline
              />
            </div>
          ) : (
            <CodeViewer
              content={file.content}
              ext={ext}
              targetLine={file.targetLine}
              targetColumn={file.targetColumn}
              contentRef={codeContentRef}
            />
          )}
        </div>
      </div>}
    </div>
  );
}

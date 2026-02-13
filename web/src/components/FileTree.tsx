import React, { useState, useCallback, useRef, useEffect } from "react";

type FileEntry = {
  name: string;
  path: string;
  is_dir: boolean;
};

type FileMeta = {
  source_session?: string;
  session_name?: string;
};

type ContextMenuState = {
  visible: boolean;
  x: number;
  y: number;
  entry: FileEntry | null;
  rootId: string | null;
};

type FileTreeProps = {
  entries: FileEntry[];
  childrenByPath: Record<string, FileEntry[]>;
  expanded: string[];
  selectedDir?: string | null;
  selectedPath?: string | null;
  rootId?: string | null;
  managedRoots?: string[];
  fileMetas?: Record<string, FileMeta>;
  activeSessionKey?: string | null;
  onSelectFile?: (entry: FileEntry, rootId: string) => void;
  onToggleDir?: (entry: FileEntry, rootId: string) => void;
  onOpenSettings?: (rootId: string) => void;
};

const ChevronRight = ({ isOpen }: { isOpen: boolean }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{
      transform: isOpen ? "rotate(90deg)" : "rotate(0deg)",
      transition: "transform 0.15s cubic-bezier(0.4, 0, 0.2, 1)",
      color: isOpen ? "var(--text-primary)" : "#9ca3af",
    }}
  >
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

const getFileIcon = (filename: string) => {
  const ext = filename.split('.').pop()?.toLowerCase();
  const iconStyle = { minWidth: 16 };
  if (['js', 'ts', 'jsx', 'tsx'].includes(ext!)) return <span style={{...iconStyle, color: '#f7df1e'}}>JS</span>;
  if (['py'].includes(ext!)) return <span style={{...iconStyle, color: '#3776ab'}}>Py</span>;
  if (['go'].includes(ext!)) return <span style={{...iconStyle, color: '#00add8'}}>Go</span>;
  if (['html', 'css'].includes(ext!)) return <span style={{...iconStyle, color: '#e34f26'}}>网页</span>;
  if (['md'].includes(ext!)) return <span style={{...iconStyle, color: '#64748b'}}>M↓</span>;
  if (['pdf'].includes(ext!)) return <span style={{...iconStyle, color: '#ef4444'}}>PDF</span>;
  if (['txt'].includes(ext!)) return <span style={{...iconStyle, color: '#94a3b8'}}>TXT</span>;
  if (['png', 'jpg', 'jpeg', 'gif', 'svg'].includes(ext!)) return <span style={{...iconStyle, color: '#ec4899'}}>图</span>;
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={iconStyle}>
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
};

export function FileTree({
  entries,
  childrenByPath,
  expanded,
  selectedDir,
  selectedPath,
  rootId,
  managedRoots = [],
  fileMetas = {},
  activeSessionKey,
  onSelectFile,
  onToggleDir,
  onOpenSettings,
}: FileTreeProps) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    entry: null,
    rootId: null,
  });
  const menuRef = useRef<HTMLDivElement>(null);

  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, visible: false }));
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) closeContextMenu();
    };
    if (contextMenu.visible) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [contextMenu.visible, closeContextMenu]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, entry: FileEntry, entryRoot: string) => {
      if (!entry.is_dir) return;
      e.preventDefault();
      setContextMenu({ visible: true, x: e.clientX, y: e.clientY, entry, rootId: entryRoot });
    },
    []
  );

  const expandedSet = new Set(expanded);
  const managedSet = new Set(managedRoots);

  const childKeyFor = (entry: FileEntry, entryRoot: string) => {
    if (managedSet.has(entry.path)) return `${entry.path}:.`;
    return `${entryRoot}:${entry.path}`;
  };

  const renderEntries = (items: FileEntry[], depth: number, branchRoot: string) => (
    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {items.map((entry) => {
        const entryRoot = managedSet.has(entry.path) ? entry.path : branchRoot;
        const expandedKey = managedSet.has(entry.path) ? entry.path : `${entryRoot}:${entry.path}`;
        const isOpen = expandedSet.has(expandedKey);
        
        const cKey = childKeyFor(entry, entryRoot);
        const children = childrenByPath[cKey] ?? childrenByPath[entry.path] ?? [];
        
        // 关键修复：增加 rootId 匹配校验，防止不同 root 下同名目录同时高亮
        const isSelected = 
          entry.path === (entry.is_dir ? selectedDir : selectedPath) && 
          entryRoot === rootId;

        const meta = fileMetas[entry.path];
        const hasSessionLink = !entry.is_dir && meta?.source_session;
        const isFromActiveSession = hasSessionLink && meta.source_session === activeSessionKey;

        return (
          <li key={entry.path}>
            <button
              type="button"
              onClick={() => entry.is_dir ? onToggleDir?.(entry, entryRoot) : onSelectFile?.(entry, entryRoot)}
              onContextMenu={(e) => handleContextMenu(e, entry, entryRoot)}
              style={{
                border: "none",
                background: isSelected ? "rgba(59, 130, 246, 0.1)" : "transparent",
                cursor: "pointer",
                padding: "6px 8px",
                paddingLeft: 8 + depth * 16,
                display: "flex",
                alignItems: "center",
                gap: "4px",
                width: "100%",
                textAlign: "left",
                color: isSelected ? "var(--accent-color)" : "var(--text-primary)",
                fontSize: "13px",
                borderRadius: "6px",
                transition: "all 0.1s",
                fontWeight: isSelected ? 600 : 400,
                outline: "none",
              }}
              onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = "rgba(0,0,0,0.03)"; }}
              onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
            >
              <div style={{ width: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                 {entry.is_dir ? <ChevronRight isOpen={isOpen} /> : (
                   <div style={{ fontSize: '10px', fontWeight: 700, opacity: 0.8 }}>
                     {getFileIcon(entry.name)}
                   </div>
                 )}
              </div>
              <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1, marginLeft: "4px" }}>
                {entry.name}
              </span>
              {hasSessionLink && (
                <span style={{ fontSize: "10px", color: isFromActiveSession ? "#3b82f6" : "#9ca3af" }}>
                  {isFromActiveSession ? "◆" : "◇"}
                </span>
              )}
            </button>
            {entry.is_dir && isOpen && children.length > 0 ? renderEntries(children, depth + 1, entryRoot) : null}
          </li>
        );
      })}
    </ul>
  );

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ height: "36px", padding: "0 16px", borderBottom: "1px solid var(--border-color)", display: "flex", justifyContent: "space-between", alignItems: "center", boxSizing: "border-box", flexShrink: 0 }}>
        <h3 style={{ margin: 0, fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)", letterSpacing: "0.5px", textTransform: "uppercase" }}>Project</h3>
      </div>
      <div style={{ padding: "8px", flex: 1, overflow: "auto" }}>
        {renderEntries(entries, 0, rootId || "")}
      </div>

      {contextMenu.visible && contextMenu.entry && (
        <div ref={menuRef} style={{ position: "fixed", left: contextMenu.x, top: contextMenu.y, background: "#fff", border: "1px solid var(--border-color)", borderRadius: "8px", boxShadow: "0 4px 12px rgba(0,0,0,0.15)", padding: "4px 0", minWidth: "160px", zIndex: 1000 }}>
          <button type="button" onClick={() => { if (contextMenu.rootId) onOpenSettings?.(contextMenu.rootId); closeContextMenu(); }} style={{ display: "flex", alignItems: "center", gap: "8px", width: "100%", padding: "8px 12px", border: "none", background: "transparent", cursor: "pointer", fontSize: "13px", color: "var(--text-primary)", textAlign: "left" }}>
            <span>⚙️</span><span>目录设置</span>
          </button>
        </div>
      )}
    </div>
  );
}

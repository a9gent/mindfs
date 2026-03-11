import React from "react";

type FileEntry = {
  name: string;
  path: string;
  is_dir: boolean;
};

type DefaultListViewProps = {
  root?: string;
  path?: string;
  entries: FileEntry[];
  onItemClick?: (entry: FileEntry) => void;
  onPathClick?: (path: string) => void;
  onUploadFiles?: (files: File[]) => void | Promise<void>;
};

// 路径导航组件
function Breadcrumbs({ root, path, onPathClick }: { root?: string; path: string; onPathClick?: (path: string) => void }) {
  const normalizedPath = root && path.startsWith(root) ? path.slice(root.length).replace(/^\/+/, "") : path;
  const parts = normalizedPath.split('/').filter(Boolean);
  
  const getPathAt = (index: number) => {
    return parts.slice(0, index + 1).join('/');
  };

  return (
    <div style={{ 
      display: 'flex', 
      alignItems: 'center', 
      gap: '4px', 
      fontSize: '13px', 
      color: 'var(--text-secondary)',
      overflow: 'hidden',
      whiteSpace: 'nowrap',
      flex: 1,
      justifyContent: 'flex-start'
    }}>
      {root && (
        <>
          <span
            onClick={() => onPathClick?.(".")}
            style={{ fontWeight: 500, color: "var(--text-primary)", cursor: "pointer" }}
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
            onClick={() => onPathClick?.(getPathAt(index))}
            style={{ 
              fontWeight: index === parts.length - 1 ? 600 : 400,
              color: index === parts.length - 1 ? 'var(--text-primary)' : 'inherit',
              cursor: 'pointer',
              flexShrink: index === parts.length - 1 ? 0 : 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis'
            }}
            onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; }}
            onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}
          >
            {part}
          </span>
          {index < parts.length - 1 && (
            <span style={{ opacity: 0.4, fontSize: '10px', flexShrink: 0 }}>❯</span>
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

export function DefaultListView({ root, path = "", entries, onItemClick, onPathClick, onUploadFiles }: DefaultListViewProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "transparent" }}>
      <header
        style={{
          height: "36px",
          padding: "0 8px 0 16px",
          borderBottom: "1px solid var(--border-color)",
          display: "flex",
          alignItems: "center",
          background: "transparent",
          boxSizing: "border-box",
          zIndex: 10,
          flexShrink: 0
        }}
      >
        <div style={{ display: "flex", alignItems: "center", overflow: "hidden", flex: 1 }}>
          <Breadcrumbs root={root} path={path || ""} onPathClick={onPathClick} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexShrink: 0 }}>
          <div style={{ fontSize: "11px", color: "var(--text-secondary)", opacity: 0.6 }}>
            {entries.length} 个项目
          </div>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={!root}
            style={{
              width: "28px",
              height: "28px",
              borderRadius: "999px",
              border: "none",
              background: "transparent",
              color: "var(--text-secondary)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: root ? "pointer" : "not-allowed",
              opacity: root ? 1 : 0.45,
            }}
            title="上传到当前目录"
            aria-label="上传到当前目录"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(event) => {
              const files = Array.from(event.target.files || []);
              if (files.length > 0) {
                void onUploadFiles?.(files);
              }
              event.currentTarget.value = "";
            }}
          />
        </div>
      </header>

      <div style={{ flex: 1, overflow: "auto", padding: "24px 16px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "4px", width: "100%" }}>
          {entries.map((entry) => (
            <div
              key={entry.path}
              onClick={() => onItemClick?.(entry)}
              style={{
                background: "transparent",
                border: "1px solid transparent",
                borderRadius: "8px",
                padding: "6px 10px",
                display: "flex",
                alignItems: "center",
                gap: "8px",
                transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
                cursor: "pointer",
                transform: "translateZ(0)",
                willChange: "background-color",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "rgba(0, 0, 0, 0.03)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
            >
              <div
                style={{
                  width: "18px",
                  height: "18px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                {entry.is_dir ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-color)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2z"/></svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
                )}
              </div>
              <div style={{ minWidth: 0, fontWeight: 500, fontSize: "13px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: "var(--text-primary)" }}>
                {entry.name}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

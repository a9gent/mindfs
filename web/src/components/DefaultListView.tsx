import React from "react";

type FileEntry = {
  name: string;
  path: string;
  is_dir: boolean;
};

type DefaultListViewProps = {
  path?: string;
  entries: FileEntry[];
  onItemClick?: (entry: FileEntry) => void;
  onPathClick?: (path: string) => void;
};

// 路径导航组件
function Breadcrumbs({ path, onPathClick }: { path: string; onPathClick?: (path: string) => void }) {
  const parts = path.split('/').filter(Boolean);
  
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

export function DefaultListView({ path = "", entries, onItemClick, onPathClick }: DefaultListViewProps) {
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "transparent" }}>
      <header
        style={{
          height: "36px",
          padding: "0 16px",
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
          <span style={{ fontSize: "14px", marginRight: "8px", opacity: 0.6 }}>📂</span>
          <Breadcrumbs path={path || "Root"} onPathClick={onPathClick} />
        </div>
        <div style={{ fontSize: "11px", color: "var(--text-secondary)", opacity: 0.6 }}>
          {entries.length} 个项目
        </div>
      </header>

      <div style={{ flex: 1, overflow: "auto", padding: "32px 40px" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
            gap: "16px",
            width: "100%",
          }}
        >
          {entries.map((entry) => (
            <div
              key={entry.path}
              onClick={() => onItemClick?.(entry)}
              style={{
                background: "rgba(255, 255, 255, 0.6)",
                backdropFilter: "blur(5px)",
                border: "1px solid rgba(0, 0, 0, 0.05)",
                borderRadius: "12px",
                padding: "16px",
                display: "flex",
                flexDirection: "column",
                gap: "12px",
                transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
                cursor: "pointer",
                transform: "translateZ(0)",
                willChange: "transform, opacity",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = "translateY(-4px) translateZ(0)";
                e.currentTarget.style.background = "rgba(255, 255, 255, 0.9)";
                e.currentTarget.style.boxShadow = "0 12px 24px rgba(0,0,0,0.08)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = "translateY(0) translateZ(0)";
                e.currentTarget.style.background = "rgba(255, 255, 255, 0.6)";
                e.currentTarget.style.boxShadow = "none";
              }}
            >
              <div
                style={{
                  width: "40px",
                  height: "40px",
                  borderRadius: "10px",
                  background: entry.is_dir ? "rgba(59, 130, 246, 0.1)" : "rgba(0, 0, 0, 0.03)",
                  color: entry.is_dir ? "#3b82f6" : "#64748b",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "20px",
                }}
              >
                {entry.is_dir ? "📁" : "📄"}
              </div>
              
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontWeight: 600,
                    fontSize: "14px",
                    marginBottom: "4px",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    color: "var(--text-primary)"
                  }}
                >
                  {entry.name}
                </div>
                <div
                  style={{
                    fontSize: "11px",
                    color: "var(--text-secondary)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    opacity: 0.7
                  }}
                >
                  {entry.path}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

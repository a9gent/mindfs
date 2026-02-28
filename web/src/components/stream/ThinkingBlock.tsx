import React, { useEffect, useState } from "react";

type ThinkingBlockProps = {
  content: string;
  defaultExpanded?: boolean;
};

export function ThinkingBlock({ content, defaultExpanded = false }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  useEffect(() => {
    if (!defaultExpanded) {
      setExpanded(false);
    }
  }, [defaultExpanded]);

  if (!content) return null;

  return (
    <div
      style={{
        borderRadius: "8px",
        border: "1px solid rgba(139, 92, 246, 0.2)",
        background: "rgba(139, 92, 246, 0.05)",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: "6px",
          padding: "8px 10px",
          background: "none",
          border: "none",
          cursor: "pointer",
          fontSize: "12px",
          color: "#8b5cf6",
          fontWeight: 500,
          whiteSpace: "nowrap",
          overflow: "hidden",
        }}
      >
        <span style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.2s" }}>
          ▶
        </span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>思考过程</span>
        <span style={{ color: "var(--text-secondary)", fontWeight: 400, flexShrink: 0 }}>
          ({content.length} 字符)
        </span>
      </button>

      {expanded && (
        <div
          style={{
            padding: "0 10px 10px",
            fontSize: "12px",
            lineHeight: 1.5,
            color: "var(--text-secondary)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: "200px",
            overflow: "auto",
          }}
        >
          {content}
        </div>
      )}
    </div>
  );
}

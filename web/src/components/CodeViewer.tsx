import React, { memo, useEffect, useMemo, useRef } from "react";
import Prism from "prismjs";
import "prismjs/themes/prism.css";

// Import common languages
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-go";
import "prismjs/components/prism-python";
import "prismjs/components/prism-java";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-csharp";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-json";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-css";

const languageByExt: Record<string, string> = {
  ".js": "javascript",
  ".jsx": "jsx",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".go": "go",
  ".py": "python",
  ".java": "java",
  ".c": "c",
  ".cpp": "cpp",
  ".cs": "csharp",
  ".rs": "rust",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".html": "markup",
  ".css": "css",
  ".md": "markdown",
};

export function supportsLineSelection(ext?: string): boolean {
  if (!ext) return false;
  return Object.prototype.hasOwnProperty.call(languageByExt, ext.toLowerCase());
}

export const CodeViewer = memo(function CodeViewer({
  content,
  ext,
  targetLine,
  contentRef,
}: {
  content: string;
  ext?: string;
  targetLine?: number;
  targetColumn?: number;
  contentRef?: React.RefObject<HTMLElement | null>;
}) {
  const language = languageByExt[ext ?? ""] ?? "markup";
  const lineRefs = useRef<Array<HTMLDivElement | null>>([]);
  
  // 计算行数
  const lines = useMemo(() => content.split("\n"), [content]);
  
  const html = useMemo(() => {
    const grammar = Prism.languages[language] ?? Prism.languages.markup;
    return Prism.highlight(content, grammar, language);
  }, [content, language]);

  useEffect(() => {
    if (!targetLine || targetLine < 1) return;
    const target = lineRefs.current[targetLine - 1];
    if (!target) return;
    target.scrollIntoView({ block: "center", behavior: "auto" });
  }, [targetLine, content]);

  return (
    <div
      style={{
        display: "flex",
        margin: 0,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        fontSize: "13px",
        lineHeight: "20px",
        color: "var(--text-primary)",
        background: "transparent",
      }}
    >
      {/* 行号列 */}
      <div
        style={{
          padding: "24px 12px 24px 16px",
          textAlign: "right",
          color: "var(--text-secondary)",
          opacity: 0.4,
          userSelect: "none",
          borderRight: "1px solid rgba(0,0,0,0.05)",
          minWidth: "32px",
          background: "rgba(0,0,0,0.02)",
          flexShrink: 0,
        }}
      >
        {lines.map((_, i) => (
          <div
            key={i}
            ref={(node) => {
              lineRefs.current[i] = node;
            }}
            style={{
              color: targetLine === i + 1 ? "var(--accent-color)" : undefined,
              fontWeight: targetLine === i + 1 ? 600 : undefined,
            }}
          >
            {i + 1}
          </div>
        ))}
      </div>

      {/* 代码内容列 */}
      <div
        style={{
          position: "relative",
          flex: 1,
        }}
      >
        {targetLine && targetLine >= 1 && targetLine <= lines.length ? (
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: `${24 + (targetLine - 1) * 20}px`,
              height: "20px",
              background: "rgba(59, 130, 246, 0.08)",
              borderRadius: "4px",
              pointerEvents: "none",
            }}
          />
        ) : null}
        <pre
          style={{
            margin: 0,
            padding: "24px 8px", // 再次缩小左侧间距
            overflow: "visible",
            background: "transparent",
            position: "relative",
            zIndex: 1,
          }}
        >
        <code 
          ref={(node) => {
            if (contentRef) {
              contentRef.current = node;
            }
          }}
          style={{ whiteSpace: "pre", display: "block", border: "none", background: "transparent" }}
          dangerouslySetInnerHTML={{ __html: html }} 
        />
        </pre>
      </div>
    </div>
  );
});

import React, { useMemo } from "react";
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

export function CodeViewer({ content, ext }: { content: string; ext?: string }) {
  const language = languageByExt[ext ?? ""] ?? "markup";
  
  // 计算行数
  const lines = useMemo(() => content.split("\n"), [content]);
  
  const html = useMemo(() => {
    const grammar = Prism.languages[language] ?? Prism.languages.markup;
    return Prism.highlight(content, grammar, language);
  }, [content, language]);

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
        minHeight: "100%",
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
          <div key={i}>{i + 1}</div>
        ))}
      </div>

      {/* 代码内容列 */}
      <pre
        style={{
          margin: 0,
          padding: "24px 8px", // 再次缩小左侧间距
          overflow: "visible", 
          background: "transparent",
          flex: 1,
        }}
      >
        <code 
          style={{ whiteSpace: "pre" }}
          dangerouslySetInnerHTML={{ __html: html }} 
        />
      </pre>
    </div>
  );
}

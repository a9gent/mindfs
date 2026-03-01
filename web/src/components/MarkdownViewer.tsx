import React, { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import Prism from "prismjs";
import "prismjs/themes/prism.css";
// Reuse the language imports from global Prism context (since they are imported in CodeViewer, they might be available if loaded, 
// but strictly speaking we should import them here or centralize. For simplicity, we rely on the side-effects of CodeViewer imports 
// if both are used, or we re-import essential ones here to be safe)
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-json";

export function MarkdownViewer({ content }: { content: string }) {
  return (
    <div
      style={{
        padding: "0", // 移除内层 padding，由 FileViewer 统一控制
        color: "var(--text-primary)",
        lineHeight: 1.75,
        fontSize: "15px",
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          h1: (props) => (
            <h1 style={{ fontSize: "24px", marginTop: 0 }} {...props} />
          ),
          h2: (props) => (
            <h2 style={{ fontSize: "20px" }} {...props} />
          ),
          blockquote: (props) => (
            <blockquote style={{ 
              borderLeft: "3px solid var(--accent-color)", 
              margin: "1.5em 0", 
              paddingLeft: "16px", 
              color: "var(--text-secondary)",
              fontStyle: "italic",
              background: "rgba(0,0,0,0.02)",
              padding: "12px 16px",
              borderRadius: "0 8px 8px 0"
            }} {...props} />
          ),
          code({ node, inline, className, children, ...props }: any) {
            const match = /language-(\w+)/.exec(className || "");
            const language = match ? match[1] : "";
            
            if (!inline && language) {
               // Render block code with highlight
               const codeContent = String(children).replace(/\n$/, "");
               const grammar = Prism.languages[language] ?? Prism.languages.markup;
               let html = codeContent;
               try { html = Prism.highlight(codeContent, grammar, language); } catch (e) {}

               return (
                 <pre
                    style={{
                      background: "rgba(0,0,0,0.04)", 
                      padding: "16px", 
                      borderRadius: "10px", 
                      overflow: "auto",
                      border: "1px solid var(--border-color)",
                      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
                      fontSize: "13px",
                      margin: "1.5em 0",
                      lineHeight: "1.6",
                      boxShadow: "none" // 强制移除阴影
                    }}
                 >
                   <code 
                      className={className} 
                      dangerouslySetInnerHTML={{ __html: html }}
                      style={{ textShadow: "none" }} // 强制移除文字阴影
                      {...props} 
                   />
                 </pre>
               );
            }

            return (
              <code
                className={className}
                style={{
                  background: "rgba(0,0,0,0.05)",
                  padding: "2px 4px",
                  borderRadius: "4px",
                  color: "inherit",
                  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
                  fontSize: "0.9em",
                }}
                {...props}
              >
                {children}
              </code>
            );
          },
          pre: (props) => (
            // The 'code' component handles the <pre> wrapper for blocks usually, 
            // but react-markdown passes <pre> then <code>. We override <code> above.
            // So here we just pass through or strip the outer pre if we want full control in <code>.
            // However, react-markdown default behavior puts the class on <code>.
            // So we can leave <pre> as a simple wrapper or just <>{children}</> if we style in code.
            // Let's keep it simple:
            <>{props.children}</> 
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
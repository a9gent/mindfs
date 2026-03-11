import React, { memo, useEffect, useMemo, useRef } from "react";
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

const monoFontFamily = [
  '"SFMono-Regular"',
  '"Cascadia Mono"',
  '"Sarasa Mono SC"',
  '"Noto Sans Mono CJK SC"',
  '"Source Han Mono SC"',
  'Menlo',
  'Monaco',
  '"Courier New"',
  'monospace',
].join(", ");

function normalizePosixPath(input: string): string {
  const absolute = input.startsWith("/");
  const parts = input.split("/").filter((part) => part && part !== ".");
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      normalized.pop();
      continue;
    }
    normalized.push(part);
  }
  return absolute ? `/${normalized.join("/")}` : normalized.join("/");
}

function dirnamePosix(input: string): string {
  const normalized = normalizePosixPath(input.replace(/\\/g, "/"));
  if (!normalized || !normalized.includes("/")) return ".";
  const parts = normalized.split("/");
  parts.pop();
  return parts.join("/") || ".";
}

function resolveMarkdownHref(currentPath: string, href: string): string {
  const trimmed = href.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("file://")) {
    return decodeURIComponent(trimmed.slice("file://".length));
  }
  if (trimmed.startsWith("/")) {
    return trimmed.replace(/^\/+/, "");
  }
  const baseDir = currentPath ? dirnamePosix(currentPath) : ".";
  return normalizePosixPath(`${baseDir}/${trimmed}`);
}

function isExternalHref(href: string): boolean {
  return /^(https?:|mailto:|tel:)/i.test(href);
}

function MarkdownViewerInner({
  content,
  currentPath = "",
  onFileClick,
  targetLine,
}: {
  content: string;
  currentPath?: string;
  onFileClick?: (path: string) => void;
  targetLine?: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onFileClickRef = useRef(onFileClick);
  const sourceLineSelector = useMemo(() => {
    if (!targetLine || targetLine < 1) return "";
    return "[data-source-line]";
  }, [targetLine]);

  useEffect(() => {
    onFileClickRef.current = onFileClick;
  }, [onFileClick]);

  useEffect(() => {
    if (!targetLine || targetLine < 1 || !containerRef.current || !sourceLineSelector) {
      return;
    }
    const elements = Array.from(containerRef.current.querySelectorAll<HTMLElement>(sourceLineSelector));
    if (elements.length === 0) return;
    let target: HTMLElement | null = null;
    for (const el of elements) {
      const line = Number.parseInt(el.dataset.sourceLine || "", 10);
      if (!Number.isFinite(line)) continue;
      if (line <= targetLine) {
        target = el;
        continue;
      }
      break;
    }
    (target || elements[0]).scrollIntoView({ block: "center", behavior: "auto" });
  }, [content, sourceLineSelector, targetLine]);

  const getSourceLineProps = (node: any): Record<string, string> => {
    const line = node?.position?.start?.line;
    if (!Number.isFinite(line)) return {};
    return { "data-source-line": String(line) };
  };

  return (
    <div
      ref={containerRef}
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
          h1: ({ node, ...props }: any) => (
            <h1 style={{ fontSize: "24px", marginTop: 0 }} {...getSourceLineProps(node)} {...props} />
          ),
          h2: ({ node, ...props }: any) => (
            <h2 style={{ fontSize: "20px" }} {...getSourceLineProps(node)} {...props} />
          ),
          h3: ({ node, ...props }: any) => (
            <h3 style={{ fontSize: "17px", marginTop: "1.25em" }} {...getSourceLineProps(node)} {...props} />
          ),
          p: ({ node, ...props }: any) => (
            <p style={{ margin: "0 0 1em", whiteSpace: "normal" }} {...getSourceLineProps(node)} {...props} />
          ),
          ul: ({ node, ...props }: any) => (
            <ul style={{ margin: "0 0 1em", paddingLeft: "1.4em" }} {...getSourceLineProps(node)} {...props} />
          ),
          ol: ({ node, ...props }: any) => (
            <ol style={{ margin: "0 0 1em", paddingLeft: "1.4em" }} {...getSourceLineProps(node)} {...props} />
          ),
          li: (props) => (
            <li style={{ margin: "0.2em 0" }} {...props} />
          ),
          a: ({ href = "", children, ...props }) => {
            if (!href || href.startsWith("#") || isExternalHref(href) || !onFileClick) {
              return (
                <a
                  href={href}
                  style={{ color: "var(--accent-color)" }}
                  {...props}
                >
                  {children}
                </a>
              );
            }
            const resolvedPath = resolveMarkdownHref(currentPath, href);
            return (
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  if (resolvedPath) {
                    onFileClickRef.current?.(resolvedPath);
                  }
                }}
                style={{ color: "var(--accent-color)", cursor: "pointer" }}
                {...props}
              >
                {children}
              </a>
            );
          },
          table: ({ node, ...props }: any) => (
            <div
              {...getSourceLineProps(node)}
              style={{
                width: "100%",
                overflowX: "auto",
                margin: "1.25em 0",
                border: "1px solid var(--border-color)",
                borderRadius: "10px",
                background: "rgba(0,0,0,0.02)",
              }}
            >
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: "14px",
                  lineHeight: 1.6,
                  minWidth: "520px",
                }}
                {...props}
              />
            </div>
          ),
          thead: (props) => (
            <thead
              style={{
                background: "rgba(0,0,0,0.04)",
              }}
              {...props}
            />
          ),
          tr: (props) => (
            <tr
              style={{
                borderBottom: "1px solid var(--border-color)",
              }}
              {...props}
            />
          ),
          th: (props) => (
            <th
              style={{
                padding: "10px 12px",
                textAlign: "left",
                fontWeight: 600,
                whiteSpace: "nowrap",
                verticalAlign: "top",
              }}
              {...props}
            />
          ),
          td: (props) => (
            <td
              style={{
                padding: "10px 12px",
                verticalAlign: "top",
                borderTop: "1px solid rgba(0,0,0,0.03)",
              }}
              {...props}
            />
          ),
          blockquote: ({ node, ...props }: any) => (
            <blockquote style={{ 
              borderLeft: "3px solid var(--accent-color)", 
              margin: "1.5em 0", 
              paddingLeft: "16px", 
              color: "var(--text-secondary)",
              fontStyle: "italic",
              background: "rgba(0,0,0,0.02)",
              padding: "12px 16px",
              borderRadius: "0 8px 8px 0"
            }} {...getSourceLineProps(node)} {...props} />
          ),
          code({ className, children, ...props }: any) {
            return (
              <code
                className={className}
                style={{
                  background: "rgba(0,0,0,0.05)",
                  padding: "2px 4px",
                  borderRadius: "4px",
                  color: "inherit",
                  fontFamily: monoFontFamily,
                  fontSize: "0.9em",
                }}
                {...props}
              >
                {children}
              </code>
            );
          },
          pre: ({ node, children }: any) => {
            const codeElement = React.Children.only(children) as React.ReactElement<any>;
            const className = codeElement?.props?.className || "";
            const rawContent = String(codeElement?.props?.children ?? "").replace(/\n$/, "");
            const match = /language-(\w+)/.exec(className);
            const language = match ? match[1] : "";
            let html = "";
            if (language) {
              const grammar = Prism.languages[language] ?? Prism.languages.markup;
              try {
                html = Prism.highlight(rawContent, grammar, language);
              } catch {
                html = "";
              }
            }
            return (
              <pre
                className={className}
                {...getSourceLineProps(node)}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  background: "rgba(0,0,0,0.04)",
                  padding: "16px",
                  borderRadius: "10px",
                  overflow: "auto",
                  border: "1px solid var(--border-color)",
                  fontFamily: monoFontFamily,
                  fontSize: "13px",
                  margin: "1.5em 0",
                  lineHeight: "1.6",
                  whiteSpace: "pre",
                  tabSize: 2 as any,
                  fontVariantLigatures: "none",
                  boxShadow: "none",
                }}
              >
                {html ? (
                  <code
                    className={className}
                    dangerouslySetInnerHTML={{ __html: html }}
                    style={{ display: "block", textShadow: "none", fontFamily: monoFontFamily, border: "none", background: "transparent" }}
                  />
                ) : (
                  <code
                    className={className}
                    style={{
                      display: "block",
                      textShadow: "none",
                      fontFamily: monoFontFamily,
                      tabSize: 2 as any,
                      fontVariantLigatures: "none",
                      whiteSpace: "pre",
                      border: "none",
                      background: "transparent",
                    }}
                  >
                    {rawContent}
                  </code>
                )}
              </pre>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export const MarkdownViewer = memo(MarkdownViewerInner, (prev, next) => (
  prev.content === next.content &&
  prev.currentPath === next.currentPath &&
  prev.targetLine === next.targetLine
));

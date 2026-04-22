import React, { memo, useEffect, useMemo, useState } from "react";
import type { ToolCallContentItem, ToolCallLocation } from "../../services/session";
import { MarkdownViewer } from "../MarkdownViewer";

type ToolCallCardProps = {
  kind?: string;
  title?: string;
  callId: string;
  status: string;
  content?: ToolCallContentItem[];
  result?: string;
  locations?: ToolCallLocation[];
  rootPath?: string;
  defaultExpanded?: boolean;
};

type DetailSection =
  | { type: "diff"; path: string; markdown: string }
  | { type: "text"; markdown: string };

function basename(path: string): string {
  const normalized = (path || "").replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || path;
}

const toolIcons: Record<string, string> = {
  delete: "🗑️",
  move: "📦",
  think: "💭",
  fetch: "🌐",
  ask_user: "❓",
  todo: "✅",
  switch_mode: "🔁",
  other: "🔧",
};

function renderToolIcon(kind: string): React.ReactNode {
  if (kind === "read") {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 32 32" aria-hidden="true" style={{ color: "#2f80ed" }}>
        <path fill="currentColor" d="M5 6C3.346 6 2 7.346 2 9v12c0 1.654 1.346 3 3 3l6.184-.02c.99 0 1.949.31 2.773.86L16 26.2l2.043-1.361a5 5 0 0 1 2.773-.84H27c1.654 0 3-1.346 3-3V9c0-1.654-1.346-3-3-3h-6.184c-1.386 0-2.73.408-3.882 1.176L16 7.799l-.934-.623A7 7 0 0 0 11.184 6zm0 2h6.184c.99 0 1.949.29 2.773.84L16 10.2l2.043-1.361A5 5 0 0 1 20.816 8H27c.552 0 1 .449 1 1v12c0 .551-.448 1-1 1h-6.184c-1.386 0-2.73.408-3.882 1.176l-.934.623l-.934-.623A7 7 0 0 0 11.184 22H5c-.552 0-1-.449-1-1V9c0-.551.448-1 1-1m1 4v2h8v-2zm12 0v2h8v-2zM6 16v2h8v-2zm12 0v2h8v-2z"/>
      </svg>
    );
  }
  if (kind === "task") {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <path
          fill="none"
          stroke="#7dc4e4"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M14.5 11.752L8 15.5l-6.5-3.752l.002-7.5L8 .5l6.5 3.752zM1.5 4.25L8 8m6.5-3.75L8 8m.003 0v7.5"
          strokeWidth="1"
        />
      </svg>
    );
  }
  if (kind === "todo") {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
        <path fill="#3f51b5" d="m17.8 18.1l-7.4 7.3l-4.2-4.1L4 23.5l6.4 6.4l9.6-9.6zm0-13l-7.4 7.3l-4.2-4.1L4 10.5l6.4 6.4L20 7.3zm0 26l-7.4 7.3l-4.2-4.1L4 36.5l6.4 6.4l9.6-9.6z" />
        <path fill="#90caf9" d="M24 22h20v4H24zm0-13h20v4H24zm0 26h20v4H24z" />
      </svg>
    );
  }
  if (kind === "ask_user") {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" style={{ color: "#ef4444" }}>
        <g fill="currentColor">
          <path d="M8 11a.75.75 0 1 1 0 1.5a.75.75 0 0 1 0-1.5m0-7c1.262 0 2.25.988 2.25 2.25c0 1.083-.566 1.648-1.021 2.104c-.408.407-.729.728-.729 1.396a.5.5 0 0 1-1 0c0-1.083.566-1.648 1.021-2.104c.408-.407.729-.728.729-1.396C9.25 5.538 8.712 5 8 5s-1.25.538-1.25 1.25a.5.5 0 0 1-1 0C5.75 4.988 6.738 4 8 4" />
          <path fillRule="evenodd" d="M8 1a7 7 0 0 1 6.999 7.001a7 7 0 0 1-10.504 6.06l-2.728.91a.582.582 0 0 1-.744-.714l.83-2.906A7 7 0 0 1 8 1m.001 1.001c-3.308 0-6 2.692-6 6c0 1.003.252 1.996.73 2.871l.196.36l-.726 2.54l1.978-.659l.428-.143l.39.226A6 6 0 0 0 8 14l.001.001c3.308 0 6-2.692 6-6s-2.692-6-6-6" clipRule="evenodd" />
        </g>
      </svg>
    );
  }
  if (kind === "search" || kind === "web_search") {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 50 50" aria-hidden="true">
        <g fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path stroke="#344054" strokeWidth="2" d="M41.667 41.667L31.146 31.146" />
          <path stroke="#344054" strokeWidth="3" d="m42.708 42.708l-7.291-7.291" />
          <path stroke="#306cfe" strokeWidth="2" d="M20.833 35.417c8.055 0 14.584-6.53 14.584-14.584S28.887 6.25 20.833 6.25S6.25 12.78 6.25 20.833c0 8.055 6.53 14.584 14.583 14.584" />
        </g>
      </svg>
    );
  }
  if (kind === "edit") {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 80 80" aria-hidden="true">
        <g fill="none">
          <path fill="#2f80ed" d="M38.4 22.742a2 2 0 1 0 0-4zm23.6 19.6a2 2 0 1 0-4 0zm-52-19.6v44h4v-44zm4 48h44v-4H14zm24.4-52H14v4h24.4zm23.6 48v-24.4h-4v24.4zm-4 4a4 4 0 0 0 4-4h-4zm-48-4a4 4 0 0 0 4 4v-4zm4-44v-4a4 4 0 0 0-4 4z" />
          <path fill="#9b51e0" fillRule="evenodd" d="M68.015 21.897c.78-.78.78-2.044 0-2.824l-5.657-5.657a2.003 2.003 0 0 0-2.833 0L30.7 42.242a16 16 0 0 0-4.555 9.267l-.308 2.384l-.125.974a.758.758 0 0 0 .848.849l.975-.126l2.384-.307a16 16 0 0 0 9.266-4.555z" clipRule="evenodd" />
          <path stroke="#f2c94c" strokeLinejoin="round" strokeWidth="4" d="m52.147 20.804l8.48 8.48" />
        </g>
      </svg>
    );
  }
  if (kind === "execute") {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 80 80" aria-hidden="true">
        <g fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth="4">
          <path stroke="#9b51e0" d="m15 24l17.16 15.253a1 1 0 0 1 0 1.494L15 56" />
          <path stroke="#2f80ed" d="M65 56H41" />
        </g>
      </svg>
    );
  }
  return toolIcons[kind] || toolIcons.other;
}

const statusColors: Record<string, string> = {
  running: "#f59e0b",
  in_progress: "#f59e0b",
  complete: "#22c55e",
  success: "#22c55e",
  failed: "#ef4444",
  error: "#ef4444",
};

export const ToolCallCard = memo(function ToolCallCard({
  kind,
  title,
  callId: _callId,
  status,
  content,
  result,
  locations,
  rootPath,
  defaultExpanded = false,
}: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const labelKind = (kind || "").trim();
  const labelTitle = (title || "").trim();
  const hasContent = !!(content && content.length > 0);
  const hasLocations = !!(locations && locations.length > 0);
  const hasResult = !!result;
  const hasDetails = hasContent || hasLocations || hasResult;
  const normalizedKind = labelKind.toLowerCase();
  const icon = renderToolIcon(normalizedKind);
  const normalizedStatus = (status || "").toLowerCase();
  const detailSections = useMemo(() => buildDetailSections(content, locations, rootPath), [content, locations, rootPath]);
  const isFileChange =
    normalizedKind === "edit" ||
    normalizedKind === "delete" ||
    normalizedKind === "move" ||
    detailSections.some((section) => section.type === "diff");
  const fileNames = useMemo(() => {
    const diffNames = detailSections
      .filter((section): section is Extract<DetailSection, { type: "diff" }> => section.type === "diff")
      .map((section) => basename(section.path))
      .filter(Boolean);
    const locationNames = (locations || [])
      .map((loc) => basename(normalizeDisplayPath(loc.path, rootPath)))
      .filter(Boolean);
    return Array.from(new Set([...diffNames, ...locationNames]));
  }, [detailSections, locations, rootPath]);
  const label = isFileChange
    ? labelKind || "edit"
    : [labelKind, labelTitle].filter(Boolean).join(" ").trim() || labelKind || labelTitle || "tool";
  const isRunning = normalizedStatus === "running" || normalizedStatus === "in_progress";
  const isComplete = normalizedStatus === "complete" || normalizedStatus === "success";
  const isFailed = normalizedStatus === "failed" || normalizedStatus === "error";
  const hasStructuredDetails = detailSections.length > 0;
  useEffect(() => {
    if (!isRunning || !hasDetails) {
      setExpanded(false);
    }
  }, [hasDetails, isRunning]);
  
  const statusColor = statusColors[normalizedStatus] || "#9ca3af";

  return (
    <div
      style={{
        width: "100%",
        minWidth: 0,
        borderRadius: "10px",
        border: isFileChange ? "1px solid rgba(59, 130, 246, 0.22)" : "1px solid var(--border-color)",
        background: isFileChange
          ? "linear-gradient(180deg, rgba(59, 130, 246, 0.08), rgba(59, 130, 246, 0.03))"
          : "var(--content-bg)",
        boxShadow: isFileChange ? "inset 0 1px 0 rgba(255,255,255,0.35)" : "none",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={hasDetails ? () => setExpanded(!expanded) : undefined}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-start",
          padding: "6px 8px",
          background: isFileChange ? "rgba(59, 130, 246, 0.04)" : "none",
          border: "none",
          cursor: hasDetails ? "pointer" : "default",
          fontSize: "12px",
          gap: "6px",
          minWidth: 0,
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: "6px", minWidth: 0, flex: 1 }}>
          <span>{icon}</span>
          <span style={{ fontWeight: 500, color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {label}
          </span>
          {isFileChange ? (
            <span
              style={{
                minWidth: 0,
                padding: "1px 6px",
                borderRadius: "999px",
                background: "rgba(37, 99, 235, 0.10)",
                color: "#1d4ed8",
                fontSize: "10px",
                fontWeight: 600,
                letterSpacing: "0.02em",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {fileNames.join(" ")}
            </span>
          ) : null}
        </span>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: "3px",
            flexShrink: 0,
            whiteSpace: "nowrap",
          }}
        >
          {isRunning && (
            <span
              style={{
                width: "6px",
                height: "6px",
                borderRadius: "50%",
                background: "#f59e0b",
                animation: "pulse 1s infinite",
              }}
            />
          )}
          {isFailed && (
            <span style={{ color: statusColor, fontSize: "12px", lineHeight: 1 }}>
              ✕
            </span>
          )}
        </span>
        {hasDetails && (
          <span
            style={{
              flexShrink: 0,
              transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
              transition: "transform 0.2s",
              color: "var(--text-secondary)",
              display: "inline-flex",
              alignItems: "center",
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </span>
        )}
      </button>

      {expanded && hasDetails && (
        <div
          style={{
            padding: "0 10px 10px",
            borderTop: "1px solid var(--border-color)",
            maxHeight: "min(60vh, 720px)",
            overflowY: "auto",
          }}
        >
          {hasStructuredDetails ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "14px", marginTop: "10px" }}>
              {detailSections.map((section, index) => (
                <div key={`${section.type}-${index}`} style={{ minWidth: 0 }}>
                  {section.type === "diff" ? (
                    <>
                      <div
                        style={{
                          marginBottom: "6px",
                          fontSize: "12px",
                          fontWeight: 600,
                          color: "var(--text-primary)",
                          wordBreak: "break-all",
                        }}
                      >
                        {section.path}
                      </div>
                      <MarkdownViewer content={section.markdown} />
                    </>
                  ) : (
                    <MarkdownViewer content={section.markdown} />
                  )}
                </div>
              ))}
            </div>
          ) : hasLocations ? (
            <div
              style={{
                marginTop: "10px",
                fontSize: "11px",
                color: "var(--text-secondary)",
                display: "flex",
                flexDirection: "column",
                gap: "2px",
                minWidth: 0,
              }}
            >
              {locations!.slice(0, 3).map((loc, idx) => (
                <div
                  key={`${loc.path}-${loc.line ?? 0}-${idx}`}
                  style={{ wordBreak: "break-all", whiteSpace: "normal" }}
                >
                  {normalizeDisplayPath(loc.path, rootPath)}
                  {typeof loc.line === "number" ? `:${loc.line}` : ""}
                </div>
              ))}
              {locations!.length > 3 && <div>... +{locations!.length - 3} 处</div>}
            </div>
          ) : null}
          {!hasStructuredDetails && hasResult && <MarkdownViewer content={result || ""} />}
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  );
});

function prefixDiffLines(text: string, prefix: "+" | "-"): string[] {
  return text.split("\n").map((line) => `${prefix}${line}`);
}

function renderStructuredDiff(path: string, oldText?: string, newText?: string): string {
  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`];
  if (typeof oldText === "string" && oldText !== "") {
    lines.push(...prefixDiffLines(oldText, "-"));
  }
  if (typeof newText === "string" && newText !== "") {
    lines.push(...prefixDiffLines(newText, "+"));
  }
  return `~~~diff\n${lines.join("\n")}\n~~~`;
}

function renderAddedText(path: string, text: string): string {
  return renderStructuredDiff(path, undefined, text);
}

function renderDeletedText(path: string, text: string): string {
  return renderStructuredDiff(path, text, undefined);
}

function isDiffLikeText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/^(```|~~~)/.test(trimmed)) return false;
  return /^(diff --git|index |--- |\+\+\+ |@@ )/m.test(trimmed);
}

function extractDiffPath(text: string, fallbackPath = "(unknown)"): string {
  const lines = text.split("\n");
  for (const line of lines) {
    const match = line.match(/^\+\+\+\s+(?:b\/)?(.+)$/);
    if (match?.[1]) return match[1].trim();
  }
  for (const line of lines) {
    const match = line.match(/^diff --git a\/.+ b\/(.+)$/);
    if (match?.[1]) return match[1].trim();
  }
  return fallbackPath;
}

function normalizeDisplayPath(path: string, rootPath?: string): string {
  const normalizedPath = (path || "").replace(/\\/g, "/").trim();
  const normalizedRoot = (rootPath || "").replace(/\\/g, "/").replace(/\/+$/g, "").trim();
  if (!normalizedPath || !normalizedRoot) {
    return path;
  }
  if (normalizedPath === normalizedRoot) {
    return ".";
  }
  if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }
  return path;
}

function buildDetailSections(content?: ToolCallContentItem[], locations?: ToolCallLocation[], rootPath?: string): DetailSection[] {
  if (!content || content.length === 0) return [];
  const sections: DetailSection[] = [];
  let locationIndex = 0;
  for (const item of content) {
    if (item.type === "diff") {
      const path = normalizeDisplayPath(item.path || locations?.[locationIndex]?.path || "(unknown)", rootPath);
      sections.push({ type: "diff", path, markdown: renderStructuredDiff(path, item.oldText, item.newText) });
      locationIndex += 1;
      continue;
    }
    if (item.type === "text" && item.text?.trim()) {
      const fallbackPath = normalizeDisplayPath(locations?.[locationIndex]?.path || "(unknown)", rootPath);
      const path = normalizeDisplayPath(item.path || fallbackPath, rootPath);
      if (item.changeKind === "add") {
        sections.push({ type: "diff", path, markdown: renderAddedText(path, item.text) });
        locationIndex += 1;
        continue;
      }
      if (item.changeKind === "delete") {
        sections.push({ type: "diff", path, markdown: renderDeletedText(path, item.text) });
        locationIndex += 1;
        continue;
      }
      if (isDiffLikeText(item.text)) {
        sections.push({
          type: "diff",
          path: normalizeDisplayPath(extractDiffPath(item.text, fallbackPath), rootPath),
          markdown: `~~~diff\n${item.text.trim()}\n~~~`,
        });
        locationIndex += 1;
      } else {
        sections.push({ type: "text", markdown: item.text });
      }
    }
  }
  return sections;
}

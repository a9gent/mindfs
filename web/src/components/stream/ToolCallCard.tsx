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
  read: "📖",
  edit: "📝",
  delete: "🗑️",
  move: "📦",
  search: "🔎",
  execute: "⌨️",
  think: "💭",
  fetch: "🌐",
  switch_mode: "🔁",
  other: "🔧",
};

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
  const icon = toolIcons[normalizedKind] || toolIcons.other;
  const normalizedStatus = (status || "").toLowerCase();
  const detailSections = useMemo(() => buildDetailSections(content, locations, rootPath), [content, locations, rootPath]);
  const isFileChange =
    normalizedKind === "edit" ||
    normalizedKind === "delete" ||
    normalizedKind === "move" ||
    detailSections.some((section) => section.type === "diff");
  const fileNames = useMemo(() => {
    const names = detailSections
      .filter((section): section is Extract<DetailSection, { type: "diff" }> => section.type === "diff")
      .map((section) => basename(section.path))
      .filter(Boolean);
    return Array.from(new Set(names));
  }, [detailSections]);
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

import React from "react";
import type { GitDiffPayload } from "../services/git";
import { rootBadgeStyle } from "./rootBadgeStyle";

type GitDiffViewerProps = {
  diff: GitDiffPayload;
  root?: string | null;
  onPathClick?: (path: string) => void;
  onSessionClick?: (sessionKey: string) => void;
  onSelectionChange?: (selection: {
    filePath: string;
    text?: string;
    startLine?: number;
    endLine?: number;
  } | null) => void;
};

type RelatedSession = {
  source_session: string;
  session_name?: string;
  agent?: string;
  created_at?: string;
  updated_at?: string;
};

function Breadcrumbs({ root, path, onPathClick }: { root?: string | null; path: string; onPathClick?: (path: string) => void }) {
  const parts = path.split("/").filter(Boolean);
  const getPathAt = (index: number) => parts.slice(0, index + 1).join("/");

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "13px", color: "var(--text-secondary)", overflow: "hidden", whiteSpace: "nowrap", flexShrink: 1, justifyContent: "flex-start" }}>
      {root ? (
        <>
          <span
            onClick={() => onPathClick?.(".")}
            style={{
              ...rootBadgeStyle,
              overflow: "hidden",
              textOverflow: "ellipsis",
              cursor: "pointer",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.textDecoration = "underline"; }}
            onMouseLeave={(e) => { e.currentTarget.style.textDecoration = "none"; }}
          >
            {root}
          </span>
          {parts.length > 0 ? <span style={{ opacity: 0.4, fontSize: "10px", flexShrink: 0 }}>❯</span> : null}
        </>
      ) : null}
      {parts.map((part, index) => (
        <React.Fragment key={`${part}-${index}`}>
          <span
            onClick={() => index < parts.length - 1 && onPathClick?.(getPathAt(index))}
            style={{
              fontWeight: index === parts.length - 1 ? 600 : 400,
              color: index === parts.length - 1 ? "var(--text-primary)" : "inherit",
              cursor: index < parts.length - 1 ? "pointer" : "default",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            onMouseEnter={(e) => { if (index < parts.length - 1) e.currentTarget.style.textDecoration = "underline"; }}
            onMouseLeave={(e) => { e.currentTarget.style.textDecoration = "none"; }}
          >
            {part}
          </span>
          {index < parts.length - 1 ? <span style={{ opacity: 0.4, fontSize: "10px", flexShrink: 0 }}>❯</span> : null}
        </React.Fragment>
      ))}
    </div>
  );
}

function renderLineStat(value: number, prefix: "+" | "-"): React.ReactNode {
  const color = prefix === "+" ? "#15803d" : "#b91c1c";
  return (
    <span style={{ color, fontVariantNumeric: "tabular-nums" }}>
      {prefix}{value}
    </span>
  );
}

function renderStatusLabel(status: string): string {
  if (status === "??") {
    return "U";
  }
  return status;
}

type DiffLine = {
  kind: "hunk" | "add" | "del" | "ctx";
  text: string;
  oldLine?: number;
  newLine?: number;
};

function buildDiffLines(content: string): DiffLine[] {
  const source = String(content || "").split("\n");
  const filtered = source.filter((line) => !/^(diff --git|index |--- |\+\+\+ )/.test(line));
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  filtered.forEach((line) => {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      oldLine = Number.parseInt(hunkMatch[1], 10) || 0;
      newLine = Number.parseInt(hunkMatch[2], 10) || 0;
      lines.push({ kind: "hunk", text: line });
      return;
    }
    if (/^\+[^+]/.test(line)) {
      lines.push({ kind: "add", text: line.slice(1), newLine });
      newLine += 1;
      return;
    }
    if (/^-[^-]/.test(line)) {
      lines.push({ kind: "del", text: line.slice(1), oldLine });
      oldLine += 1;
      return;
    }
    lines.push({
      kind: "ctx",
      text: line.startsWith(" ") ? line.slice(1) : line,
      oldLine: oldLine || undefined,
      newLine: newLine || undefined,
    });
    if (oldLine > 0) {
      oldLine += 1;
    }
    if (newLine > 0) {
      newLine += 1;
    }
  });

  return lines;
}

function lineBackground(kind: DiffLine["kind"]): string {
  switch (kind) {
    case "add":
      return "rgba(34, 197, 94, 0.14)";
    case "del":
      return "rgba(239, 68, 68, 0.14)";
    case "hunk":
      return "rgba(59, 130, 246, 0.10)";
    default:
      return "transparent";
  }
}

function lineColor(kind: DiffLine["kind"]): string {
  switch (kind) {
    case "add":
      return "#166534";
    case "del":
      return "#991b1b";
    case "hunk":
      return "#1d4ed8";
    default:
      return "var(--text-primary)";
  }
}

function displayLineNumber(line: DiffLine): string {
  if (line.kind === "add" && typeof line.newLine === "number") {
    return String(line.newLine);
  }
  return "";
}

function normalizeRelatedSessions(raw: unknown): RelatedSession[] {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const normalized = list.map((item) => {
    if (!item || typeof item !== "object") return null;
    const value = item as Record<string, unknown>;
    const source = (typeof value.source_session === "string" && value.source_session)
      || (typeof value.sourceSession === "string" && value.sourceSession)
      || (typeof value.session_key === "string" && value.session_key)
      || "";
    if (!source) return null;
    return {
      source_session: source,
      session_name: (typeof value.session_name === "string" && value.session_name) || undefined,
      agent: typeof value.agent === "string" ? value.agent : undefined,
      created_at: typeof value.created_at === "string" ? value.created_at : undefined,
      updated_at: typeof value.updated_at === "string" ? value.updated_at : undefined,
    };
  }).filter((value): value is RelatedSession => Boolean(value));
  const dedup = new Map<string, RelatedSession>();
  normalized.forEach((item) => {
    const existing = dedup.get(item.source_session);
    if (!existing) {
      dedup.set(item.source_session, item);
      return;
    }
    const existingTime = Date.parse(existing.updated_at || existing.created_at || "") || 0;
    const itemTime = Date.parse(item.updated_at || item.created_at || "") || 0;
    if (itemTime >= existingTime) {
      dedup.set(item.source_session, item);
    }
  });
  return Array.from(dedup.values()).sort((left, right) => {
    const leftTime = Date.parse(left.updated_at || left.created_at || "") || 0;
    const rightTime = Date.parse(right.updated_at || right.created_at || "") || 0;
    return rightTime - leftTime;
  });
}

export function GitDiffViewer({ diff, root, onPathClick, onSessionClick, onSelectionChange }: GitDiffViewerProps) {
  const lines = React.useMemo(() => buildDiffLines(diff.content), [diff.content]);
  const relatedSessions = React.useMemo(() => normalizeRelatedSessions(diff.file_meta), [diff.file_meta]);
  const visibleRelatedSessions = relatedSessions.slice(0, 3);
  const contentRootRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const updateSelection = () => {
      const rootNode = contentRootRef.current;
      if (!onSelectionChange || !rootNode) {
        return;
      }
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        onSelectionChange(null);
        return;
      }
      const range = selection.getRangeAt(0);
      if (!rootNode.contains(range.commonAncestorContainer)
        && !rootNode.contains(range.startContainer)
        && !rootNode.contains(range.endContainer)) {
        onSelectionChange(null);
        return;
      }
      const text = selection.toString();
      if (!text.trim()) {
        onSelectionChange(null);
        return;
      }
      const rows = Array.from(rootNode.querySelectorAll<HTMLElement>("[data-line-number]"));
      const lineNumbers = rows
        .filter((row) => {
          try {
            return range.intersectsNode(row);
          } catch {
            return false;
          }
        })
        .map((row) => Number.parseInt(row.dataset.lineNumber || "", 10))
        .filter((value) => Number.isFinite(value));
      const startLine = lineNumbers.length > 0 ? Math.min(...lineNumbers) : undefined;
      const endLine = lineNumbers.length > 0 ? Math.max(...lineNumbers) : undefined;
      onSelectionChange({
        filePath: diff.path,
        text,
        startLine,
        endLine,
      });
    };

    if (!onSelectionChange) {
      return;
    }
    const handleSelectionChange = () => updateSelection();
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
      onSelectionChange(null);
    };
  }, [diff.path, onSelectionChange]);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <header style={{ height: "36px", padding: "0 16px", borderBottom: "1px solid var(--border-color)", display: "flex", alignItems: "center", gap: "10px", background: "var(--mindfs-topbar-bg, transparent)", boxSizing: "border-box", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", overflow: "hidden", flex: 1, minWidth: 0 }}>
          <Breadcrumbs root={root} path={diff.path} onPathClick={onPathClick} />
          {relatedSessions.length > 0 ? (
            <div style={{ marginLeft: "16px", display: "flex", alignItems: "center", gap: "6px", minWidth: 0, flexShrink: 0 }}>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ color: "var(--text-secondary)", opacity: 0.4 }}
              >
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              <div style={{ display: "flex", gap: "4px", overflowX: "auto", whiteSpace: "nowrap", scrollbarWidth: "none" }}>
                {visibleRelatedSessions.map((meta) => (
                  <button
                    key={meta.source_session}
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (meta.source_session) {
                        onSessionClick?.(meta.source_session);
                      }
                    }}
                    style={{
                      background: "rgba(0, 0, 0, 0.03)",
                      border: "1px solid rgba(0, 0, 0, 0.05)",
                      borderRadius: "6px",
                      padding: "1px 8px",
                      cursor: "pointer",
                      color: "var(--text-secondary)",
                      fontSize: "11px",
                      fontWeight: 500,
                      flexShrink: 0,
                      transition: "all 0.2s ease",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "rgba(59, 130, 246, 0.08)";
                      e.currentTarget.style.color = "var(--accent-color)";
                      e.currentTarget.style.borderColor = "rgba(59, 130, 246, 0.2)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "rgba(0, 0, 0, 0.03)";
                      e.currentTarget.style.color = "var(--text-secondary)";
                      e.currentTarget.style.borderColor = "rgba(0, 0, 0, 0.05)";
                    }}
                  >
                    <span
                      style={{
                        display: "inline-block",
                        maxWidth: "120px",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        verticalAlign: "bottom",
                      }}
                      title={meta.session_name || `Session ${meta.source_session.slice(0, 8)}`}
                    >
                      {meta.session_name || `Session ${meta.source_session.slice(0, 8)}`}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
        <div style={{ display: "inline-flex", alignItems: "center", gap: "8px", fontSize: "11px", color: "var(--text-secondary)", flexShrink: 0 }}>
          <span>{renderStatusLabel(diff.status)}</span>
          {renderLineStat(diff.additions, "+")}
          {renderLineStat(diff.deletions, "-")}
        </div>
      </header>

      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        <div
          style={{
            fontFamily: 'Menlo, Monaco, "Courier New", monospace',
            fontSize: "13px",
            lineHeight: "20px",
            color: "var(--text-primary)",
            background: "transparent",
          }}
        >
          <div ref={contentRootRef} style={{ position: "relative" }}>
            <div style={{ padding: "24px 8px 24px 16px" }}>
              <div style={{ color: "var(--text-primary)" }}>
                {lines.map((line, index) => (
                  <div
                    key={`${index}-${line.kind}-${line.oldLine || 0}-${line.newLine || 0}`}
                    data-line-number={line.kind === "add" && typeof line.newLine === "number" ? line.newLine : undefined}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "48px 18px minmax(0, 1fr)",
                      alignItems: "stretch",
                      background: lineBackground(line.kind),
                      color: lineColor(line.kind),
                    }}
                  >
                    <div
                      style={{
                        padding: "0 8px 0 0",
                        textAlign: "right",
                        color: "var(--text-secondary)",
                        opacity: 0.55,
                        userSelect: "none",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {line.kind === "add" ? displayLineNumber(line) : ""}
                    </div>
                    <div style={{ padding: "0 0 0 2px", userSelect: "none", fontWeight: 700 }}>
                      {line.kind === "add" ? "+" : line.kind === "del" ? "-" : line.kind === "ctx" ? " " : ""}
                    </div>
                    <div style={{ padding: "0 16px 0 8px", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                      {line.text || " "}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

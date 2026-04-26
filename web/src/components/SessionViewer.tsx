import React, { memo, useEffect, useRef, useState } from "react";
import { useSessionStream, type TimelineItem } from "../hooks/useSessionStream";
import type { TodoUpdate } from "../services/session";
import { ThinkingBlock } from "./stream/ThinkingBlock";
import { ToolCallCard } from "./stream/ToolCallCard";
import { AgentIcon } from "./AgentIcon";
import { InlineTokenText } from "./InlineTokenText";
import { MarkdownViewer } from "./MarkdownViewer";
import { fetchProofProtectedBlob } from "../services/file";
import type { ExchangeAux, RelatedFile, ToolCall } from "../services/session";
import { savePrompt } from "../services/prompts";
import { reportError } from "../services/error";
import { rootBadgeButtonStyle } from "./rootBadgeStyle";

type SessionItem = {
  key?: string;
  session_key?: string;
  type?: string;
  name?: string;
  agent?: string;
  context_window?: {
    totalTokens: number;
    modelContextWindow: number;
  };
  search_seq?: number;
  scope?: string;
  purpose?: string;
  exchanges?: Array<{
    seq?: number;
    role?: string;
    agent?: string;
    content?: string;
    timestamp?: string;
    context_window?: {
      totalTokens: number;
      modelContextWindow: number;
    };
  }>;
  closed_at?: string;
  related_files?: RelatedFile[];
  exchange_aux?: Record<string, ExchangeAux[]>;
};

type SessionViewerProps = {
  session: SessionItem | null;
  loading?: boolean;
  rootId?: string | null;
  rootPath?: string | null;
  interactionMode?: "main" | "drawer";
  targetSeq?: number;
  gitFileStatsByPath?: Record<
    string,
    { status: string; additions: number; deletions: number }
  >;
  onFileClick?: (path: string) => void;
  onRootClick?: (rootId: string) => void;
  onRemoveRelatedFile?: (path: string) => void;
  onAskUserAnswer?: (input: {
    rootId: string;
    sessionKey: string;
    agent?: string;
    toolUseId: string;
    answers: Record<string, string>;
  }) => void | Promise<void>;
};

type AskUserQuestionOption = {
  label?: string;
  description?: string;
};

type AskUserQuestionItem = {
  question?: string;
  header?: string;
  options?: AskUserQuestionOption[];
  multiSelect?: boolean;
};

type UploadAttachment = {
  path: string;
  name: string;
  isImage: boolean;
};

function AttachmentImage({
  rootId,
  path,
  name,
}: {
  rootId: string;
  path: string;
  name: string;
}) {
  const [url, setURL] = useState("");

  useEffect(() => {
    let cancelled = false;
    let objectURL = "";
    async function run() {
      try {
        const blob = await fetchProofProtectedBlob({ rootId, path });
        if (cancelled) return;
        objectURL = URL.createObjectURL(blob);
        setURL(objectURL);
      } catch {
        if (!cancelled) {
          setURL("");
        }
      }
    }
    if (rootId && path) {
      void run();
    }
    return () => {
      cancelled = true;
      if (objectURL) {
        URL.revokeObjectURL(objectURL);
      }
    };
  }, [rootId, path]);

  return (
    <img
      src={url}
      alt={name}
      style={{
        display: "block",
        width: "100%",
        maxHeight: "220px",
        objectFit: "cover",
        background: "rgba(15,23,42,0.06)",
      }}
    />
  );
}

const uploadTokenPattern = /\[read file:\s*([^\]]+)\]/g;

function basename(path: string): string {
  const normalized = (path || "").replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || path;
}

function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(path);
}

function extractUploadAttachments(content: string): UploadAttachment[] {
  const attachments: UploadAttachment[] = [];
  uploadTokenPattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = uploadTokenPattern.exec(content || "")) !== null) {
    const path = match[1].trim();
    attachments.push({
      path,
      name: basename(path),
      isImage: isImagePath(path),
    });
  }
  return attachments;
}

function stripImageAttachmentTokens(content: string): string {
  if (!content) {
    return "";
  }
  const stripped = content.replace(
    uploadTokenPattern,
    (fullMatch, rawPath: string) => {
      const path = String(rawPath || "").trim();
      if (!isImagePath(path)) {
        return fullMatch;
      }
      return "";
    },
  );
  return stripped.replace(/\n{3,}/g, "\n\n").replace(/^[\n\s]+|[\n\s]+$/g, "");
}

function stripUploadAttachmentTokens(content: string): string {
  if (!content) {
    return "";
  }
  return content
    .replace(uploadTokenPattern, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[\n\s]+|[\n\s]+$/g, "");
}

function formatContextWindowPercent(contextWindow?: {
  totalTokens: number;
  modelContextWindow: number;
}) {
  const usedTokens = Math.max(0, Number(contextWindow?.totalTokens || 0));
  const modelContextWindow = Math.max(
    0,
    Number(contextWindow?.modelContextWindow || 0),
  );
  if (!usedTokens || !modelContextWindow) {
    return null;
  }
  const usedRatio = Math.max(0, Math.min(1, usedTokens / modelContextWindow));
  return {
    usedTokens,
    usedRatio,
    percent: Math.round(usedRatio * 100),
  };
}

function formatCompactTokenCount(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0";
  }
  if (value >= 1_000_000) {
    return `${Math.round(value / 1_000_000)}M`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}K`;
  }
  return String(Math.round(value));
}

function ContextWindowBadge({
  contextWindow,
}: {
  contextWindow?: { totalTokens: number; modelContextWindow: number };
}) {
  const metrics = formatContextWindowPercent(contextWindow);
  if (!metrics) {
    return null;
  }
  const hue =
    metrics.percent >= 90
      ? "#dc2626"
      : metrics.percent >= 75
        ? "#ea580c"
        : "#0f766e";
  return (
    <span
      title={`Context Window ${metrics.percent}% used (${metrics.usedTokens}/${contextWindow?.modelContextWindow} used)`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: hue,
        lineHeight: 1.1,
        flexShrink: 0,
        fontSize: "10px",
        fontWeight: 700,
        letterSpacing: "0.01em",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <span>{metrics.percent}%</span>
      <span>&middot;used</span>
      <span>
        {`(${formatCompactTokenCount(metrics.usedTokens)}/${formatCompactTokenCount(
          contextWindow?.modelContextWindow || 0,
        )})`}
      </span>
    </span>
  );
}

const formatTime = (isoString?: string) => {
  if (!isoString) return "";
  try {
    const date = new Date(isoString);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    const isThisYear = date.getFullYear() === now.getFullYear();
    const timeStr = date.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    if (isToday) return timeStr;
    const month = (date.getMonth() + 1).toString().padStart(2, "0");
    const day = date.getDate().toString().padStart(2, "0");
    if (isThisYear) return `${month}-${day} ${timeStr}`;
    return `${date.getFullYear()}-${month}-${day} ${timeStr}`;
  } catch {
    return "";
  }
};

const formatToolCallFallbackResult = (toolCall: Partial<ToolCall>): string => {
  const kind = (toolCall.kind || "").toLowerCase();
  if (kind === "read") return "";
  const rawInput = toolCall.meta?.input;
  if (typeof rawInput === "string" && rawInput.trim() !== "") {
    const todoMarkdown = formatTodoToolCallInput(rawInput);
    if (todoMarkdown) return todoMarkdown;
    return rawInput;
  }
  const rawOutput = toolCall.meta?.output;
  if (typeof rawOutput === "string" && rawOutput.trim() !== "")
    return rawOutput;
  return "";
};

const formatTodoToolCallInput = (rawInput: string): string => {
  try {
    const parsed = JSON.parse(rawInput) as {
      todos?: Array<{
        content?: string;
        status?: string;
        activeForm?: string;
      }>;
    };
    if (!Array.isArray(parsed?.todos) || parsed.todos.length === 0) {
      return "";
    }
    const lines = parsed.todos
      .map((todo) => {
        const content = `${todo?.content || ""}`.trim();
        const activeForm = `${todo?.activeForm || ""}`.trim();
        const status = `${todo?.status || ""}`.trim().toLowerCase();
        if (status === "completed") {
          const label = content || activeForm;
          return label ? `- [x] ${label}` : "";
        }
        if (status === "in_progress") {
          const label = activeForm || content;
          return label ? `- [ ] ${label} _(in progress)_` : "";
        }
        const label = content || activeForm;
        return label ? `- [ ] ${label}` : "";
      })
      .filter(Boolean);
    return lines.join("\n");
  } catch {
    return "";
  }
};

function isAuxiliaryTimelineItem(item: TimelineItem | null): boolean {
  return (
    item?.type === "tool" || item?.type === "thought" || item?.type === "todo"
  );
}

function TodoUpdateCard({ todoUpdate }: { todoUpdate: TodoUpdate }) {
  const items = Array.isArray(todoUpdate?.items) ? todoUpdate.items : [];
  return (
    <div
      style={{
        width: "100%",
        minWidth: 0,
        borderRadius: "10px",
        border: "1px solid rgba(16, 185, 129, 0.22)",
        background:
          "linear-gradient(180deg, rgba(16, 185, 129, 0.08), rgba(16, 185, 129, 0.03))",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "6px 8px",
          fontSize: "12px",
          fontWeight: 600,
          color: "var(--text-primary)",
          borderBottom: "1px solid var(--border-color)",
        }}
      >
        ✅ todos
      </div>
      <div
        style={{
          padding: "10px",
          display: "flex",
          flexDirection: "column",
          gap: "6px",
        }}
      >
        {items.map((item, index) => {
          const status = `${item?.status || ""}`.trim().toLowerCase();
          const content = `${item?.content || ""}`.trim();
          const activeForm = `${item?.activeForm || ""}`.trim();
          const label =
            status === "in_progress" && activeForm
              ? activeForm
              : content || activeForm;
          const checked = status === "completed";
          return (
            <div
              key={`${index}-${label}`}
              style={{
                fontSize: "13px",
                color: "var(--text-primary)",
                opacity: checked ? 0.78 : 1,
                textDecoration: checked ? "line-through" : "none",
              }}
            >
              {checked ? "☑" : "☐"} {label}
              {status === "in_progress" ? " (in progress)" : ""}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function getAskUserQuestions(toolCall: Partial<ToolCall>): AskUserQuestionItem[] {
  const raw = toolCall.meta?.questions;
  if (Array.isArray(raw)) {
    return raw as AskUserQuestionItem[];
  }
  const input = toolCall.meta?.input;
  if (typeof input !== "string" || input.trim() === "") {
    return [];
  }
  try {
    const parsed = JSON.parse(input) as { questions?: AskUserQuestionItem[] };
    return Array.isArray(parsed.questions) ? parsed.questions : [];
  } catch {
    return [];
  }
}

function AskUserIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      style={{ color: "#ef4444", flexShrink: 0 }}
    >
      <g fill="currentColor">
        <path d="M8 11a.75.75 0 1 1 0 1.5a.75.75 0 0 1 0-1.5m0-7c1.262 0 2.25.988 2.25 2.25c0 1.083-.566 1.648-1.021 2.104c-.408.407-.729.728-.729 1.396a.5.5 0 0 1-1 0c0-1.083.566-1.648 1.021-2.104c.408-.407.729-.728.729-1.396C9.25 5.538 8.712 5 8 5s-1.25.538-1.25 1.25a.5.5 0 0 1-1 0C5.75 4.988 6.738 4 8 4" />
        <path
          fillRule="evenodd"
          d="M8 1a7 7 0 0 1 6.999 7.001a7 7 0 0 1-10.504 6.06l-2.728.91a.582.582 0 0 1-.744-.714l.83-2.906A7 7 0 0 1 8 1m.001 1.001c-3.308 0-6 2.692-6 6c0 1.003.252 1.996.73 2.871l.196.36l-.726 2.54l1.978-.659l.428-.143l.39.226A6 6 0 0 0 8 14l.001.001c3.308 0 6-2.692 6-6s-2.692-6-6-6"
          clipRule="evenodd"
        />
      </g>
    </svg>
  );
}

function AskUserQuestionCard({
  toolCall,
  rootId,
  sessionKey,
  agent,
  active,
  onAnswer,
}: {
  toolCall: ToolCall;
  rootId?: string | null;
  sessionKey?: string | null;
  agent?: string;
  active: boolean;
  onAnswer?: SessionViewerProps["onAskUserAnswer"];
}) {
  const questions = getAskUserQuestions(toolCall);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const status = `${toolCall.status || ""}`.toLowerCase();
  const isCurrent =
    status === "running" || status === "pending" || status === "in_progress";
  const [expanded, setExpanded] = useState(isCurrent);
  const toolUseId =
    toolCall.callId ||
    (typeof toolCall.meta?.toolUseId === "string" ? toolCall.meta.toolUseId : "");
  const firstQuestion = questions[0] || {};
  const questionTitle = `${firstQuestion.question || ""}`.trim();
  const questionHeader = `${firstQuestion.header || ""}`.trim();
  const title =
    questionHeader && questionTitle
      ? `${questionHeader}：${questionTitle}`
      : questionTitle ||
    `${toolCall.title || ""}`.trim() ||
    (typeof toolCall.meta?.title === "string" ? toolCall.meta.title : "") ||
    questionHeader ||
    "ask user";
  const canSubmit =
    !!rootId &&
    !!sessionKey &&
    !!toolUseId &&
    !!onAnswer &&
    questions.length > 0 &&
    questions.every((_, index) => (answers[`q_${index}`] || "").trim() !== "") &&
    !submitting &&
    !submitted;

  useEffect(() => {
    if (submitted) {
      setExpanded(false);
      return;
    }
    setExpanded(active && isCurrent);
  }, [active, isCurrent, submitted, toolUseId]);

  const setAnswer = (index: number, value: string) => {
    setAnswers((prev) => ({ ...prev, [`q_${index}`]: value }));
  };
  const toggleMultiAnswer = (index: number, label: string) => {
    const key = `q_${index}`;
    setAnswers((prev) => {
      const current = (prev[key] || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      const next = current.includes(label)
        ? current.filter((item) => item !== label)
        : [...current, label];
      return { ...prev, [key]: next.join(", ") };
    });
  };

  return (
    <div
      style={{
        width: "100%",
        minWidth: 0,
        borderRadius: "10px",
        border: "1px solid rgba(239, 68, 68, 0.28)",
        background:
          "linear-gradient(180deg, rgba(239, 68, 68, 0.08), rgba(239, 68, 68, 0.03))",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-start",
          padding: "6px 8px",
          background: "rgba(239, 68, 68, 0.04)",
          border: "none",
          borderBottom: expanded ? "1px solid var(--border-color)" : "none",
          cursor: "pointer",
          fontSize: "12px",
          gap: "6px",
          minWidth: 0,
        }}
      >
        <AskUserIcon />
        <span
          style={{
            minWidth: 0,
            flex: 1,
            fontWeight: 500,
            color: "var(--text-primary)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            textAlign: "left",
          }}
        >
          {title}
        </span>
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
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.25"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>
      </button>
      {expanded ? (
        <div style={{ padding: "10px", display: "flex", flexDirection: "column", gap: "12px" }}>
        {questions.map((question, index) => {
          const key = `q_${index}`;
          const options = Array.isArray(question.options) ? question.options : [];
          const selected = answers[key] || "";
          const selectedSet = new Set(
            selected
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean),
          );
          return (
            <div key={key} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {options.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  {options.map((option) => {
                    const label = `${option.label || ""}`.trim();
                    if (!label) return null;
                    const checked = question.multiSelect
                      ? selectedSet.has(label)
                      : selected === label;
                    return (
                      <label
                        key={label}
                        style={{
                          display: "flex",
                          gap: "8px",
                          alignItems: "flex-start",
                          padding: "7px 8px",
                          borderRadius: "8px",
                          border: checked
                            ? "1px solid rgba(239, 68, 68, 0.42)"
                            : "1px solid var(--border-color)",
                          background: checked ? "rgba(239, 68, 68, 0.10)" : "var(--content-bg)",
                          cursor: submitted ? "default" : "pointer",
                        }}
                      >
                        <input
                          type={question.multiSelect ? "checkbox" : "radio"}
                          name={`${toolUseId}-${key}`}
                          checked={checked}
                          disabled={submitted}
                          onChange={() =>
                            question.multiSelect
                              ? toggleMultiAnswer(index, label)
                              : setAnswer(index, label)
                          }
                          style={{ marginTop: "2px" }}
                        />
                        <span style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                          <span style={{ fontSize: "13px", color: "var(--text-primary)" }}>{label}</span>
                          {option.description ? (
                            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                              {option.description}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <textarea
                  value={selected}
                  disabled={submitted}
                  onChange={(event) => setAnswer(index, event.target.value)}
                  placeholder="输入回答..."
                  rows={3}
                  style={{
                    width: "100%",
                    resize: "vertical",
                    borderRadius: "8px",
                    border: "1px solid var(--border-color)",
                    background: "var(--content-bg)",
                    color: "var(--text-primary)",
                    padding: "8px",
                    fontSize: "13px",
                    boxSizing: "border-box",
                  }}
                />
              )}
            </div>
          );
        })}
        <button
          type="button"
          disabled={!canSubmit}
          onClick={async () => {
            if (!canSubmit || !rootId || !sessionKey || !toolUseId || !onAnswer) return;
            setSubmitting(true);
            try {
              await onAnswer({ rootId, sessionKey, agent, toolUseId, answers });
              setSubmitted(true);
              setExpanded(false);
            } finally {
              setSubmitting(false);
            }
          }}
          style={{
            alignSelf: "flex-start",
            border: "none",
            borderRadius: "999px",
            padding: "6px 12px",
            background: canSubmit ? "#ef4444" : "var(--border-color)",
            color: canSubmit ? "#fff" : "var(--text-secondary)",
            fontSize: "12px",
            fontWeight: 700,
            cursor: canSubmit ? "pointer" : "default",
          }}
        >
          {submitted ? "已提交" : submitting ? "提交中..." : "提交回答"}
        </button>
        </div>
      ) : null}
    </div>
  );
}

function timelineItemSpacing(
  previous: TimelineItem | null,
  current: TimelineItem,
): string {
  if (!previous) {
    return "0";
  }
  if (isAuxiliaryTimelineItem(previous) && isAuxiliaryTimelineItem(current)) {
    return "6px";
  }
  return "16px";
}

function collectAssistantFlowMarkdown(
  timeline: TimelineItem[],
  startIndex: number,
): string {
  const segments: string[] = [];

  for (let index = startIndex; index >= 0; index -= 1) {
    const item = timeline[index];
    if (item.type === "user_text") {
      break;
    }
    if (item.type === "assistant_text" && item.content) {
      segments.unshift(item.content);
    }
  }

  for (let index = startIndex + 1; index < timeline.length; index += 1) {
    const item = timeline[index];
    if (item.type === "user_text") {
      break;
    }
    if (item.type === "assistant_text" && item.content) {
      segments.push(item.content);
    }
  }

  return segments.join("").trim();
}

async function copyText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back for browsers/webviews with restricted Clipboard API support.
    }
  }

  if (typeof document === "undefined") {
    throw new Error("当前环境不支持复制");
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "true");
  textArea.setAttribute("aria-hidden", "true");
  textArea.style.position = "fixed";
  textArea.style.top = "0";
  textArea.style.left = "0";
  textArea.style.width = "1px";
  textArea.style.height = "1px";
  textArea.style.padding = "0";
  textArea.style.border = "0";
  textArea.style.outline = "0";
  textArea.style.boxShadow = "none";
  textArea.style.background = "transparent";
  textArea.style.opacity = "0";

  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  textArea.setSelectionRange(0, text.length);

  try {
    const succeeded = document.execCommand("copy");
    if (!succeeded) {
      throw new Error("复制失败");
    }
  } finally {
    document.body.removeChild(textArea);
  }
}

function shouldDefaultCollapseRelatedFiles(
  isMobile: boolean,
  relatedFileCount: number,
): boolean {
  if (isMobile) {
    return relatedFileCount > 0;
  }
  return relatedFileCount > 5;
}

function SessionViewerInner({
  session,
  loading = false,
  rootId,
  rootPath,
  interactionMode = "main",
  targetSeq = 0,
  gitFileStatsByPath = {},
  onFileClick,
  onRootClick,
  onRemoveRelatedFile,
  onAskUserAnswer,
}: SessionViewerProps) {
  const [showAllFiles, setShowAllFiles] = useState(false);
  const [relatedFilesCollapsed, setRelatedFilesCollapsed] = useState(false);
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.matchMedia("(max-width: 767px)").matches;
  });
  const [savedPromptKeys, setSavedPromptKeys] = useState<Record<string, true>>(
    {},
  );
  const [copiedMessageKeys, setCopiedMessageKeys] = useState<
    Record<string, true>
  >({});
  const scrollEndRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const onFileClickRef = useRef(onFileClick);
  const copyResetTimersRef = useRef<Record<string, number>>({});
  const relatedFilesDefaultStateRef = useRef<string>("");
  const sessionKey = session?.key || session?.session_key || null;
  const exchanges = Array.isArray(session?.exchanges) ? session.exchanges : [];
  const { timeline, isStreaming } = useSessionStream(
    sessionKey,
    exchanges,
    session?.exchange_aux || {},
    session?.context_window,
  );
  const isAwaiting = !!(session as any)?.pending;
  const shouldStickToBottomRef = useRef(true);
  const lastSessionKeyRef = useRef<string | null>(null);

  useEffect(() => {
    onFileClickRef.current = onFileClick;
  }, [onFileClick]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const media = window.matchMedia("(max-width: 767px)");
    const handleChange = () => {
      setIsMobile(media.matches);
    };
    handleChange();
    media.addEventListener("change", handleChange);
    return () => {
      media.removeEventListener("change", handleChange);
    };
  }, []);

  useEffect(() => {
    setSavedPromptKeys({});
    setCopiedMessageKeys({});
    relatedFilesDefaultStateRef.current = "";
    Object.values(copyResetTimersRef.current).forEach((timer) =>
      window.clearTimeout(timer),
    );
    copyResetTimersRef.current = {};
  }, [sessionKey]);

  useEffect(() => {
    return () => {
      Object.values(copyResetTimersRef.current).forEach((timer) =>
        window.clearTimeout(timer),
      );
      copyResetTimersRef.current = {};
    };
  }, []);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }
    const nextKey = sessionKey;
    const isSessionChanged = lastSessionKeyRef.current !== nextKey;
    if (isSessionChanged) {
      lastSessionKeyRef.current = nextKey;
      shouldStickToBottomRef.current = true;
    }
    if (shouldStickToBottomRef.current) {
      scrollEndRef.current.scrollIntoView({ behavior: "auto", block: "end" });
    }
  }, [sessionKey, timeline, isStreaming]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const updateStickiness = () => {
      const distanceFromBottom =
        el.scrollHeight - el.clientHeight - el.scrollTop;
      shouldStickToBottomRef.current = distanceFromBottom < 32;
    };
    updateStickiness();
    el.addEventListener("scroll", updateStickiness, { passive: true });
    return () => {
      el.removeEventListener("scroll", updateStickiness);
    };
  }, [sessionKey]);

  useEffect(() => {
    if (!targetSeq) {
      return;
    }
    const container = scrollRef.current;
    if (!container || !timeline.length) {
      return;
    }
    const node = container.querySelector<HTMLElement>(
      `[data-session-seq="${targetSeq}"]`,
    );
    if (!node) {
      return;
    }
    window.requestAnimationFrame(() => {
      node.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }, [targetSeq, timeline]);

  const rawRelated = session?.related_files || (session as any)?.outputs || [];
  const relatedFiles = (Array.isArray(rawRelated) ? rawRelated : [])
    .map((f: any) => {
      const path =
        typeof f === "string" ? f : typeof f?.path === "string" ? f.path : "";
      const name =
        typeof f?.name === "string" ? f.name : path.split("/").pop() || path;
      return { path, name };
    })
    .filter((f) => f.path);
  const activeAskUserCallId = (() => {
    if (!isAwaiting) {
      return "";
    }
    for (let i = timeline.length - 1; i >= 0; i -= 1) {
      const item = timeline[i];
      if (item.type === "user_text" || item.type === "assistant_text") {
        return "";
      }
      if (item.type !== "tool") continue;
      const toolCall = item.toolCall || {};
      const kind = `${toolCall.kind || ""}`.toLowerCase();
      const status = `${toolCall.status || ""}`.toLowerCase();
      if (kind !== "ask_user") continue;
      if (
        status !== "running" &&
        status !== "pending" &&
        status !== "in_progress"
      ) {
        continue;
      }
      if (getAskUserQuestions(toolCall).length === 0) continue;
      return (
        toolCall.callId ||
        (typeof toolCall.meta?.toolUseId === "string"
          ? toolCall.meta.toolUseId
          : "")
      );
    }
    return "";
  })();
  const defaultRelatedFilesCollapsed = shouldDefaultCollapseRelatedFiles(
    isMobile,
    relatedFiles.length,
  );
  const relatedFilesDefaultStateKey = `${sessionKey || ""}:${isMobile ? "mobile" : "desktop"}:${defaultRelatedFilesCollapsed ? "collapsed" : "expanded"}`;

  useEffect(() => {
    if (relatedFilesDefaultStateRef.current === relatedFilesDefaultStateKey) {
      return;
    }
    relatedFilesDefaultStateRef.current = relatedFilesDefaultStateKey;
    setRelatedFilesCollapsed(defaultRelatedFilesCollapsed);
  }, [defaultRelatedFilesCollapsed, relatedFilesDefaultStateKey]);

  if (!session) {
    return (
      <div
        style={{
          padding: "40px",
          textAlign: "center",
          color: "var(--text-secondary)",
        }}
      >
        选择一个会话查看内容
      </div>
    );
  }

  const displayFiles = showAllFiles ? relatedFiles : relatedFiles.slice(0, 10);
  const hasMoreFiles = relatedFiles.length > 10;
  const displayName =
    session.name ||
    session.purpose ||
    session.key ||
    session.session_key ||
    "Session";
  const hasVisibleTimeline = timeline.length > 0;
  const userMetaButtonStyle: React.CSSProperties = {
    width: "18px",
    height: "18px",
    border: "none",
    background: "transparent",
    padding: 0,
    margin: 0,
    color: "#2563eb",
    cursor: "pointer",
    fontSize: "14px",
    fontWeight: 800,
    lineHeight: 1,
    opacity: 1,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "6px",
    flexShrink: 0,
  };

  const makePromptKey = (item: TimelineItem): string =>
    `${item.id}\n${item.timestamp || ""}\n${item.content || ""}`;

  const renderTimelineItem = (
    item: TimelineItem,
    idx: number,
    spacing: string = "0",
  ) => {
    const timelineItemKey = item.id || `${item.type}-${idx}`;
    if (item.type === "thought") {
      return (
        <div key={timelineItemKey} style={{ marginTop: spacing }}>
          <ThinkingBlock content={item.content || ""} defaultExpanded={false} />
        </div>
      );
    }
    if (item.type === "tool") {
      const tc = item.toolCall || {};
      const isAskUser =
        `${tc.kind || ""}`.toLowerCase() === "ask_user" &&
        `${tc.status || ""}`.toLowerCase() !== "complete" &&
        getAskUserQuestions(tc).length > 0;
      const toolUseId =
        tc.callId ||
        (typeof tc.meta?.toolUseId === "string" ? tc.meta.toolUseId : "");
      return (
        <div key={timelineItemKey} style={{ marginTop: spacing }}>
          {isAskUser ? (
            <AskUserQuestionCard
              toolCall={tc}
              rootId={rootId}
              sessionKey={sessionKey}
              agent={session?.agent}
              active={!!toolUseId && toolUseId === activeAskUserCallId}
              onAnswer={onAskUserAnswer}
            />
          ) : (
            <ToolCallCard
              kind={tc.kind}
              title={
                (tc as any).title ||
                (tc.meta && typeof tc.meta.title === "string"
                  ? (tc.meta.title as string)
                  : "")
              }
              callId={tc.callId || ""}
              status={tc.status || "running"}
              content={tc.content}
              result={formatToolCallFallbackResult(tc)}
              locations={tc.locations}
              rootPath={rootPath || undefined}
              defaultExpanded={false}
            />
          )}
        </div>
      );
    }
    if (item.type === "todo") {
      return (
        <div key={timelineItemKey} style={{ marginTop: spacing }}>
          <TodoUpdateCard todoUpdate={item.todoUpdate} />
        </div>
      );
    }
    const isUser = item.type === "user_text";
    const next = idx + 1 < timeline.length ? timeline[idx + 1] : null;
    const hasFollowingAssistantFlow =
      !isUser && !!next && next.type !== "user_text";
    const hideAssistantMeta =
      !isUser &&
      (hasFollowingAssistantFlow ||
        (isStreaming && idx === timeline.length - 1));
    const time = formatTime(item.timestamp);
    const uploadAttachments = isUser
      ? extractUploadAttachments(item.content || "")
      : [];
    const imageAttachments = uploadAttachments.filter(
      (attachment) => attachment.isImage,
    );
    const displayContent = isUser
      ? stripImageAttachmentTokens(item.content || "")
      : item.content || "";
    const promptSaveContent = isUser
      ? stripUploadAttachmentTokens(item.content || "")
      : "";
    const promptKey = makePromptKey(item);
    const promptSaved = !!savedPromptKeys[promptKey];
    const copySucceeded = !!copiedMessageKeys[promptKey];
    const userMessageWidth =
      imageAttachments.length > 0 ? "min(320px, 100%)" : "auto";
    const hasRichUserAttachments = imageAttachments.length > 0;
    const assistantMarkdownContent = !isUser
      ? collectAssistantFlowMarkdown(timeline, idx)
      : "";
    return (
      <div
        key={timelineItemKey}
        data-session-seq={item.seq || undefined}
        style={{
          marginTop: spacing,
          alignSelf: isUser ? "flex-end" : "flex-start",
          width: isUser ? userMessageWidth : "100%",
          maxWidth: isUser ? "80%" : "100%",
          minWidth: 0,
          position: "relative",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {isUser ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "stretch",
              gap: "6px",
              width: userMessageWidth,
              maxWidth: "100%",
              minWidth: 0,
            }}
          >
            {hasRichUserAttachments ? (
              <div
                style={{
                  width: "100%",
                  maxWidth: "100%",
                  minWidth: 0,
                  padding: "8px",
                  borderRadius: "18px 18px 4px 18px",
                  background: "rgba(148,163,184,0.14)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                  boxSizing: "border-box",
                }}
              >
                {imageAttachments.length > 0 ? (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        imageAttachments.length > 1
                          ? "repeat(2, minmax(0, 1fr))"
                          : "minmax(0, 1fr)",
                      gap: "8px",
                      width: "100%",
                    }}
                  >
                    {imageAttachments.map((attachment) => (
                      <button
                        key={attachment.path}
                        type="button"
                        onClick={() =>
                          onFileClickRef.current?.(attachment.path)
                        }
                        style={{
                          border: "none",
                          padding: 0,
                          background: "transparent",
                          cursor: "pointer",
                          borderRadius: "12px",
                          overflow: "hidden",
                        }}
                        title={attachment.name}
                      >
                        <AttachmentImage
                          rootId={rootId || ""}
                          path={attachment.path}
                          name={attachment.name}
                        />
                      </button>
                    ))}
                  </div>
                ) : null}
                {displayContent ? (
                  <div
                    style={{
                      padding:
                        imageAttachments.length > 0 ? "2px 6px 0" : "6px 8px",
                      color: "var(--text-primary)",
                      fontSize: "14px",
                      lineHeight: "1.5",
                      whiteSpace: "pre-wrap",
                      overflowWrap: "anywhere",
                      wordBreak: "break-word",
                    }}
                  >
                    <InlineTokenText
                      content={displayContent}
                      isDark={false}
                      variant="inverse"
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
            {!hasRichUserAttachments && displayContent ? (
              <div
                style={{
                  padding: "10px 16px",
                  borderRadius: "18px 18px 4px 18px",
                  background: "rgba(148,163,184,0.14)",
                  color: "var(--text-primary)",
                  fontSize: "14px",
                  lineHeight: "1.5",
                  boxShadow: "none",
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                  wordBreak: "break-word",
                  alignSelf: "flex-end",
                  maxWidth: "100%",
                  minWidth: 0,
                }}
              >
                <InlineTokenText
                  content={displayContent}
                  isDark={false}
                  variant="inverse"
                />
              </div>
            ) : null}
            <span
              style={{
                fontSize: "10px",
                color: "var(--text-secondary)",
                opacity: 0.5,
                alignSelf: "flex-end",
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
              }}
            >
              {item.pendingAck ? (
                <span
                  aria-label="发送中"
                  style={{
                    width: "8px",
                    height: "8px",
                    border: "1px solid var(--text-secondary)",
                    borderTopColor: "transparent",
                    borderRadius: "50%",
                    display: "inline-block",
                    animation: "spin 0.8s linear infinite",
                  }}
                />
              ) : null}
              <span>{time}</span>
              {promptSaved ? (
                <span
                  aria-label="已添加提示词"
                  title="已添加提示词"
                  style={{
                    ...userMetaButtonStyle,
                    color: "#2563eb",
                    fontSize: "13px",
                  }}
                >
                  ✓
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    if (!promptSaveContent) {
                      reportError(
                        "file.write_failed",
                        "消息内容为空，无法加入常用提示词",
                      );
                      return;
                    }
                    void savePrompt(promptSaveContent)
                      .then(() => {
                        setSavedPromptKeys((prev) => ({
                          ...prev,
                          [promptKey]: true,
                        }));
                      })
                      .catch((err) => {
                        reportError(
                          "file.write_failed",
                          String((err as Error)?.message || "保存提示词失败"),
                        );
                      });
                  }}
                  style={userMetaButtonStyle}
                  aria-label="加入常用提示词"
                  title="加入常用提示词"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    aria-hidden="true"
                  >
                    <path
                      fill="currentColor"
                      stroke="currentColor"
                      strokeWidth="0.45"
                      strokeLinejoin="round"
                      d="M1.086 5.183A2.5 2.5 0 0 1 2.854 2.12l3.863-1.035A2.5 2.5 0 0 1 9.78 2.854L10.354 5H9.32l-.506-1.888a1.5 1.5 0 0 0-1.837-1.06L3.112 3.087a1.5 1.5 0 0 0-1.06 1.837l1.035 3.864a1.5 1.5 0 0 0 1.837 1.06L5 9.828v1.028a2.5 2.5 0 0 1-2.879-1.81zM8 6a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h5a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zM7 8a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1zm4 .5a.5.5 0 0 0-1 0V10H8.5a.5.5 0 0 0 0 1H10v1.5a.5.5 0 0 0 1 0V11h1.5a.5.5 0 0 0 0-1H11z"
                    />
                  </svg>
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  if (!promptSaveContent) {
                    reportError("file.write_failed", "消息内容为空，无法复制");
                    return;
                  }
                  void copyText(promptSaveContent)
                    .then(() => {
                      setCopiedMessageKeys((prev) => ({
                        ...prev,
                        [promptKey]: true,
                      }));
                      if (copyResetTimersRef.current[promptKey]) {
                        window.clearTimeout(
                          copyResetTimersRef.current[promptKey],
                        );
                      }
                      copyResetTimersRef.current[promptKey] = window.setTimeout(
                        () => {
                          setCopiedMessageKeys((prev) => {
                            const next = { ...prev };
                            delete next[promptKey];
                            return next;
                          });
                          delete copyResetTimersRef.current[promptKey];
                        },
                        1000,
                      );
                    })
                    .catch((err) => {
                      reportError(
                        "file.write_failed",
                        String((err as Error)?.message || "复制失败"),
                      );
                    });
                }}
                style={userMetaButtonStyle}
                aria-label="复制消息"
                title="复制消息"
              >
                {copySucceeded ? (
                  <span
                    aria-hidden="true"
                    style={{ fontSize: "13px", fontWeight: 800, lineHeight: 1 }}
                  >
                    ✓
                  </span>
                ) : (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      fill="currentColor"
                      d="M20 2H10c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2m0 12H10V4h10z"
                    />
                    <path
                      fill="currentColor"
                      d="M14 20H4V10h2V8H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2v-2h-2z"
                    />
                  </svg>
                )}
              </button>
            </span>
          </div>
        ) : (
          <div
            style={{
              width: "100%",
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
            }}
          >
            <div
              style={{
                color: "var(--text-primary)",
                fontSize: "15px",
                lineHeight: "1.7",
                width: "100%",
                minWidth: 0,
              }}
            >
              <MarkdownViewer
                content={item.content || ""}
                onFileClick={onFileClickRef.current}
              />
            </div>
            {!hideAssistantMeta && (
              <span
                style={{
                  alignSelf: "flex-start",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  fontSize: "10px",
                  color: "var(--text-secondary)",
                  opacity: 0.5,
                  marginTop: "-10px",
                  marginBottom: "4px",
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    if (!assistantMarkdownContent) {
                      reportError(
                        "file.write_failed",
                        "消息内容为空，无法复制",
                      );
                      return;
                    }
                    void copyText(assistantMarkdownContent)
                      .then(() => {
                        setCopiedMessageKeys((prev) => ({
                          ...prev,
                          [promptKey]: true,
                        }));
                        if (copyResetTimersRef.current[promptKey]) {
                          window.clearTimeout(
                            copyResetTimersRef.current[promptKey],
                          );
                        }
                        copyResetTimersRef.current[promptKey] =
                          window.setTimeout(() => {
                            setCopiedMessageKeys((prev) => {
                              const next = { ...prev };
                              delete next[promptKey];
                              return next;
                            });
                            delete copyResetTimersRef.current[promptKey];
                          }, 1000);
                      })
                      .catch((err) => {
                        reportError(
                          "file.write_failed",
                          String((err as Error)?.message || "复制失败"),
                        );
                      });
                  }}
                  style={userMetaButtonStyle}
                  aria-label="复制 Markdown"
                  title="复制 Markdown"
                >
                  {copySucceeded ? (
                    <span
                      aria-hidden="true"
                      style={{
                        fontSize: "13px",
                        fontWeight: 800,
                        lineHeight: 1,
                      }}
                    >
                      ✓
                    </span>
                  ) : (
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path
                        fill="currentColor"
                        d="M20 2H10c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2m0 12H10V4h10z"
                      />
                      <path
                        fill="currentColor"
                        d="M14 20H4V10h2V8H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2v-2h-2z"
                      />
                    </svg>
                  )}
                </button>
                <AgentIcon
                  agentName={item.agent || ""}
                  style={{ width: "12px", height: "12px" }}
                />
                <span>{time}</span>
                <ContextWindowBadge contextWindow={item.contextWindow} />
              </span>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        background: "transparent",
      }}
    >
      {interactionMode === "drawer" ? null : (
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
            flexShrink: 0,
          }}
        >
          <h1
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              fontSize: "14px",
              fontWeight: 600,
              margin: 0,
              minWidth: 0,
            }}
          >
            {rootId ? (
              <button
                type="button"
                onClick={() => onRootClick?.(rootId)}
                style={{
                  ...rootBadgeButtonStyle,
                  flexShrink: 0,
                  cursor: onRootClick ? "pointer" : "default",
                }}
              >
                {rootId}
              </button>
            ) : null}
            <span
              style={{
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {displayName}
            </span>
          </h1>
        </header>
      )}

      {/* 滚动容器 */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          overflowY: "auto",
          overflowX: "hidden",
          position: "relative",
          WebkitOverflowScrolling: "touch",
        }}
      >
        <div
          style={{
            width: "100%",
            minWidth: 0,
            display: "block",
            padding: "24px 16px",
            boxSizing: "border-box",
            overflowX: "hidden",
          }}
        >
          <div
            style={{
              width: "100%",
              minWidth: 0,
              margin: "0",
              display: "flex",
              flexDirection: "column",
            }}
          >
            {loading && !hasVisibleTimeline ? (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "10px",
                  padding: "6px 0 8px",
                }}
              >
                {[0, 1, 2].map((index) => (
                  <div
                    key={index}
                    style={{
                      width: index === 1 ? "78%" : index === 2 ? "64%" : "52%",
                      height: index === 0 ? "18px" : "72px",
                      alignSelf:
                        index === 0
                          ? "flex-start"
                          : index === 1
                            ? "flex-end"
                            : "flex-start",
                      borderRadius: index === 0 ? "8px" : "18px",
                      background:
                        "linear-gradient(90deg, rgba(148,163,184,0.12) 0%, rgba(148,163,184,0.24) 50%, rgba(148,163,184,0.12) 100%)",
                      backgroundSize: "200% 100%",
                      animation:
                        "sessionLoadingPulse 1.1s ease-in-out infinite",
                    }}
                  />
                ))}
              </div>
            ) : null}
            {timeline.map((item, idx) =>
              renderTimelineItem(
                item,
                idx,
                timelineItemSpacing(idx > 0 ? timeline[idx - 1] : null, item),
              ),
            )}
            {(isAwaiting || isStreaming) && (
              <div
                style={{
                  marginTop: "16px",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  fontSize: "12px",
                  color: "var(--text-secondary)",
                }}
              >
                <span
                  style={{
                    width: "8px",
                    height: "8px",
                    borderRadius: "50%",
                    background: "var(--accent-color)",
                    animation: "pulse 1s infinite",
                  }}
                />
                {isStreaming ? "正在生成..." : "已发送，等待响应..."}
              </div>
            )}

            {/* 关联文件区域 */}
            {relatedFiles.length > 0 && (
              <div
                style={{
                  marginTop: "18px",
                  paddingTop: "14px",
                  borderTop: "1px solid var(--border-color)",
                  width: "100%",
                  boxSizing: "border-box",
                }}
              >
                <div
                  style={{
                    fontSize: "12px",
                    fontWeight: 500,
                    color: "var(--text-secondary)",
                    marginBottom: "6px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <span>关联文件 {relatedFiles.length}</span>
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "10px",
                    }}
                  >
                    {hasMoreFiles ? (
                      <button
                        type="button"
                        onClick={() => setShowAllFiles(!showAllFiles)}
                        style={{
                          background: "none",
                          border: "none",
                          padding: 0,
                          cursor: "pointer",
                          color: "var(--text-secondary)",
                          fontSize: "11px",
                        }}
                      >
                        {showAllFiles ? "收起" : "更多"}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() =>
                        setRelatedFilesCollapsed((value) => !value)
                      }
                      aria-label={
                        relatedFilesCollapsed ? "展开关联文件" : "折叠关联文件"
                      }
                      title={
                        relatedFilesCollapsed ? "展开关联文件" : "折叠关联文件"
                      }
                      style={{
                        border: "none",
                        background: "transparent",
                        padding: 0,
                        margin: 0,
                        cursor: "pointer",
                        color: "var(--text-secondary)",
                        width: "16px",
                        height: "16px",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          flexShrink: 0,
                          transform: relatedFilesCollapsed
                            ? "rotate(0deg)"
                            : "rotate(90deg)",
                          transition: "transform 0.2s",
                          color: "var(--text-secondary)",
                          display: "inline-flex",
                          alignItems: "center",
                        }}
                      >
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.25"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                      </span>
                    </button>
                  </div>
                </div>
                {!relatedFilesCollapsed ? (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "4px",
                    }}
                  >
                    {displayFiles.map((file, i) => (
                      <div
                        key={i}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "6px",
                        }}
                      >
                        <div
                          onClick={() => onFileClickRef.current?.(file.path)}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            flex: 1,
                            minWidth: 0,
                            padding: "3px 6px",
                            borderRadius: "6px",
                            cursor: "pointer",
                            transition: "background 0.15s",
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background =
                              "rgba(0,0,0,0.04)";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = "transparent";
                          }}
                        >
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="13"
                            height="13"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="#94a3b8"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                            style={{ flexShrink: 0 }}
                          >
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <polyline points="14 2 14 8 20 8" />
                            <line x1="16" x2="8" y1="13" y2="13" />
                            <line x1="16" x2="8" y1="17" y2="17" />
                            <line x1="10" x2="8" y1="9" y2="9" />
                          </svg>
                          <div
                            style={{
                              flex: 1,
                              minWidth: 0,
                              fontSize: "12px",
                              color: "var(--text-primary)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {file.name}
                          </div>
                          {gitFileStatsByPath[file.path] ? (
                            <div
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "8px",
                                fontSize: "11px",
                                color: "var(--text-secondary)",
                                flexShrink: 0,
                              }}
                            >
                              <span
                                style={{
                                  color: "#15803d",
                                  fontVariantNumeric: "tabular-nums",
                                }}
                              >
                                +{gitFileStatsByPath[file.path].additions}
                              </span>
                              <span
                                style={{
                                  color: "#b91c1c",
                                  fontVariantNumeric: "tabular-nums",
                                }}
                              >
                                -{gitFileStatsByPath[file.path].deletions}
                              </span>
                            </div>
                          ) : null}
                        </div>
                        <button
                          type="button"
                          aria-label={`移除关联文件 ${file.name}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            onRemoveRelatedFile?.(file.path);
                          }}
                          style={{
                            border: "none",
                            background: "transparent",
                            color: "#dc2626",
                            cursor: "pointer",
                            fontSize: "14px",
                            lineHeight: 1,
                            padding: "2px 4px",
                            borderRadius: "4px",
                            flexShrink: 0,
                          }}
                        >
                          x
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
            <div ref={scrollEndRef} style={{ height: "1px" }} />
          </div>
        </div>
      </div>
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        @keyframes sessionLoadingPulse {
          0% { background-position: 100% 0; opacity: 0.7; }
          50% { opacity: 1; }
          100% { background-position: -100% 0; opacity: 0.7; }
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

export const SessionViewer = memo(
  SessionViewerInner,
  (prev, next) =>
    prev.session === next.session &&
    prev.loading === next.loading &&
    prev.rootId === next.rootId &&
    prev.rootPath === next.rootPath &&
    prev.interactionMode === next.interactionMode &&
    prev.gitFileStatsByPath === next.gitFileStatsByPath &&
    prev.onRootClick === next.onRootClick,
);

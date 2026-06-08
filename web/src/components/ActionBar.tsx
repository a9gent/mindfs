import React, { useCallback, useEffect, useRef, useState } from "react";
import { type SessionMode } from "./ModeSelector";
import { ModeSelector } from "./ModeSelector";
import { AgentSelector } from "./AgentSelector";
import { fetchAgents, fetchShells, restartAgent, type AgentStatus, type ShellStatus } from "../services/agents";
import { fetchCandidates, type CandidateItem } from "../services/candidates";
import { reportError } from "../services/error";
import { uploadFiles } from "../services/upload";
import {
  APPEARANCE_CHANGE_EVENT,
  getAppearanceMode,
  getEffectiveAppearanceMode,
} from "../services/appearance";
import TokenEditor, {
  type TokenEditorHandle,
} from "./editor/TokenEditor";
import { renderToolIcon } from "./stream/ToolCallCard";

type SessionInfo = {
  key: string;
  session_key?: string;
  name: string;
  type: "chat" | "plugin" | "command";
  agent: string;
  model?: string;
  shell?: string;
  mode?: string;
  effort?: string;
  fast_service?: string;
  pending?: boolean;
};

type PendingAttachment = {
  id: string;
  file: File;
  previewUrl?: string;
  isImage: boolean;
};

type AttachedFileContext = {
  filePath: string;
  fileName: string;
  startLine?: number;
  endLine?: number;
  text?: string;
};

type QueuedMessageInfo = {
  id: string;
  content: string;
  created_at?: string;
};

type WSStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

function getSelectionPreview(text?: string): string {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return "...";
  }
  return `${Array.from(trimmed).slice(0, 3).join("")}...`;
}

type ActionBarProps = {
  status?: WSStatus;
  agentsVersion?: number;
  currentRootId?: string | null;
  currentSession?: SessionInfo | null;
  attachedFileContext?: AttachedFileContext | null;
  canOpenSessionDrawer?: boolean;
  sessionDrawerOpen?: boolean;
  detachedBoundSession?: boolean;
  editDraftRequest?: {
    id: number;
    content: string;
  } | null;
  queuedMessages?: QueuedMessageInfo[];
  mobileEnterKeySends?: boolean;
  onSendMessage?: (
    message: string,
    mode: SessionMode,
    agent: string,
    model?: string,
    agentMode?: string,
    effort?: string,
    fastService?: "" | "on" | "off",
    shell?: string,
  ) => void | Promise<void>;
  onCancelCurrentTurn?: (sessionKey: string) => void;
  onRemoveQueuedMessage?: (queueId: string) => void | Promise<void>;
  onUpdateQueuedMessage?: (queueId: string, content: string) => void | Promise<void>;
  onSendQueuedMessageNow?: (queueId: string) => void | Promise<void>;
  onNewSession?: () => void;
  onRequestFileContext?: () => void;
  onClearFileContext?: () => void;
  onSessionClick?: () => void;
  onToggleLeftSidebar?: () => void;
  onToggleRightSidebar?: () => void;
};

function wsStatusMeta(status: WSStatus): {
  color: string;
  shadow: string;
  label: string;
} {
  switch (status) {
    case "connected":
      return {
        color: "#22c55e",
        shadow: "none",
        label: "WebSocket 连接正常",
      };
    case "connecting":
      return {
        color: "#f59e0b",
        shadow: "none",
        label: "WebSocket 正在连接",
      };
    case "reconnecting":
      return {
        color: "#ef4444",
        shadow: "none",
        label: "WebSocket 已断开，正在重连",
      };
    case "disconnected":
    default:
      return {
        color: "#94a3b8",
        shadow: "none",
        label: "WebSocket 未连接",
      };
  }
}

const modePlaceholders: Record<SessionMode, string> = {
  chat: "给 agent 发消息...",
  plugin: "描述要生成的视图插件...",
  command: "输入命令...",
};

const chatBlurPlaceholders = [
  "给 agent 发消息...",
  "试试输入/ @ #，更快捷",
];

const MOBILE_BREAKPOINT = 768;
const IME_ENTER_GUARD_MS = 120;
const CANDIDATE_FETCH_DEBOUNCE_MS = 512;

function getAgentDefaults(agent?: AgentStatus | null) {
  return {
    model: agent?.default_model_id || agent?.current_model_id || "",
    effort: agent?.default_effort || "",
    fastService: (agent?.default_fast_service || "") as "" | "on" | "off",
  } as const;
}

function buildPendingAttachment(file: File): PendingAttachment {
  const isImage = file.type.startsWith("image/");
  const fallbackExt = file.type.split("/")[1] || "png";
  const fileName = file.name || `pasted-image-${Date.now()}.${fallbackExt}`;
  const normalizedFile = file.name
    ? file
    : new File([file], fileName, {
      type: file.type || "image/png",
      lastModified: file.lastModified || Date.now(),
    });
  return {
    id: `${normalizedFile.name}-${normalizedFile.size}-${normalizedFile.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
    file: normalizedFile,
    isImage,
    previewUrl: isImage ? URL.createObjectURL(normalizedFile) : undefined,
  };
}

function ShellSelector({
  shell,
  shells,
  onShellChange,
  compact = false,
}: {
  shell: string;
  shells: ShellStatus[];
  onShellChange: (shell: string) => void;
  compact?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const selected = shells.find((item) => item.id === shell || item.command === shell || item.resolved_command === shell) || shells.find((item) => item.default) || shells[0];

  useEffect(() => {
    const handlePointerOutside = (event: PointerEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener("pointerdown", handlePointerOutside);
      return () => document.removeEventListener("pointerdown", handlePointerOutside);
    }
  }, [isOpen]);

  return (
    <div ref={dropdownRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => shells.length > 0 && setIsOpen((prev) => !prev)}
        disabled={shells.length === 0}
        title="Shell"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          maxWidth: compact ? "72px" : "92px",
          height: compact ? "24px" : "28px",
          border: "none",
          borderRadius: "8px",
          background: "transparent",
          color: "inherit",
          fontSize: "11px",
          fontWeight: 700,
          lineHeight: 1,
          padding: "0 3px",
          outline: "none",
          cursor: shells.length === 0 ? "default" : "pointer",
          opacity: shells.length === 0 ? 0.45 : 1,
        }}
      >
        <span
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            display: "inline-block",
            maxWidth: "100%",
            padding: "1px 4px",
            borderRadius: "6px",
            background: "#1d4ed8",
            color: "#fff",
            lineHeight: 1.2,
            boxSizing: "border-box",
          }}
        >
          {selected?.label || "shell"}
        </span>
      </button>

      {isOpen && (
        <div
          style={{
            position: "absolute",
            bottom: "calc(100% + 8px)",
            right: 0,
            background: "var(--menu-bg)",
            border: "1px solid var(--menu-border)",
            borderRadius: "12px",
            boxShadow: "0 8px 32px rgba(0,0,0,0.15)",
            zIndex: 1000,
            width: "max-content",
            minWidth: "104px",
            maxWidth: "min(72vw, 180px)",
            padding: "8px 0",
          }}
        >
          <div
            style={{
              padding: "6px 12px",
              fontSize: "11px",
              fontWeight: 600,
              color: "var(--text-secondary)",
              textTransform: "uppercase",
            }}
          >
            Shell
          </div>
          {shells.map((item) => {
            const isSelected = item.id === selected?.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  onShellChange(item.id);
                  setIsOpen(false);
                }}
                style={{
                  display: "block",
                  width: "100%",
                  padding: "9px 12px",
                  border: "none",
                  background: isSelected ? "rgba(59, 130, 246, 0.08)" : "transparent",
                  color: isSelected ? "var(--accent-color)" : "var(--text-primary)",
                  fontSize: "13px",
                  fontWeight: isSelected ? 700 : 500,
                  textAlign: "left",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
                onMouseEnter={(event) => {
                  if (!isSelected) {
                    event.currentTarget.style.background = "rgba(0,0,0,0.04)";
                  }
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.background = isSelected ? "rgba(59, 130, 246, 0.08)" : "transparent";
                }}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function useResponsive() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const checkSize = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    checkSize();
    window.addEventListener("resize", checkSize);
    return () => window.removeEventListener("resize", checkSize);
  }, []);
  return { isMobile };
}

function candidateNameColor(candidateType: CandidateItem["type"], isDark: boolean): string {
  switch (candidateType) {
    case "slash_command":
      return isDark ? "#93c5fd" : "#1d4ed8";
    case "prompt":
      return isDark ? "#fcd34d" : "#b45309";
    case "skill":
      return isDark ? "#c4b5fd" : "#7c3aed";
    default:
      return "var(--text-primary)";
  }
}

function replaceActiveTokenText(input: string, activeToken: { type: "file" | "slash" | "prompt" | "command"; query: string } | null, value: string): string {
  if (!activeToken) return input;
  const trigger = activeToken.type === "file" ? "@" : activeToken.type === "prompt" ? "#" : activeToken.type === "slash" ? "/" : "";
  if (!trigger) return value;
  const needle = `${trigger}${activeToken.query}`;
  const index = input.lastIndexOf(needle);
  if (index < 0) {
    return `${input}${value} `;
  }
  return `${input.slice(0, index)}${value} ${input.slice(index + needle.length)}`;
}

export function ActionBar({
  status = "disconnected",
  agentsVersion = 0,
  currentRootId,
  currentSession,
  attachedFileContext,
  canOpenSessionDrawer = false,
  sessionDrawerOpen = false,
  detachedBoundSession = false,
  editDraftRequest = null,
  queuedMessages = [],
  onSendMessage,
  onCancelCurrentTurn,
  onRemoveQueuedMessage,
  onUpdateQueuedMessage,
  onSendQueuedMessageNow,
  onNewSession,
  onRequestFileContext,
  onClearFileContext,
  onSessionClick,
  onToggleLeftSidebar,
  onToggleRightSidebar,
  mobileEnterKeySends = false,
}: ActionBarProps) {
  const [mode, setMode] = useState<SessionMode>("chat");
  const [agent, setAgent] = useState("");
  const [model, setModel] = useState("");
  const [agentMode, setAgentMode] = useState("");
  const [effort, setEffort] = useState("");
  const [fastService, setFastService] = useState<"" | "on" | "off">("");
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [shells, setShells] = useState<ShellStatus[]>([]);
  const [shell, setShell] = useState("");
  const [serializedInput, setSerializedInput] = useState("");
  const [activeToken, setActiveToken] = useState<{ type: "file" | "slash" | "prompt" | "command"; query: string } | null>(null);
  const [dragX, setDragX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null);
  const [editingQueueText, setEditingQueueText] = useState("");
  const [isMultiLine, setIsMultiLine] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [isDark, setIsDark] = useState(() => getEffectiveAppearanceMode() === "dark");
  const [blurPlaceholder, setBlurPlaceholder] = useState(
    () => chatBlurPlaceholders[Math.floor(Math.random() * chatBlurPlaceholders.length)] || modePlaceholders.chat,
  );
  const [candidates, setCandidates] = useState<CandidateItem[]>([]);
  const [activeCandidateIndex, setActiveCandidateIndex] = useState(0);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const dragStartRef = useRef(0);
  const syncedSessionSignatureRef = useRef<string>("");
  const editorRef = useRef<TokenEditorHandle>(null);
  const candidateAbortRef = useRef<AbortController | null>(null);
  const candidateItemRefs = useRef<Array<HTMLDivElement | null>>([]);
  const suppressedCommandCandidateTextRef = useRef("");
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);
  const compositionGuardUntilRef = useRef(0);
  const { isMobile } = useResponsive();
  const isConnected = status === "connected";
  const connectionMeta = wsStatusMeta(status);
  const DRAG_THRESHOLD = -40;
  const boundRingColor = detachedBoundSession ? "#f59e0b" : "#2563eb";
  const boundRingShadow = detachedBoundSession
    ? "0 0 0 1px rgba(245,158,11,0.18)"
    : "0 0 0 1px rgba(37,99,235,0.08)";
  const boundArrowColor = detachedBoundSession ? "#f59e0b" : "#2563eb";

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const syncAppearance = () => setIsDark(getEffectiveAppearanceMode() === "dark");
    const onSystemChange = () => {
      if (getAppearanceMode() === "system") {
        syncAppearance();
      }
    };
    window.addEventListener(APPEARANCE_CHANGE_EVENT, syncAppearance);
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", onSystemChange);
      return () => {
        window.removeEventListener(APPEARANCE_CHANGE_EVENT, syncAppearance);
        media.removeEventListener("change", onSystemChange);
      };
    }
    media.addListener(onSystemChange);
    return () => {
      window.removeEventListener(APPEARANCE_CHANGE_EVENT, syncAppearance);
      media.removeListener(onSystemChange);
    };
  }, []);

  useEffect(() => {
    const sessionKey = currentSession?.key || currentSession?.session_key || null;
    if (!currentSession) {
      syncedSessionSignatureRef.current = "";
      return;
    }
    const nextMode = currentSession.type === "plugin" ? "plugin" : currentSession.type === "command" ? "command" : "chat";
    const nextAgent = currentSession.agent || "";
    const nextModel = currentSession.model || "";
    const nextShell = currentSession.shell || "";
    const nextAgentMode = currentSession.mode || "";
    const nextEffort = currentSession.effort || "";
    const nextFastService = (currentSession.fast_service || "") as "" | "on" | "off";
    const signature = `${sessionKey || ""}::${nextMode}::${nextAgent}::${nextModel}::${nextShell}::${nextAgentMode}::${nextEffort}::${nextFastService}`;
    if (syncedSessionSignatureRef.current === signature) {
      return;
    }
    syncedSessionSignatureRef.current = signature;
    setMode(nextMode);
    setAgent(nextAgent);
    setModel(nextModel);
    setShell(nextShell);
    setAgentMode(nextAgentMode);
    setEffort(nextEffort);
    setFastService(nextFastService);
  }, [currentSession]);

  useEffect(() => {
    if (!currentSession?.pending) {
      setCancelling(false);
    }
  }, [currentSession?.pending]);

  useEffect(() => {
    Promise.all([fetchAgents(true), fetchShells(true)])
      .then(([nextAgents, nextShells]) => {
        setAgents(nextAgents);
        setShells(nextShells);
      })
      .catch((err) => console.error("Failed to fetch agents:", err));
  }, [agentsVersion]);

  useEffect(() => {
    if (mode !== "command" || shells.length === 0) {
      return;
    }
    if (shells.some((item) => item.id === shell || item.command === shell || item.resolved_command === shell)) {
      return;
    }
    const preferred = shells.find((item) => item.default) || shells[0];
    setShell(preferred?.id || "");
  }, [mode, shell, shells]);

  useEffect(() => {
    if (currentSession || agents.length === 0) return;
    if (agents.some((a) => a.name === agent)) return;
    const preferred = agents.find((a) => a.available) ?? agents[0];
    if (!preferred) {
      return;
    }
    const defaults = getAgentDefaults(preferred);
    setAgent(preferred.name);
    setModel(defaults.model);
    setAgentMode("");
    setEffort(defaults.effort);
    setFastService(defaults.fastService);
  }, [agent, agents, currentSession]);

  useEffect(() => {
    if (!agent || !model) {
      return;
    }
    const selectedAgent = agents.find((item) => item.name === agent);
    if (!selectedAgent) {
      return;
    }
    const hasModel = (selectedAgent.models ?? []).some((item) => item.id === model);
    if (!hasModel) {
      setModel("");
    }
  }, [agent, model, agents]);

  const selectedAgent = agents.find((item) => item.name === agent);
  const selectedModelInfo =
    (selectedAgent?.models ?? []).find((item) => item.id === model)
    || (selectedAgent?.models ?? []).find(
      (item) => item.id === (selectedAgent?.default_model_id || selectedAgent?.current_model_id),
    );
  const availableEfforts = selectedAgent?.efforts ?? [];
  const isCodexEffortAgent = selectedAgent?.name === "codex";
  const supportsEffort =
    availableEfforts.length > 0 && !!selectedModelInfo?.supportEffort;
  const supportsServiceTier = !!selectedAgent?.supports_fast_service;

  useEffect(() => {
    if (!supportsEffort) {
      if (effort) {
        setEffort("");
      }
      return;
    }
    if (effort && !availableEfforts.includes(effort)) {
      setEffort(getAgentDefaults(selectedAgent).effort);
    }
  }, [supportsEffort, effort, availableEfforts, selectedAgent, isCodexEffortAgent]);

  useEffect(() => {
    if (!supportsServiceTier) {
      return;
    }
    if (fastService === "on" && !selectedAgent?.supports_fast_service) {
      setFastService(getAgentDefaults(selectedAgent).fastService);
    }
  }, [supportsServiceTier, fastService, selectedAgent]);

  useEffect(() => () => candidateAbortRef.current?.abort(), []);

  useEffect(() => {
    if (mode !== "command") {
      return;
    }
    if (!isFocused) {
      candidateAbortRef.current?.abort();
      setActiveToken(null);
      setCandidates([]);
      setActiveCandidateIndex(0);
    }
  }, [mode, isFocused]);

  useEffect(() => {
    return () => {
      pendingAttachments.forEach((attachment) => {
        if (attachment.previewUrl) {
          URL.revokeObjectURL(attachment.previewUrl);
        }
      });
    };
  }, []);

  useEffect(() => {
    if (!activeToken || !currentRootId || (activeToken.type === "slash" && mode !== "command" && !agent)) {
      candidateAbortRef.current?.abort();
      setCandidates([]);
      setActiveCandidateIndex(0);
      return;
    }
    const controller = new AbortController();
    candidateAbortRef.current?.abort();
    candidateAbortRef.current = controller;
    const timer = window.setTimeout(() => {
      fetchCandidates({
        rootId: currentRootId,
        type: activeToken.type === "file"
          ? "file"
          : activeToken.type === "prompt"
            ? "prompt"
            : activeToken.type === "command" || mode === "command"
              ? "command"
              : "skill",
        query: activeToken.query,
        agent: activeToken.type === "slash" && mode !== "command" ? agent : undefined,
        signal: controller.signal,
      })
        .then((items) => {
          const nextItems = activeToken.type === "command"
            ? items.filter((item) => item.name.trim() !== activeToken.query.trim())
            : items;
          setCandidates(nextItems);
          setActiveCandidateIndex(activeToken.type === "command" ? -1 : 0);
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          console.error("Failed to fetch candidates:", err);
          setCandidates([]);
          setActiveCandidateIndex(0);
        });
    }, CANDIDATE_FETCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [activeToken, currentRootId, agent, mode]);

  useEffect(() => {
    if (candidates.length === 0) {
      candidateItemRefs.current = [];
      return;
    }
    if (activeCandidateIndex < 0) {
      return;
    }
    const activeItem = candidateItemRefs.current[activeCandidateIndex];
    if (!activeItem) {
      return;
    }
    activeItem.scrollIntoView({ block: "nearest" });
  }, [candidates, activeCandidateIndex]);

  const syncEditorHeight = useCallback(() => {
    const height = editorRef.current?.getHeight() || 44;
    setIsMultiLine(height > 50);
  }, []);

  useEffect(() => {
    if (!editDraftRequest) {
      return;
    }
    const nextText = editDraftRequest.content || "";
    editorRef.current?.setText(nextText);
    setSerializedInput(nextText);
    setActiveToken(null);
    setCandidates([]);
    setActiveCandidateIndex(0);
    requestAnimationFrame(syncEditorHeight);
  }, [editDraftRequest, syncEditorHeight]);

  const appendPendingAttachments = useCallback((files: File[]) => {
    if (files.length === 0) {
      return;
    }
    setPendingAttachments((prev) => [...prev, ...files.map(buildPendingAttachment)]);
  }, []);

  const handleEditorChange = useCallback((payload: {
    serializedText: string;
    displayText: string;
    activeToken: { type: "file" | "slash" | "prompt" | "command"; query: string } | null;
  }) => {
    setSerializedInput(payload.serializedText);
    if (mode === "command") {
      const query = payload.displayText.trim();
      if (!query) {
        suppressedCommandCandidateTextRef.current = "";
        setActiveToken(null);
      } else if (payload.activeToken) {
        suppressedCommandCandidateTextRef.current = "";
        setActiveToken(payload.activeToken);
      } else if (query === suppressedCommandCandidateTextRef.current) {
        setActiveToken(null);
      } else {
        suppressedCommandCandidateTextRef.current = "";
        setActiveToken({ type: "command", query });
      }
    } else {
      suppressedCommandCandidateTextRef.current = "";
      setActiveToken(payload.activeToken);
    }
    if (payload.displayText.trim().length === 0) {
      setIsMultiLine(false);
      return;
    }
    requestAnimationFrame(syncEditorHeight);
  }, [mode, syncEditorHeight]);

  const applyCandidate = useCallback((candidate: CandidateItem) => {
    if (!activeToken) return;
    setCandidates([]);
    setActiveCandidateIndex(0);
    if (candidate.type === "command") {
      suppressedCommandCandidateTextRef.current = candidate.name.trim();
      editorRef.current?.setText(candidate.name);
    } else if (mode === "command" && candidate.type === "file") {
      suppressedCommandCandidateTextRef.current = "";
      const nextText = replaceActiveTokenText(serializedInput, activeToken, candidate.name);
      editorRef.current?.setText(nextText);
      setSerializedInput(nextText);
    } else {
      suppressedCommandCandidateTextRef.current = "";
      editorRef.current?.insertCandidate(candidate.type, candidate.name);
    }
    editorRef.current?.focus();
    syncEditorHeight();
  }, [activeToken, mode, serializedInput, syncEditorHeight]);

  const handleSend = useCallback(async () => {
    const messageText = serializedInput.trim();
    if ((!messageText && pendingAttachments.length === 0) || !isConnected || sending || (mode !== "command" && !agent)) return;
    setSending(true);
    setCandidates([]);
    setActiveCandidateIndex(0);
    try {
      let attachmentTokens = "";
      if (pendingAttachments.length > 0) {
        if (!currentRootId) {
          reportError("file.write_failed", "当前未选择项目，无法上传附件");
          return;
        }
        const uploaded = await uploadFiles({
          rootId: currentRootId,
          files: pendingAttachments.map((attachment) => attachment.file),
        });
        attachmentTokens = uploaded
          .map((file) => `[read file: ${file.path}]`)
          .join("\n");
      }
      const payload = [messageText, attachmentTokens].filter(Boolean).join("\n");
      if (!payload) {
        return;
      }
      await onSendMessage?.(
        payload,
        mode,
        mode === "command" ? "" : agent,
        model || undefined,
        agentMode || undefined,
        supportsEffort ? effort || undefined : undefined,
        supportsServiceTier ? fastService : undefined,
        mode === "command" ? shell || undefined : undefined,
      );
      editorRef.current?.clear();
      setSerializedInput("");
      setActiveToken(null);
      setCandidates([]);
      setActiveCandidateIndex(0);
      setPendingAttachments((prev) => {
        prev.forEach((attachment) => {
          if (attachment.previewUrl) {
            URL.revokeObjectURL(attachment.previewUrl);
          }
        });
        return [];
      });
      setIsMultiLine(false);
      if (isMobile) {
        requestAnimationFrame(() => editorRef.current?.blur());
      }
    } catch (err) {
      reportError("file.write_failed", String((err as Error)?.message || "附件上传失败"));
    } finally {
      setSending(false);
      if (!isMobile) {
        requestAnimationFrame(() => editorRef.current?.focus());
      }
    }
  }, [serializedInput, pendingAttachments, isConnected, sending, agent, model, agentMode, onSendMessage, mode, currentRootId, supportsEffort, effort, supportsServiceTier, fastService, isMobile]);

  const handleCancel = useCallback(async () => {
    const sessionKey = currentSession?.key;
    if (!sessionKey || cancelling) return;
    setCancelling(true);
    try {
      await onCancelCurrentTurn?.(sessionKey);
    } finally {
      // Reset is driven by currentSession.pending.
    }
  }, [currentSession?.key, cancelling, onCancelCurrentTurn]);

  const startEditQueuedMessage = useCallback((item: QueuedMessageInfo) => {
    setEditingQueueId(item.id);
    setEditingQueueText(item.content || "");
  }, []);

  const saveEditQueuedMessage = useCallback(async () => {
    const queueId = editingQueueId;
    const nextText = editingQueueText.trim();
    if (!queueId || !nextText) return;
    await onUpdateQueuedMessage?.(queueId, nextText);
    setEditingQueueId(null);
    setEditingQueueText("");
  }, [editingQueueId, editingQueueText, onUpdateQueuedMessage]);

  const cancelEditQueuedMessage = useCallback(() => {
    setEditingQueueId(null);
    setEditingQueueText("");
  }, []);

  useEffect(() => {
    if (!editingQueueId) return;
    if (!queuedMessages.some((item) => item.id === editingQueueId)) {
      cancelEditQueuedMessage();
    }
  }, [cancelEditQueuedMessage, editingQueueId, queuedMessages]);

  const isCompositionActive = useCallback((event?: KeyboardEvent | null) => {
    const nativeEvent = event as (KeyboardEvent & { isComposing?: boolean; keyCode?: number }) | null | undefined;
    return isComposingRef.current
      || performance.now() < compositionGuardUntilRef.current
      || !!nativeEvent?.isComposing
      || nativeEvent?.keyCode === 229;
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (isCompositionActive(e.nativeEvent)) {
      return;
    }
    if (candidates.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveCandidateIndex((prev) => (prev < 0 ? 0 : (prev + 1) % candidates.length));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveCandidateIndex((prev) => (prev < 0 ? candidates.length - 1 : (prev - 1 + candidates.length) % candidates.length));
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        if (activeCandidateIndex >= 0) {
          applyCandidate(candidates[activeCandidateIndex]);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setCandidates([]);
        setActiveCandidateIndex(0);
        return;
      }
    }
  }, [candidates, activeCandidateIndex, applyCandidate, isCompositionActive]);

  const handleEditorEnter = useCallback((event: KeyboardEvent | null) => {
    if (isCompositionActive(event)) {
      return false;
    }
    if (event?.shiftKey) {
      return false;
    }
    if (candidates.length > 0) {
      if (activeCandidateIndex >= 0) {
        event?.preventDefault();
        event?.stopPropagation();
        applyCandidate(candidates[activeCandidateIndex]);
        return true;
      }
      if (mode !== "command") {
        event?.preventDefault();
        event?.stopPropagation();
        applyCandidate(candidates[0]);
        return true;
      }
    }
    if (!isMobile || (mobileEnterKeySends && mode === "chat")) {
      event?.preventDefault();
      event?.stopPropagation();
      void handleSend();
      return true;
    }
    return false;
  }, [candidates, activeCandidateIndex, applyCandidate, handleSend, isCompositionActive, isMobile, mobileEnterKeySends, mode]);

  const handleEditorPaste = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
    if (sending || !currentRootId) {
      return;
    }
    const clipboardItems = Array.from(event.clipboardData?.items || []);
    const imageFiles = clipboardItems
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
    if (imageFiles.length === 0) {
      return;
    }
    event.preventDefault();
    appendPendingAttachments(imageFiles);
  }, [appendPendingAttachments, currentRootId, sending]);

  const resetForNewSession = useCallback(() => {
    const nextAgent = agents.find((item) => item.name === agent)
      || agents.find((item) => item.available)
      || agents[0];
    if (!nextAgent) {
      return;
    }
    const defaults = getAgentDefaults(nextAgent);
    setAgent(nextAgent.name);
    setModel(defaults.model);
    setAgentMode("");
    setEffort(defaults.effort);
    setFastService(defaults.fastService);
    syncedSessionSignatureRef.current = "";
  }, [agent, agents]);

  const handleDragStart = (e: React.MouseEvent | React.TouchEvent) => {
    const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
    dragStartRef.current = clientX;
    setIsDragging(true);
  };

  const handleDragEnd = useCallback(() => {
    if (!isDragging) return;
    if (dragX <= DRAG_THRESHOLD) {
      resetForNewSession();
      onNewSession?.();
    }
    setDragX(0);
    setIsDragging(false);
  }, [isDragging, dragX, onNewSession, resetForNewSession]);

  useEffect(() => {
    if (!isDragging) return;
    const move = (e: MouseEvent | TouchEvent) => {
      const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
      setDragX(Math.min(0, clientX - dragStartRef.current));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", handleDragEnd);
    window.addEventListener("touchmove", move);
    window.addEventListener("touchend", handleDragEnd);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", handleDragEnd);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", handleDragEnd);
    };
  }, [isDragging, handleDragEnd]);

  const isSelectedAgentUnavailable = agents.length > 0 ? agents.find((a) => a.name === agent)?.available === false : false;
  const canSend = (!!serializedInput.trim() || pendingAttachments.length > 0) && isConnected && !sending && (mode === "command" || !!agent);
  const hasBoundSession = !!currentSession;
  const hasDraft = !!serializedInput.trim() || pendingAttachments.length > 0;
  const showCancel = !!currentSession?.pending && !!currentSession?.key && !hasDraft;
  const isModeLocked = !!currentSession;

  useEffect(() => {
    if (isMobile || !showCancel) {
      return;
    }
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape" || isCompositionActive(event) || event.repeat) {
        return;
      }
      event.preventDefault();
      void handleCancel();
    };
    window.addEventListener("keydown", cancelOnEscape);
    return () => window.removeEventListener("keydown", cancelOnEscape);
  }, [handleCancel, isCompositionActive, isMobile, showCancel]);

  const inputPlaceholder = currentSession && !currentSession.pending
    ? "左滑蓝环开始新会话..."
    : mode === "chat" && !isFocused
      ? blurPlaceholder
      : modePlaceholders[mode];
  const editorRightInset = isMultiLine ? 14 : mode === "command" ? (isMobile ? 92 : 116) : isMobile ? 124 : 148;
  const editorBottomInset = isMultiLine ? 44 : 12;
  const editorMinHeight = 44;

  return (
    <div style={{ width: "100%", minWidth: 0, padding: isMobile ? "0 0 var(--mindfs-actionbar-bottom-padding, calc(env(safe-area-inset-bottom, 0px) + 2px))" : "0 16px 12px", display: "flex", justifyContent: "center", boxSizing: "border-box", background: "var(--content-bg)" }}>
      <div style={{ width: "100%", minWidth: 0, display: "flex", flexDirection: "column", gap: isMobile ? "0" : "6px" }}>
        {queuedMessages.length > 0 ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "3px",
              padding: isMobile ? "0 31px 3px" : "0",
              maxHeight: isMobile ? "116px" : "144px",
              overflowY: "auto",
              scrollbarWidth: "thin",
            }}
          >
            {queuedMessages.map((item) => (
              <div
                key={item.id}
                style={{
                  position: "relative",
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1fr) auto",
                  alignItems: "center",
                  gap: "6px",
                  minHeight: "28px",
                  padding: "2px 3px 2px 9px",
                  border: "1px solid color-mix(in srgb, var(--accent-color) 32%, transparent)",
                  borderRadius: "8px",
                  background: "var(--panel-bg)",
                  boxShadow: isMobile ? "none" : "var(--panel-shadow)",
                }}
              >
                {editingQueueId === item.id ? (
                  <input
                    value={editingQueueText}
                    onChange={(event) => setEditingQueueText(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void saveEditQueuedMessage();
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        cancelEditQueuedMessage();
                      }
                    }}
                    autoFocus
                    style={{
                      minWidth: 0,
                      height: "24px",
                      border: "none",
                      borderRadius: 0,
                      background: "transparent",
                      color: "var(--text-primary)",
                      fontSize: "12px",
                      padding: 0,
                      outline: "none",
                    }}
                  />
                ) : (
                  <div
                    title={item.content}
                    style={{
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontSize: "12px",
                      color: "var(--text-secondary)",
                      lineHeight: 1.35,
                    }}
                  >
                    {item.content}
                  </div>
                )}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "3px",
                  }}
                >
                  {editingQueueId === item.id ? (
                    <>
                      <button
                        type="button"
                        aria-label="保存排队消息"
                        title="保存"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => void saveEditQueuedMessage()}
                        disabled={!editingQueueText.trim()}
                        style={{ width: "28px", height: "28px", border: "none", borderRadius: "7px", background: "transparent", color: editingQueueText.trim() ? "var(--accent-color)" : "var(--text-secondary)", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: editingQueueText.trim() ? "pointer" : "not-allowed", opacity: editingQueueText.trim() ? 1 : 0.45 }}
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        aria-label="取消编辑排队消息"
                        title="取消"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={cancelEditQueuedMessage}
                        style={{ width: "28px", height: "28px", border: "none", borderRadius: "7px", background: "transparent", color: "var(--text-secondary)", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M18 6 6 18" />
                          <path d="m6 6 12 12" />
                        </svg>
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        aria-label="删除排队消息"
                        title="删除"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => void onRemoveQueuedMessage?.(item.id)}
                        style={{ width: "28px", height: "28px", border: "none", borderRadius: "7px", background: "transparent", color: "#dc2626", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6l-1 14H6L5 6" />
                          <path d="M10 11v6" />
                          <path d="M14 11v6" />
                          <path d="M9 6V4h6v2" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        aria-label="编辑排队消息"
                        title="编辑"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => startEditQueuedMessage(item)}
                        style={{ width: "28px", height: "28px", border: "none", borderRadius: "7px", background: "transparent", color: "var(--text-secondary)", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
                      >
                        <span style={{ display: "inline-flex", transform: "scale(1.125)" }}>
                          {renderToolIcon("edit")}
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-label="立即发送排队消息"
                        title="立即发送"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => void onSendQueuedMessageNow?.(item.id)}
                        style={{ width: "28px", height: "28px", border: "none", borderRadius: "7px", background: "transparent", color: "var(--text-secondary)", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M0 0h24v24H0z" fill="none" />
                          <g fill="currentColor" fillRule="evenodd" clipRule="evenodd">
                            <path d="M3 14a1 1 0 0 1 1-1h12a3 3 0 0 0 3-3V6a1 1 0 1 1 2 0v4a5 5 0 0 1-5 5H4a1 1 0 0 1-1-1" />
                            <path d="M3.293 14.707a1 1 0 0 1 0-1.414l4-4a1 1 0 0 1 1.414 1.414L5.414 14l3.293 3.293a1 1 0 1 1-1.414 1.414z" />
                          </g>
                        </svg>
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : null}
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "30px minmax(0, 1fr) 30px" : "1fr", alignItems: "center", gap: isMobile ? "1px" : 0, padding: isMobile ? "0 1px" : 0, minWidth: 0, maxWidth: "100%" }}>
          {isMobile ? (
            <button
              type="button"
              onClick={onToggleLeftSidebar}
              style={{ width: "30px", height: "44px", borderRadius: "0", border: "none", background: "transparent", color: "var(--text-secondary)", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", opacity: 0.86, outline: "none", boxShadow: "none", WebkitTapHighlightColor: "transparent" as any, overflow: "hidden" }}
              aria-label="打开文件侧栏"
              title="文件侧栏"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none">
                <path fill="currentColor" d="M3 3h6v4H3zm12 7h6v4h-6zm0 7h6v4h-6zm-2-4H7v5h6v2H5V9h2v2h6z" style={{ transform: "scale(1.28)", transformOrigin: "12px 12px" }} />
              </svg>
            </button>
          ) : null}

          <div
            data-mindfs-command-input-width="1"
            style={{
              background: "var(--panel-bg)",
              border: isFocused
                ? "1px solid var(--accent-color)"
                : "1px solid var(--panel-border)",
              borderRadius: isMobile ? "10px" : "12px",
              boxShadow: isMobile
                ? "none"
                : (isFocused ? "var(--panel-focus-shadow)" : "var(--panel-shadow)"),
              display: "flex",
              alignItems: "center",
              position: "relative",
              transition: isDragging ? "none" : "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
              minHeight: `${editorMinHeight}px`,
              minWidth: 0,
              overflow: "visible",
            }}
          >
            <TokenEditor
              ref={editorRef}
              placeholder={inputPlaceholder}
              disabled={sending}
              isDark={isDark}
              rightInset={editorRightInset}
              bottomInset={editorBottomInset}
              onChange={handleEditorChange}
              onFocusChange={(focused) => {
                setIsFocused(focused);
                if (!focused && mode === "chat") {
                  setBlurPlaceholder(
                    chatBlurPlaceholders[Math.floor(Math.random() * chatBlurPlaceholders.length)] || modePlaceholders.chat,
                  );
                }
                if (focused) {
                  if (mode === "command" && serializedInput.trim()) {
                    setActiveToken({ type: "command", query: serializedInput.trim() });
                  }
                  onRequestFileContext?.();
                }
              }}
              onPointerDown={onRequestFileContext}
              onKeyDown={handleKeyDown}
              onPaste={handleEditorPaste}
              onEnter={handleEditorEnter}
              enterKeyHint={isMobile && mobileEnterKeySends && mode === "chat" ? "send" : undefined}
              onCompositionStart={() => {
                isComposingRef.current = true;
                compositionGuardUntilRef.current = 0;
              }}
              onCompositionEnd={() => {
                isComposingRef.current = false;
                compositionGuardUntilRef.current = performance.now() + IME_ENTER_GUARD_MS;
              }}
            />

            {activeToken && (candidates.length > 0 || activeToken.type === "prompt") ? (
              <div
                style={{
                  position: "absolute",
                  left: "8px",
                  right: "8px",
                  bottom: "calc(100% + 8px)",
                  background: "var(--menu-bg)",
                  border: "1px solid var(--menu-border)",
                  borderRadius: "12px",
                  boxShadow: "0 12px 32px rgba(0,0,0,0.16)",
                  overflowX: "hidden",
                  overflowY: "auto",
                  maxHeight: isMobile ? "min(55vh, 416px)" : "320px",
                  WebkitOverflowScrolling: "touch",
                  scrollbarWidth: "thin",
                  zIndex: 20,
                }}
              >
                {candidates.length === 0 ? (
                  <div
                    style={{
                      padding: "11px 12px",
                      fontSize: "12px",
                      color: "var(--text-secondary)",
                      lineHeight: 1.5,
                    }}
                  >
                    {activeToken.type === "command" ? "暂无命令历史，成功执行后会出现在这里" : "收藏用户消息后，可快速插入提示词"}
                  </div>
                ) : (
                  candidates.map((candidate, index) => (
                    <div
                      key={`${candidate.type}:${candidate.name}`}
                      ref={(element) => {
                        candidateItemRefs.current[index] = element;
                      }}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        applyCandidate(candidate);
                      }}
                      role="option"
                      aria-selected={index === activeCandidateIndex}
                      style={{
                        display: "flex",
                        flexDirection: candidate.type === "command" ? "row" : "column",
                        alignItems: candidate.type === "command" ? "center" : "flex-start",
                        gap: candidate.type === "command" ? "0" : "2px",
                        width: "100%",
                        padding: candidate.type === "command" ? "8px 12px" : "10px 12px",
                        border: "none",
                        borderTop: index === 0 ? "none" : "1px solid var(--menu-divider)",
                        background: index === activeCandidateIndex ? "var(--menu-active-bg)" : "transparent",
                        color: "var(--text-primary)",
                        cursor: "pointer",
                        textAlign: "left",
                      }}
                    >
                      <span style={{
                        fontSize: "13px",
                        fontWeight: 500,
                        color: candidateNameColor(candidate.type, isDark),
                        minWidth: 0,
                        overflow: candidate.type === "command" ? "hidden" : "visible",
                        textOverflow: candidate.type === "command" ? "ellipsis" : "clip",
                        whiteSpace: candidate.type === "command" ? "nowrap" : "normal",
                      }}>
                        {candidate.type === "file" ? (mode === "command" ? candidate.name : `@${candidate.name}`) : candidate.type === "prompt" ? `#${candidate.name}` : candidate.type === "command" ? candidate.name : `/${candidate.name}`}
                      </span>
                      {candidate.type !== "command" && candidate.description ? (
                        <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>{candidate.description}</span>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            ) : null}

            <span
              aria-label={connectionMeta.label}
              title={connectionMeta.label}
              style={{
                position: "absolute",
                left: "5px",
                bottom: "4px",
                width: "6px",
                height: "6px",
                borderRadius: "50%",
                background: connectionMeta.color,
                boxShadow: connectionMeta.shadow,
                pointerEvents: "auto",
                zIndex: 6,
              }}
            />

            <div style={{ position: "absolute", right: isMobile ? "4px" : "8px", bottom: isMultiLine ? "6px" : "50%", transform: isMultiLine ? "none" : "translateY(50%)", display: "flex", alignItems: "center", gap: isMobile ? "0px" : "2px", zIndex: 5, transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)" }}>
              <div
                onMouseDown={handleDragStart}
                onTouchStart={handleDragStart}
                onClick={() => {
                  if (Math.abs(dragX) < 5) {
                    onSessionClick?.();
                  }
                }}
                style={{
                  width: "32px",
                  height: "32px",
                  cursor: "pointer",
                  transform: `translateX(${dragX}px)`,
                  transition: isDragging ? "none" : "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
                  position: "relative",
                  zIndex: 10,
                  opacity: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  touchAction: "none",
                }}
                title="左滑新建会话"
              >
                {!hasBoundSession ? (
                  <div
                    style={{
                      width: "14px",
                      height: "14px",
                      borderRadius: "50%",
                      background: "transparent",
                      border: "2px solid #94a3b8",
                    }}
                  />
                ) : (
                  <div
                    style={{
                      width: "14px",
                      height: "14px",
                      borderRadius: "50%",
                      background: "transparent",
                      border: `2px solid ${boundRingColor}`,
                      boxShadow: boundRingShadow,
                    }}
                  />
                )}
                {canOpenSessionDrawer ? (
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    style={{
                      position: "absolute",
                      inset: 0,
                      margin: "auto",
                      color: boundArrowColor,
                      pointerEvents: "none",
                    }}
                    aria-hidden="true"
                  >
                    <path
                      d={sessionDrawerOpen ? "M3.25 4.75 6 7.5l2.75-2.75" : "M3.25 7.25 6 4.5l2.75 2.75"}
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : null}
                {isDragging && dragX < -10 ? (
                  <div style={{ position: "absolute", right: "100%", top: "50%", transform: "translateY(-50%)", marginRight: "8px", fontSize: "10px", fontWeight: 600, color: dragX <= DRAG_THRESHOLD ? "var(--accent-color)" : "#9ca3af", whiteSpace: "nowrap", opacity: Math.min(1, Math.abs(dragX) / 20), pointerEvents: "none" }}>
                    {dragX <= DRAG_THRESHOLD ? "松开新建" : "左滑新建"}
                  </div>
                ) : null}
              </div>

              <ModeSelector mode={mode} onModeChange={setMode} compact={true} disabled={isModeLocked} />
              {mode !== "command" ? (
                <AgentSelector
                  agent={agent}
                  model={model}
                  mode={agentMode}
                  effort={effort}
                  agents={agents}
                  onAgentChange={(nextAgent, nextModel) => {
                    const nextStatus = agents.find((item) => item.name === nextAgent);
                    const defaults = getAgentDefaults(nextStatus);
                    setAgent(nextAgent);
                    setModel(nextModel || defaults.model);
                    setAgentMode("");
                    setEffort(defaults.effort);
                    setFastService(defaults.fastService);
                  }}
                  onModeChange={(nextAgentMode) => setAgentMode(nextAgentMode || "")}
                  onEffortChange={(nextEffort) => setEffort(nextEffort || "")}
                  fastService={fastService}
                  onFastServiceChange={(nextFastService) => setFastService(nextFastService || "")}
                  onAgentRestart={async (targetAgent) => {
                    await restartAgent(targetAgent);
                    const items = await fetchAgents(true);
                    setAgents(items);
                  }}
                  compact={true}
                  warnUnavailable={isSelectedAgentUnavailable}
                />
              ) : (
                <ShellSelector
                  shell={shell}
                  shells={shells}
                  onShellChange={setShell}
                  compact={true}
                />
              )}

              <button
                type="button"
                onClick={() => attachmentInputRef.current?.click()}
                disabled={!currentRootId || sending}
                style={{
                  width: "28px",
                  height: "28px",
                  borderRadius: "8px",
                  border: "none",
                  background: pendingAttachments.length > 0
                    ? "rgba(59,130,246,0.14)"
                    : "transparent",
                  color: pendingAttachments.length > 0
                    ? "var(--accent-color)"
                    : "var(--text-secondary)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: !currentRootId || sending ? "not-allowed" : "pointer",
                  opacity: !currentRootId || sending ? 0.35 : 1,
                }}
                title="添加附件"
                aria-label="添加附件"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <path d="M12 5v14" />
                  <path d="M5 12h14" />
                </svg>
              </button>
              <button
                type="button"
                onClick={showCancel ? handleCancel : handleSend}
                disabled={showCancel ? cancelling : !canSend}
                style={{ width: "28px", height: "28px", borderRadius: "8px", border: "none", background: showCancel ? "rgba(239,68,68,0.14)" : (canSend ? "var(--accent-color)" : "transparent"), color: showCancel ? "#ef4444" : (canSend ? "#fff" : "var(--text-secondary)"), display: "flex", alignItems: "center", justifyContent: "center", cursor: showCancel ? (cancelling ? "wait" : "pointer") : (canSend ? "pointer" : "not-allowed"), transition: "all 0.2s", opacity: showCancel ? 1 : (canSend ? 1 : 0.3) }}
              >
                {sending || cancelling ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ animation: "spin 1s linear infinite" }}><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                ) : showCancel ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2.5" /></svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
                )}
              </button>
              <input
                ref={attachmentInputRef}
                type="file"
                multiple
                style={{ display: "none" }}
                onChange={(event) => {
                  const selectedFiles = Array.from(event.target.files || []);
                  if (selectedFiles.length > 0) {
                    appendPendingAttachments(selectedFiles);
                  }
                  event.currentTarget.value = "";
                }}
              />
            </div>
          </div>

          {isMobile ? (
            <button
              type="button"
              onClick={onToggleRightSidebar}
              style={{ width: "30px", height: "44px", borderRadius: "0", border: "none", background: "transparent", color: "var(--text-secondary)", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", opacity: 0.86, outline: "none", boxShadow: "none", WebkitTapHighlightColor: "transparent" as any, overflow: "hidden" }}
              aria-label="打开会话侧栏"
              title="会话侧栏"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.8" strokeLinecap="round">
                <line x1="6" y1="4" x2="18" y2="4" />
                <line x1="6" y1="12" x2="18" y2="12" />
                <line x1="6" y1="20" x2="18" y2="20" />
              </svg>
            </button>
          ) : null}
        </div>
        {attachedFileContext ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", padding: isMobile ? "6px 4px 0" : "0 4px" }}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                minWidth: 0,
                maxWidth: "100%",
                padding: "4px 8px",
                borderRadius: "999px",
                background: isDark ? "rgba(59,130,246,0.14)" : "rgba(59,130,246,0.08)",
                color: "var(--text-primary)",
                fontSize: "12px",
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: isMobile ? "96px" : "140px" }}>
                {attachedFileContext.fileName}
              </span>
              {typeof attachedFileContext.startLine === "number" && typeof attachedFileContext.endLine === "number" ? (
                <span style={{ color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                  {attachedFileContext.startLine}-{attachedFileContext.endLine}
                </span>
              ) : attachedFileContext.text ? (
                <span style={{ color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                  {getSelectionPreview(attachedFileContext.text)}
                </span>
              ) : null}
              <button
                type="button"
                onClick={onClearFileContext}
                onMouseDown={(event) => event.preventDefault()}
                onTouchStart={(event) => event.preventDefault()}
                style={{
                  border: "none",
                  background: "transparent",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  padding: 0,
                  lineHeight: 1,
                  fontSize: "14px",
                }}
                aria-label={`移除文件上下文 ${attachedFileContext.fileName}`}
                title={`移除 ${attachedFileContext.fileName}`}
              >
                ×
              </button>
            </span>
          </div>
        ) : null}
        {pendingAttachments.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", padding: isMobile ? "6px 4px 0" : "0 4px" }}>
            {pendingAttachments.some((attachment) => attachment.isImage) ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))", gap: "8px" }}>
                {pendingAttachments
                  .filter((attachment) => attachment.isImage && attachment.previewUrl)
                  .map((attachment) => (
                    <div
                      key={attachment.id}
                      style={{
                        position: "relative",
                        borderRadius: "12px",
                        overflow: "hidden",
                        background: isDark ? "rgba(15,23,42,0.55)" : "rgba(15,23,42,0.06)",
                        aspectRatio: "1 / 1",
                      }}
                    >
                      <img
                        src={attachment.previewUrl}
                        alt={attachment.file.name}
                        style={{ display: "block", width: "100%", height: "100%", objectFit: "cover" }}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setPendingAttachments((prev) => {
                            const target = prev.find((item) => item.id === attachment.id);
                            if (target?.previewUrl) {
                              URL.revokeObjectURL(target.previewUrl);
                            }
                            return prev.filter((item) => item.id !== attachment.id);
                          });
                        }}
                        style={{
                          position: "absolute",
                          top: "6px",
                          right: "6px",
                          width: "22px",
                          height: "22px",
                          borderRadius: "999px",
                          border: "none",
                          background: "rgba(15,23,42,0.72)",
                          color: "#fff",
                          cursor: "pointer",
                          lineHeight: 1,
                          fontSize: "14px",
                        }}
                        aria-label={`移除附件 ${attachment.file.name}`}
                        title={`移除 ${attachment.file.name}`}
                      >
                        ×
                      </button>
                    </div>
                  ))}
              </div>
            ) : null}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
              {pendingAttachments
                .filter((attachment) => !attachment.isImage)
                .map((attachment) => (
              <span
                key={attachment.id}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  maxWidth: "220px",
                  padding: "4px 8px",
                  borderRadius: "999px",
                  background: isDark ? "rgba(59,130,246,0.14)" : "rgba(59,130,246,0.08)",
                  color: "var(--text-primary)",
                  fontSize: "12px",
                }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{attachment.file.name}</span>
                <button
                  type="button"
                  onClick={() => {
                    setPendingAttachments((prev) => {
                      const target = prev.find((item) => item.id === attachment.id);
                      if (target?.previewUrl) {
                        URL.revokeObjectURL(target.previewUrl);
                      }
                      return prev.filter((item) => item.id !== attachment.id);
                    });
                  }}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: "var(--text-secondary)",
                    cursor: "pointer",
                    padding: 0,
                    lineHeight: 1,
                    fontSize: "14px",
                  }}
                  aria-label={`移除附件 ${attachment.file.name}`}
                  title={`移除 ${attachment.file.name}`}
                >
                  ×
                </button>
              </span>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

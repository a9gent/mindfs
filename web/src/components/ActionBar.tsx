import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AgentIcon } from "./AgentIcon";
import { ModeIcon } from "./ModeIcon";
import { filterAgentModels } from "./modelFiltering";
import { sessionService } from "../services/session";
import { type SessionMode } from "./ModeSelector";
import { ModeSelector } from "./ModeSelector";
import { AgentSelector } from "./AgentSelector";
import type { ComposerStyle } from "../services/preferences";
import { getStoredString, removeStoredString, setStoredString } from "../services/storage";
import { fetchAgents, fetchShells, restartAgent, type AgentStatus, type ShellStatus } from "../services/agents";
import { fetchCandidates, type CandidateItem } from "../services/candidates";
import { reportError } from "../services/error";
import { isUploadAbortError, uploadFiles, type UploadProgress } from "../services/upload";
import {
  APPEARANCE_CHANGE_EVENT,
  getAppearanceMode,
  getEffectiveAppearanceMode,
} from "../services/appearance";
import TokenEditor, {
  type TokenEditorHandle,
} from "./editor/TokenEditor";
import { renderToolIcon } from "./stream/ToolCallCard";
import { useI18n, type MessageKey } from "../i18n";
import { CompactUploadProgress } from "./CompactUploadProgress";
import { fetchGitBranches, type GitBranchesPayload } from "../services/git";
import { WorktreeBranchSelector } from "./WorktreeBranchSelector";
import { NoWorktreeIcon } from "./NoWorktreeIcon";
import { CodexRateLimitIndicator } from "./CodexRateLimitIndicator";
import { AgentMemoryIndicator } from "./AgentMemoryIndicator";
import { deletePrompt, savePrompt } from "../services/prompts";
import { matchesSendShortcut, type SendShortcut } from "../services/sendShortcut";
import {
  effectiveBlueRingActions, BLUE_RING_ACTION_LABEL_KEYS, BLUE_RING_GESTURE_LABEL_KEYS,
  recentQuickSwitchGroups, ringPathGesture,
  type BlueRingAction, type BlueRingGestureConfig, type RingPathPoint,
} from "../services/quickSwitch";
import { SessionQuickActions, type SessionQuickActionsProps } from "./SessionQuickActions";

type SessionInfo = {
  key: string;
  session_key?: string;
  root_id?: string;
  name: string;
  type: "chat" | "plugin" | "command";
  agent: string;
  model?: string;
  shell?: string;
  mode?: string;
  effort?: string;
  fast_service?: string;
  plan_mode?: boolean;
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
  onNewSession: SessionQuickActionsProps["onNewSession"];
  onSelectProject: SessionQuickActionsProps["onSelectProject"];
  onSelectSession: SessionQuickActionsProps["onSelectSession"];
  taskGroupBadge?: React.ReactNode;
  status?: WSStatus;
  agentsVersion?: number;
  codexRateLimitsRefreshToken?: number;
  currentRootId?: string | null;
  currentRootIsGitRepo?: boolean;
  currentSession?: SessionInfo | null;
  pendingPlanMode?: boolean;
  attachedFileContext?: AttachedFileContext | null;
  editDraftRequest?: {
    id: number;
    content: string;
  } | null;
  queuedMessages?: QueuedMessageInfo[];
  inputHistory?: string[];
  mobileEnterKeySends?: boolean;
  sendShortcut?: SendShortcut | null;
  onSendMessage?: (
    message: string,
    mode: SessionMode,
    agent: string,
    model?: string,
    agentMode?: string,
    effort?: string,
    fastService?: "" | "on" | "off",
    shell?: string,
    newSessionWorktree?: {
      create: boolean;
      branchMode: "new" | "existing";
      branch: string;
    },
  ) => void | Promise<void>;
  onSetPlanMode?: (
    enabled: boolean,
    sessionKey?: string,
    rootId?: string,
  ) => void | Promise<void>;
  onCancelCurrentTurn?: (sessionKey: string) => void;
  onRemoveQueuedMessage?: (queueId: string) => void | Promise<void>;
  onUpdateQueuedMessage?: (queueId: string, content: string) => void | Promise<void>;
  onSendQueuedMessageNow?: (queueId: string) => void | Promise<void>;
  onRequestFileContext?: () => void;
  onClearFileContext?: () => void;
  onToggleLeftSidebar?: () => void;
  onToggleRightSidebar?: () => void;
  sidebarsSwapped?: boolean;
  blueRingGestures?: BlueRingGestureConfig;
  composerStyle?: ComposerStyle;
  onOpenGestureSettings?: () => void;
};

function wsStatusMeta(status: WSStatus, t: (key: MessageKey) => string): {
  color: string;
  shadow: string;
  label: string;
} {
  switch (status) {
    case "connected":
      return {
        color: "#22c55e",
        shadow: "none",
        label: t("action.ws.connected"),
      };
    case "connecting":
      return {
        color: "#f59e0b",
        shadow: "none",
        label: t("action.ws.connecting"),
      };
    case "reconnecting":
      return {
        color: "#ef4444",
        shadow: "none",
        label: t("action.ws.reconnecting"),
      };
    case "disconnected":
    default:
      return {
        color: "#94a3b8",
        shadow: "none",
        label: t("action.ws.disconnected"),
      };
  }
}

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

function parsePlanCommand(input: string): boolean | null {
  const normalized = input.trim().toLowerCase();
  if (normalized === "/plan" || normalized.startsWith("/plan ")) {
    return true;
  }
  return null;
}

function stripPlanCommandPrefix(input: string): string {
  const trimmed = input.trim();
  if (trimmed.toLowerCase() === "/plan") {
    return "";
  }
  if (trimmed.toLowerCase().startsWith("/plan ")) {
    return trimmed.slice(5).trimStart();
  }
  return trimmed;
}

export function ActionBar({
  onNewSession,
  onSelectProject,
  onSelectSession,
  taskGroupBadge,
  status = "disconnected",
  agentsVersion = 0,
  codexRateLimitsRefreshToken = 0,
  currentRootId,
  currentRootIsGitRepo = false,
  currentSession,
  pendingPlanMode = false,
  attachedFileContext,
  editDraftRequest = null,
  queuedMessages = [],
  inputHistory = [],
  onSendMessage,
  onSetPlanMode,
  onCancelCurrentTurn,
  onRemoveQueuedMessage,
  onUpdateQueuedMessage,
  onSendQueuedMessageNow,
  onRequestFileContext,
  onClearFileContext,
  onToggleLeftSidebar,
  onToggleRightSidebar,
  mobileEnterKeySends = false,
  sendShortcut = null,
  sidebarsSwapped = false,
  blueRingGestures,
  composerStyle = "classic",
  onOpenGestureSettings,
}: ActionBarProps) {
  const { t } = useI18n();
  const isModern = composerStyle === "modern";
  const [modelSelectorSignal, setModelSelectorSignal] = useState(0);
  const [sessionMenuRequest, setSessionMenuRequest] = useState<ComposerSessionQuickActionsProps["menuRequest"]>();
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
  const [inputHistoryIndex, setInputHistoryIndex] = useState<number | null>(null);
  const [activeToken, setActiveToken] = useState<{ type: "file" | "slash" | "prompt" | "command"; query: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null);
  const [editingQueueText, setEditingQueueText] = useState("");
  const [isMultiLine, setIsMultiLine] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [placeholderVariant, setPlaceholderVariant] = useState(0);
  const [isDark, setIsDark] = useState(() => getEffectiveAppearanceMode() === "dark");
  const [candidates, setCandidates] = useState<CandidateItem[]>([]);
  const [activeCandidateIndex, setActiveCandidateIndex] = useState(0);
  const [addingPrompt, setAddingPrompt] = useState(false);
  const [newPromptText, setNewPromptText] = useState("");
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [deletingPrompt, setDeletingPrompt] = useState("");
  const [promptSaveError, setPromptSaveError] = useState("");
  const [promptCandidateRefresh, setPromptCandidateRefresh] = useState(0);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [createWorktree, setCreateWorktree] = useState(false);
  const [worktreeBranchMode, setWorktreeBranchMode] = useState<"new" | "existing">("new");
  const [worktreeBranch, setWorktreeBranch] = useState("");
  const [worktreeBranches, setWorktreeBranches] = useState<GitBranchesPayload>({ branches: [] });
  const [worktreeBranchesLoading, setWorktreeBranchesLoading] = useState(false);
  const [worktreeBranchError, setWorktreeBranchError] = useState("");
  const syncedSessionSignatureRef = useRef<string>("");
  const editorRef = useRef<TokenEditorHandle>(null);
  const candidateAbortRef = useRef<AbortController | null>(null);
  const candidateItemRefs = useRef<Array<HTMLDivElement | null>>([]);
  const suppressedCommandCandidateTextRef = useRef("");
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const isComposingRef = useRef(false);
  const compositionGuardUntilRef = useRef(0);
  const inputHistoryDraftRef = useRef("");
  const applyingInputHistoryRef = useRef(false);
  const { isMobile } = useResponsive();
  const canResizeComposer = isModern && !isMobile;
  const composerSize = useComposerSize(canResizeComposer);
  const compactComposer = isMobile || composerSize.isNarrow;
  const editorMinHeight = isModern ? (compactComposer ? 128 : 120) : 44;
  const isConnected = status === "connected";
  const [displayStatus, setDisplayStatus] = useState<WSStatus>(status);
  const reconnectDisplayTimerRef = useRef<number | null>(null);
  const connectionMeta = wsStatusMeta(displayStatus, t);

  useEffect(() => {
    if (reconnectDisplayTimerRef.current) {
      window.clearTimeout(reconnectDisplayTimerRef.current);
      reconnectDisplayTimerRef.current = null;
    }
    if (status !== "reconnecting") {
      setDisplayStatus(status);
      return;
    }
    setDisplayStatus("connecting");
    reconnectDisplayTimerRef.current = window.setTimeout(() => {
      reconnectDisplayTimerRef.current = null;
      setDisplayStatus("reconnecting");
    }, 800);
    return () => {
      if (reconnectDisplayTimerRef.current) {
        window.clearTimeout(reconnectDisplayTimerRef.current);
        reconnectDisplayTimerRef.current = null;
      }
    };
  }, [status]);

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

  const resetForNewSession = useCallback(() => {
    const nextAgent = agents.find((item) => item.name === agent)
      || agents.find((item) => item.available) || agents[0];
    if (nextAgent) {
      const defaults = getAgentDefaults(nextAgent);
      setAgent(nextAgent.name);
      setModel(defaults.model);
      setAgentMode("");
      setEffort(defaults.effort);
      setFastService(defaults.fastService);
    }
    syncedSessionSignatureRef.current = "";
  }, [agent, agents]);

  useEffect(() => {
    const sessionKey = currentSession?.key || currentSession?.session_key || null;
    if (!currentSession) {
      if (syncedSessionSignatureRef.current) resetForNewSession();
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
  }, [currentSession, resetForNewSession]);

  useEffect(() => {
    if (!currentSession?.pending) {
      setCancelling(false);
    }
    if (currentSession) {
      setCreateWorktree(false);
      setWorktreeBranchMode("new");
      setWorktreeBranch("");
    }
  }, [currentSession?.key, currentSession?.session_key, currentSession?.pending]);

  useEffect(() => {
    setCreateWorktree(false);
    setWorktreeBranchMode("new");
    setWorktreeBranch("");
    setWorktreeBranches({ branches: [] });
    setWorktreeBranchError("");
  }, [currentRootId]);

  useEffect(() => {
    if (!createWorktree || currentSession || mode === "command" || !currentRootId || !currentRootIsGitRepo) {
      setWorktreeBranchError("");
      return;
    }
    let active = true;
    setWorktreeBranchesLoading(true);
    setWorktreeBranchError("");
    fetchGitBranches(currentRootId)
      .then((payload) => {
        if (active) setWorktreeBranches(payload);
      })
      .catch((error) => {
        if (!active) return;
        setWorktreeBranches({ branches: [] });
        setWorktreeBranchError(error instanceof Error ? error.message : t("worktree.loadBranchFailed"));
      })
      .finally(() => {
        if (active) setWorktreeBranchesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [createWorktree, currentRootId, currentRootIsGitRepo, currentSession, mode, t]);

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
    const preferred = agents.find((a) => a.last_used && a.available)
      ?? agents.find((a) => a.available) ?? agents[0];
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
  const availableEfforts = selectedModelInfo?.efforts ?? selectedAgent?.efforts ?? [];
  const isCodexEffortAgent = selectedAgent?.name === "codex";
  const supportsEffort =
    availableEfforts.length > 0 && !!selectedModelInfo?.supportEffort;
  const supportsServiceTier = !!selectedAgent?.supports_fast_service;
  const planModeActive = (!!currentSession?.plan_mode || pendingPlanMode) && mode !== "command";
  const planSessionKey = currentSession?.key || currentSession?.session_key || "";
  const planRootId = currentSession?.root_id || currentRootId || "";
  const sessionHistoryKey = currentSession?.key || currentSession?.session_key || "";

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

  useEffect(() => {
    setInputHistoryIndex(null);
    inputHistoryDraftRef.current = "";
  }, [sessionHistoryKey]);

  useEffect(() => {
    if (inputHistoryIndex !== null && inputHistoryIndex >= inputHistory.length) {
      setInputHistoryIndex(null);
      inputHistoryDraftRef.current = "";
    }
  }, [inputHistory.length, inputHistoryIndex]);

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
          const supportsPlanCommand =
            activeToken.type !== "slash" ||
            mode === "command" ||
            ["codex", "claude"].includes(agent.trim().toLowerCase());
          const filteredItems = supportsPlanCommand
            ? items
            : items.filter(
                (item) =>
                  item.type !== "slash_command" ||
                  item.name.trim().toLowerCase() !== "plan",
              );
          const nextItems = activeToken.type === "command"
            ? filteredItems.filter((item) => item.name.trim() !== activeToken.query.trim())
            : filteredItems;
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
  }, [activeToken, currentRootId, agent, mode, promptCandidateRefresh]);

  useEffect(() => {
    if (activeToken?.type === "prompt") {
      return;
    }
    setAddingPrompt(false);
    setNewPromptText("");
    setPromptSaveError("");
  }, [activeToken?.type]);

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
    if (isModern) return;
    setIsMultiLine(false);
    const frame = requestAnimationFrame(syncEditorHeight);
    return () => cancelAnimationFrame(frame);
  }, [isModern, syncEditorHeight]);

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
    if (!applyingInputHistoryRef.current && inputHistoryIndex !== null) {
      setInputHistoryIndex(null);
      inputHistoryDraftRef.current = payload.serializedText;
    }
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
  }, [inputHistoryIndex, mode, syncEditorHeight]);

  const applyInputHistoryAt = useCallback((index: number | null) => {
    const nextText = index === null ? inputHistoryDraftRef.current : inputHistory[index] || "";
    applyingInputHistoryRef.current = true;
    editorRef.current?.setText(nextText);
    setSerializedInput(nextText);
    setInputHistoryIndex(index);
    setActiveToken(null);
    setCandidates([]);
    setActiveCandidateIndex(0);
    requestAnimationFrame(() => {
      applyingInputHistoryRef.current = false;
      syncEditorHeight();
    });
  }, [inputHistory, syncEditorHeight]);

  const navigateInputHistory = useCallback((direction: "previous" | "next"): boolean => {
    if (inputHistory.length === 0) {
      return false;
    }
    if (direction === "previous") {
      if (inputHistoryIndex === null) {
        inputHistoryDraftRef.current = serializedInput;
        applyInputHistoryAt(inputHistory.length - 1);
        return true;
      }
      if (inputHistoryIndex > 0) {
        applyInputHistoryAt(inputHistoryIndex - 1);
      }
      return true;
    }
    if (inputHistoryIndex === null) {
      return false;
    }
    if (inputHistoryIndex < inputHistory.length - 1) {
      applyInputHistoryAt(inputHistoryIndex + 1);
    } else {
      applyInputHistoryAt(null);
    }
    return true;
  }, [applyInputHistoryAt, inputHistory, inputHistoryIndex, serializedInput]);

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

  const cancelAddPrompt = useCallback(() => {
    if (savingPrompt) return;
    setAddingPrompt(false);
    setNewPromptText("");
    setPromptSaveError("");
    requestAnimationFrame(() => editorRef.current?.focus());
  }, [savingPrompt]);

  const submitNewPrompt = useCallback(async () => {
    const text = newPromptText.trim();
    if (!text || savingPrompt) return;
    setSavingPrompt(true);
    setPromptSaveError("");
    try {
      await savePrompt(text);
      setAddingPrompt(false);
      setNewPromptText("");
      setPromptCandidateRefresh((value) => value + 1);
      requestAnimationFrame(() => editorRef.current?.focus());
    } catch (error) {
      setPromptSaveError(String((error as Error)?.message || t("action.addPromptFailed")));
    } finally {
      setSavingPrompt(false);
    }
  }, [newPromptText, savingPrompt, t]);

  const removePrompt = useCallback(async (text: string) => {
    if (deletingPrompt) return;
    setDeletingPrompt(text);
    setPromptSaveError("");
    try {
      await deletePrompt(text);
      setCandidates((items) => items.filter((item) => item.type !== "prompt" || item.name !== text));
      setActiveCandidateIndex(0);
      setPromptCandidateRefresh((value) => value + 1);
    } catch (error) {
      setPromptSaveError(String((error as Error)?.message || t("action.deletePromptFailed")));
    } finally {
      setDeletingPrompt("");
    }
  }, [deletingPrompt, t]);

  const handleSend = useCallback(async () => {
    if (currentSession?.key?.startsWith("pending-")) return;
    const messageText = serializedInput.trim();
    if ((!messageText && pendingAttachments.length === 0) || !isConnected || sending || (mode !== "command" && !agent)) return;
    const planCommand = pendingAttachments.length === 0 ? parsePlanCommand(messageText) : null;
    if (planCommand !== null) {
      const planContent = stripPlanCommandPrefix(messageText);
      if (!planContent) {
        setSending(true);
        try {
          await onSetPlanMode?.(planCommand, planSessionKey, planRootId);
          editorRef.current?.clear();
          setSerializedInput("");
          setActiveToken(null);
          setCandidates([]);
          setActiveCandidateIndex(0);
        } finally {
          setSending(false);
          if (!isMobile) {
            requestAnimationFrame(() => editorRef.current?.focus());
          }
        }
        return;
      }
    }
    setSending(true);
    setUploadProgress(null);
    setCandidates([]);
    setActiveCandidateIndex(0);
    try {
      let attachmentTokens = "";
      if (pendingAttachments.length > 0) {
        if (!currentRootId) {
          reportError("file.write_failed", t("action.uploadNoProject"));
          return;
        }
        const uploadAbort = new AbortController();
        uploadAbortRef.current = uploadAbort;
        const uploaded = await uploadFiles({
          rootId: currentRootId,
          files: pendingAttachments.map((attachment) => attachment.file),
          onProgress: setUploadProgress,
          signal: uploadAbort.signal,
        });
        attachmentTokens = uploaded
          .map((file) => `[file: ${file.agent_path || file.path}]`)
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
        !currentSession && mode !== "command" && currentRootIsGitRepo
          ? {
              create: createWorktree,
              branchMode: worktreeBranchMode,
              branch: worktreeBranchMode === "existing" ? worktreeBranch : "",
            }
          : undefined,
      );
      editorRef.current?.clear();
      setSerializedInput("");
      setInputHistoryIndex(null);
      inputHistoryDraftRef.current = "";
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
      setCreateWorktree(false);
      setWorktreeBranchMode("new");
      setWorktreeBranch("");
      if (isMobile) {
        requestAnimationFrame(() => editorRef.current?.blur());
      }
    } catch (err) {
      if (!isUploadAbortError(err)) {
        reportError("file.write_failed", String((err as Error)?.message || t("action.uploadFailed")));
      }
    } finally {
      uploadAbortRef.current = null;
      setSending(false);
      setUploadProgress(null);
      if (!isMobile) {
        requestAnimationFrame(() => editorRef.current?.focus());
      }
    }
  }, [serializedInput, pendingAttachments, isConnected, sending, mode, agent, currentRootId, planSessionKey, planRootId, onSetPlanMode, isMobile, model, agentMode, onSendMessage, supportsEffort, effort, supportsServiceTier, fastService, shell, t, currentSession, currentRootIsGitRepo, createWorktree, worktreeBranchMode, worktreeBranch]);

  const handleCancel = useCallback(async () => {
    const sessionKey = currentSession?.key;
    if (!sessionKey || cancelling) return;
    setCancelling(true);
    try {
      await onCancelCurrentTurn?.(sessionKey);
    } finally {
      setCancelling(false);
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
    if (e.key !== "Enter" && !e.repeat && matchesSendShortcut(e.nativeEvent, sendShortcut)) {
      e.preventDefault();
      e.stopPropagation();
      void handleSend();
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
    if (!activeToken && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      if (e.key === "ArrowUp" && navigateInputHistory("previous")) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.key === "ArrowDown" && navigateInputHistory("next")) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
  }, [candidates, activeCandidateIndex, applyCandidate, handleSend, isCompositionActive, activeToken, navigateInputHistory, sendShortcut]);

  const handleEditorEnter = useCallback((event: KeyboardEvent | null) => {
    if (isCompositionActive(event)) {
      // Stop Lexical's plain-text Enter handler without preventing the native
      // event, so an IME can finish committing its composition text.
      return true;
    }
    if (event && !event.repeat && matchesSendShortcut(event, sendShortcut)) {
      event.preventDefault();
      event.stopPropagation();
      void handleSend();
      return true;
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
  }, [candidates, activeCandidateIndex, applyCandidate, handleSend, isCompositionActive, isMobile, mobileEnterKeySends, mode, sendShortcut]);

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

  const isSelectedAgentUnavailable = agents.length > 0 ? agents.find((a) => a.name === agent)?.available === false : false;
  const canSend = (!!serializedInput.trim() || pendingAttachments.length > 0) && isConnected && !sending && !currentSession?.key?.startsWith("pending-") && (mode === "command" || !!agent);
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

  const inputPlaceholder = isModern && mode === "chat"
    ? t(currentSession ? "composer.continueSession" : "composer.newMessage")
    : mode === "chat"
    ? !isFocused && placeholderVariant !== 0
      ? t(placeholderVariant === 1 ? "action.placeholder.tip" : "action.placeholder.quickSwitch")
      : t(currentSession ? "action.placeholder.continueSession" : "action.placeholder.newSession")
    : t(mode === "command" ? "action.placeholder.command" : "action.placeholder.plugin");
  const editorRightInset = isModern ? 16 : isMultiLine ? 14 : mode === "command" ? (isMobile ? 84 : 108) : isMobile ? 116 : 140;
  const editorBottomInset = isModern ? 64 : isMultiLine ? 44 : 12;
  const startNewSession = () => {
    resetForNewSession();
    onNewSession();
  };
  const QuickActionsControl = isModern ? ComposerSessionQuickActions : SessionQuickActions;
  const quickActions = (
    <QuickActionsControl
      variant={compactComposer ? "icon" : "button"}
      menuRequest={sessionMenuRequest}
      onOpenGestureSettings={onOpenGestureSettings}
      currentRootId={currentRootId}
      currentSessionKey={currentSession?.key || currentSession?.session_key}
      gestureConfig={blueRingGestures}
      onNewSession={startNewSession}
      onSelectProject={onSelectProject}
      onSelectSession={onSelectSession}
      onToggleFileSidebar={onToggleLeftSidebar}
      onToggleSessionSidebar={onToggleRightSidebar}
      onOpenModelSelector={() => setModelSelectorSignal((value) => value + 1)}
    />
  );
  const AgentControl = isModern ? ComposerAgentSelector : AgentSelector;
  const mobileFileSidebarButton = isMobile ? (
    <button
      type="button"
      onClick={onToggleLeftSidebar}
      style={{ width: "30px", height: "44px", borderRadius: "0", border: "none", background: "transparent", color: "var(--text-secondary)", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", opacity: 0.86, outline: "none", boxShadow: "none", WebkitTapHighlightColor: "transparent" as any, overflow: "hidden" }}
      aria-label={t("sidebar.openFile")}
      title={t("sidebar.file")}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none">
        <path fill="currentColor" d="M3 3h6v4H3zm12 7h6v4h-6zm0 7h6v4h-6zm-2-4H7v5h6v2H5V9h2v2h6z" style={{ transform: "scale(1.28)", transformOrigin: "12px 12px" }} />
      </svg>
    </button>
  ) : null;
  const mobileSessionSidebarButton = isMobile ? (
    <button
      type="button"
      onClick={onToggleRightSidebar}
      style={{ width: "30px", height: "44px", borderRadius: "0", border: "none", background: "transparent", color: "var(--text-secondary)", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", opacity: 0.86, outline: "none", boxShadow: "none", WebkitTapHighlightColor: "transparent" as any, overflow: "hidden" }}
      aria-label={t("sidebar.openSession")}
      title={t("sidebar.session")}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.8" strokeLinecap="round">
        <line x1="6" y1="4" x2="18" y2="4" />
        <line x1="6" y1="12" x2="18" y2="12" />
        <line x1="6" y1="20" x2="18" y2="20" />
      </svg>
    </button>
  ) : null;

  return (
    <div data-onboarding="action-bar" data-composer-style={composerStyle} className={isModern ? `composer-modern${compactComposer ? " composer-modern--compact" : ""}` : undefined} style={{ width: "100%", minWidth: 0, padding: isMobile ? `0 ${isModern ? 12 : 0}px var(--mindfs-actionbar-bottom-padding, calc(env(safe-area-inset-bottom, 0px) + 2px))` : "0 16px 12px", display: "flex", justifyContent: "center", boxSizing: "border-box", background: "var(--content-bg)" }}>
      <div style={{ position: "relative", width: "100%", minWidth: 0, display: "flex", flexDirection: "column", gap: 0 }}>
        <div
            className={isModern ? "composer-status-row" : undefined}
            style={{
              position: "absolute",
              left: "2px",
              right: isMobile ? "2px" : "8px",
              bottom: "100%",
              zIndex: 7,
              minWidth: 0,
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "space-between",
              gap: "8px",
              pointerEvents: "none",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "flex-end",
                gap: "6px",
                minWidth: 0,
                pointerEvents: "auto",
              }}
            >
              {taskGroupBadge}
              {planModeActive ? (
                <div style={{ display: "inline-flex", alignItems: "center", gap: "5px", height: "20px", padding: "0 5px 0 8px", borderRadius: "999px", border: "1px solid rgba(37, 99, 235, 0.22)", background: "linear-gradient(rgba(37, 99, 235, 0.10), rgba(37, 99, 235, 0.10)), var(--mobile-overlay-bg)", color: "#2563eb", fontSize: "11px", fontWeight: 700, lineHeight: 1, flexShrink: 0 }}>
                  <span>Plan</span>
                  <button type="button" aria-label={t("action.closePlanMode")} title={t("action.closePlanMode")} onMouseDown={(event) => event.preventDefault()} onClick={() => void onSetPlanMode?.(false, planSessionKey, planRootId)} style={{ width: "14px", height: "14px", border: "none", borderRadius: "999px", background: "transparent", color: "currentColor", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: "14px", lineHeight: 1, padding: 0 }}>
                    <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true"><path d="M0 0h24v24H0z" fill="none" /><path fill="currentColor" fillRule="evenodd" d="M21 12a9 9 0 1 1-18 0a9 9 0 0 1 18 0M7.293 16.707a1 1 0 0 1 0-1.414L10.586 12L7.293 8.707a1 1 0 0 1 1.414-1.414L12 10.586l3.293-3.293a1 1 0 1 1 1.414 1.414L13.414 12l3.293 3.293a1 1 0 0 1-1.414 1.414L12 13.414l-3.293 3.293a1 1 0 0 1-1.414 0" clipRule="evenodd" /></svg>
                  </button>
                </div>
              ) : null}
              {mode !== "command" && !currentSession && currentRootIsGitRepo ? (
                <>
                  <button type="button" onClick={() => setCreateWorktree((value) => !value)} disabled={sending} aria-label={createWorktree ? t("task.worktreeTitle") : t("task.noWorktreeTitle")} title={createWorktree ? t("task.worktreeTitle") : t("task.noWorktreeTitle")} style={{ height: "24px", borderRadius: "6px", border: createWorktree ? "1px solid rgba(22, 163, 74, 0.28)" : "1px solid var(--border-color)", background: createWorktree ? "linear-gradient(rgba(22, 163, 74, 0.08), rgba(22, 163, 74, 0.08)), var(--mobile-overlay-bg)" : "linear-gradient(rgba(100, 116, 139, 0.10), rgba(100, 116, 139, 0.10)), var(--mobile-overlay-bg)", color: createWorktree ? "#15803d" : "var(--text-secondary)", padding: createWorktree ? "0 8px" : "0 8px 0 5px", fontSize: "11px", fontWeight: 800, cursor: sending ? "not-allowed" : "pointer", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "3px" }}>
                    {createWorktree ? "worktree" : <><NoWorktreeIcon size={12} />worktree</>}
                  </button>
                  {createWorktree ? <><WorktreeBranchSelector branchMode={worktreeBranchMode} branch={worktreeBranch} branches={worktreeBranches.branches} disabled={sending} maxWidth={isMobile ? 150 : 240} menuAlign={isMobile ? "left" : "right"} menuPlacement="top" onChange={(nextMode, nextBranch) => { setWorktreeBranchMode(nextMode); setWorktreeBranch(nextBranch); }} />{worktreeBranchesLoading ? <span style={{ fontSize: "11px", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>{t("common.loading")}</span> : worktreeBranchError ? <span title={worktreeBranchError} style={{ fontSize: "11px", color: "#b45309", whiteSpace: "nowrap" }}>{t("common.loadingFailed")}</span> : null}</> : null}
                </>
              ) : null}
            </div>
            <div style={{ pointerEvents: "auto", display: "inline-flex", alignItems: "flex-end", gap: "6px" }}>
              <AgentMemoryIndicator refreshToken={agentsVersion + codexRateLimitsRefreshToken} />
              <CodexRateLimitIndicator agent={agent} refreshToken={codexRateLimitsRefreshToken} />
            </div>
        </div>
        {queuedMessages.length > 0 ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "3px",
              padding: isMobile ? "0 31px 4px" : "0 0 4px",
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
                        aria-label={t("action.queueSave")}
                        title={t("common.save")}
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
                        aria-label={t("action.queueCancelEdit")}
                        title={t("common.cancel")}
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
                        aria-label={t("action.queueDelete")}
                        title={t("common.delete")}
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
                        aria-label={t("action.queueEdit")}
                        title={t("common.edit")}
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
                        aria-label={t("action.queueSendNow")}
                        title={t("action.queueSendNow")}
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
        <div style={{ display: "grid", gridTemplateColumns: isMobile && !isModern ? "30px minmax(0, 1fr) 30px" : "1fr", alignItems: isMobile ? "end" : "center", gap: isMobile ? "1px" : 0, padding: isMobile ? "0 1px" : 0, minWidth: 0, maxWidth: "100%" }}>
          {!isModern && (sidebarsSwapped ? mobileSessionSidebarButton : mobileFileSidebarButton)}

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: 0,
              minWidth: 0,
            }}
          >
            <div
              ref={composerSize.surfaceRef}
              data-mindfs-command-input-width="1"
              data-onboarding="message-input"
              className={isModern ? "composer-surface" : undefined}
              style={{
                background: "var(--panel-bg)",
                border: isFocused
                  ? "1px solid var(--accent-color)"
                  : "1px solid var(--panel-border)",
                borderRadius: isModern ? "16px" : isMobile ? "10px" : "12px",
                boxSizing: isModern ? "border-box" : undefined,
                boxShadow: isMobile
                  ? "none"
                  : (isFocused ? "var(--panel-focus-shadow)" : "var(--panel-shadow)"),
                display: "flex",
                alignItems: "center",
                position: "relative",
                transition: isModern ? undefined : "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
                height: composerSize.height,
                minHeight: `${composerSize.height !== undefined ? COMPOSER_MIN_HEIGHT : editorMinHeight}px`,
                minWidth: 0,
                width: "100%",
                overflow: "visible",
              }}
            >
              {canResizeComposer ? (
                <div
                  className="composer-resize-handle"
                  role="separator"
                  tabIndex={0}
                  aria-orientation="horizontal"
                  aria-label={t("composer.resizeHeight")}
                  aria-valuemin={COMPOSER_MIN_HEIGHT}
                  aria-valuemax={composerSize.maxHeight}
                  aria-valuenow={composerSize.currentHeight}
                  title={t("composer.resizeHeightHint")}
                  {...composerSize.handleProps}
                />
              ) : null}
	            <TokenEditor
	              ref={editorRef}
	              placeholder={inputPlaceholder}
	              disabled={sending}
	              isDark={isDark}
	              rightInset={editorRightInset}
	              topInset={isModern ? 8 : 0}
	              bottomInset={editorBottomInset}
	              fillHeight={composerSize.height !== undefined}
	              minHeight={isModern ? editorMinHeight : undefined}
              onChange={handleEditorChange}
              onFocusChange={(focused) => {
                setIsFocused(focused);
                if (!focused && mode === "chat") {
                  setPlaceholderVariant((previous) => (previous + 1) % 3);
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
                    {activeToken.type === "command" ? t("action.noCommandHistory") : t("action.noPromptFavorites")}
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
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", width: "100%", minWidth: 0 }}>
                        <span style={{
                          fontSize: "13px",
                          fontWeight: 500,
                          color: candidateNameColor(candidate.type, isDark),
                          minWidth: 0,
                          flex: 1,
                          overflow: candidate.type === "command" || candidate.type === "prompt" ? "hidden" : "visible",
                          textOverflow: candidate.type === "command" || candidate.type === "prompt" ? "ellipsis" : "clip",
                          whiteSpace: candidate.type === "command" || candidate.type === "prompt" ? "nowrap" : "normal",
                        }}>
                          {candidate.type === "file" ? (mode === "command" ? candidate.name : `@${candidate.name}`) : candidate.type === "prompt" ? `#${candidate.name}` : candidate.type === "command" ? candidate.name : `/${candidate.name}`}
                        </span>
                        {candidate.type === "prompt" ? (
                          <button
                            type="button"
                            onMouseDown={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                            }}
                            onClick={(event) => {
                              event.stopPropagation();
                              void removePrompt(candidate.name);
                            }}
                            disabled={!!deletingPrompt}
                            aria-label={t("action.deletePrompt", { name: candidate.name })}
                            title={t("common.delete")}
                            style={{ width: "28px", height: "28px", margin: "-5px -4px -5px 0", flexShrink: 0, border: "none", borderRadius: "7px", background: "transparent", color: "#dc2626", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: deletingPrompt ? "wait" : "pointer", opacity: deletingPrompt && deletingPrompt !== candidate.name ? 0.35 : 1 }}
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6l-1 14H6L5 6" />
                              <path d="M10 11v6" />
                              <path d="M14 11v6" />
                              <path d="M9 6V4h6v2" />
                            </svg>
                          </button>
                        ) : null}
                      </div>
                      {candidate.type !== "command" && candidate.description ? (
                        <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>{candidate.description}</span>
                      ) : null}
                    </div>
                  ))
                )}
                {activeToken.type === "prompt" ? (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "5px",
                      padding: addingPrompt ? "8px" : 0,
                      borderTop: "1px solid var(--menu-divider)",
                      background: "var(--menu-bg)",
                    }}
                  >
                    {addingPrompt ? (
                      <>
                        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                          <input
                            value={newPromptText}
                            onChange={(event) => {
                              setNewPromptText(event.currentTarget.value);
                              if (promptSaveError) setPromptSaveError("");
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                                event.preventDefault();
                                void submitNewPrompt();
                              } else if (event.key === "Escape") {
                                event.preventDefault();
                                cancelAddPrompt();
                              }
                            }}
                            placeholder={t("action.addPromptPlaceholder")}
                            aria-label={t("action.addPromptPlaceholder")}
                            disabled={savingPrompt}
                            autoFocus
                            style={{
                              minWidth: 0,
                              flex: 1,
                              height: "32px",
                              padding: "0 9px",
                              border: "1px solid var(--accent-color)",
                              borderRadius: "8px",
                              outline: "none",
                              background: "var(--panel-bg)",
                              color: "var(--text-primary)",
                              fontSize: "13px",
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => void submitNewPrompt()}
                            disabled={!newPromptText.trim() || savingPrompt}
                            aria-label={t("common.save")}
                            title={t("common.save")}
                            style={{ width: "32px", height: "32px", border: "none", borderRadius: "8px", background: "transparent", color: newPromptText.trim() && !savingPrompt ? "var(--accent-color)" : "var(--text-secondary)", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: newPromptText.trim() && !savingPrompt ? "pointer" : "not-allowed", opacity: newPromptText.trim() && !savingPrompt ? 1 : 0.45 }}
                          >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M20 6 9 17l-5-5" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            onClick={cancelAddPrompt}
                            disabled={savingPrompt}
                            aria-label={t("common.cancel")}
                            title={t("common.cancel")}
                            style={{ width: "32px", height: "32px", border: "none", borderRadius: "8px", background: "transparent", color: "var(--text-secondary)", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: savingPrompt ? "not-allowed" : "pointer" }}
                          >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M18 6 6 18" />
                              <path d="m6 6 12 12" />
                            </svg>
                          </button>
                        </div>
                        {promptSaveError ? (
                          <div role="alert" style={{ padding: "0 2px", color: "#dc2626", fontSize: "11px", lineHeight: 1.4 }}>
                            {promptSaveError}
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <>
                        {promptSaveError ? (
                          <div role="alert" style={{ padding: "7px 12px 0", color: "#dc2626", fontSize: "11px", lineHeight: 1.4 }}>
                            {promptSaveError}
                          </div>
                        ) : null}
                        <button
                          type="button"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            setPromptSaveError("");
                            setAddingPrompt(true);
                          }}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "7px",
                            width: "100%",
                            padding: "9px 12px",
                            border: "none",
                            background: "transparent",
                            color: "var(--accent-color)",
                            fontSize: "13px",
                            fontWeight: 600,
                            textAlign: "left",
                            cursor: "pointer",
                          }}
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                            <path d="M12 5v14" />
                            <path d="M5 12h14" />
                          </svg>
                          {t("action.addPrompt")}
                        </button>
                      </>
                    )}
                  </div>
                ) : null}
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

            <div data-onboarding="input-controls" style={isModern ? undefined : { position: "absolute", right: isMobile ? "4px" : "8px", bottom: isMultiLine ? "6px" : "50%", transform: isMultiLine ? "none" : "translateY(50%)", display: "flex", alignItems: "center", gap: isMobile ? "0px" : "2px", zIndex: 5, transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)" }}>
              {isModern && compactComposer ? null : quickActions}
              <>
                {isModern ? (!compactComposer || mode === "command" ? <ComposerActions mode={mode} onModeChange={setMode} disabled={isModeLocked} isMobile={isMobile} /> : null) : <ModeSelector mode={mode} onModeChange={setMode} compact={true} disabled={isModeLocked} onboardingId="mode-selector" viewportMenu />}
                {mode !== "command" ? (
                  <div style={isModern ? { display: "flex", alignItems: "center", minWidth: 0, flex: compactComposer ? 1 : undefined } : undefined}>
                    <AgentControl
                    isMobile={isMobile}
                    agent={agent}
                    model={model}
                    mode={agentMode}
                    effort={effort}
                    agents={agents}
                    onAgentChange={(nextAgent, nextModel) => {
                      const nextStatus = agents.find((item) => item.name === nextAgent);
                      const defaults = getAgentDefaults(nextStatus);
                      setModel(nextModel || defaults.model);
                      if (nextAgent === agent) return;
                      setAgent(nextAgent);
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
                    defaultExpandOptions
                    onboardingId="agent-selector"
                    viewportMenu
                    openSignal={modelSelectorSignal}
                    />
                  </div>
                ) : (
                  <ShellSelector
                    shell={shell}
                    shells={shells}
                    onShellChange={setShell}
                    compact={true}
                  />
                )}
              </>
              {isModern ? <span className="composer-toolbar-spacer" /> : null}
              {isModern && compactComposer ? quickActions : null}
              {isModern && compactComposer ? (
                <ComposerActions compact isMobile
                  mode={mode} onModeChange={setMode} disabled={isModeLocked}
                  attachmentDisabled={!currentRootId || sending} hasAttachments={pendingAttachments.length > 0}
                  onAddAttachment={() => attachmentInputRef.current?.click()}
                  onQuickSwitch={() => setSessionMenuRequest((previous) => ({ id: (previous?.id || 0) + 1, view: "switch" }))}
                  onRecentSessions={() => setSessionMenuRequest((previous) => ({ id: (previous?.id || 0) + 1, view: "recent" }))}
                  onOpenGestureSettings={onOpenGestureSettings}
                />
              ) : null}

              <>
                <button
                data-onboarding="attachment-action"
                className={isModern ? "composer-attachment" : undefined}
                type="button"
                onClick={() => attachmentInputRef.current?.click()}
                disabled={!currentRootId || sending}
                style={{
                  marginLeft: isModern ? undefined : "-4px",
                  width: isModern ? undefined : "28px",
                  height: isModern ? undefined : "28px",
                  borderRadius: "8px",
                  border: "none",
                  background: pendingAttachments.length > 0
                    ? "rgba(59,130,246,0.14)"
                    : "transparent",
                  color: pendingAttachments.length > 0
                    ? "var(--accent-color)"
                    : "var(--text-secondary)",
                  display: isModern && compactComposer ? "none" : "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: !currentRootId || sending ? "not-allowed" : "pointer",
                  opacity: !currentRootId || sending ? 0.35 : 1,
                }}
                title={t("action.addAttachment")}
                aria-label={t("action.addAttachment")}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <path d="M12 5v14" />
                  <path d="M5 12h14" />
                </svg>
                </button>
                <button
                data-onboarding="send-action"
                className="composer-send"
                data-cancelling={showCancel || undefined}
                aria-label={t(showCancel ? "composer.stop" : "composer.send")}
                title={t(showCancel ? "composer.stop" : "composer.send")}
                type="button"
                onClick={showCancel ? handleCancel : handleSend}
                disabled={showCancel ? cancelling : !canSend}
              >
                {sending || cancelling ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ animation: "spin 1s linear infinite" }}><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                ) : showCancel ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2.5" /></svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
                )}
                </button>
              </>
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
          </div>

          {!isModern && (sidebarsSwapped ? mobileFileSidebarButton : mobileSessionSidebarButton)}
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
                aria-label={t("action.removeFileContext", { name: attachedFileContext.fileName })}
                title={t("action.removeItem", { name: attachedFileContext.fileName })}
              >
                ×
              </button>
            </span>
          </div>
        ) : null}
        {pendingAttachments.length > 0 || uploadProgress ? (
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
                        aria-label={t("action.removeAttachment", { name: attachment.file.name })}
                        title={t("action.removeItem", { name: attachment.file.name })}
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
                  aria-label={t("action.removeAttachment", { name: attachment.file.name })}
                  title={t("action.removeItem", { name: attachment.file.name })}
                >
                  ×
                </button>
              </span>
              ))}
              <CompactUploadProgress
                progress={uploadProgress}
                label={t("upload.attachmentsProgress")}
                statusLabel={t("upload.inProgress")}
                cancelLabel={t("upload.cancel")}
                onCancel={() => uploadAbortRef.current?.abort()}
              />
            </div>
          </div>
        ) : null}
      </div>
      <style>{`
        .composer-popover :is(.composer-agent-option, .composer-model-option, .composer-effort-option, .composer-menu-action, .session-entry-action) { display: flex; align-items: center; width: 100%; border: 0; background: transparent; color: var(--text-primary); text-align: left; }
        .composer-popover { margin: 0; padding: 0; position: fixed; z-index: 10110; box-sizing: border-box; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--menu-border); background: var(--menu-bg); color: var(--text-primary); box-shadow: none; outline: none; font-size: calc(13px * var(--mindfs-font-scale, 1)); }
        .composer-popover--desktop { border-radius: 14px; }
        .composer-popover-content { min-height: 0; overflow: auto; overscroll-behavior: contain; }
        .composer-popover button, .composer-popover input { font: inherit; }
        .composer-popover button { cursor: pointer; }
        .composer-popover button:disabled { cursor: default; opacity: 0.55; }
        .composer-popover button:focus-visible, .composer-popover input:focus-visible { outline: 2px solid var(--accent-color); outline-offset: -2px; }
        .composer-popover--sheet::backdrop { background: rgba(0, 0, 0, 0.38); }
        .composer-popover--sheet { border-radius: 20px 20px 0 0; padding: 0 16px max(20px, env(safe-area-inset-bottom), var(--mindfs-safe-area-bottom, 0px)); animation: composer-sheet-enter 160ms ease-out; }
        .composer-sheet-handle { align-self: center; flex: 0 0 auto; width: 36px; height: 4px; border-radius: 10px; margin: 9px 0 8px; background: color-mix(in srgb, var(--text-secondary) 35%, transparent); }
        .composer-sheet-heading { display: flex; align-items: center; justify-content: space-between; flex: 0 0 auto; gap: 12px; margin-bottom: 12px; }
        .composer-sheet-heading h2 { margin: 0; font-size: calc(17px * var(--mindfs-font-scale, 1)); font-weight: 600; }
        .composer-sheet-close { display: grid; place-items: center; flex: 0 0 auto; width: 36px; height: 36px; border: 0; border-radius: 8px; background: transparent; color: var(--text-secondary); }
        .composer-sheet-close:hover { background: var(--menu-active-bg); }
        @keyframes composer-sheet-enter {
          from { transform: translateY(24px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
        @media (prefers-reduced-motion: reduce) {
          .composer-popover--sheet { animation: none; }
        }
        .composer-selectors, .composer-agent-controls { display: flex; align-items: center; min-width: 0; gap: 5px; }
        .composer-selector-trigger { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-width: 0; min-height: 32px; padding: 5px 8px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--text-primary); font: inherit; font-size: calc(13px * var(--mindfs-font-scale, 1)); white-space: nowrap; cursor: pointer; }
        .composer-selector-trigger:hover, .composer-selector-trigger.is-active { background: var(--menu-active-bg); color: var(--accent-color); }
        .composer-selector-trigger:focus-visible { outline: 2px solid var(--accent-color); outline-offset: 1px; }
        .composer-selector-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .composer-agent-trigger { flex: 0 1 auto; max-width: 160px; }
        .composer-model-trigger { flex: 0 1 auto; max-width: 200px; }
        .composer-selector-chevron { flex: 0 0 auto; color: var(--text-secondary); transition: transform 140ms ease; }
        .composer-selector-chevron.is-open { transform: rotate(180deg); }
        .composer-agent-icon { position: relative; display: flex; flex: 0 0 auto; }
        .composer-agent-warning { position: absolute; top: -4px; right: -5px; display: grid; place-items: center; width: 11px; height: 11px; border-radius: 50%; background: var(--text-secondary); color: var(--menu-bg); font-size: 9px; font-weight: 700; }
        .composer-effort-trigger { flex: 0 0 auto; }
        .composer-selectors--mobile { flex: 1 1 auto; gap: 4px; }
        .composer-selectors--mobile .composer-agent-controls { flex: 1 1 auto; overflow: hidden; }
        .composer-selectors--mobile .composer-agent-trigger { justify-content: flex-start; max-width: none; width: 100%; padding: 6px 2px; }
        .composer-selectors--mobile .composer-effort-trigger { padding: 6px 4px; }
        .composer-agent-popover.composer-popover--desktop { width: 440px; }
        .composer-agent-menu { display: grid; grid-template-columns: 132px minmax(0, 1fr); min-height: 270px; }
        .composer-agent-list { min-width: 0; padding: 10px 6px; border-right: 1px solid var(--menu-divider); }
        .composer-menu-caption { display: block; padding: 6px 8px 9px; color: var(--text-secondary); font-size: calc(11px * var(--mindfs-font-scale, 1)); }
        .composer-agent-option { gap: 8px; min-height: 39px; padding: 8px; border-radius: 8px; }
        .composer-agent-option > svg, .composer-agent-option > img { flex: 0 0 auto; }
        .composer-agent-option .composer-selector-chevron { width: 10px; margin-left: auto; transform: rotate(-90deg); }
        .composer-agent-option .composer-selector-chevron.is-open { transform: rotate(0); }
        .composer-agent-status { display: grid; place-items: center; width: 14px; height: 14px; flex: 0 0 auto; margin-left: auto; border: 1px solid var(--menu-border); border-radius: 50%; color: var(--text-secondary); font-size: 10px; }
        .composer-agent-option:hover, .composer-model-option:hover, .composer-effort-option:hover, .composer-mode-option:hover, .composer-inline-effort:hover { background: var(--menu-active-bg); }
        .composer-agent-option.is-selected, .composer-model-option.is-selected, .composer-effort-option.is-selected, .composer-mode-option.is-selected, .composer-inline-effort.is-selected { background: var(--menu-active-bg); color: var(--accent-color); }
        .composer-model-panel { min-width: 0; padding: 10px; }
        .composer-model-heading, .composer-effort-heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
        .composer-model-heading > span:last-child, .composer-effort-heading > span:last-child { min-width: 0; max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: calc(10px * var(--mindfs-font-scale, 1)); }
        .composer-model-search { display: flex; align-items: center; gap: 8px; min-width: 0; height: 31px; margin: 0 2px 6px; padding: 0 9px; border: 1px solid var(--menu-border); border-radius: 7px; color: var(--text-secondary); background: color-mix(in srgb, var(--text-secondary) 3%, transparent); }
        .composer-model-search input { width: 100%; min-width: 0; border: 0; background: transparent; outline: none; color: var(--text-primary); font-size: calc(12px * var(--mindfs-font-scale, 1)); }
        .composer-model-search:focus-within { border-color: var(--accent-color); }
        .composer-model-search input::placeholder { color: var(--text-secondary); opacity: 0.75; }
        .composer-model-list { max-height: 240px; overflow-y: auto; overscroll-behavior: contain; }
        .composer-model-option, .composer-effort-option { gap: 10px; min-height: 34px; padding: 8px; border-radius: 7px; }
        .composer-model-option.is-hidden-model { opacity: 0.65; }
        .composer-selector-check { flex: 0 0 auto; margin-left: auto; color: var(--accent-color); }
        .composer-model-empty { margin: 14px 8px; color: var(--text-secondary); font-size: calc(12px * var(--mindfs-font-scale, 1)); }
        .composer-agent-settings { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--menu-divider); }
        .composer-agent-settings .composer-menu-caption { padding: 0 2px 8px; }
        .composer-inline-effort-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; color: var(--text-secondary); }
        .composer-inline-effort-heading > span:last-child { font-size: calc(11px * var(--mindfs-font-scale, 1)); }
        .composer-mode-options, .composer-inline-efforts { display: flex; flex-wrap: wrap; gap: 4px; }
        .composer-mode-option, .composer-inline-effort { flex: 1 0 auto; padding: 8px 10px; border: 0; border-radius: 7px; background: transparent; color: var(--text-primary); }
        .composer-fast-setting { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 28px; color: var(--text-secondary); }
        .composer-fast-control { display: inline-flex; align-items: center; gap: 8px; border: 0; padding: 2px; background: transparent; color: var(--text-secondary); }
        .composer-fast-control > span:first-child { font-size: calc(11px * var(--mindfs-font-scale, 1)); }
        .composer-toggle-track { display: block; flex: 0 0 auto; width: 28px; height: 16px; padding: 3px; box-sizing: border-box; border-radius: 99px; background: color-mix(in srgb, var(--text-secondary) 25%, transparent); }
        .composer-toggle-track > span { display: block; width: 10px; height: 10px; border-radius: 50%; background: var(--menu-bg); transition: transform 140ms ease; }
        .composer-toggle-track.is-on { background: var(--accent-color); }
        .composer-toggle-track.is-on > span { transform: translateX(12px); }
        .composer-agent-error { margin: 8px 2px; padding: 8px; border: 1px solid var(--menu-border); border-radius: 8px; color: var(--text-secondary); font-size: calc(11px * var(--mindfs-font-scale, 1)); overflow-wrap: anywhere; }
        .composer-agent-error-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .composer-agent-error-heading button { border: 0; padding: 4px 6px; border-radius: 5px; color: var(--accent-color); background: var(--menu-active-bg); }
        .composer-agent-error pre { margin: 8px 0 0; max-height: 120px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
        .composer-effort-popover.composer-popover--desktop { width: 270px; padding: 10px; }
        .composer-effort-heading { padding-bottom: 12px; }
        .composer-effort-option { min-height: 41px; }
        .composer-effort-description { color: var(--text-secondary); font-size: calc(12px * var(--mindfs-font-scale, 1)); }
        .composer-agent-popover.composer-popover--sheet .composer-agent-menu { display: flex; flex-direction: column; min-height: 0; }
        .composer-agent-popover.composer-popover--sheet .composer-agent-list { display: flex; flex: 0 0 auto; gap: 2px; overflow-x: auto; padding: 0 0 12px; border-right: 0; border-bottom: 1px solid var(--menu-divider); }
        .composer-agent-popover.composer-popover--sheet .composer-agent-option { flex: 0 0 auto; width: auto; padding: 7px; gap: 5px; }
        .composer-agent-popover.composer-popover--sheet .composer-model-panel { padding: 14px 0 0; }
        .composer-agent-popover.composer-popover--sheet .composer-model-search { height: 36px; margin: 0 0 10px; }
        .composer-agent-popover.composer-popover--sheet .composer-model-search input { font-size: calc(16px * var(--mindfs-font-scale, 1)); }
        .composer-agent-popover.composer-popover--sheet .composer-model-list { max-height: min(32dvh, 260px); }
        .composer-agent-popover.composer-popover--sheet .composer-model-option { min-height: 40px; padding: 9px 12px; font-size: calc(15px * var(--mindfs-font-scale, 1)); }
        .composer-agent-popover.composer-popover--sheet .composer-agent-settings { margin-top: 13px; padding-top: 13px; }
        .composer-agent-popover.composer-popover--sheet .composer-fast-setting { min-height: 36px; }
        .composer-agent-popover.composer-popover--sheet .composer-toggle-track { width: 40px; height: 24px; padding: 3px; }
        .composer-agent-popover.composer-popover--sheet .composer-toggle-track > span { width: 18px; height: 18px; }
        .composer-agent-popover.composer-popover--sheet .composer-toggle-track.is-on > span { transform: translateX(16px); }
        .composer-effort-popover.composer-popover--sheet .composer-effort-option { min-height: 44px; font-size: calc(15px * var(--mindfs-font-scale, 1)); }
        @media (prefers-reduced-motion: reduce) {
          .composer-selector-chevron, .composer-toggle-track > span { transition: none; }
        }
        .composer-inline-effort { color: var(--text-secondary); }
        :root[data-theme="dark"] .composer-agent-menu img:is([alt="Cursor"], [alt="Grok"]) { filter: invert(1); opacity: 0.75; }
        @media (prefers-color-scheme: dark) {
          :root:not([data-theme]) .composer-agent-menu img:is([alt="Cursor"], [alt="Grok"]) { filter: invert(1); opacity: 0.75; }
        }
        .composer-toolbar-spacer { flex: 1; min-width: 0; }
        .composer-modern .session-entry { height: 34px; }
        .composer-modern .session-entry-main { font-size: calc(13px * var(--mindfs-font-scale, 1)); }
        .composer-mode-popover.composer-popover--desktop { width: 210px; padding: 6px; }
        .composer-mode-trigger, .composer-more-trigger { display: inline-flex; align-items: center; justify-content: center; gap: 7px; flex-shrink: 0; height: 34px; padding: 0 6px; border: 0; border-radius: 8px; background: transparent; color: var(--text-secondary); font: inherit; font-size: calc(14px * var(--mindfs-font-scale, 1)); white-space: nowrap; cursor: pointer; }
        .composer-mode-trigger:disabled { cursor: default; }
        .composer-mode-trigger > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
        .composer-mode-trigger > svg { flex-shrink: 0; }
        .composer-mode-trigger > svg:first-child { color: var(--accent-color); }
        .composer-mode-trigger:hover:not(:disabled), .composer-more-trigger:hover { background: var(--menu-active-bg); }
        .composer-popover .composer-menu-action { gap: 12px; min-height: 44px; padding: 10px 12px; border-radius: 9px; font-size: calc(14px * var(--mindfs-font-scale, 1)); }
        .composer-menu-action:hover:not(:disabled), .composer-menu-action[aria-pressed="true"] { background: var(--menu-active-bg); }
        .composer-menu-action:disabled { opacity: 0.6; cursor: default; }
        .composer-menu-check { margin-left: auto; color: var(--accent-color); }
        .composer-menu-symbol { width: 20px; font-size: 22px; text-align: center; }
        .composer-menu-divider { border-top: 1px solid var(--menu-border); margin: 10px 0; }
        .composer-menu-label { padding: 4px 12px; color: var(--text-secondary); font-size: calc(12px * var(--mindfs-font-scale, 1)); }
        .composer-new-icon { display: inline-flex; align-items: center; justify-content: center; position: relative; flex-shrink: 0; width: 28px; height: 34px; padding: 0; border: 0; border-radius: 7px; background: transparent; color: var(--text-secondary); cursor: pointer; touch-action: none; }
        .composer-new-icon:hover { background: var(--menu-active-bg); }
        .composer-modern--compact .composer-toolbar-spacer { display: none; }
        .composer-modern--compact .composer-more-trigger { width: 28px; height: 38px; padding: 0; position: relative; }
        .composer-more-trigger[data-has-attachments]::after { content: ""; position: absolute; right: 2px; top: 3px; width: 5px; height: 5px; border-radius: 50%; background: var(--accent-color); }
        .composer-menu-next { margin-left: auto; color: var(--text-secondary); }
        .composer-popover--sheet .composer-mode-choices { flex-wrap: nowrap; gap: 4px; }
        .composer-popover--sheet .composer-mode-choices .composer-menu-action { justify-content: center; padding-inline: 6px; gap: 4px; font-size: calc(13px * var(--mindfs-font-scale, 1)); }
        .composer-popover--sheet .composer-mode-choices svg, .composer-popover--sheet .composer-mode-choices .composer-menu-check { display: none; }
        .composer-modern--compact :is(.composer-selectors, .composer-agent-controls) { flex: 1; }
        .composer-modern--compact .composer-agent-trigger { max-width: 100%; }
        .composer-modern--compact .composer-mode-trigger { min-width: 0; flex-shrink: 1; }
        .session-entry { display: inline-flex; align-items: stretch; height: 32px; flex-shrink: 0; border: 1px solid color-mix(in srgb, var(--accent-color) 28%, var(--border-color)); border-radius: 8px; background: color-mix(in srgb, var(--accent-color) 5%, transparent); color: var(--accent-color); }
        .session-entry-main, .session-entry-toggle { display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: 0; background: transparent; color: inherit; font: inherit; font-size: calc(12px * var(--mindfs-font-scale, 1)); cursor: pointer; }
        .session-entry-main { position: relative; padding: 0 9px; border-radius: 7px 0 0 7px; white-space: nowrap; touch-action: none; }
        .session-entry-toggle { width: 27px; padding: 0; border-left: 1px solid color-mix(in srgb, var(--accent-color) 20%, var(--border-color)); border-radius: 0 7px 7px 0; }
        .session-entry-main:hover, .session-entry-toggle:hover, .session-entry[data-open="true"] .session-entry-toggle { background: color-mix(in srgb, var(--accent-color) 10%, transparent); }
        .session-entry[data-open="true"] .session-entry-toggle svg { transform: rotate(180deg); }
        .session-entry-main:focus-visible, .session-entry-toggle:focus-visible, .session-entry-panel button:focus-visible { outline: 2px solid var(--accent-color); outline-offset: -2px; }
        .session-entry-panel.composer-popover--desktop { width: 272px; padding: 8px; box-shadow: 0 8px 32px rgba(0,0,0,0.18); }
        .session-entry-heading { padding: 7px 10px 10px; color: var(--text-secondary); font-size: calc(11px * var(--mindfs-font-scale, 1)); }
        .composer-popover .session-entry-action { gap: 12px; min-height: 43px; padding: 10px; border-radius: 7px; color: var(--text-secondary); font-size: calc(13px * var(--mindfs-font-scale, 1)); }
        .session-entry-action:hover, .session-entry-back:hover { background: color-mix(in srgb, var(--accent-color) 10%, transparent); }
        .session-entry-action > svg, .session-entry-next, .session-entry-shortcut { flex-shrink: 0; }
        .session-entry-action-label { flex: 1; color: var(--text-primary); }
        .session-entry-action-label small, .session-entry-recent small { display: block; margin-top: 3px; color: var(--text-secondary); font-size: calc(11px * var(--mindfs-font-scale, 1)); }
        .session-entry-shortcut { font-size: calc(10px * var(--mindfs-font-scale, 1)); }
        .session-entry-next { display: flex; transform: rotate(-90deg); }
        .session-entry-separator { margin: 5px 8px; border-top: 1px solid var(--menu-border); }
        .session-entry-list-heading { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; color: var(--text-secondary); font-size: calc(11px * var(--mindfs-font-scale, 1)); }
        .session-entry-back { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 5px; color: inherit; background: transparent; cursor: pointer; }
        .session-entry-back svg { transform: rotate(90deg); }
        .session-entry-recent > span, .session-entry-recent small { display: block; overflow: hidden; text-overflow: ellipsis; }
        .composer-modern .composer-surface { transition: border-color 0.2s, box-shadow 0.2s; }
        .composer-modern [data-onboarding="input-controls"] { position: absolute; display: flex; align-items: center; z-index: 5; left: 12px; right: 12px; bottom: 12px; gap: 10px; min-width: 0; }
        .composer-modern--compact [data-onboarding="input-controls"] { left: 10px; right: 10px; bottom: 10px; gap: 3px; }
        .composer-modern .composer-attachment { flex-shrink: 0; margin-left: 0; width: 34px; height: 34px; }
        .composer-send { width: 28px; height: 28px; border-radius: 8px; border: none; background: var(--accent-color); color: #fff; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: all 0.2s; }
        .composer-send:disabled { background: transparent; color: var(--text-secondary); cursor: not-allowed; opacity: 0.3; }
        .composer-send[data-cancelling] { background: rgba(239,68,68,0.14); color: #ef4444; opacity: 1; }
        .composer-send[data-cancelling]:disabled { cursor: wait; }
        .composer-modern .composer-send { flex-shrink: 0; width: 36px; height: 36px; border-radius: 10px; transition: none; }
        .composer-modern .composer-send:disabled:not([data-cancelling]) { background: var(--accent-color); color: #fff; opacity: 0.45; }
        .composer-modern--compact .composer-send { width: 38px; height: 38px; border-radius: 8px; }
        .composer-modern .composer-send svg { width: 22px; height: 22px; }
        .composer-modern .composer-status-row, .composer-modern .composer-status-row > div { flex-wrap: wrap; }
        .composer-modern .composer-status-row > div { max-width: 100%; }
        .composer-modern .composer-status-row > div:last-child { margin-left: auto; justify-content: flex-end; }
        .composer-resize-handle {
          position: absolute; top: 0; left: 50%; transform: translateX(-50%); width: 64px; height: 14px;
          z-index: 6; cursor: ns-resize; touch-action: none; user-select: none; border-radius: 6px;
        }
        .composer-resize-handle::after {
          content: ""; position: absolute; top: 4px; left: 18px; width: 28px; height: 3px;
          border-radius: 3px; background: var(--text-secondary); opacity: 0.3;
        }
        .composer-resize-handle:hover::after, .composer-resize-handle:focus-visible::after { background: var(--accent-color); opacity: 1; }
        .composer-modern button:focus-visible, .composer-resize-handle:focus-visible { outline: 2px solid var(--accent-color); outline-offset: 1px; }
        @media (prefers-reduced-motion: reduce) { .composer-modern .composer-surface { transition: none; } }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

const COMPOSER_HEIGHT_STORAGE_KEY = "mindfs-desktop-composer-height";
const COMPOSER_MIN_HEIGHT = 104;
const COMPOSER_KEYBOARD_STEP = 20;

function loadComposerHeight(): number | null {
  const height = Number(getStoredString(COMPOSER_HEIGHT_STORAGE_KEY));
  return Number.isFinite(height) && height >= COMPOSER_MIN_HEIGHT ? height : null;
}

function useComposerSize(enabled: boolean) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const [preferredHeight, setPreferredHeight] = useState(loadComposerHeight);
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight);
  const [currentHeight, setCurrentHeight] = useState(COMPOSER_MIN_HEIGHT);
  const [isNarrow, setIsNarrow] = useState(() => window.innerWidth < 660);
  const maxHeight = Math.max(COMPOSER_MIN_HEIGHT, Math.floor(viewportHeight * 0.6));
  const clampHeight = (value: number) => Math.max(COMPOSER_MIN_HEIGHT, Math.min(maxHeight, Math.round(value)));
  const height = enabled && preferredHeight !== null ? clampHeight(preferredHeight) : undefined;

  useEffect(() => {
    if (preferredHeight === null) removeStoredString(COMPOSER_HEIGHT_STORAGE_KEY);
    else setStoredString(COMPOSER_HEIGHT_STORAGE_KEY, String(preferredHeight));
  }, [preferredHeight]);

  useEffect(() => {
    dragRef.current = null;
    if (!enabled || !surfaceRef.current) return;
    const updateViewport = () => setViewportHeight(window.innerHeight);
    updateViewport();
    window.addEventListener("resize", updateViewport);
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.target.getBoundingClientRect();
      setIsNarrow(width < 660);
      setCurrentHeight(Math.round(height));
    });
    observer.observe(surfaceRef.current);
    return () => {
      window.removeEventListener("resize", updateViewport);
      observer.disconnect();
    };
  }, [enabled]);

  const reset = () => setPreferredHeight(null);
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!enabled || event.button !== 0 || !surfaceRef.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: surfaceRef.current.getBoundingClientRect().height,
    };
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPreferredHeight(clampHeight(drag.startHeight + drag.startY - event.clientY));
  };
  const stopDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const actualHeight = surfaceRef.current?.getBoundingClientRect().height ?? currentHeight;
    switch (event.key) {
      case "ArrowUp": setPreferredHeight(clampHeight(actualHeight + COMPOSER_KEYBOARD_STEP)); break;
      case "ArrowDown": setPreferredHeight(clampHeight(actualHeight - COMPOSER_KEYBOARD_STEP)); break;
      case "Home": setPreferredHeight(COMPOSER_MIN_HEIGHT); break;
      case "End": setPreferredHeight(maxHeight); break;
      case "Escape": reset(); break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return {
    surfaceRef,
    height,
    maxHeight,
    currentHeight,
    isNarrow,
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: stopDrag,
      onPointerCancel: stopDrag,
      onLostPointerCapture: stopDrag,
      onDoubleClick: reset,
      onKeyDown,
    },
  };
}

type ComposerPopoverProps = {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  isMobile: boolean;
  title: string;
  className?: string;
  aboveInput?: boolean;
  onKeyDown?: React.KeyboardEventHandler<HTMLDialogElement>;
  children: ReactNode;
};

function ComposerPopover({ open, onClose, anchorRef, isMobile, title, className = "", aboveInput = false, onKeyDown, children }: ComposerPopoverProps) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [position, setPosition] = useState<CSSProperties>({});

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const anchor = anchorRef.current;
    if (!open || !panel || !anchor) return;
    const update = () => {
      const viewport = window.visualViewport;
      const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
      const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
      const fontScale = { "--mindfs-font-scale": getComputedStyle(anchor).getPropertyValue("--mindfs-font-scale").trim() || "1" } as CSSProperties;
      const rect = (aboveInput ? anchor.closest('[data-onboarding="message-input"]') || anchor : anchor).getBoundingClientRect();
      const above = rect.top - top - 16, below = top + height - rect.bottom - 16;
      const placeAbove = above >= Math.min(panel.offsetHeight, 280) || above >= below;
      const maxHeight = Math.min(aboveInput ? 440 : Infinity, Math.max(80, placeAbove ? above : below));
      setPosition(isMobile
        ? { ...fontScale, left, width, maxWidth: width, top: "auto", bottom: Math.max(0, window.innerHeight - top - height), maxHeight: Math.max(0, height - 16) }
        : { ...fontScale, left: Math.max(left + 8, Math.min(anchor.getBoundingClientRect().left, left + width - panel.offsetWidth - 8)), top: placeAbove ? Math.max(top + 8, rect.top - Math.min(panel.offsetHeight, maxHeight) - 8) : rect.bottom + 8, maxWidth: width - 16, maxHeight });
    };
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    isMobile ? panel.showModal() : panel.show();
    panel.focus({ preventScroll: true });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(panel);
    observer.observe(anchor);
    const fontObserver = new MutationObserver(update);
    const fontRegion = anchor.closest(".mindfs-font-scale-region");
    if (fontRegion) fontObserver.observe(fontRegion, { attributes: true, attributeFilter: ["style"] });
    const outside = (event: PointerEvent) => {
      if (!panel.contains(event.target as Node) && !anchor.contains(event.target as Node)) closeRef.current();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
      if (event.key !== "Tab" || isMobile) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]')).filter(node => node.getClientRects().length);
      if (!items.length) { event.preventDefault(); return; }
      if (document.activeElement === panel || document.activeElement === items[event.shiftKey ? 0 : items.length - 1]) {
        event.preventDefault(); items[event.shiftKey ? items.length - 1 : 0].focus();
      }
    };
    if (!isMobile) document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keyboard, true);
    for (const target of [window, window.visualViewport]) {
      target?.addEventListener("resize", update);
      target?.addEventListener("scroll", update, true);
    }
    return () => {
      observer.disconnect(); fontObserver.disconnect(); panel.close();
      // Unmounting a dialog can leave focus on the body before native restoration.
      if (document.activeElement === document.body || panel.contains(document.activeElement)) {
        const fallback = anchor.matches("button") ? anchor : anchor.querySelector<HTMLElement>("button");
        (previousFocus?.isConnected && previousFocus !== document.body ? previousFocus : fallback)?.focus({ preventScroll: true });
      }
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", keyboard, true);
      for (const target of [window, window.visualViewport]) {
        target?.removeEventListener("resize", update);
        target?.removeEventListener("scroll", update, true);
      }
    };
  }, [open, isMobile, anchorRef, aboveInput]);

  if (!open) return null;
  return createPortal(<dialog ref={panelRef} autoFocus tabIndex={-1} aria-label={title} className={`composer-popover ${isMobile ? "composer-popover--sheet" : "composer-popover--desktop"} ${className}`} style={position}
    onPointerDown={event => event.stopPropagation()} onKeyDown={onKeyDown} onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); if (event.target === event.currentTarget && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) onClose(); }}>
    {isMobile ? <><div className="composer-sheet-handle" aria-hidden="true" /><div className="composer-sheet-heading"><h2>{title}</h2><button type="button" className="composer-sheet-close" onClick={onClose} aria-label={t("common.close")}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></div></> : null}
    <div className="composer-popover-content">{children}</div>
  </dialog>, document.body);
}

type ComposerAgentSelectorProps = ComponentProps<typeof AgentSelector> & { isMobile?: boolean };

const effortLabels: Record<string, MessageKey> = {
  low: "composer.effortLow", medium: "composer.effortMedium", high: "composer.effortHigh",
  xhigh: "composer.effortXhigh", max: "composer.effortMax", ultra: "composer.effortUltra",
};

function Chevron({ open = false }: { open?: boolean }) {
  return <svg className={`composer-selector-chevron${open ? " is-open" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>;
}

function Check() {
  return <svg className="composer-selector-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>;
}

function errorText(error: string): string {
  try {
    const value = JSON.parse(error) as { message?: unknown; data?: unknown };
    if (typeof value.message !== "string") return error;
    return value.data ? `${value.message}\n${typeof value.data === "string" ? value.data : JSON.stringify(value.data, null, 2)}` : value.message;
  } catch { return error; }
}

function ComposerAgentSelector({ agent, model = "", mode = "", effort = "", fastService = "", agents, onAgentChange, onModeChange, onEffortChange, onFastServiceChange, onAgentRestart, openSignal, isMobile = false, warnUnavailable = false }: ComposerAgentSelectorProps) {
  const { t } = useI18n();
  const [openMenu, setOpenMenu] = useState<"agent" | "effort" | null>(null);
  const [viewedAgent, setViewedAgent] = useState(agent);
  const [query, setQuery] = useState("");
  const [restarting, setRestarting] = useState<string | null>(null);
  const [restartError, setRestartError] = useState<{ agent: string; message: string } | null>(null);
  const agentAnchor = useRef<HTMLDivElement>(null);
  const effortAnchor = useRef<HTMLButtonElement>(null);
  const selectedAgent = agents.find((entry) => entry.name === agent);
  const selectedModelId = model || selectedAgent?.default_model_id || selectedAgent?.current_model_id || "";
  const selectedModel = selectedAgent?.models?.find((entry) => entry.id === selectedModelId);
  const selectedModelName = selectedModel?.name || selectedModelId || t("agent.defaultModel");
  const selectedEfforts = selectedModel?.efforts ?? selectedAgent?.efforts ?? [];
  const supportsEffort = !!selectedModel?.supportEffort && selectedEfforts.length > 0 && !!onEffortChange;
  const selectedEffort = effort || selectedAgent?.default_effort || "Auto";
  const viewed = agents.find((entry) => entry.name === viewedAgent) ?? selectedAgent ?? agents[0];
  const viewedIsSelected = viewed?.name === agent;
  const viewedModelId = viewedIsSelected ? selectedModelId : viewed?.default_model_id || viewed?.current_model_id || "";
  const viewedModel = viewed?.models?.find((entry) => entry.id === viewedModelId);
  const viewedEfforts = viewedModel?.efforts ?? viewed?.efforts ?? [];
  const viewedSupportsEffort = !!viewedModel?.supportEffort && viewedEfforts.length > 0 && !!onEffortChange;
  const viewedEffort = viewedIsSelected ? selectedEffort : viewed?.default_effort || "Auto";
  const viewedMode = viewedIsSelected ? mode || viewed?.current_mode_id : viewed?.current_mode_id;
  const fastEnabled = (viewedIsSelected ? fastService : viewed?.default_fast_service) === "on";
  const filteredModels = filterAgentModels(viewed?.models ?? [], query);
  const unavailable = warnUnavailable || !!agent && !selectedAgent?.available;
  const close = useCallback(() => setOpenMenu(null), []);
  const openAgents = useCallback(() => {
    setViewedAgent(agent);
    setQuery("");
    setOpenMenu("agent");
  }, [agent]);

  const handledSignal = useRef(openSignal ?? 0);
  useEffect(() => {
    if (!openSignal || handledSignal.current === openSignal) return;
    handledSignal.current = openSignal;
    openAgents();
  }, [openSignal, openAgents]);

  useEffect(() => {
    if (openMenu === "effort" && !supportsEffort) close();
  }, [openMenu, supportsEffort, close]);

  const selectViewedAgent = () => {
    if (viewed && !viewedIsSelected) onAgentChange(viewed.name, viewedModelId);
  };
  const selectEffort = (next: string, inline = false) => {
    if (inline) selectViewedAgent();
    onEffortChange?.(next);
    if (!inline) close();
  };
  const restart = async () => {
    if (!viewed || !onAgentRestart || restarting) return;
    const target = viewed.name;
    setRestarting(target);
    setRestartError(null);
    try { await onAgentRestart(target); }
    catch (error) { setRestartError({ agent: target, message: error instanceof Error ? error.message : String(error) }); }
    finally { setRestarting(null); }
  };

  return <div className={`composer-selectors${isMobile ? " composer-selectors--mobile" : ""}`}>
    <div className="composer-agent-controls" ref={agentAnchor} data-onboarding="agent-selector">
      <button type="button" className={`composer-selector-trigger composer-agent-trigger${openMenu === "agent" ? " is-active" : ""}`} onClick={() => openMenu === "agent" ? close() : openAgents()} aria-haspopup="dialog" aria-expanded={openMenu === "agent"} aria-label={`${t("composer.agentModels")}: ${agent}, ${selectedModelName}`} title={unavailable ? t("agent.currentUnavailable", { name: agent }) : `${agent} · ${selectedModelName}`}>
        <span className="composer-agent-icon"><AgentIcon agentName={agent} style={{ width: 19, height: 19 }} />{unavailable ? <span className="composer-agent-warning" aria-hidden="true">!</span> : null}</span>
        <span className="composer-selector-label">{isMobile ? selectedModelName : agent}</span>
        <Chevron open={openMenu === "agent"} />
      </button>
      {!isMobile ? <button type="button" className={`composer-selector-trigger composer-model-trigger${openMenu === "agent" ? " is-active" : ""}`} onClick={() => openMenu === "agent" ? close() : openAgents()} aria-haspopup="dialog" aria-expanded={openMenu === "agent"} aria-label={`${t("agent.model")}: ${selectedModelName}`} title={selectedModelName}>
        <span className="composer-selector-label">{selectedModelName}</span><Chevron open={openMenu === "agent"} />
      </button> : null}
    </div>
    {supportsEffort ? <button ref={effortAnchor} type="button" className={`composer-selector-trigger composer-effort-trigger${openMenu === "effort" ? " is-active" : ""}`} onClick={() => setOpenMenu(openMenu === "effort" ? null : "effort")} aria-haspopup="dialog" aria-expanded={openMenu === "effort"} aria-label={`${t("agent.effort")}: ${selectedEffort}`} title={t("agent.effort")}>
      <span>{selectedEffort}</span><Chevron open={openMenu === "effort"} />
    </button> : null}

    <ComposerPopover open={openMenu === "agent"} onClose={close} anchorRef={agentAnchor} isMobile={isMobile} title={t("composer.agentModels")} className="composer-agent-popover">
      <div className="composer-agent-menu">
        <div className="composer-agent-list" aria-label={t("composer.agentModels")}>
          {!isMobile ? <div className="composer-menu-caption">Agent</div> : null}
          {agents.map((entry) => <button key={entry.name} type="button" className={`composer-agent-option${entry.name === viewed?.name ? " is-selected" : ""}`} aria-pressed={entry.name === viewed?.name} onClick={() => { setViewedAgent(entry.name); setQuery(""); }} title={entry.available ? entry.brief || entry.name : t("agent.currentUnavailable", { name: entry.name })}>
            <AgentIcon agentName={entry.name} style={{ width: 20, height: 20 }} /><span className="composer-selector-label">{entry.name}</span>
            {!entry.available ? <span className="composer-agent-status" aria-label={t("agent.notReady")}>?</span> : !isMobile ? <Chevron open={entry.name === viewed?.name} /> : null}
          </button>)}
        </div>
        <div className="composer-model-panel">
          <div className="composer-menu-caption composer-model-heading"><span>{t("agent.model")}</span><span title={viewedModelId}>{viewedModelId}</span></div>
          <label className="composer-model-search">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("agent.modelSearchPlaceholder")} aria-label={t("agent.modelSearchPlaceholder")} autoComplete="off" spellCheck={false} />
          </label>
          {viewed && !viewed.available ? <div className="composer-agent-error" role="status">
            <div className="composer-agent-error-heading"><span>{t("agent.notReady")}</span>{onAgentRestart ? <button type="button" onClick={() => void restart()} disabled={!!restarting} aria-label={t("agent.restart", { name: viewed.name })}>{restarting === viewed.name ? "…" : t("agent.restartAgent")}</button> : null}</div>
            {viewed.error ? <pre>{errorText(viewed.error)}</pre> : null}
          </div> : null}
          {restartError?.agent === viewed?.name ? <p className="composer-agent-error" role="alert">{restartError?.message}</p> : null}
          {viewed?.models_error ? <p className="composer-agent-error" role="status">{errorText(viewed.models_error)}</p> : null}
          <div className="composer-model-list" aria-label={t("agent.model")}>
            {filteredModels.map((entry) => {
              const selected = viewedIsSelected && entry.id === selectedModelId;
              return <button key={entry.id} type="button" className={`composer-model-option${selected ? " is-selected" : ""}${entry.hidden ? " is-hidden-model" : ""}`} aria-pressed={selected} title={entry.description || entry.id} onClick={() => { if (viewed) onAgentChange(viewed.name, entry.id); if (!isMobile) close(); }}>
                <span className="composer-selector-label">{entry.name || entry.id}</span>{selected ? <Check /> : null}
              </button>;
            })}
            {filteredModels.length === 0 ? <p className="composer-model-empty">{t("agent.modelNoMatch")}</p> : null}
            {viewed && !viewed.models?.length ? <button type="button" className="composer-model-option" onClick={() => { onAgentChange(viewed.name, viewedModelId); close(); }}>{t("composer.agentUse", { name: viewed.name })}{viewedIsSelected ? <Check /> : null}</button> : null}
          </div>
          {viewed?.modes?.length && onModeChange ? <div className="composer-agent-settings">
            <span className="composer-menu-caption">{t("agent.mode")}</span>
            <div className="composer-mode-options">{viewed.modes.map((entry) => <button type="button" key={entry.id} className={`composer-mode-option${entry.id === viewedMode ? " is-selected" : ""}`} aria-pressed={entry.id === viewedMode} title={entry.description || entry.id} onClick={() => { selectViewedAgent(); onModeChange(entry.id); }}>{entry.name || entry.id}</button>)}</div>
          </div> : null}
          {viewedSupportsEffort ? <div className="composer-agent-settings">
            <div className="composer-inline-effort-heading"><span className="composer-menu-caption">{t("agent.effort")}</span><span>{viewedEffort}</span></div>
            <div className="composer-inline-efforts">{viewedEfforts.map((entry) => <button key={entry} type="button" className={`composer-inline-effort${entry.toLowerCase() === viewedEffort.toLowerCase() ? " is-selected" : ""}`} aria-pressed={entry.toLowerCase() === viewedEffort.toLowerCase()} onClick={() => selectEffort(entry, true)}>{entry}</button>)}</div>
          </div> : null}
          {viewed?.supports_fast_service && onFastServiceChange ? <div className="composer-agent-settings composer-fast-setting"><span>{t("agent.fastMode")}</span><button className="composer-fast-control" type="button" role="switch" aria-checked={fastEnabled} aria-label={t("agent.fastMode")} onClick={() => { selectViewedAgent(); onFastServiceChange(fastEnabled ? "off" : "on"); }}><span>{fastEnabled ? t("agent.enabled") : t("agent.disabled")}</span><span className={`composer-toggle-track${fastEnabled ? " is-on" : ""}`} aria-hidden="true"><span /></span></button></div> : null}
        </div>
      </div>
    </ComposerPopover>
    <ComposerPopover open={openMenu === "effort"} onClose={close} anchorRef={effortAnchor} isMobile={isMobile} title={t("agent.effort")} className="composer-effort-popover">
      {!isMobile ? <div className="composer-menu-caption composer-effort-heading"><span>{t("agent.effort")}</span><span title={selectedModelName}>{selectedModelName}</span></div> : null}
      <div className="composer-effort-list">{selectedEfforts.map((entry) => <button key={entry} type="button" className={`composer-effort-option${entry.toLowerCase() === selectedEffort.toLowerCase() ? " is-selected" : ""}`} aria-pressed={entry.toLowerCase() === selectedEffort.toLowerCase()} onClick={() => selectEffort(entry)}>
        <span>{entry}</span>{effortLabels[entry] ? <span className="composer-effort-description">{t(effortLabels[entry])}</span> : null}{entry.toLowerCase() === selectedEffort.toLowerCase() ? <Check /> : null}
      </button>)}</div>
    </ComposerPopover>
  </div>;
}

function ComposerActions({ mode, onModeChange, disabled, isMobile, compact = false, attachmentDisabled, hasAttachments, onAddAttachment, onQuickSwitch, onRecentSessions, onOpenGestureSettings }: {
  mode: SessionMode;
  onModeChange: (mode: SessionMode) => void;
  disabled?: boolean;
  isMobile: boolean;
  compact?: boolean;
  attachmentDisabled?: boolean;
  hasAttachments?: boolean;
  onAddAttachment?: () => void;
  onQuickSwitch?: () => void;
  onRecentSessions?: () => void;
  onOpenGestureSettings?: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const run = (action?: () => void) => { setOpen(false); action?.(); };
  const title = t(compact ? "composer.more" : "mode.title");
  return <>
    <button ref={anchorRef} type="button" className={compact ? "composer-more-trigger" : "composer-mode-trigger"} disabled={!compact && disabled} data-onboarding={compact ? undefined : "mode-selector"} data-has-attachments={hasAttachments || undefined} aria-label={title} title={title} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
      {compact ? <svg width="23" height="23" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg> : <><ModeIcon type={mode} size={19} /><span>{t(mode === "chat" ? "composer.chatMode" : `mode.${mode}`)}</span><Chevron /></>}
    </button>
    <ComposerPopover open={open && (compact || !disabled)} onClose={() => setOpen(false)} anchorRef={anchorRef} isMobile={compact || isMobile} title={title} className={compact ? undefined : "composer-mode-popover"}>
      {compact ? <>
        <button type="button" className="composer-menu-action" disabled={attachmentDisabled} onClick={() => run(onAddAttachment)}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m9 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8" /></svg>{t("action.addAttachment")}</button>
        <div className="composer-menu-divider" /><div className="composer-menu-label">{t("mode.title")}</div>
      </> : null}
      <div className="composer-mode-options composer-mode-choices" role="group" aria-label={t("mode.title")}>
        {(["chat", "plugin", "command"] as SessionMode[]).map(value => <button key={value} type="button" className="composer-menu-action" aria-pressed={mode === value} disabled={disabled} onClick={() => run(() => onModeChange(value))}>
          <ModeIcon type={value} size={19} /><span>{t(value === "chat" ? "composer.chatMode" : `mode.${value}`)}</span>{mode === value ? <span className="composer-menu-check" aria-hidden="true">✓</span> : null}
        </button>)}
      </div>
      {compact ? <><div className="composer-menu-divider" /><ComposerSessionItems compact onQuickSwitch={() => run(onQuickSwitch)} onRecentSessions={() => run(onRecentSessions)} onOpenGestureSettings={onOpenGestureSettings ? () => run(onOpenGestureSettings) : undefined} /></> : null}
    </ComposerPopover>
  </>;
}

function ComposerSessionItems({ compact = false, gestureHint, onQuickSwitch, onRecentSessions, onOpenGestureSettings }: {
  compact?: boolean;
  gestureHint?: string;
  onQuickSwitch: () => void;
  onRecentSessions: () => void;
  onOpenGestureSettings?: () => void;
}) {
  const { t } = useI18n();
  const entries = [
    { label: "action.sessionMenu.quickSwitch" as const, action: onQuickSwitch, path: "M4 7h15m-4-4 4 4-4 4M20 17H5m4-4-4 4 4 4" },
    { label: "action.sessionMenu.recent" as const, action: onRecentSessions, path: "M3 10a9 9 0 1 1 2 8M3 4v6h6M12 7v5l3 2" },
    { label: "action.sessionMenu.gestures" as const, action: onOpenGestureSettings, path: "M8 13V5a2 2 0 0 1 4 0v7-3a2 2 0 0 1 4 0v3-1a2 2 0 0 1 4 0v4c0 4-2 6-6 6h-1c-2 0-3-1-4-2l-5-6a2 2 0 0 1 3-2l1 2Z" },
  ];
  return <>{entries.map((entry, index) => entry.action ? <React.Fragment key={entry.label}>
    {!compact && index === 2 ? <div className="session-entry-separator" /> : null}
    <button type="button" className={compact ? "composer-menu-action" : "session-entry-action"} onClick={entry.action}>
      {compact && index === 0 ? <span className="composer-menu-symbol" aria-hidden="true">⇄</span> : <svg width={compact ? 20 : 19} height={compact ? 20 : 19} viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d={entry.path} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>}
      <span className={compact ? undefined : "session-entry-action-label"}>{t(entry.label)}{!compact && index === 0 ? <small>{t("action.quickSwitch")}</small> : null}</span>
      {!compact && index === 0 && gestureHint ? <small className="session-entry-shortcut">{gestureHint}</small> : compact ? <span className="composer-menu-next" aria-hidden="true">›</span> : <span className="session-entry-next"><Chevron /></span>}
    </button>
  </React.Fragment> : null)}</>;
}

type ComposerSessionQuickActionsProps = SessionQuickActionsProps & {
  variant: "button" | "icon";
  menuRequest?: { id: number; view: "switch" | "recent" };
  onOpenGestureSettings?: () => void;
};

type PanelView = "actions" | "switch" | "recent";

function ComposerSessionQuickActions({ currentRootId, currentSessionKey, gestureConfig, variant, menuRequest, onNewSession, onSelectProject, onSelectSession, onToggleFileSidebar, onToggleSessionSidebar, onOpenModelSelector, onOpenGestureSettings }: ComposerSessionQuickActionsProps) {
  const { t } = useI18n();
  const anchorRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; points: RingPathPoint[] } | null>(null);
  const suppressClick = useRef(false);
  const [path, setPath] = useState<RingPathPoint[]>([]);
  const [open, setOpen] = useState<PanelView | null>(null);
  const [loading, setLoading] = useState(false);
  const [groups, setGroups] = useState<ReturnType<typeof recentQuickSwitchGroups>>([]);
  const isIcon = variant === "icon";

  useEffect(() => {
    if (menuRequest) setOpen(menuRequest.view);
  }, [menuRequest]);

  useEffect(() => { setOpen(null); }, [currentRootId, currentSessionKey, variant]);
  useEffect(() => {
    if (!open || open === "actions") return;
    let active = true;
    setLoading(true);
    void sessionService.fetchMultiRootSessions(3).then((items) => {
      if (active) { setGroups(recentQuickSwitchGroups(items)); setLoading(false); }
    });
    return () => { active = false; };
  }, [open]);
  const actions = effectiveBlueRingActions(gestureConfig);
  const gesturesEnabled = gestureConfig?.enabled === true;

  const reset = () => { drag.current = null; setPath([]); };
  const runAction = (action: BlueRingAction) => {
    switch (action) {
      case "newSession": setOpen(null); onNewSession(); break;
      case "quickSwitch": setOpen("switch"); break;
      case "toggleFileSidebar": onToggleFileSidebar?.(); break;
      case "toggleSessionSidebar": onToggleSessionSidebar?.(); break;
      case "modelSelector": onOpenModelSelector?.(); break;
      case "recentSession": {
        void sessionService.fetchMultiRootSessions(5).then((items) => {
          for (const group of recentQuickSwitchGroups(items)) {
            for (const session of group.items) {
              const key = session.key || session.session_key;
              if (key && key !== currentSessionKey) {
                setOpen(null);
                onSelectSession({ ...session, root_id: group.rootId });
                return;
              }
            }
          }
          setOpen("switch");
        });
        break;
      }
      case "none": break;
    }
  };

  const hint = ringPathGesture(path, false);
  const hintAction: BlueRingAction | null = hint ? actions[hint.gesture] : null;
  const hintText = hint && hintAction && hintAction !== "none"
    ? (gesturesEnabled
      ? (() => {
        const actionLabel = t(BLUE_RING_ACTION_LABEL_KEYS[hintAction]);
        return hint.ready
          ? t("action.gestureReady", { action: actionLabel })
          : t("action.gesturePending", { gesture: t(BLUE_RING_GESTURE_LABEL_KEYS[hint.gesture]), action: actionLabel });
      })()
      : t(hint.gesture === "left"
        ? hint.ready ? "action.releaseNewSession" : "action.swipeNewSession"
        : hint.ready ? "action.releaseQuickSwitch" : "action.swipeQuickSwitch"))
    : "";
  const rowStyle: React.CSSProperties = { display: "block", width: "100%", border: 0, background: "transparent", color: "var(--text-primary)", textAlign: "left", padding: "4px 6px", borderRadius: 6, cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, lineHeight: "18px" };
  const gestureLabel = gesturesEnabled ? t("action.ringHint.custom") : t("action.ringHint");
  const recentSessions = open === "recent" ? groups.flatMap((group) => group.items.map((session) => ({ session, group })))
    .sort((a, b) => (Date.parse(b.session.updated_at || b.session.created_at) || 0) - (Date.parse(a.session.updated_at || a.session.created_at) || 0)) : [];
  const chevron = <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  const trigger = <button type="button" className={isIcon ? "composer-new-icon" : "session-entry-main"} aria-label={t("blueRing.action.newSession")} title={`${t("blueRing.action.newSession")} · ${gestureLabel}`}
    onPointerDown={(event) => {
      if (!event.isPrimary || event.button !== 0) return;
      suppressClick.current = false;
      drag.current = { id: event.pointerId, points: [{ x: event.clientX, y: event.clientY }] };
      setPath(drag.current.points);
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={(event) => {
      if (drag.current?.id !== event.pointerId || !drag.current.points.length) return;
      const points = drag.current.points;
      const previous = points[points.length - 1];
      if (Math.abs(event.clientX - previous.x) < 3 && Math.abs(event.clientY - previous.y) < 3) return;
      points.push({ x: event.clientX, y: event.clientY });
      setPath([...points]);
    }}
    onPointerUp={(event) => {
      if (drag.current?.id !== event.pointerId) return;
      const points = [...drag.current.points, { x: event.clientX, y: event.clientY }];
      const origin = points[0];
      suppressClick.current = points.some((point) => Math.hypot(point.x - origin.x, point.y - origin.y) > 8);
      reset();
      const match = ringPathGesture(points, true);
      if (match) runAction(actions[match.gesture]);
    }}
    onPointerCancel={reset} onLostPointerCapture={reset}
    onKeyDown={(event) => {
      if (event.key === "ArrowLeft") { event.preventDefault(); runAction(actions.left); }
      if (event.key === "ArrowUp") { event.preventDefault(); runAction(actions.up); }
      if (event.key === "ArrowDown") { event.preventDefault(); setOpen("actions"); }
    }}
    onClick={(event) => {
      if (event.detail !== 0 && suppressClick.current) { suppressClick.current = false; event.preventDefault(); return; }
      runAction("newSession");
    }}>
    {!isIcon ? <><svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 3v14M3 10h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg><span>{t("blueRing.action.newSession")}</span></> : <span aria-hidden="true" style={{ width: 18, height: 18, border: "2px solid #2563eb", borderRadius: "50%", boxShadow: "0 0 0 1px rgba(37,99,235,0.08)", pointerEvents: "none" }} />}
    {hintText ? <span style={{ position: "absolute", left: 0, bottom: "calc(100% + 8px)", fontSize: 10, fontWeight: 600, color: hint?.ready ? "var(--accent-color)" : "var(--text-secondary)", background: "var(--panel-bg)", borderRadius: 4, padding: "2px 4px", whiteSpace: "nowrap", pointerEvents: "none", zIndex: 10 }}>{hintText}</span> : null}
  </button>;
  const panel = <>
      {open === "actions" ? <>
        <div className="session-entry-heading">{t("action.sessionMenu.title")}</div>
        <ComposerSessionItems gestureHint={actions.up === "quickSwitch" ? t("blueRing.gesture.up") : undefined} onQuickSwitch={() => setOpen("switch")} onRecentSessions={() => setOpen("recent")} onOpenGestureSettings={onOpenGestureSettings ? () => { setOpen(null); onOpenGestureSettings(); } : undefined} />
      </> : <>
        <div className="session-entry-list-heading"><button type="button" className="session-entry-back" aria-label={t("action.sessionMenu.title")} onClick={() => setOpen("actions")}>{chevron}</button><span>{t(open === "recent" ? "action.sessionMenu.recent" : "action.sessionMenu.quickSwitch")}</span></div>
        {loading ? <div role="status" style={{ padding: "8px 6px" }}>{t("common.loading")}</div> : (open === "recent" ? recentSessions.length === 0 : groups.length === 0) ? <div style={{ padding: "8px 6px", color: "var(--text-secondary)" }}>{t("action.quickSwitchEmpty")}</div> : open === "recent" ? recentSessions.map(({ session, group }) => <button className="quick-switch-row session-entry-recent" type="button" key={`${group.rootId}:${session.key || session.session_key}`} title={session.name || session.key || session.session_key} aria-current={group.rootId === currentRootId && (session.key || session.session_key) === currentSessionKey ? "true" : undefined} style={rowStyle} onClick={() => { setOpen(null); onSelectSession({ ...session, root_id: group.rootId }); }}><span>{session.name || session.key || session.session_key}</span><small>{group.rootName || group.rootId}</small></button>) : groups.map((group, index) => <div key={group.rootId} style={{ padding: "2px 0", borderTop: index === 0 ? 0 : "1px solid var(--menu-border)" }}>
          <button className="quick-switch-row" type="button" title={group.rootName || group.rootId} style={{ ...rowStyle, fontWeight: 600, color: group.rootId === currentRootId ? "var(--accent-color)" : "var(--text-primary)" }} onClick={() => { setOpen(null); onSelectProject(group.rootId); }}>{group.rootName || group.rootId}</button>
          {group.items.map((session) => <button className="quick-switch-row" type="button" key={session.key || session.session_key} title={session.name || session.key || session.session_key} aria-current={group.rootId === currentRootId && (session.key || session.session_key) === currentSessionKey ? "true" : undefined} style={{ ...rowStyle, paddingLeft: 18, color: "var(--text-secondary)" }} onClick={() => { setOpen(null); onSelectSession({ ...session, root_id: group.rootId }); }}>{session.name || session.key || session.session_key}</button>)}
        </div>)}
      </>}
      <style>{`.quick-switch-row:hover, .quick-switch-row:focus-visible, .quick-switch-row[aria-current="true"] { background: color-mix(in srgb, var(--accent-color) 10%, transparent) !important; }`}</style>
    </>;
  return <>
    <div ref={anchorRef} className={isIcon ? undefined : "session-entry"} style={isIcon ? { flexShrink: 0 } : undefined} data-open={!!open}>
      {trigger}
      {!isIcon ? <button type="button" className="session-entry-toggle" aria-label={t("action.sessionMenu.title")} title={t("action.sessionMenu.title")} aria-haspopup="dialog" aria-expanded={!!open} onClick={() => setOpen(value => value ? null : "actions")} onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen("actions"); } }}>{chevron}</button> : null}
    </div>
    <ComposerPopover open={!!open} onClose={() => setOpen(null)} anchorRef={anchorRef} isMobile={isIcon} aboveInput className="session-entry-panel mindfs-font-scale-region" title={t(open === "recent" ? "action.sessionMenu.recent" : open === "actions" ? "action.sessionMenu.title" : "action.quickSwitch")}
      onKeyDown={(event) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
        if (!buttons.length) return;
        event.preventDefault();
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowDown" ? (index + 1) % buttons.length : (index <= 0 ? buttons.length : index) - 1;
        buttons[next].focus();
      }}>
      {panel}
    </ComposerPopover>
  </>;
}

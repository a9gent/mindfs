import React, { useCallback, useEffect, useRef, useState } from "react";
import { type SessionMode } from "./ModeSelector";
import { ModeSelector } from "./ModeSelector";
import { AgentSelector } from "./AgentSelector";
import { fetchAgents, type AgentStatus } from "../services/agents";
import { fetchCandidates, type CandidateItem } from "../services/candidates";
import { reportError } from "../services/error";
import { uploadFiles } from "../services/upload";
import TokenEditor, {
  type TokenEditorHandle,
} from "./editor/TokenEditor";

type SessionInfo = {
  key: string;
  name: string;
  type: "chat" | "plugin";
  agent: string;
  model?: string;
  mode?: string;
  effort?: string;
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

function getSelectionPreview(text?: string): string {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return "...";
  }
  return `${Array.from(trimmed).slice(0, 3).join("")}...`;
}

type ActionBarProps = {
  status?: string;
  agentsVersion?: number;
  currentRootId?: string | null;
  currentSession?: SessionInfo | null;
  attachedFileContext?: AttachedFileContext | null;
  canOpenSessionDrawer?: boolean;
  detachedBoundSession?: boolean;
  onSendMessage?: (
    message: string,
    mode: SessionMode,
    agent: string,
    model?: string,
    agentMode?: string,
    effort?: string,
  ) => void | Promise<void>;
  onCancelCurrentTurn?: (sessionKey: string) => void;
  onNewSession?: () => void;
  onRequestFileContext?: () => void;
  onClearFileContext?: () => void;
  onSessionClick?: () => void;
  onToggleLeftSidebar?: () => void;
  onToggleRightSidebar?: () => void;
};

const modePlaceholders: Record<SessionMode, string> = {
  chat: "给 agent 发消息...",
  plugin: "描述要生成的视图插件...",
};

const chatBlurPlaceholders = [
  "给 agent 发消息...",
  "试试输入/ @ #，更快捷",
];

const MOBILE_BREAKPOINT = 768;
const IME_ENTER_GUARD_MS = 120;

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

export function ActionBar({
  status = "Disconnected",
  agentsVersion = 0,
  currentRootId,
  currentSession,
  attachedFileContext,
  canOpenSessionDrawer = false,
  detachedBoundSession = false,
  onSendMessage,
  onCancelCurrentTurn,
  onNewSession,
  onRequestFileContext,
  onClearFileContext,
  onSessionClick,
  onToggleLeftSidebar,
  onToggleRightSidebar,
}: ActionBarProps) {
  const [mode, setMode] = useState<SessionMode>("chat");
  const [agent, setAgent] = useState("");
  const [model, setModel] = useState("");
  const [agentMode, setAgentMode] = useState("");
  const [effort, setEffort] = useState("");
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [serializedInput, setSerializedInput] = useState("");
  const [activeToken, setActiveToken] = useState<{ type: "file" | "slash" | "prompt"; query: string } | null>(null);
  const [dragX, setDragX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [isMultiLine, setIsMultiLine] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [isDark, setIsDark] = useState(window.matchMedia("(prefers-color-scheme: dark)").matches);
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
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);
  const compositionGuardUntilRef = useRef(0);
  const { isMobile } = useResponsive();
  const isConnected = status === "Connected";
  const DRAG_THRESHOLD = -40;
  const boundRingColor = detachedBoundSession ? "#f59e0b" : "#2563eb";
  const boundRingShadow = detachedBoundSession
    ? "0 0 0 1px rgba(245,158,11,0.18)"
    : "0 0 0 1px rgba(37,99,235,0.08)";
  const boundArrowColor = detachedBoundSession ? "#f59e0b" : "#2563eb";

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setIsDark(e.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const sessionKey = currentSession?.key || currentSession?.session_key || null;
    if (!currentSession) {
      syncedSessionSignatureRef.current = "";
      return;
    }
    const nextMode = currentSession.type === "plugin" ? "plugin" : "chat";
    const nextAgent = currentSession.agent || "";
    const nextModel = currentSession.model || "";
    const nextAgentMode = currentSession.mode || "";
    const nextEffort = currentSession.effort || "";
    const signature = `${sessionKey || ""}::${nextMode}::${nextAgent}::${nextModel}::${nextAgentMode}::${nextEffort}`;
    if (syncedSessionSignatureRef.current === signature) {
      return;
    }
    syncedSessionSignatureRef.current = signature;
    setMode(nextMode);
    setAgent(nextAgent);
    setModel(nextModel);
    setAgentMode(nextAgentMode);
    setEffort(nextEffort);
  }, [currentSession]);

  useEffect(() => {
    if (!currentSession?.pending) {
      setCancelling(false);
    }
  }, [currentSession?.pending]);

  useEffect(() => {
    fetchAgents(true)
      .then(setAgents)
      .catch((err) => console.error("Failed to fetch agents:", err));
  }, [agentsVersion]);

  useEffect(() => {
    if (currentSession || agents.length === 0) return;
    if (agents.some((a) => a.name === agent)) return;
    const preferred = agents.find((a) => a.available) ?? agents[0];
    if (!preferred) {
      return;
    }
    setAgent(preferred.name);
    setModel("");
    setAgentMode("");
    setEffort("");
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
      (item) => item.id === selectedAgent?.current_model_id,
    );
  const availableEfforts = selectedAgent?.efforts ?? [];
  const isCodexEffortAgent = selectedAgent?.name === "codex";
  const supportsEffort =
    availableEfforts.length > 0 && !!selectedModelInfo?.supportEffort;

  useEffect(() => {
    if (!supportsEffort) {
      if (effort) {
        setEffort("");
      }
      return;
    }
    if (isCodexEffortAgent) {
      if (!effort || !availableEfforts.includes(effort)) {
        setEffort("medium");
      }
      return;
    }
    if (effort && !availableEfforts.includes(effort)) {
      setEffort("");
    }
  }, [supportsEffort, effort, availableEfforts, isCodexEffortAgent]);

  useEffect(() => () => candidateAbortRef.current?.abort(), []);

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
    if (!activeToken || !currentRootId || (activeToken.type === "slash" && !agent)) {
      candidateAbortRef.current?.abort();
      setCandidates([]);
      setActiveCandidateIndex(0);
      return;
    }
    const controller = new AbortController();
    candidateAbortRef.current?.abort();
    candidateAbortRef.current = controller;
    fetchCandidates({
      rootId: currentRootId,
      type: activeToken.type === "file" ? "file" : activeToken.type === "prompt" ? "prompt" : "skill",
      query: activeToken.query,
      agent: activeToken.type === "slash" ? agent : undefined,
      signal: controller.signal,
    })
      .then((items) => {
        setCandidates(items);
        setActiveCandidateIndex(0);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        console.error("Failed to fetch candidates:", err);
        setCandidates([]);
        setActiveCandidateIndex(0);
      });
    return () => controller.abort();
  }, [activeToken, currentRootId, agent]);

  useEffect(() => {
    if (candidates.length === 0) {
      candidateItemRefs.current = [];
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

  const handleEditorChange = useCallback((payload: {
    serializedText: string;
    activeToken: { type: "file" | "slash" | "prompt"; query: string } | null;
  }) => {
    setSerializedInput(payload.serializedText);
    setActiveToken(payload.activeToken);
    if (payload.serializedText.length === 0) {
      setIsMultiLine(false);
      return;
    }
    requestAnimationFrame(syncEditorHeight);
  }, [syncEditorHeight]);

  const applyCandidate = useCallback((candidate: CandidateItem) => {
    if (!activeToken) return;
    setCandidates([]);
    setActiveCandidateIndex(0);
    editorRef.current?.insertCandidate(candidate.type, candidate.name);
    editorRef.current?.focus();
    syncEditorHeight();
  }, [activeToken, syncEditorHeight]);

  const handleSend = useCallback(async () => {
    const messageText = serializedInput.trim();
    if ((!messageText && pendingAttachments.length === 0) || !isConnected || sending || !agent) return;
    setSending(true);
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
        agent,
        model || undefined,
        agentMode || undefined,
        supportsEffort ? effort || undefined : undefined,
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
    } catch (err) {
      reportError("file.write_failed", String((err as Error)?.message || "附件上传失败"));
    } finally {
      setSending(false);
      requestAnimationFrame(() => editorRef.current?.focus());
    }
  }, [serializedInput, pendingAttachments, isConnected, sending, agent, model, agentMode, onSendMessage, mode, currentRootId, supportsEffort, effort]);

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
        setActiveCandidateIndex((prev) => (prev + 1) % candidates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveCandidateIndex((prev) => (prev - 1 + candidates.length) % candidates.length);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        applyCandidate(candidates[activeCandidateIndex] || candidates[0]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
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
      event?.preventDefault();
      event?.stopPropagation();
      applyCandidate(candidates[activeCandidateIndex] || candidates[0]);
      return true;
    }
    if (!isMobile) {
      event?.preventDefault();
      event?.stopPropagation();
      void handleSend();
      return true;
    }
    return false;
  }, [candidates, activeCandidateIndex, applyCandidate, handleSend, isCompositionActive, isMobile]);

  const handleDragStart = (e: React.MouseEvent | React.TouchEvent) => {
    const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
    dragStartRef.current = clientX;
    setIsDragging(true);
  };

  const handleDragEnd = useCallback(() => {
    if (!isDragging) return;
    if (dragX <= DRAG_THRESHOLD) onNewSession?.();
    setDragX(0);
    setIsDragging(false);
  }, [isDragging, dragX, onNewSession]);

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
  const canSend = (!!serializedInput.trim() || pendingAttachments.length > 0) && isConnected && !sending && !!agent;
  const hasBoundSession = !!currentSession;
  const showCancel = !!currentSession?.pending && !!currentSession?.key;
  const isModeLocked = !!currentSession;
  const inputPlaceholder = currentSession && !currentSession.pending
    ? "左滑蓝环开始新会话..."
    : mode === "chat" && !isFocused
      ? blurPlaceholder
      : modePlaceholders[mode];
  const editorRightInset = isMultiLine ? 14 : isMobile ? 124 : 148;
  const editorBottomInset = isMultiLine ? 44 : 12;
  const editorMinHeight = 44;

  return (
    <div style={{ width: "100%", minWidth: 0, padding: isMobile ? "0 0 var(--mindfs-actionbar-bottom-padding, calc(env(safe-area-inset-bottom, 0px) + 2px))" : "0 16px 12px", display: "flex", justifyContent: "center", boxSizing: "border-box", background: "var(--content-bg)" }}>
      <div style={{ width: "100%", minWidth: 0, display: "flex", flexDirection: "column", gap: isMobile ? "0" : "6px" }}>
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
                  onRequestFileContext?.();
                }
              }}
              onPointerDown={onRequestFileContext}
              onKeyDown={handleKeyDown}
              onEnter={handleEditorEnter}
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
                    收藏用户消息后，可快速插入提示词
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
                        flexDirection: "column",
                        alignItems: "flex-start",
                        gap: "2px",
                        width: "100%",
                        padding: "10px 12px",
                        border: "none",
                        borderTop: index === 0 ? "none" : "1px solid var(--menu-divider)",
                        background: index === activeCandidateIndex ? "var(--menu-active-bg)" : "transparent",
                        color: "var(--text-primary)",
                        cursor: "pointer",
                        textAlign: "left",
                      }}
                    >
                      <span style={{ fontSize: "13px", fontWeight: 500, color: candidateNameColor(candidate.type, isDark) }}>
                        {candidate.type === "file" ? `@${candidate.name}` : candidate.type === "prompt" ? `#${candidate.name}` : `/${candidate.name}`}
                      </span>
                      {candidate.description ? (
                        <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>{candidate.description}</span>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            ) : null}

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
                      d="M3.25 7.25 6 4.5l2.75 2.75"
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
              <AgentSelector
                agent={agent}
                model={model}
                mode={agentMode}
                effort={effort}
                agents={agents}
                onAgentChange={(nextAgent, nextModel) => {
                  setAgent(nextAgent);
                  setModel(nextModel || "");
                  setAgentMode("");
                  setEffort("");
                }}
                onModeChange={(nextAgentMode) => setAgentMode(nextAgentMode || "")}
                onEffortChange={(nextEffort) => setEffort(nextEffort || "")}
                compact={true}
                warnUnavailable={isSelectedAgentUnavailable}
              />

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
                    setPendingAttachments((prev) => [
                      ...prev,
                      ...selectedFiles.map((file) => {
                        const isImage = file.type.startsWith("image/");
                        return {
                          id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
                          file,
                          isImage,
                          previewUrl: isImage ? URL.createObjectURL(file) : undefined,
                        };
                      }),
                    ]);
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

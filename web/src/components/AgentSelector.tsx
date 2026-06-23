import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import { AgentIcon } from "./AgentIcon";
import type { AgentStatus } from "../services/agents";

type AgentSelectorProps = {
  agent: string;
  model?: string;
  mode?: string;
  effort?: string;
  fastService?: "" | "on" | "off";
  agents: AgentStatus[];
  onAgentChange: (agent: string, model?: string) => void;
  onModeChange?: (mode?: string) => void;
  onEffortChange?: (effort?: string) => void;
  onFastServiceChange?: (fastService?: "" | "on" | "off") => void;
  onAgentRestart?: (agent: string) => void | Promise<void>;
  compact?: boolean;
  warnUnavailable?: boolean;
  menuPlacement?: "top" | "bottom";
  showChevron?: boolean;
};

const AGENT_MENU_MAX_BODY_HEIGHT = 344;
const AGENT_MENU_HEADER_HEIGHT = 34;
const AGENT_MENU_ROW_HEIGHT = 40;
const AGENT_MENU_MIN_VISIBLE_ROWS = 3;
const AGENT_MENU_MIN_BODY_HEIGHT =
  AGENT_MENU_HEADER_HEIGHT +
  AGENT_MENU_ROW_HEIGHT * AGENT_MENU_MIN_VISIBLE_ROWS;

function parseAgentErrorMessage(error?: string): string {
  const raw = String(error || "").trim();
  if (!raw) {
    return "";
  }

  try {
    const parsed = JSON.parse(raw) as {
      message?: unknown;
    };
    return typeof parsed.message === "string" && parsed.message.trim()
      ? parsed.message.trim()
      : raw;
  } catch {
    return raw;
  }
}

function parseAgentErrorDetails(error?: string): string[] {
  const raw = String(error || "").trim();
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as {
      data?: unknown;
    };
    if (parsed.data === undefined) {
      return [];
    }

    if (Array.isArray(parsed.data)) {
      return parsed.data.map((item) => String(item)).filter(Boolean);
    }

    if (parsed.data && typeof parsed.data === "object") {
      if (
        Array.isArray((parsed.data as { authMethods?: unknown }).authMethods)
      ) {
        return (
          parsed.data as {
            authMethods: Array<{ name?: unknown; description?: unknown }>;
          }
        ).authMethods
          .map((item) => {
            const name = typeof item?.name === "string" ? item.name.trim() : "";
            const description =
              typeof item?.description === "string"
                ? item.description.trim()
                : "";
            if (name && description) {
              return `${name}: ${description}`;
            }
            return name || description;
          })
          .filter(Boolean);
      }
      return Object.entries(parsed.data as Record<string, unknown>).map(
        ([key, value]) => {
          if (typeof value === "string") {
            return `${key}: ${value}`;
          }
          return `${key}: ${JSON.stringify(value)}`;
        },
      );
    }

    return [String(parsed.data)];
  } catch {
    return [];
  }
}

export function AgentSelector({
  agent,
  model = "",
  mode = "",
  effort = "",
  fastService = "",
  agents,
  onAgentChange,
  onModeChange,
  onEffortChange,
  onFastServiceChange,
  onAgentRestart,
  compact = false,
  warnUnavailable = false,
  menuPlacement = "top",
  showChevron = false,
}: AgentSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [submenuAgent, setSubmenuAgent] = useState<string | null>(null);
  const [errorAgent, setErrorAgent] = useState<string | null>(null);
  const [modelSectionExpanded, setModelSectionExpanded] = useState(true);
  const [modeSectionExpanded, setModeSectionExpanded] = useState(false);
  const [effortSectionExpanded, setEffortSectionExpanded] = useState(false);
  const [serviceTierSectionExpanded, setServiceTierSectionExpanded] =
    useState(false);
  const [restartingAgent, setRestartingAgent] = useState<string | null>(null);
  const [menuBodyHeight, setMenuBodyHeight] = useState<number | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const agentColumnRef = useRef<HTMLDivElement>(null);
  const submenuAgentStatus = useMemo(
    () => agents.find((item) => item.name === submenuAgent) ?? null,
    [agents, submenuAgent],
  );
  const errorAgentStatus = useMemo(
    () => agents.find((item) => item.name === errorAgent) ?? null,
    [agents, errorAgent],
  );
  const submenuModels = useMemo(
    () => submenuAgentStatus?.models ?? [],
    [submenuAgentStatus],
  );
  const submenuSelectedModel = useMemo(() => {
    if (!submenuAgentStatus) return null;
    const fallbackModel =
      submenuAgentStatus.default_model_id ||
      submenuAgentStatus.current_model_id ||
      "";
    const targetModel =
      submenuAgentStatus.name === agent
        ? model || fallbackModel
        : fallbackModel;
    return (
      (submenuAgentStatus.models ?? []).find(
        (item) => item.id === targetModel,
      ) ?? null
    );
  }, [submenuAgentStatus, agent, model]);
  const submenuEfforts = useMemo(
    () => submenuAgentStatus?.efforts ?? [],
    [submenuAgentStatus],
  );
  const submenuModes = useMemo(
    () => submenuAgentStatus?.modes ?? [],
    [submenuAgentStatus],
  );
  const displayedMode = useMemo(() => {
    if (!submenuAgentStatus) return "";
    const fallbackMode = submenuAgentStatus.current_mode_id || "";
    return submenuAgentStatus.name === agent
      ? mode || fallbackMode
      : fallbackMode;
  }, [submenuAgentStatus, agent, mode]);
  const submenuIsCodex = submenuAgentStatus?.name === "codex";
  const submenuSupportsEffort = useMemo(
    () => submenuEfforts.length > 0 && !!submenuSelectedModel?.supportEffort,
    [submenuEfforts, submenuSelectedModel],
  );
  const submenuSupportsServiceTier =
    !!submenuAgentStatus?.supports_fast_service;
  const fallbackEffort = submenuAgentStatus?.default_effort || "";
  const displayedEffort = submenuIsCodex
    ? effort || fallbackEffort || "Auto"
    : effort || fallbackEffort || "Auto";
  const fallbackFastService = submenuAgentStatus?.default_fast_service || "";
  const fastModeEnabled =
    (submenuAgentStatus?.name === agent ? fastService : fallbackFastService) ===
    "on";
  const buttonTitle = useMemo(() => {
    if (warnUnavailable) {
      return `当前会话的 Agent（${agent}）不可用`;
    }
    if (agent && model) {
      return `${agent} · ${model}`;
    }
    return undefined;
  }, [agent, model, warnUnavailable]);

  useEffect(() => {
    const handlePointerOutside = (e: PointerEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
        setSubmenuAgent(null);
        setErrorAgent(null);
        setModelSectionExpanded(true);
        setModeSectionExpanded(false);
        setEffortSectionExpanded(false);
        setServiceTierSectionExpanded(false);
        setMenuBodyHeight(null);
      }
    };
    if (isOpen) {
      document.addEventListener("pointerdown", handlePointerOutside);
      return () =>
        document.removeEventListener("pointerdown", handlePointerOutside);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || submenuAgent) {
      return;
    }
    const node = agentColumnRef.current;
    if (!node) {
      return;
    }
    setMenuBodyHeight(
      Math.min(
        AGENT_MENU_MAX_BODY_HEIGHT,
        Math.max(node.scrollHeight, AGENT_MENU_MIN_BODY_HEIGHT),
      ),
    );
  }, [isOpen, submenuAgent, agents.length]);

  const handleAgentSelect = useCallback(
    (newAgent: string, nextModel?: string) => {
      onAgentChange(newAgent, nextModel);
      setIsOpen(false);
      setSubmenuAgent(null);
      setErrorAgent(null);
      setModelSectionExpanded(true);
      setModeSectionExpanded(false);
      setEffortSectionExpanded(false);
      setServiceTierSectionExpanded(false);
    },
    [onAgentChange],
  );

  const handleAgentRowClick = useCallback(
    (entry: AgentStatus) => {
      handleAgentSelect(entry.name, "");
    },
    [handleAgentSelect],
  );

  const handleSubmenuToggle = useCallback((entry: AgentStatus) => {
    if (
      (entry.models?.length ?? 0) === 0 &&
      (entry.modes?.length ?? 0) === 0 &&
      (entry.efforts?.length ?? 0) === 0 &&
      !entry.supports_fast_service
    ) {
      return;
    }
    setErrorAgent(null);
    setModelSectionExpanded(true);
    setModeSectionExpanded(false);
    setEffortSectionExpanded(false);
    setServiceTierSectionExpanded(false);
    const node = agentColumnRef.current;
    if (node) {
      setMenuBodyHeight(
        Math.min(
          AGENT_MENU_MAX_BODY_HEIGHT,
          Math.max(node.scrollHeight, AGENT_MENU_MIN_BODY_HEIGHT),
        ),
      );
    }
    setSubmenuAgent((prev) => (prev === entry.name ? null : entry.name));
  }, []);

  const handleEffortSelect = useCallback(
    (nextEffort: string) => {
      onEffortChange?.(nextEffort);
      setIsOpen(false);
      setSubmenuAgent(null);
      setErrorAgent(null);
      setModelSectionExpanded(true);
      setModeSectionExpanded(false);
      setEffortSectionExpanded(false);
      setServiceTierSectionExpanded(false);
      setMenuBodyHeight(null);
    },
    [onEffortChange],
  );

  const handleServiceTierSelect = useCallback(
    (nextFastService: "" | "on" | "off") => {
      onFastServiceChange?.(nextFastService);
      setIsOpen(false);
      setSubmenuAgent(null);
      setErrorAgent(null);
      setModelSectionExpanded(true);
      setModeSectionExpanded(false);
      setEffortSectionExpanded(false);
      setServiceTierSectionExpanded(false);
      setMenuBodyHeight(null);
    },
    [onFastServiceChange],
  );

  const handleModeSelect = useCallback(
    (nextMode: string) => {
      onModeChange?.(nextMode);
      setIsOpen(false);
      setSubmenuAgent(null);
      setErrorAgent(null);
      setModelSectionExpanded(true);
      setModeSectionExpanded(false);
      setEffortSectionExpanded(false);
      setServiceTierSectionExpanded(false);
      setMenuBodyHeight(null);
    },
    [onModeChange],
  );

  const handleAgentRestart = useCallback(
    async (targetAgent: string) => {
      if (!onAgentRestart || restartingAgent) {
        return;
      }
      setRestartingAgent(targetAgent);
      try {
        await onAgentRestart(targetAgent);
      } finally {
        setRestartingAgent((current) =>
          current === targetAgent ? null : current,
        );
      }
    },
    [onAgentRestart, restartingAgent],
  );

  return (
    <div ref={dropdownRef} style={{ position: "relative" }}>
      <style>{`
        @keyframes agent-refresh-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
      <button
        type="button"
        onClick={() => {
          setIsOpen((prev) => {
            const next = !prev;
            if (!next) {
              setSubmenuAgent(null);
              setErrorAgent(null);
              setModelSectionExpanded(true);
              setModeSectionExpanded(false);
              setEffortSectionExpanded(false);
              setServiceTierSectionExpanded(false);
              setMenuBodyHeight(null);
            }
            return next;
          });
        }}
        title={buttonTitle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "4px",
          padding: compact ? "4px 4px" : "6px 8px",
          borderRadius: "12px",
          border: "none",
          background: "transparent",
          cursor: "pointer",
          fontSize: "16px",
          transition: "background 0.2s",
          outline: "none",
          position: "relative",
        }}
        onMouseEnter={(e) => {
          if (compact) e.currentTarget.style.background = "rgba(0,0,0,0.05)";
        }}
        onMouseLeave={(e) => {
          if (compact) e.currentTarget.style.background = "transparent";
        }}
      >
        <AgentIcon
          agentName={agent}
          style={{ width: "16px", height: "16px" }}
        />
        {showChevron ? (
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ color: "var(--text-secondary)" }}
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        ) : null}
        {warnUnavailable && (
          <span
            style={{
              position: "absolute",
              top: "3px",
              right: "3px",
              minWidth: "11px",
              height: "11px",
              padding: "0 2px",
              borderRadius: "50%",
              background: "#d97706",
              color: "#fff",
              fontSize: "9px",
              lineHeight: "11px",
              fontWeight: 700,
              textAlign: "center",
              boxShadow: "0 0 0 1px rgba(255,255,255,0.95)",
            }}
          >
            !
          </span>
        )}
      </button>

      {isOpen && (
        <div
          style={{
            position: "absolute",
            ...(menuPlacement === "bottom"
              ? { top: "calc(100% + 8px)" }
              : { bottom: "calc(100% + 8px)" }),
            right: 0,
            background: "var(--menu-bg)",
            border: "1px solid var(--menu-border)",
            borderRadius: "12px",
            boxShadow: "0 8px 32px rgba(0,0,0,0.15)",
            zIndex: 1000,
            width: "max-content",
            minWidth: "0",
            maxWidth: "calc(100vw - 16px)",
            padding: "8px 0",
            display: "flex",
            alignItems: "stretch",
            height: menuBodyHeight ? `${menuBodyHeight + 16}px` : "auto",
            maxHeight: "360px",
          }}
        >
          <div
            ref={agentColumnRef}
            style={{
              width: "fit-content",
              minWidth: "0",
              maxWidth:
                submenuAgentStatus || errorAgentStatus
                  ? "min(44vw, 180px)"
                  : "min(72vw, 180px)",
              height: menuBodyHeight ? `${menuBodyHeight}px` : "auto",
              maxHeight: `${AGENT_MENU_MAX_BODY_HEIGHT}px`,
              overflowY: "auto",
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
              Agent
            </div>
            {agents.map((a) => {
              const hasModelOptions =
                (a.models?.length ?? 0) > 0 ||
                (a.modes?.length ?? 0) > 0 ||
                (a.efforts?.length ?? 0) > 0 ||
                !!a.supports_fast_service;
              const hasError = !a.available && !!a.error;
              const isSelected = a.name === agent;
              const isExpanded = submenuAgent === a.name;
              const isShowingError = errorAgent === a.name;
              return (
                <div
                  key={a.name}
                  style={{
                    minWidth: "100%",
                  }}
                >
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "20px minmax(0, 1fr) 18px 18px",
                      alignItems: "center",
                      columnGap: "4px",
                      width: "100%",
                      padding: "10px 12px",
                      background:
                        isExpanded || isSelected
                          ? "rgba(59, 130, 246, 0.08)"
                          : "transparent",
                      opacity: 1,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => handleAgentRowClick(a)}
                      style={{
                        display: "contents",
                        border: "none",
                        background: "transparent",
                        padding: 0,
                        margin: 0,
                        cursor: "pointer",
                        textAlign: "left",
                      }}
                    >
                      <AgentIcon
                        agentName={a.name}
                        style={{ width: "16px", height: "16px" }}
                      />
                      <span
                        style={{
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          fontSize: "13px",
                          color:
                            isExpanded || isSelected
                              ? "#3b82f6"
                              : "var(--text-primary)",
                          fontWeight: isExpanded || isSelected ? 500 : 400,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {a.name}
                      </span>
                    </button>
                    {hasError ? (
                      <button
                        type="button"
                        aria-label={`查看 ${a.name} 错误信息`}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setSubmenuAgent(null);
                          setModelSectionExpanded(true);
                          setModeSectionExpanded(false);
                          setEffortSectionExpanded(false);
                          setServiceTierSectionExpanded(false);
                          setErrorAgent((prev) =>
                            prev === a.name ? null : a.name,
                          );
                        }}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: "18px",
                          height: "18px",
                          borderRadius: "999px",
                          border: "1px solid var(--menu-border)",
                          background: isShowingError
                            ? "rgba(217, 119, 6, 0.12)"
                            : "transparent",
                          color: "#d97706",
                          fontSize: "11px",
                          fontWeight: 700,
                          cursor: "pointer",
                          justifySelf: "center",
                        }}
                      >
                        ?
                      </button>
                    ) : (
                      <span
                        aria-hidden="true"
                        style={{ width: "18px", height: "18px" }}
                      />
                    )}
                    {hasModelOptions ? (
                      <button
                        type="button"
                        aria-label={
                          isExpanded
                            ? `收起 ${a.name} 模型列表`
                            : `展开 ${a.name} 模型列表`
                        }
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          handleSubmenuToggle(a);
                        }}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: "18px",
                          height: "18px",
                          borderRadius: "6px",
                          border: "none",
                          background: "transparent",
                          color: isExpanded
                            ? "#3b82f6"
                            : "var(--text-secondary)",
                          cursor: "pointer",
                          justifySelf: "center",
                        }}
                      >
                        <SelectorChevron expanded={isExpanded} />
                      </button>
                    ) : (
                      <span
                        aria-hidden="true"
                        style={{ width: "18px", height: "18px" }}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div
            style={{
              width:
                submenuAgentStatus || errorAgentStatus ? "fit-content" : "0",
              minWidth: submenuAgentStatus || errorAgentStatus ? "0" : "0",
              maxWidth:
                submenuAgentStatus || errorAgentStatus
                  ? "min(40vw, 180px)"
                  : "0",
              borderLeft:
                submenuAgentStatus || errorAgentStatus
                  ? "1px solid var(--menu-divider)"
                  : "none",
              height: menuBodyHeight ? `${menuBodyHeight}px` : "auto",
              maxHeight: `${AGENT_MENU_MAX_BODY_HEIGHT}px`,
              overflowY: "auto",
              overflowX: "hidden",
              transition: "width 0.16s ease, border-left-color 0.16s ease",
              boxSizing: "border-box",
            }}
          >
            {errorAgentStatus &&
            parseAgentErrorMessage(errorAgentStatus.error) ? (
              <div
                style={{
                  width: "100%",
                  minWidth: 0,
                  padding: "12px",
                  boxSizing: "border-box",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "8px",
                    marginBottom: "8px",
                  }}
                >
                  <div
                    style={{
                      fontSize: "11px",
                      fontWeight: 600,
                      color: "#d97706",
                      textTransform: "uppercase",
                    }}
                  >
                    错误信息
                  </div>
                  {onAgentRestart ? (
                    <button
                      type="button"
                      aria-label={`重启 ${errorAgentStatus.name}`}
                      title="重启 Agent"
                      disabled={restartingAgent === errorAgentStatus.name}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void handleAgentRestart(errorAgentStatus.name);
                      }}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: "22px",
                        height: "22px",
                        borderRadius: "7px",
                        border: "none",
                        background: "transparent",
                        color: "#d97706",
                        cursor:
                          restartingAgent === errorAgentStatus.name
                            ? "default"
                            : "pointer",
                        opacity:
                          restartingAgent === errorAgentStatus.name ? 0.62 : 1,
                        padding: 0,
                        flex: "0 0 auto",
                      }}
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="1em"
                        height="1em"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                        style={{
                          transformOrigin: "50% 50%",
                          animation:
                            restartingAgent === errorAgentStatus.name
                              ? "agent-refresh-spin 0.9s linear infinite"
                              : undefined,
                        }}
                      >
                        <path d="M0 0h24v24H0z" fill="none" />
                        <path
                          fill="currentColor"
                          d="M12 20q-3.35 0-5.675-2.325T4 12t2.325-5.675T12 4q1.725 0 3.3.712T18 6.75V5q0-.425.288-.712T19 4t.713.288T20 5v5q0 .425-.288.713T19 11h-5q-.425 0-.712-.288T13 10t.288-.712T14 9h3.2q-.8-1.4-2.187-2.2T12 6Q9.5 6 7.75 7.75T6 12t1.75 4.25T12 18q1.7 0 3.113-.862t2.187-2.313q.2-.35.563-.487t.737-.013q.4.125.575.525t-.025.75q-1.025 2-2.925 3.2T12 20"
                        />
                      </svg>
                    </button>
                  ) : null}
                </div>
                <div
                  style={{
                    padding: "10px 12px",
                    borderRadius: "10px",
                    background: "rgba(217, 119, 6, 0.08)",
                    border: "1px solid rgba(217, 119, 6, 0.18)",
                    color: "var(--text-primary)",
                    fontSize: "12px",
                    lineHeight: 1.5,
                    whiteSpace: "normal",
                    overflowWrap: "anywhere",
                    wordBreak: "break-word",
                  }}
                >
                  {parseAgentErrorMessage(errorAgentStatus.error)}
                </div>
                {parseAgentErrorDetails(errorAgentStatus.error).map(
                  (detail) => (
                    <div
                      key={detail}
                      style={{
                        marginTop: "8px",
                        padding: "10px 12px",
                        borderRadius: "10px",
                        background: "rgba(0, 0, 0, 0.03)",
                        border: "1px solid var(--menu-divider)",
                        color: "var(--text-secondary)",
                        fontSize: "11px",
                        lineHeight: 1.5,
                        whiteSpace: "normal",
                        overflowWrap: "anywhere",
                        wordBreak: "break-word",
                      }}
                    >
                      {detail}
                    </div>
                  ),
                )}
              </div>
            ) : submenuAgentStatus ? (
              <>
                <SectionHeader
                  title="模型"
                  expanded={modelSectionExpanded}
                  onToggle={() => setModelSectionExpanded((prev) => !prev)}
                  value={submenuSelectedModel?.id || undefined}
                />
                {modelSectionExpanded ? (
                  <>
                    {submenuModels.map((item, index) => {
                      const isSelected =
                        submenuAgentStatus.name === agent &&
                        item.id === (submenuSelectedModel?.id || "");
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() =>
                            handleAgentSelect(submenuAgentStatus.name, item.id)
                          }
                          style={sectionItemStyle(
                            isSelected,
                            index > 0,
                            item.hidden ? 0.66 : 1,
                          )}
                          title={item.description || item.id}
                        >
                          <span style={{ fontSize: "13px", fontWeight: 500 }}>
                            {item.name || item.id}
                          </span>
                          {item.description ? (
                            <span
                              style={{
                                fontSize: "11px",
                                color: "var(--text-secondary)",
                                whiteSpace: "normal",
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                              }}
                            >
                              {item.description}
                            </span>
                          ) : item.hidden ? (
                            <span
                              style={{
                                fontSize: "11px",
                                color: "var(--text-secondary)",
                              }}
                            >
                              hidden
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </>
                ) : null}
                {submenuModes.length > 0 ? (
                  <>
                    <SectionHeader
                      title="模式"
                      expanded={modeSectionExpanded}
                      onToggle={() => setModeSectionExpanded((prev) => !prev)}
                      topBorder={
                        modelSectionExpanded ||
                        submenuModels.length > 0 ||
                        !!submenuSelectedModel?.id
                      }
                      value={displayedMode || undefined}
                    />
                    {modeSectionExpanded ? (
                      <>
                        {submenuModes.map((item, index) => (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => handleModeSelect(item.id)}
                            style={sectionItemStyle(
                              item.id === displayedMode,
                              index > 0,
                            )}
                            title={item.description || item.id}
                          >
                            <span style={{ fontSize: "13px", fontWeight: 500 }}>
                              {item.name || item.id}
                            </span>
                            {item.description ? (
                              <span
                                style={{
                                  fontSize: "11px",
                                  color: "var(--text-secondary)",
                                  whiteSpace: "normal",
                                  overflowWrap: "anywhere",
                                  wordBreak: "break-word",
                                }}
                              >
                                {item.description}
                              </span>
                            ) : null}
                          </button>
                        ))}
                      </>
                    ) : null}
                  </>
                ) : null}
                {submenuSupportsEffort ? (
                  <>
                    <SectionHeader
                      title="思考等级"
                      expanded={effortSectionExpanded}
                      onToggle={() => setEffortSectionExpanded((prev) => !prev)}
                      topBorder={
                        modelSectionExpanded ||
                        submenuModels.length > 0 ||
                        !!submenuSelectedModel?.id ||
                        submenuModes.length > 0
                      }
                      value={displayedEffort}
                    />
                    {effortSectionExpanded ? (
                      <>
                        {submenuEfforts.map((item, index) => (
                          <button
                            key={item}
                            type="button"
                            onClick={() => handleEffortSelect(item)}
                            style={sectionItemStyle(
                              item === displayedEffort.toLowerCase(),
                              index > 0,
                            )}
                          >
                            <span
                              style={{
                                fontSize: "13px",
                                fontWeight: 500,
                                textTransform: "capitalize",
                              }}
                            >
                              {item}
                            </span>
                          </button>
                        ))}
                      </>
                    ) : null}
                  </>
                ) : null}
                {submenuSupportsServiceTier ? (
                  <>
                    <SectionHeader
                      title="Fast 模式"
                      expanded={serviceTierSectionExpanded}
                      onToggle={() =>
                        setServiceTierSectionExpanded((prev) => !prev)
                      }
                      topBorder={
                        modelSectionExpanded ||
                        submenuModels.length > 0 ||
                        !!submenuSelectedModel?.id ||
                        submenuModes.length > 0 ||
                        submenuSupportsEffort
                      }
                      value={fastModeEnabled ? "开启" : "关闭"}
                    />
                    {serviceTierSectionExpanded ? (
                      <>
                        {(["off", "on"] as const).map((item, index) => (
                          <button
                            key={item}
                            type="button"
                            onClick={() => handleServiceTierSelect(item)}
                            style={sectionItemStyle(
                              (item === "on") === fastModeEnabled,
                              index > 0,
                            )}
                          >
                            <span
                              style={{
                                fontSize: "13px",
                                fontWeight: 500,
                              }}
                            >
                              {item === "on" ? "开启" : "关闭"}
                            </span>
                          </button>
                        ))}
                      </>
                    ) : null}
                  </>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function SectionHeader({
  title,
  expanded,
  onToggle,
  topBorder = false,
  value,
}: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  topBorder?: boolean;
  value?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        width: "100%",
        minWidth: 0,
        padding: "10px 12px",
        border: "none",
        borderTop: topBorder ? "1px solid var(--menu-divider)" : "none",
        background: expanded ? "rgba(59, 130, 246, 0.05)" : "transparent",
        color: "var(--text-primary)",
        textAlign: "left",
        cursor: "pointer",
      }}
    >
      <span
        style={{
          flex: "0 0 auto",
          fontSize: "11px",
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: expanded ? "#3b82f6" : "var(--text-secondary)",
          whiteSpace: "nowrap",
        }}
      >
        {title}
      </span>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: "8px",
          flex: "1 1 auto",
          minWidth: 0,
          marginLeft: "8px",
        }}
      >
        {value ? (
          <span
            title={value}
            style={{
              minWidth: 0,
              fontSize: "11px",
              color: "var(--text-secondary)",
              whiteSpace: "nowrap",
              maxWidth: "92px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              direction: "rtl",
              textAlign: "left",
            }}
          >
            {value}
          </span>
        ) : null}
        <SelectorChevron expanded={expanded} />
      </span>
    </button>
  );
}

function SelectorChevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      style={{
        flexShrink: 0,
        color: expanded ? "#3b82f6" : "#9ca3af",
        transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 0.16s ease",
      }}
    >
      <path
        d="M4 2.5 8 6 4 9.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function sectionItemStyle(
  selected: boolean,
  topBorder = false,
  opacity = 1,
): React.CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "2px",
    width: "100%",
    minWidth: 0,
    padding: "10px 12px",
    border: "none",
    borderTop: topBorder ? "1px solid var(--menu-divider)" : "none",
    background: selected ? "rgba(59, 130, 246, 0.08)" : "transparent",
    color: selected ? "#3b82f6" : "var(--text-primary)",
    textAlign: "left",
    cursor: "pointer",
    opacity,
  };
}

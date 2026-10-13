import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import type { AgentStatus } from "../services/agents";
import { AgentIcon } from "./AgentIcon";
import { filterAgentModels } from "./modelFiltering";
import "./ComposerModelSelector.css";

type SelectionProps = {
  agent: string;
  model?: string;
  effort?: string;
  agents: AgentStatus[];
  mobile?: boolean;
  onEffortChange?: (effort?: string) => void;
};

export type ComposerModelSelectorProps = SelectionProps & {
  mode?: string;
  fastService?: "" | "on" | "off";
  onAgentChange: (agent: string, model?: string) => void;
  onModeChange?: (mode?: string) => void;
  onFastServiceChange?: (fastService?: "" | "on" | "off") => void;
  onAgentRestart?: (agent: string) => void | Promise<void>;
  warnUnavailable?: boolean;
  allowDefaultModel?: boolean;
  onboardingId?: string;
  openSignal?: number;
};

function Chevron({ open = false }: { open?: boolean }) {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: open ? "rotate(180deg)" : undefined }}><path d="m6 9 6 6 6-6" /></svg>;
}

function Check() {
  return <svg className="composer-selector-check" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>;
}

function selectedModel(status: AgentStatus | undefined, model = "") {
  const models = status?.models ?? [];
  return models.find((item) => item.id === model)
    ?? models.find((item) => item.id === (status?.default_model_id || status?.current_model_id));
}

function useMobile(override?: boolean) {
  const [mobile, setMobile] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches);
  useEffect(() => {
    if (override !== undefined) return;
    const query = window.matchMedia("(max-width: 767px)");
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [override]);
  return override ?? mobile;
}

/** Keep portalled menus above the composer and within the visual viewport. */
function useSelectorPopup(open: boolean, mobile: boolean, close: () => void) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<React.CSSProperties>({ visibility: "hidden" });

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      const viewport = window.visualViewport;
      const leftEdge = viewport?.offsetLeft ?? 0;
      const topEdge = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      if (mobile) {
        setPosition({ left: leftEdge, width, bottom: Math.max(0, window.innerHeight - topEdge - height), maxHeight: height - 12 });
      } else {
        const panelWidth = panel.getBoundingClientRect().width;
        const availableAbove = anchor.top - topEdge - 16;
        const availableBelow = topEdge + height - anchor.bottom - 16;
        const placeAbove = availableAbove >= Math.min(panel.scrollHeight, 300) || availableAbove >= availableBelow;
        const maxHeight = Math.max(100, placeAbove ? availableAbove : availableBelow);
        const panelHeight = Math.min(panel.scrollHeight, maxHeight);
        setPosition({
          left: Math.max(leftEdge + 8, Math.min(anchor.left, leftEdge + width - panelWidth - 8)),
          top: placeAbove ? Math.max(topEdge + 8, anchor.top - panelHeight - 8) : anchor.bottom + 8,
          maxHeight,
        });
      }
    };
    update();
    const observer = new ResizeObserver(update);
    if (panelRef.current) observer.observe(panelRef.current);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, [open, mobile]);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Focusing the sheet itself avoids opening the phone keyboard before search is requested.
    panelRef.current?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!anchorRef.current?.contains(target) && !panelRef.current?.contains(target)) close();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (event.key === "Tab" && mobile) {
        const controls = Array.from(panelRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input, select, [tabindex='0']") ?? []);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keyboard, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", keyboard, true);
      if (previousFocus?.isConnected && (panelRef.current?.contains(document.activeElement) || document.activeElement === document.body)) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [open, mobile, close]);

  return { anchorRef, panelRef, position };
}

function SheetHeading({ title, onClose }: { title: string; onClose: () => void }) {
  const { t } = useI18n();
  return <>
    <div className="composer-selector-handle" aria-hidden="true" />
    <div className="composer-selector-sheet-heading">
      <strong>{title}</strong>
      <button className="composer-selector-close" type="button" aria-label={t("common.close")} onClick={onClose}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
      </button>
    </div>
  </>;
}

export function ComposerModelSelector({
  agent, model = "", effort = "", mode = "", fastService = "", agents,
  mobile: mobileOverride, onAgentChange, onModeChange, onEffortChange,
  onFastServiceChange, onAgentRestart, warnUnavailable = false,
  allowDefaultModel = false, onboardingId, openSignal,
}: ComposerModelSelectorProps) {
  const { t } = useI18n();
  const mobile = useMobile(mobileOverride);
  const [open, setOpen] = useState(false);
  const [browsedAgent, setBrowsedAgent] = useState(agent);
  const [query, setQuery] = useState("");
  const [restartPending, setRestartPending] = useState(false);
  const [restartError, setRestartError] = useState("");
  const close = useCallback(() => setOpen(false), []);
  const popup = useSelectorPopup(open, mobile, close);
  const id = useId();
  const currentStatus = agents.find((item) => item.name === agent);
  const currentModel = selectedModel(currentStatus, model);
  const modelLabel = currentModel?.name || model || currentModel?.id || t("agent.defaultModel");
  const status = agents.find((item) => item.name === browsedAgent) ?? currentStatus ?? agents[0];
  const isCurrent = status?.name === agent;
  const activeModel = selectedModel(status, isCurrent ? model : "");
  const models = filterAgentModels(status?.models ?? [], query);
  const efforts = activeModel?.supportEffort ? activeModel.efforts ?? status?.efforts ?? [] : [];
  const activeEffort = (isCurrent ? effort : "") || status?.default_effort || "";
  const activeMode = (isCurrent ? mode : "") || status?.current_mode_id || "";
  const fastEnabled = ((isCurrent ? fastService : "") || status?.default_fast_service) === "on";

  const openMenu = useCallback(() => {
    setBrowsedAgent(agent);
    setQuery("");
    setRestartError("");
    setOpen(true);
  }, [agent]);
  const handledSignal = useRef(openSignal ?? 0);
  useEffect(() => {
    if (openSignal && handledSignal.current !== openSignal) {
      handledSignal.current = openSignal;
      openMenu();
    }
  }, [openSignal, openMenu]);

  const selectModel = (nextModel?: string) => {
    if (!status) return;
    onAgentChange(status.name, nextModel);
    if (!mobile) close();
  };
  // Option changes on another agent must first switch to that agent.
  const selectBrowsedAgent = () => {
    if (status && !isCurrent) onAgentChange(status.name, activeModel?.id || status.default_model_id || status.current_model_id || "");
  };
  const restart = async () => {
    if (!status || !onAgentRestart || restartPending) return;
    setRestartPending(true);
    setRestartError("");
    try { await onAgentRestart(status.name); }
    catch (error) { setRestartError(error instanceof Error ? error.message : String(error)); }
    finally { setRestartPending(false); }
  };

  const triggerProps = {
    "aria-haspopup": "dialog" as const,
    "aria-expanded": open,
    "aria-controls": open ? id : undefined,
    onClick: () => open ? close() : openMenu(),
  };

  return <div ref={popup.anchorRef} className={`composer-model-selector${mobile ? " is-mobile" : ""}`} data-onboarding={onboardingId}>
    <button type="button" className="composer-selector-trigger composer-agent-trigger" {...triggerProps}
      aria-label={t("composer.agentModels")}
      title={warnUnavailable ? t("agent.currentUnavailable", { name: agent }) : `${agent} · ${modelLabel}`}>
      <AgentIcon agentName={agent} style={{ width: mobile ? 21 : 19, height: mobile ? 21 : 19, flexShrink: 0 }} />
      <span className="composer-selector-trigger-label">{mobile ? modelLabel : agent}</span>
      {warnUnavailable && <span className="composer-selector-warning" aria-label={t("agent.notReady")}>!</span>}
      <Chevron open={open} />
    </button>
    {!mobile && <button type="button" className="composer-selector-trigger composer-model-trigger" {...triggerProps} title={modelLabel} aria-label={`${t("agent.model")}: ${modelLabel}`}>
      <span className="composer-selector-trigger-label">{modelLabel}</span><Chevron open={open} />
    </button>}
    {open && createPortal(<>
      {mobile && <div className="composer-selector-backdrop" aria-hidden="true" onClick={close} />}
      <div ref={popup.panelRef} id={id} role="dialog" aria-modal={mobile || undefined} aria-label={t("composer.agentModels")} tabIndex={-1}
        className={`composer-selector-panel composer-model-panel${mobile ? " is-mobile" : ""}`} style={popup.position}>
        {mobile && <SheetHeading title={t("composer.agentModels")} onClose={close} />}
        <div className="composer-selector-columns">
          <div className="composer-selector-agents">
            {!mobile && <div className="composer-selector-caption">Agent</div>}
            <div className="composer-selector-agent-list" role="group" aria-label="Agent">
              {agents.map((item) => <button type="button" key={item.name} className={`composer-selector-agent${item.name === status?.name ? " is-selected" : ""}`}
                aria-pressed={item.name === status?.name} title={!item.available ? t("agent.currentUnavailable", { name: item.name }) : item.brief || item.name}
                onClick={() => { setBrowsedAgent(item.name); setQuery(""); setRestartError(""); }}>
                <AgentIcon agentName={item.name} style={{ width: 20, height: 20, flexShrink: 0 }} />
                <span>{item.name}</span>
                {!item.available ? <span className="composer-selector-unavailable" aria-label={t("agent.notReady")}>!</span> : !mobile && <Chevron open={item.name === status?.name} />}
              </button>)}
            </div>
          </div>
          <div className="composer-selector-options">
            {!mobile && <div className="composer-selector-caption composer-selector-model-heading"><span>{t("agent.model")}</span><span title={activeModel?.id}>{activeModel?.id}</span></div>}
            <label className="composer-selector-search">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("agent.modelSearchPlaceholder")} aria-label={t("agent.modelSearchPlaceholder")} />
            </label>
            <div className="composer-selector-model-list" role="group" aria-label={t("agent.model")}>
              {status && (allowDefaultModel || !(status.models?.length)) && !query.trim() && <button type="button"
                className={`composer-selector-model${isCurrent && !model ? " is-selected" : ""}`} aria-pressed={isCurrent && !model}
                title={t("agent.defaultModelDescription")} onClick={() => selectModel(allowDefaultModel ? "" : status.default_model_id || status.current_model_id || "")}>
                <span>{t("agent.defaultModel")}</span>{isCurrent && !model && <Check />}
              </button>}
              {models.map((item) => {
                const selected = isCurrent && item.id === activeModel?.id && (!allowDefaultModel || !!model);
                return <button type="button" key={item.id} className={`composer-selector-model${selected ? " is-selected" : ""}${item.hidden ? " is-hidden-model" : ""}`}
                  title={item.description || item.id} aria-pressed={selected} onClick={() => selectModel(item.id)}>
                  <span>{item.name || item.id}</span>{selected && <Check />}
                </button>;
              })}
              {models.length === 0 && (query.trim() || !!status?.models?.length || !status) && <p className="composer-selector-empty">{t("agent.modelNoMatch")}</p>}
            </div>
            {(status?.error || status?.models_error || !status?.available || restartError) && status && <div className="composer-selector-error">
              <span>{restartError || status.error || status.models_error || t("agent.notReady")}</span>
              {onAgentRestart && <button type="button" onClick={() => void restart()} disabled={restartPending}>{restartPending ? t("common.loading") : t("agent.restartAgent")}</button>}
            </div>}
            {!!status?.modes?.length && onModeChange && <label className="composer-selector-mode">
              <span>{t("agent.mode")}</span>
              <select value={activeMode} onChange={(event) => { selectBrowsedAgent(); onModeChange(event.target.value); }}>
                {!activeMode && <option value="">Auto</option>}
                {status.modes.map((item) => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}
              </select>
            </label>}
            {mobile && efforts.length > 0 && onEffortChange && <div className="composer-selector-effort-section">
              <div className="composer-selector-caption">{t("agent.effort")}</div>
              <div className="composer-selector-effort-segments" role="group" aria-label={t("agent.effort")}>
                {efforts.map((item) => <button type="button" key={item} aria-pressed={item === activeEffort} className={item === activeEffort ? "is-selected" : ""}
                  onClick={() => { selectBrowsedAgent(); onEffortChange(item); }}>{item}</button>)}
              </div>
            </div>}
            {status?.supports_fast_service && onFastServiceChange && <div className="composer-selector-fast">
              <span>{t("agent.fastMode")}</span>
              <button type="button" role="switch" aria-checked={fastEnabled} aria-label={t("agent.fastMode")} className="composer-selector-fast-control"
                onClick={() => { selectBrowsedAgent(); onFastServiceChange(fastEnabled ? "off" : "on"); }}>
                {!mobile && <span>{fastEnabled ? t("agent.enabled") : t("agent.disabled")}</span>}
                <span className={`composer-selector-switch${fastEnabled ? " is-on" : ""}`} aria-hidden="true"><span /></span>
              </button>
            </div>}
          </div>
        </div>
      </div>
    </>, document.body)}
  </div>;
}

export function ComposerEffortSelector({ agent, model = "", effort = "", agents, mobile: mobileOverride, onEffortChange }: SelectionProps) {
  const { t } = useI18n();
  const mobile = useMobile(mobileOverride);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const popup = useSelectorPopup(open, mobile, close);
  const id = useId();
  const status = agents.find((item) => item.name === agent);
  const modelInfo = selectedModel(status, model);
  const efforts = modelInfo?.supportEffort ? modelInfo.efforts ?? status?.efforts ?? [] : [];
  const value = effort || status?.default_effort || "Auto";
  useEffect(() => { setOpen(false); }, [agent, model]);
  if (!efforts.length || !onEffortChange) return null;

  return <div ref={popup.anchorRef} className={`composer-effort-selector${mobile ? " is-mobile" : ""}`}>
    <button type="button" className="composer-selector-trigger composer-effort-trigger" aria-label={`${t("agent.effort")}: ${value}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen((previous) => !previous)}>
      {!mobile && <span className="composer-effort-trigger-caption">{t("composer.thinking")}</span>}<span>{value}</span><Chevron open={open} />
    </button>
    {open && createPortal(<>
      {mobile && <div className="composer-selector-backdrop" aria-hidden="true" onClick={close} />}
      <div ref={popup.panelRef} id={id} role="dialog" aria-modal={mobile || undefined} aria-label={t("agent.effort")} tabIndex={-1}
        className={`composer-selector-panel composer-effort-panel${mobile ? " is-mobile" : ""}`} style={popup.position}>
        {mobile ? <SheetHeading title={t("agent.effort")} onClose={close} /> : <div className="composer-selector-caption composer-selector-model-heading"><span>{t("agent.effort")}</span><span>{modelInfo?.name || modelInfo?.id || model}</span></div>}
        <div className="composer-effort-options" role="group" aria-label={t("agent.effort")}>
          {efforts.map((item) => <button type="button" key={item} className={`composer-selector-model${item === value ? " is-selected" : ""}`} aria-pressed={item === value}
            onClick={() => { onEffortChange(item); close(); }}>
            <span>{item}</span>{item === value && <Check />}
          </button>)}
        </div>
      </div>
    </>, document.body)}
  </div>;
}

import { useCallback, useEffect, useRef, useState } from "react";
import { AgentIcon } from "./AgentIcon";
import { ComposerPopover } from "./ComposerPopover";
import { filterAgentModels } from "./modelFiltering";
import type { AgentStatus } from "../services/agents";
import { useI18n, type MessageKey } from "../i18n";
import "./ComposerAgentSelector.css";

type ComposerAgentSelectorProps = {
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
  openSignal?: number;
  isMobile: boolean;
  warnUnavailable?: boolean;
};

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

export function ComposerAgentSelector({ agent, model = "", mode = "", effort = "", fastService = "", agents, onAgentChange, onModeChange, onEffortChange, onFastServiceChange, onAgentRestart, openSignal, isMobile, warnUnavailable = false }: ComposerAgentSelectorProps) {
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
          {!isMobile ? <div className="composer-menu-caption composer-model-heading"><span>{t("agent.model")}</span><span title={viewedModelId}>{viewedModelId}</span></div> : null}
          <label className="composer-model-search">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg>
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
          {viewed?.supports_fast_service && onFastServiceChange ? <div className="composer-agent-settings composer-fast-setting"><span>{t("agent.fastMode")}</span><button className="composer-fast-control" type="button" role="switch" aria-checked={fastEnabled} aria-label={t("agent.fastMode")} onClick={() => { selectViewedAgent(); onFastServiceChange(fastEnabled ? "off" : "on"); }}>{!isMobile ? <span>{fastEnabled ? t("agent.enabled") : t("agent.disabled")}</span> : null}<span className={`composer-toggle-track${fastEnabled ? " is-on" : ""}`} aria-hidden="true"><span /></span></button></div> : null}
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

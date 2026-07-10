import React, { useEffect, useMemo, useRef, useState } from "react";
import { AgentSelector } from "./AgentSelector";
import { ModelSelector } from "./ModelSelector";
import { AgentModeSelector } from "./AgentModeSelector";
import { EffortSelector } from "./EffortSelector";
import { FastServiceSelector } from "./FastServiceSelector";
import { AgentIcon } from "./AgentIcon";
import {
  deleteStageTemplate,
  fetchStageTemplates,
  saveStageTemplate,
  saveTaskTemplate,
  type StageRole,
  type StageTemplate,
  type TaskTemplate,
  type TaskTemplateStage,
} from "../services/tasks";
import type { AgentStatus } from "../services/agents";
import { reportError } from "../services/error";

type TaskTemplateDialogProps = {
  open: boolean;
  agents: AgentStatus[];
  template?: TaskTemplate | null;
  onClose: () => void;
  onSaved?: (template: TaskTemplate) => void;
};

const blankUserStage = (): StageTemplate => ({
  name: "",
  role: "user",
  auto_advance: false,
  prompt_template: "",
});

const blankAgentStage = (): StageTemplate => ({
  name: "",
  role: "agent",
  auto_advance: false,
  agent: "codex",
  model: "",
  mode: "",
  effort: "",
  fast_service: "",
  plan_mode: false,
  session_reuse_policy: "task_main",
  prompt_template: "{previous_input}",
  agent_can_control_stage: false,
});

const newTaskTemplate = (): TaskTemplate => ({
  name: "",
  description: "",
  max_concurrency: 2,
  stages: [{ position: 0, snapshot: { ...blankUserStage(), name: defaultStageName(0) } }],
});

function defaultStageName(index: number): string {
  return `阶段${index + 1}`;
}

function normalizeStages(stages: TaskTemplateStage[]): TaskTemplateStage[] {
  return stages.map((stage, index) => ({
    ...stage,
    position: index,
    snapshot: {
      ...stage.snapshot,
      role: index === 0 ? "user" : stage.snapshot.role,
    },
  }));
}

function cloneTemplate(template?: TaskTemplate | null): TaskTemplate {
  const base = template ? { ...template } : newTaskTemplate();
  return {
    ...base,
    stages: normalizeStages(base.stages?.length ? base.stages : newTaskTemplate().stages),
  };
}

function stageChangedFromTemplate(stage: StageTemplate, templates: StageTemplate[]): boolean {
  if (!stage.id) return true;
  const original = templates.find((item) => item.id === stage.id);
  if (!original) return true;
  const comparable = (value: StageTemplate) => JSON.stringify({
    name: value.name || "",
    role: value.role,
    auto_advance: value.auto_advance === true,
    agent: value.agent || "",
    model: value.model || "",
    mode: value.mode || "",
    effort: value.effort || "",
    fast_service: value.fast_service || "",
    plan_mode: value.plan_mode === true,
    session_reuse_policy: value.session_reuse_policy || "",
    prompt_template: value.prompt_template || "",
    agent_can_control_stage: value.agent_can_control_stage === true,
  });
  return comparable(stage) !== comparable(original);
}

function toFastService(value?: string): "" | "on" | "off" {
  return value === "on" || value === "off" ? value : "";
}

function agentDefaults(agent?: AgentStatus | null) {
  return {
    model: agent?.default_model_id || agent?.current_model_id || "",
    effort: agent?.default_effort || "",
    fastService: (agent?.default_fast_service || "") as "" | "on" | "off",
  };
}

function modelDefaultEffort(agent: AgentStatus | null, modelID: string): string {
  const model = agent?.models?.find((item) => item.id === modelID);
  if (model && !model.supportEffort) return "";
  const modelEfforts = model?.efforts ?? [];
  const efforts = modelEfforts.length > 0 ? modelEfforts : agent?.efforts ?? [];
  return [model?.default_effort || "", agent?.default_effort || ""]
    .find((item) => item && efforts.includes(item)) || efforts[0] || "";
}

export function TaskTemplateDialog({ open, agents, template, onClose, onSaved }: TaskTemplateDialogProps) {
  const [stageTemplates, setStageTemplates] = useState<StageTemplate[]>([]);
  const [draft, setDraft] = useState<TaskTemplate>(() => cloneTemplate(template));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [openHelpKey, setOpenHelpKey] = useState("");
  const [savedStageKeys, setSavedStageKeys] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!open) return;
    setDraft(cloneTemplate(template));
    setSavedStageKeys({});
    setSaveError("");
    let cancelled = false;
    fetchStageTemplates()
      .then((stages) => {
        if (!cancelled) setStageTemplates(stages);
      })
      .catch((err) => reportError("file.write_failed", String((err as Error)?.message || "阶段模板加载失败")));
    return () => {
      cancelled = true;
    };
  }, [open, template]);

  const title = useMemo(() => (template?.id ? "编辑任务模板" : "创建任务模板"), [template?.id]);

  if (!open) return null;

  const updateStage = (index: number, patch: Partial<StageTemplate>) => {
    setDraft((prev) => ({
      ...prev,
      stages: normalizeStages(prev.stages.map((stage, i) => (
        i === index ? { ...stage, snapshot: { ...stage.snapshot, ...patch } } : stage
      ))),
    }));
  };

  const chooseStageTemplate = (index: number, id: string) => {
    if (!id) {
      updateStage(index, { ...(index === 0 ? blankUserStage() : blankAgentStage()), name: draft.stages[index]?.snapshot.name || "" });
      setDraft((prev) => ({
        ...prev,
        stages: normalizeStages(prev.stages.map((stage, i) => (
          i === index ? { ...stage, stage_template_id: "" } : stage
        ))),
      }));
      return;
    }
    const selected = stageTemplates.find((item) => item.id === id);
    if (!selected) return;
    setDraft((prev) => ({
      ...prev,
      stages: normalizeStages(prev.stages.map((stage, i) => (
        i === index
          ? {
              ...stage,
              stage_template_id: selected.id,
              snapshot: { ...selected, role: index === 0 ? "user" : selected.role },
            }
          : stage
      ))),
    }));
  };

  const removeStageTemplate = async (id: string) => {
    const target = stageTemplates.find((item) => item.id === id);
    if (!target?.id) return;
    try {
      await deleteStageTemplate(target.id);
      setStageTemplates((prev) => prev.filter((item) => item.id !== target.id));
      setDraft((prev) => ({
        ...prev,
        stages: normalizeStages(prev.stages.map((stage) => (
          stage.stage_template_id === target.id || stage.snapshot.id === target.id
            ? { ...stage, stage_template_id: "", snapshot: { ...stage.snapshot, id: "" } }
            : stage
        ))),
      }));
    } catch (err) {
      reportError("file.write_failed", String((err as Error)?.message || "阶段模板删除失败"));
    }
  };

  const addStage = () => {
    setDraft((prev) => ({
      ...prev,
      stages: normalizeStages([...prev.stages, { position: prev.stages.length, snapshot: { ...blankAgentStage(), name: defaultStageName(prev.stages.length) } }]),
    }));
  };

  const removeStage = (index: number) => {
    if (index === 0) return;
    setDraft((prev) => ({
      ...prev,
      stages: normalizeStages(prev.stages.filter((_, stageIndex) => stageIndex !== index)),
    }));
  };

  const confirmSaveStageAsTemplate = async (index: number) => {
    const name = (draft.stages[index]?.snapshot.name || defaultStageName(index)).trim();
    if (!name) {
      reportError("file.write_failed", "阶段模板名称不能为空");
      return;
    }
    try {
      const saved = await saveStageTemplate({ ...draft.stages[index].snapshot, id: "", name });
      setStageTemplates((prev) => [...prev.filter((item) => item.id !== saved.id), saved]);
      setDraft((prev) => ({
        ...prev,
        stages: normalizeStages(prev.stages.map((stage, i) => (
          i === index
            ? { ...stage, stage_template_id: saved.id, snapshot: { ...saved } }
            : stage
        ))),
      }));
      const key = `${saved.id || index}-${index}`;
      setSavedStageKeys((prev) => ({ ...prev, [key]: true }));
      window.setTimeout(() => {
        setSavedStageKeys((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }, 1200);
    } catch (err) {
      reportError("file.write_failed", String((err as Error)?.message || "阶段模板保存失败"));
    }
  };

  const saveTask = async () => {
    if (!draft.name.trim()) {
      reportError("file.write_failed", "任务模板名称不能为空");
      return;
    }
    if (!draft.stages[0] || draft.stages[0].snapshot.role !== "user") {
      reportError("file.write_failed", "第一阶段必须是用户阶段");
      return;
    }
    setSaving(true);
    setSaveError("");
    try {
      const saved = await saveTaskTemplate({
        ...draft,
        stages: normalizeStages(draft.stages),
      });
      setDraft(cloneTemplate(saved));
      onSaved?.(saved);
      onClose();
    } catch (err) {
      const message = String((err as Error)?.message || "任务模板保存失败");
      setSaveError(message);
      reportError("file.write_failed", message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="task-template-overlay" style={{ position: "fixed", inset: 0, zIndex: 90, background: "rgba(15, 23, 42, 0.36)", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }}>
      <section className="task-template-dialog" style={{ width: "min(760px, 100%)", maxHeight: "88vh", overflow: "hidden", borderRadius: "10px", background: "var(--menu-bg)", border: "1px solid var(--border-color)", boxShadow: "0 24px 60px rgba(15, 23, 42, 0.24)", display: "flex", flexDirection: "column" }}>
        <style>{`
          .task-template-input:focus {
            border-color: var(--accent-color) !important;
            box-shadow: none;
          }
          .task-template-agent-active > div > button svg {
            color: #fff !important;
          }
          .task-template-agent-active > div > button img {
            filter: brightness(0) invert(1);
          }
          .task-template-agent-active > div > button span[aria-label] {
            color: #fff !important;
            background: transparent !important;
          }
          @media (max-width: 640px) {
            .task-template-overlay {
              top: 36px !important;
              align-items: flex-start !important;
              padding: 8px 12px 12px !important;
            }
            .task-template-dialog {
              width: 100% !important;
              height: auto !important;
              max-height: 60dvh !important;
            }
            .task-template-dialog-body {
              min-height: 0 !important;
              overflow: auto !important;
              -webkit-overflow-scrolling: touch;
            }
            .task-template-stage-name {
              width: 120px !important;
              flex-basis: 120px !important;
            }
          }
        `}</style>
        <header style={{ padding: "10px 14px", borderBottom: "1px solid var(--border-color)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
          <div style={{ fontSize: "15px", fontWeight: 800, color: "var(--text-color)" }}>{title}</div>
          <div style={{ display: "flex", gap: "8px" }}>
            <button type="button" onClick={onClose} style={buttonStyle("secondary")}>关闭</button>
            <button type="button" disabled={saving} onClick={() => void saveTask()} style={buttonStyle("primary")}>{saving ? "保存中" : "保存"}</button>
          </div>
        </header>
        {saveError ? (
          <div
            style={{
              margin: "10px 14px 0",
              padding: "8px 10px",
              borderRadius: "8px",
              border: "1px solid rgba(220, 38, 38, 0.24)",
              background: "rgba(220, 38, 38, 0.08)",
              color: "#b91c1c",
              fontSize: "12px",
              lineHeight: 1.45,
              fontWeight: 700,
            }}
          >
            {saveError}
          </div>
        ) : null}
        <div className="task-template-dialog-body" style={{ padding: "12px 14px", overflow: "auto", display: "flex", flexDirection: "column", gap: "12px", minHeight: 0 }}>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: "10px", alignItems: "end" }}>
            <label style={fieldStyle}>
              <input className="task-template-input" value={draft.name} placeholder="请输入模板名称" onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))} style={inputStyle} />
            </label>
          </div>

          {draft.stages.map((stage, index) => {
            const snapshot = stage.snapshot;
            const isAgent = snapshot.role === "agent";
            const selectedAgentStatus = agents.find((item) => item.name === (snapshot.agent || "codex")) || null;
            const planModeDisabled = isAgent && selectedAgentStatus?.protocol === "acp";
            const changed = stageChangedFromTemplate(snapshot, stageTemplates);
            const savedStageKey = `${stage.stage_template_id || snapshot.id || stage.id || index}-${index}`;
            const recentlySaved = savedStageKeys[savedStageKey] === true;
            const renderSaveTemplateAction = () => (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "4px", marginLeft: "auto", flex: "0 0 auto" }}>
                <button
                  type="button"
                  disabled={recentlySaved || !changed || !snapshot.name.trim()}
                  onClick={() => void confirmSaveStageAsTemplate(index)}
                  style={{ ...buttonStyle("secondary"), minWidth: "72px", justifyContent: "center" }}
                >
                  {recentlySaved ? <CheckIcon /> : "保存模板"}
                </button>
              </div>
            );
            const renderStageMetaActions = () => (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "4px", marginLeft: "auto", flex: "0 0 auto" }}>
                <button
                  type="button"
                  aria-label="删除阶段"
                  title={index === 0 ? "第一阶段不能删除" : "删除阶段"}
                  disabled={index === 0}
                  onClick={() => removeStage(index)}
                  style={{ ...taskIconButtonStyle(index === 0), color: index === 0 ? "var(--text-secondary)" : "#dc2626" }}
                >
                  <DeleteIcon />
                </button>
              </div>
            );
            return (
              <div
                key={`${stage.id || "stage"}-${index}`}
                style={{
                  border: "1px solid rgba(96, 165, 250, 0.42)",
                  borderRadius: "8px",
                  background: "var(--panel-bg)",
                  padding: "10px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "10px",
                  flexShrink: 0,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                  <StageTemplateSelect
                    value={stage.stage_template_id || snapshot.id || ""}
                    name={snapshot.name || ""}
                    role={snapshot.role}
                    templates={stageTemplates}
                    onNameChange={(name) => updateStage(index, { name })}
                    onChange={(id) => chooseStageTemplate(index, id)}
                    onDelete={(id) => void removeStageTemplate(id)}
                  />
                  <RoleAgentSwitch
                    role={snapshot.role}
                    disabled={index === 0}
                    agent={snapshot.agent || "codex"}
                    agents={agents}
                    onUserClick={() => updateStage(index, { ...blankUserStage(), name: snapshot.name || "" })}
                    onAgentActivate={() => {
                      const status = agents.find((item) => item.name === (snapshot.agent || "codex")) || agents[0] || null;
                      const defaults = agentDefaults(status);
                      updateStage(index, {
                        ...blankAgentStage(),
                        name: snapshot.name || "",
                        agent: status?.name || snapshot.agent || "codex",
                        model: snapshot.model || defaults.model,
                        effort: snapshot.effort || defaults.effort,
                        fast_service: snapshot.fast_service || defaults.fastService,
                        ...(status?.protocol === "acp" ? { plan_mode: false } : {}),
                      });
                    }}
                    onAgentChange={(agent) => {
                      const status = agents.find((item) => item.name === agent) || null;
                      const defaults = agentDefaults(status);
                      updateStage(index, {
                        agent,
                        model: defaults.model,
                        mode: status?.current_mode_id || "",
                        effort: modelDefaultEffort(status, defaults.model),
                        fast_service: defaults.fastService,
                        ...(status?.protocol === "acp" ? { plan_mode: false } : {}),
                      });
                    }}
                  />
                  {isAgent ? (
                    <>
                      <ModelSelector
                        agent={selectedAgentStatus}
                        model={snapshot.model || ""}
                        compact
                        menuPlacement="bottom"
                        maxButtonWidth="132px"
                        onModelChange={(model) =>
                          updateStage(index, {
                            model,
                            effort: modelDefaultEffort(selectedAgentStatus, model),
                          })
                        }
                      />
                      <AgentModeSelector
                        agent={selectedAgentStatus}
                        mode={snapshot.mode || ""}
                        compact
                        menuPlacement="bottom"
                        maxButtonWidth="132px"
                        onModeChange={(mode) => updateStage(index, { mode: mode || "" })}
                      />
                      <EffortSelector
                        agent={selectedAgentStatus}
                        model={snapshot.model || ""}
                        effort={snapshot.effort || ""}
                        compact
                        menuPlacement="bottom"
                        maxButtonWidth="132px"
                        onEffortChange={(effort) => updateStage(index, { effort: effort || "" })}
                      />
                    <FastServiceSelector
                      agent={selectedAgentStatus}
                      fastService={toFastService(snapshot.fast_service)}
                      compact
                      onFastServiceChange={(fastService) => updateStage(index, { fast_service: fastService || "" })}
                    />
                    </>
                  ) : null}
                  <StageOptionsMenu
                    isAgent={isAgent}
                    autoAdvance={snapshot.auto_advance === true}
                    planMode={!planModeDisabled && snapshot.plan_mode === true}
                    planModeDisabled={planModeDisabled}
                    sessionReusePolicy={snapshot.session_reuse_policy || "task_main"}
                    onAutoAdvanceChange={() => updateStage(index, { auto_advance: !snapshot.auto_advance })}
                    onPlanModeChange={() => {
                      if (!planModeDisabled) updateStage(index, { plan_mode: !snapshot.plan_mode });
                    }}
                    onSessionReusePolicyChange={(policy) => updateStage(index, { session_reuse_policy: policy })}
                  />
                  <div style={{ flex: "1 1 8px", minWidth: 0 }} />
                  {renderStageMetaActions()}
                </div>
                {isAgent ? (
                  <div style={fieldStyle}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
	                      <FieldLabelWithInfo
	                        label="Prompt 模板"
	                        info="阶段开始时提交给 Agent，可用 {previous_input}、{task_initial_input}、{task_number}。"
	                        helpKey={`prompt-${index}`}
                        openHelpKey={openHelpKey}
                        setOpenHelpKey={setOpenHelpKey}
                      />
                      {renderSaveTemplateAction()}
                    </div>
                    <textarea className="task-template-input" value={snapshot.prompt_template || ""} onChange={(event) => updateStage(index, { prompt_template: event.target.value })} rows={4} style={{ ...inputStyle, height: "auto", padding: "8px", resize: "vertical" }} />
                  </div>
                ) : (
                  <div style={fieldStyle}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <FieldLabelWithInfo
                        label="用户输入模板"
                        info="创建任务时预填到输入框。"
                        helpKey={`user-${index}`}
                        openHelpKey={openHelpKey}
                        setOpenHelpKey={setOpenHelpKey}
                      />
                      {renderSaveTemplateAction()}
                    </div>
                    <textarea className="task-template-input" value={snapshot.prompt_template || ""} onChange={(event) => updateStage(index, { prompt_template: event.target.value })} rows={4} style={{ ...inputStyle, height: "auto", padding: "8px", resize: "vertical" }} />
                  </div>
                )}
              </div>
            );
          })}
          <button type="button" onClick={addStage} style={{ ...buttonStyle("secondary"), flexShrink: 0 }}>添加新阶段</button>
        </div>
      </section>
    </div>
  );
}

function FieldLabelWithInfo({ label, info, helpKey, openHelpKey, setOpenHelpKey }: {
  label: string;
  info: string;
  helpKey: string;
  openHelpKey: string;
  setOpenHelpKey: (key: string) => void;
}) {
  const open = openHelpKey === helpKey;
  return (
    <span style={{ ...labelStyle, position: "relative", display: "inline-flex", alignItems: "center", gap: "5px", width: "fit-content" }}>
      {label}
      <button
        type="button"
        aria-label={`${label}说明`}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpenHelpKey(open ? "" : helpKey);
        }}
        style={{
          width: "15px",
          height: "15px",
          borderRadius: "999px",
          border: "1px solid var(--border-color)",
          background: open ? "var(--selection-bg)" : "transparent",
          color: open ? "var(--accent-color)" : "var(--text-secondary)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          fontSize: "10px",
          fontWeight: 800,
          cursor: "pointer",
          lineHeight: 1,
        }}
      >
        i
      </button>
      {open ? (
        <span style={{ color: "var(--text-secondary)", fontSize: "11px", fontWeight: 500, lineHeight: 1.35 }}>
          {info}
        </span>
      ) : null}
    </span>
  );
}

function StageTemplateSelect({ value, name, role, templates, onNameChange, onChange, onDelete }: {
  value: string;
  name: string;
  role: StageRole;
  templates: StageTemplate[];
  onNameChange: (name: string) => void;
  onChange: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const visibleTemplates = templates.filter((item) => item.role === role);
  const selected = visibleTemplates.find((item) => item.id === value) || null;

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  return (
    <div ref={ref} className="task-template-stage-name" style={{ position: "relative", width: "156px", flex: "0 0 156px" }}>
      <div
        className="task-template-input"
        style={{
          ...inputStyle,
          width: "100%",
          padding: 0,
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 28px",
          alignItems: "center",
          overflow: "hidden",
        }}
      >
        <input
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          placeholder="阶段名"
          style={{
            minWidth: 0,
            height: "100%",
            border: "none",
            background: "transparent",
            color: "var(--text-color)",
            outline: "none",
            padding: "0 7px",
            fontSize: "12px",
            fontWeight: 700,
          }}
        />
        <button
          type="button"
          aria-label="选择阶段模板"
          title={selected?.name ? `当前模板：${selected.name}` : "选择阶段模板"}
          onClick={() => setOpen((next) => !next)}
          style={{
            width: "28px",
            height: "28px",
            border: "none",
            borderLeft: "1px solid var(--border-color)",
            background: selected ? "rgba(37, 99, 235, 0.08)" : "transparent",
            color: selected ? "var(--accent-color)" : "var(--text-secondary)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            padding: 0,
          }}
        >
          <AgentDropdownChevron />
        </button>
      </div>
      {open ? (
        <div style={{ ...stageMenuStyle, left: 0, right: "auto", minWidth: "188px" }}>
          {visibleTemplates.length === 0 ? (
            <div style={{ padding: "8px 10px", fontSize: "12px", color: "var(--text-secondary)" }}>暂无阶段模板</div>
          ) : visibleTemplates.map((template) => {
            const active = template.id === value;
            return (
              <div key={template.id || template.name} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 26px", alignItems: "center" }}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(template.id || "");
                    setOpen(false);
                  }}
                  style={{ ...menuRowStyle({ active }), minWidth: 0 }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{template.name || "未命名模板"}</span>
                  <span style={menuTrailingCheckStyle(active)}>✓</span>
                </button>
                <button
                  type="button"
                  aria-label="删除阶段模板"
                  title="删除阶段模板"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete(template.id || "");
                  }}
                  style={{ ...taskIconButtonStyle(false), color: "#dc2626" }}
                >
                  <DeleteIcon />
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function StageOptionsMenu({
  isAgent,
  autoAdvance,
  planMode,
  planModeDisabled,
  sessionReusePolicy,
  onAutoAdvanceChange,
  onPlanModeChange,
  onSessionReusePolicyChange,
}: {
  isAgent: boolean;
  autoAdvance: boolean;
  planMode: boolean;
  planModeDisabled?: boolean;
  sessionReusePolicy: "task_main" | "same_stage" | "always_new";
  onAutoAdvanceChange: () => void;
  onPlanModeChange: () => void;
  onSessionReusePolicyChange: (policy: "task_main" | "same_stage" | "always_new") => void;
}) {
  const [open, setOpen] = useState(false);
  const [sessionOpen, setSessionOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        setOpen(false);
        setSessionOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative", width: "32px", height: "30px" }}>
      <button
        type="button"
        aria-label="阶段选项"
        onClick={() => setOpen((value) => !value)}
        style={menuIconButtonStyle(open)}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>
      {open ? (
        <div style={stageMenuStyle}>
          <MenuCheckRow checked={autoAdvance} label="自动进入下一阶段" onClick={onAutoAdvanceChange} />
          <MenuCheckRow checked={planMode} label="Plan 模式" disabled={!isAgent || planModeDisabled} onClick={onPlanModeChange} />
          <div style={menuDividerStyle} />
          <button
            type="button"
            disabled={!isAgent}
            onClick={() => {
              if (isAgent) setSessionOpen((value) => !value);
            }}
            style={menuRowStyle({ disabled: !isAgent })}
          >
            <span style={{ flex: 1 }}>会话复用</span>
            <span style={{ color: "var(--text-secondary)", fontSize: "11px" }}>{sessionReuseLabel(sessionReusePolicy)}</span>
            <ChevronRight isOpen={sessionOpen} />
          </button>
          {sessionOpen && isAgent ? (
            <>
              <MenuRadioRow checked={sessionReusePolicy === "task_main"} label="任务主会话" onClick={() => onSessionReusePolicyChange("task_main")} />
              <MenuRadioRow checked={sessionReusePolicy === "same_stage"} label="同阶段会话" onClick={() => onSessionReusePolicyChange("same_stage")} />
              <MenuRadioRow checked={sessionReusePolicy === "always_new"} label="每次新建" onClick={() => onSessionReusePolicyChange("always_new")} />
            </>
          ) : null}
          <div style={menuDividerStyle} />
        </div>
      ) : null}
    </div>
  );
}

function AgentDropdownChevron() {
  return (
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
      style={{ color: "var(--text-secondary)", flexShrink: 0 }}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function sessionReuseLabel(policy: "task_main" | "same_stage" | "always_new"): string {
  if (policy === "same_stage") return "同阶段会话";
  if (policy === "always_new") return "每次新建";
  return "任务主会话";
}

function MenuCheckRow({ checked, label, disabled, onClick }: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} style={menuRowStyle({ active: checked, disabled })}>
      <span>{label}</span>
      <span style={menuTrailingCheckStyle(checked)}>✓</span>
    </button>
  );
}

function MenuRadioRow({ checked, label, onClick }: {
  checked: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} style={menuRowStyle({ active: checked })}>
      <span>{label}</span>
      <span style={menuTrailingCheckStyle(checked)}>✓</span>
    </button>
  );
}

function ChevronRight({ isOpen }: { isOpen: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        transform: isOpen ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 0.15s cubic-bezier(0.4, 0, 0.2, 1)",
        color: isOpen ? "var(--text-primary)" : "#9ca3af",
        flexShrink: 0,
      }}
      aria-hidden="true"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function RoleAgentSwitch({
  role,
  disabled,
  agent,
  agents,
  onUserClick,
  onAgentActivate,
  onAgentChange,
}: {
  role: "user" | "agent";
  disabled?: boolean;
  agent: string;
  agents: AgentStatus[];
  onUserClick: () => void;
  onAgentActivate: () => void;
  onAgentChange: (agent: string) => void;
}) {
  const userActive = role === "user";
  return (
    <div
      style={{
        height: "30px",
        width: "76px",
        borderRadius: "7px",
        border: "1px solid var(--border-color)",
        background: "var(--input-bg)",
        padding: "1px",
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        opacity: disabled ? 0.68 : 1,
      }}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={onUserClick}
        style={roleSegmentStyle(userActive, disabled)}
      >
        user
      </button>
      {role === "agent" ? (
        <div
          className="task-template-agent-active"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            minWidth: 0,
            borderRadius: "5px",
            background: "var(--accent-color)",
            position: "relative",
            overflow: "visible",
          }}
        >
          <AgentSelector
            agent={agent}
            agents={agents}
            compact
            menuPlacement="bottom"
            showChevron
            onAgentChange={onAgentChange}
          />
        </div>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={onAgentActivate}
          style={roleSegmentStyle(false, disabled)}
          aria-label="切换到 Agent 阶段"
          title="切换到 Agent 阶段"
        >
          <AgentIcon agentName={agent || "codex"} style={{ width: "15px", height: "15px" }} />
        </button>
      )}
    </div>
  );
}

function roleSegmentStyle(active: boolean, disabled?: boolean): React.CSSProperties {
  return {
    border: "none",
    borderRadius: "5px",
    background: active ? "var(--accent-color)" : "transparent",
    color: active ? "#fff" : "var(--text-color)",
    fontSize: "11px",
    fontWeight: 800,
    cursor: disabled ? "not-allowed" : "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 0,
    padding: 0,
  };
}

const fieldStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 };
const labelStyle: React.CSSProperties = { fontSize: "11px", color: "var(--text-secondary)", fontWeight: 700 };
const inputStyle: React.CSSProperties = { height: "30px", boxSizing: "border-box", borderRadius: "6px", border: "1px solid var(--border-color)", background: "var(--input-bg)", color: "var(--text-color)", padding: "0 8px", fontSize: "12px", minWidth: 0, outline: "none" };

function menuIconButtonStyle(active: boolean): React.CSSProperties {
  return {
    width: "30px",
    height: "30px",
    borderRadius: "8px",
    border: "none",
    background: active ? "rgba(0, 0, 0, 0.06)" : "transparent",
    color: "var(--text-secondary)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    outline: "none",
  };
}

const stageMenuStyle: React.CSSProperties = {
  position: "absolute",
  top: "calc(100% + 6px)",
  right: 0,
  minWidth: "220px",
  padding: "6px",
  borderRadius: "10px",
  border: "1px solid var(--border-color)",
  background: "var(--menu-bg)",
  boxShadow: "0 12px 30px rgba(15, 23, 42, 0.14)",
  zIndex: 25,
};

const menuDividerStyle: React.CSSProperties = {
  height: "1px",
  background: "var(--border-color)",
  margin: "6px 4px",
};

function menuRowStyle({ active = false, disabled = false }: { active?: boolean; disabled?: boolean }): React.CSSProperties {
  return {
    width: "100%",
    minHeight: "32px",
    border: "none",
    borderRadius: "8px",
    background: active ? "var(--selection-bg)" : "transparent",
    color: disabled ? "var(--muted-text)" : active ? "var(--accent-color)" : "var(--text-primary)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "10px",
    padding: "8px 10px",
    fontSize: "12px",
    fontWeight: 500,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.55 : 1,
    textAlign: "left",
  };
}

function menuTrailingCheckStyle(checked: boolean): React.CSSProperties {
  return {
    marginLeft: "auto",
    color: "var(--accent-color)",
    fontSize: "10px",
    opacity: checked ? 1 : 0,
    flexShrink: 0,
  };
}

function taskIconButtonStyle(disabled = false): React.CSSProperties {
  return {
    border: "none",
    background: "transparent",
    color: "var(--text-primary)",
    borderRadius: 6,
    width: 26,
    height: 26,
    padding: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: disabled ? "not-allowed" : "pointer",
    flexShrink: 0,
    opacity: disabled ? 0.5 : 1,
  };
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m5 12 4 4L19 6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4h6v2" />
    </svg>
  );
}

function buttonStyle(kind: "primary" | "secondary"): React.CSSProperties {
  return {
    height: "30px",
    borderRadius: "6px",
    border: kind === "primary" ? "1px solid var(--accent-color)" : "1px solid var(--border-color)",
    background: kind === "primary" ? "var(--accent-color)" : "var(--button-bg)",
    color: kind === "primary" ? "#fff" : "var(--text-color)",
    padding: "0 9px",
    fontSize: "12px",
    fontWeight: 700,
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}

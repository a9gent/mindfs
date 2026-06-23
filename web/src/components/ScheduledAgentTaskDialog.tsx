import React, { useEffect, useMemo, useRef, useState } from "react";
import { AgentIcon } from "./AgentIcon";
import { AgentSelector } from "./AgentSelector";
import { renderToolIcon } from "./stream/ToolCallCard";
import type { AgentStatus } from "../services/agents";
import {
  createScheduledAgentTask,
  deleteScheduledAgentTask,
  fetchScheduledAgentTasks,
  runScheduledAgentTask,
  updateScheduledAgentTask,
  type ScheduledAgentTask,
} from "../services/scheduledTasks";

type DialogView = "list" | "create" | "edit";

type FormState = {
  name: string;
  enabled: boolean;
  task_cron: string;
  agent: string;
  model: string;
  mode: string;
  effort: string;
  fast_service: "" | "on" | "off";
  prompt: string;
  new_session_cron: string;
};

type Props = {
  open: boolean;
  rootId?: string | null;
  agents: AgentStatus[];
  onClose: () => void;
};

const CRON_LABELS = ["分", "时", "日", "月", "周"] as const;

const emptyForm = (agent = ""): FormState => ({
  name: "",
  enabled: true,
  task_cron: "0 9 * * 1-5",
  agent,
  model: "",
  mode: "",
  effort: "",
  fast_service: "",
  prompt: "",
  new_session_cron: "",
});

function formatTime(value?: string): string {
  if (!value) return "未执行";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function splitCron(value: string): string[] {
  const raw = String(value || "").trim();
  if (!raw) {
    return ["", "", "", "", ""];
  }
  const parts = raw.split(/\s+/).filter(Boolean);
  const padded = [...parts.slice(0, 5)];
  while (padded.length < 5) {
    padded.push("*");
  }
  return padded;
}

function joinCron(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .slice(0, 5)
    .join(" ");
}

function isCronSegmentValid(value: string, index: number): boolean {
  const raw = value.trim();
  if (!raw) return false;
  if (raw === "*" || raw === "?") return true;
  const names =
    index === 3
      ? [
          "jan",
          "feb",
          "mar",
          "apr",
          "may",
          "jun",
          "jul",
          "aug",
          "sep",
          "oct",
          "nov",
          "dec",
        ]
      : index === 4
        ? ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
        : [];
  const min = [0, 0, 1, 1, 0][index];
  const max = [59, 23, 31, 12, 7][index];
  const atomValid = (atom: string): boolean => {
    const normalized = atom.toLowerCase();
    if (names.includes(normalized)) return true;
    if (!/^\d+$/.test(atom)) return false;
    const number = Number(atom);
    return number >= min && number <= max;
  };
  return raw.split(",").every((item) => {
    if (!item) return false;
    const [rangePart, stepPart] = item.split("/");
    if (
      stepPart !== undefined &&
      (!/^\d+$/.test(stepPart) || Number(stepPart) <= 0)
    ) {
      return false;
    }
    if (rangePart === "*" || rangePart === "?") return true;
    const range = rangePart.split("-");
    if (range.length === 1) return atomValid(range[0]);
    if (range.length !== 2 || !atomValid(range[0]) || !atomValid(range[1]))
      return false;
    if (/^\d+$/.test(range[0]) && /^\d+$/.test(range[1])) {
      return Number(range[0]) <= Number(range[1]);
    }
    return true;
  });
}

function taskToForm(task: ScheduledAgentTask): FormState {
  return {
    name: task.name || "",
    enabled: !!task.enabled,
    task_cron: task.task_cron || "",
    agent: task.agent || "",
    model: task.model || "",
    mode: task.mode || "",
    effort: task.effort || "",
    fast_service: task.fast_service || "",
    prompt: task.prompt || "",
    new_session_cron: task.new_session_cron || "",
  };
}

const fieldStyle: React.CSSProperties = {
  width: "100%",
  border: "1px solid var(--border-color)",
  borderRadius: 8,
  background: "var(--content-bg, #fff)",
  color: "var(--text-primary)",
  fontSize: 13,
  padding: "8px 10px",
  outline: "none",
  boxSizing: "border-box",
};

const menuButtonStyle: React.CSSProperties = {
  border: "1px solid var(--border-color)",
  borderRadius: 8,
  background: "var(--content-bg, #fff)",
  color: "var(--text-primary)",
  cursor: "pointer",
  fontSize: 12,
  padding: "7px 10px",
};

const strategyButtonStyle: React.CSSProperties = {
  ...menuButtonStyle,
  borderColor: "var(--accent-color)",
  color: "var(--accent-color)",
  padding: "4px 8px",
  lineHeight: 1.2,
};

const taskIconButtonStyle: React.CSSProperties = {
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
  cursor: "pointer",
  flexShrink: 0,
};

function StopIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="13"
      height="13"
      viewBox="0 0 1024 1024"
      aria-hidden="true"
    >
      <path d="M0 0h1024v1024H0z" fill="none" />
      <path
        fill="currentColor"
        d="M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448s448-200.6 448-448S759.4 64 512 64m0 820c-205.4 0-372-166.6-372-372c0-89 31.3-170.8 83.5-234.8l523.3 523.3C682.8 852.7 601 884 512 884m288.5-137.2L277.2 223.5C341.2 171.3 423 140 512 140c205.4 0 372 166.6 372 372c0 89-31.3 170.8-83.5 234.8"
      />
    </svg>
  );
}

function RunNowIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path d="M0 0h24v24H0z" fill="none" />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        d="M20.409 9.353a2.998 2.998 0 0 1 0 5.294L7.597 21.614C5.534 22.737 3 21.277 3 18.968V5.033c0-2.31 2.534-3.769 4.597-2.648z"
      />
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

function CronEditor({
  label,
  value,
  onChange,
  placeholder,
  headerRight,
  allowEmpty = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  headerRight?: React.ReactNode;
  allowEmpty?: boolean;
}) {
  const [parts, setParts] = useState(() => splitCron(value));
  const [touched, setTouched] = useState<boolean[]>(() => [
    false,
    false,
    false,
    false,
    false,
  ]);
  const lastEmittedRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastEmittedRef.current === value) {
      return;
    }
    setParts(splitCron(value));
    setTouched([false, false, false, false, false]);
  }, [value]);
  const placeholderParts = splitCron(placeholder || "* * * * *");
  const allEmpty = parts.every((part) => !part.trim());
  const shouldValidate = touched.some(Boolean) && !(allowEmpty && allEmpty);
  const invalid =
    shouldValidate &&
    parts.some((part, index) => !isCronSegmentValid(part || "", index));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div
          style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}
        >
          <div
            style={{
              fontSize: 12,
              color: "var(--text-secondary)",
              flexShrink: 0,
            }}
          >
            {label}
          </div>
          {invalid ? (
            <div
              style={{
                fontSize: 12,
                color: "#dc2626",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              仅支持 *、数字、逗号、- 范围和 / 步长
            </div>
          ) : null}
        </div>
        {headerRight ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {headerRight}
          </div>
        ) : null}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
          gap: 8,
        }}
      >
        {CRON_LABELS.map((item, index) => (
          <div
            key={item}
            style={{
              position: "relative",
              minWidth: 0,
            }}
          >
            <span
              style={{
                position: "absolute",
                top: "50%",
                left: 9,
                transform: "translateY(-50%)",
                color: "var(--text-secondary)",
                opacity: 0.65,
                fontSize: 11,
                lineHeight: 1,
                pointerEvents: "none",
              }}
            >
              {item}
            </span>
            <input
              className="scheduled-agent-task-input"
              value={parts[index] || ""}
              placeholder={placeholderParts[index] || "*"}
              onChange={(event) => {
                const next = [...parts];
                next[index] = event.target.value;
                setParts(next);
                const nextValue = joinCron(next);
                lastEmittedRef.current = nextValue;
                onChange(nextValue);
              }}
              onBlur={() => {
                setTouched([true, true, true, true, true]);
              }}
              style={{
                ...fieldStyle,
                borderColor:
                  shouldValidate &&
                  !isCronSegmentValid(parts[index] || "", index)
                    ? "#ef4444"
                    : "var(--border-color)",
                padding: "7px 8px 7px 26px",
                textAlign: "center",
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export function ScheduledAgentTaskDialog({
  open,
  rootId,
  agents,
  onClose,
}: Props) {
  const [view, setView] = useState<DialogView>("list");
  const [tasks, setTasks] = useState<ScheduledAgentTask[]>([]);
  const [selected, setSelected] = useState<ScheduledAgentTask | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);
  const dialogBodyRef = useRef<HTMLDivElement | null>(null);

  const defaultAgent = useMemo(
    () => agents.find((item) => item.available)?.name || agents[0]?.name || "",
    [agents],
  );

  const loadTasks = async () => {
    if (!rootId) return;
    setLoading(true);
    setError("");
    try {
      setTasks(await fetchScheduledAgentTasks(rootId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setView("list");
    setSelected(null);
    setForm(emptyForm(defaultAgent));
    void loadTasks();
  }, [open, rootId, defaultAgent]);

  useEffect(() => {
    if (!open) return;
    const body = dialogBodyRef.current;
    if (!body) return;
    const scrollFocusedInputIntoView = (target: HTMLElement) => {
      const bodyRect = body.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const bodyCenter = bodyRect.top + bodyRect.height * 0.45;
      const targetCenter = targetRect.top + targetRect.height / 2;
      body.scrollTo({
        top: Math.max(0, body.scrollTop + targetCenter - bodyCenter),
        behavior: "smooth",
      });
    };
    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (!target.matches("input, textarea")) return;
      for (const delay of [80, 260, 520]) {
        window.setTimeout(() => scrollFocusedInputIntoView(target), delay);
      }
    };
    body.addEventListener("focusin", handleFocusIn);
    return () => body.removeEventListener("focusin", handleFocusIn);
  }, [open]);

  if (!open) return null;

  const startCreate = () => {
    setSelected(null);
    setForm(emptyForm(defaultAgent));
    setError("");
    setView("create");
  };

  const startEdit = (task: ScheduledAgentTask) => {
    setSelected(task);
    setForm(taskToForm(task));
    setError("");
    setView("edit");
  };

  const save = async () => {
    if (!rootId || saving) return;
    if (!form.name.trim()) {
      setError("任务名称不能为空");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const payload = {
        root_id: rootId,
        name: form.name.trim(),
        enabled: form.enabled,
        task_cron: form.task_cron,
        agent: form.agent,
        model: form.model,
        mode: form.mode,
        effort: form.effort,
        fast_service: form.fast_service,
        prompt: form.prompt,
        new_session_cron: form.new_session_cron,
      };
      if (view === "edit" && selected) {
        await updateScheduledAgentTask(selected.id, payload);
      } else {
        await createScheduledAgentTask(payload);
      }
      await loadTasks();
      setView("list");
      setSelected(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (task: ScheduledAgentTask) => {
    if (!rootId || !window.confirm(`删除定时任务「${task.name || task.id}」？`))
      return;
    setError("");
    try {
      await deleteScheduledAgentTask(rootId, task.id);
      await loadTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const runNow = async (task: ScheduledAgentTask) => {
    if (!rootId || runningTaskId) return;
    setRunningTaskId(task.id);
    setError("");
    try {
      await runScheduledAgentTask(rootId, task.id);
      await loadTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunningTaskId(null);
    }
  };

  const toggleEnabled = async (task: ScheduledAgentTask) => {
    if (!rootId) return;
    setError("");
    try {
      await updateScheduledAgentTask(task.id, {
        root_id: rootId,
        name: task.name,
        enabled: !task.enabled,
        task_cron: task.task_cron,
        agent: task.agent,
        model: task.model || "",
        mode: task.mode || "",
        effort: task.effort || "",
        fast_service: task.fast_service || "",
        prompt: task.prompt,
        new_session_cron: task.new_session_cron || "",
      });
      await loadTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const renderList = () => (
    <>
      {loading ? (
        <div
          style={{
            border: "1px solid var(--border-color)",
            borderRadius: 8,
            padding: 24,
            color: "var(--text-secondary)",
            textAlign: "center",
            fontSize: 13,
          }}
        >
          加载中...
        </div>
      ) : tasks.length === 0 ? (
        <div
          style={{
            border: "1px dashed var(--border-color)",
            borderRadius: 8,
            padding: 24,
            color: "var(--text-secondary)",
            textAlign: "center",
            fontSize: 13,
          }}
        >
          暂无定时任务
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            maxHeight: "56vh",
            overflow: "auto",
          }}
        >
          {tasks.map((task) => (
            <div
              key={task.id}
              style={{
                border: "1px solid var(--border-color)",
                borderRadius: 8,
                padding: 12,
                background: "var(--content-bg, #fff)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <button
                  type="button"
                  onClick={() => startEdit(task)}
                  style={{
                    border: "none",
                    background: "transparent",
                    padding: 0,
                    color: "var(--text-primary)",
                    textAlign: "left",
                    cursor: "pointer",
                    minWidth: 0,
                    flex: 1,
                  }}
                >
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: 700,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {task.name || "未命名任务"}
                  </div>
                </button>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    flexShrink: 0,
                  }}
                >
                  <button
                    type="button"
                    title="停止"
                    aria-label="停止任务"
                    disabled={!task.enabled}
                    onClick={() => {
                      if (task.enabled) void toggleEnabled(task);
                    }}
                    style={{
                      ...taskIconButtonStyle,
                      color: task.enabled ? "#dc2626" : "var(--text-secondary)",
                      opacity: task.enabled ? 1 : 0.5,
                      cursor: task.enabled ? "pointer" : "not-allowed",
                    }}
                  >
                    <StopIcon />
                  </button>
                  <button
                    type="button"
                    title="立即运行"
                    aria-label="立即运行任务"
                    disabled={runningTaskId === task.id}
                    onClick={() => void runNow(task)}
                    style={{
                      ...taskIconButtonStyle,
                      color: "var(--accent-color)",
                      opacity: runningTaskId === task.id ? 0.6 : 1,
                    }}
                  >
                    <RunNowIcon />
                  </button>
                  <button
                    type="button"
                    title="编辑"
                    aria-label="编辑任务"
                    onClick={() => startEdit(task)}
                    style={taskIconButtonStyle}
                  >
                    {renderToolIcon("edit")}
                  </button>
                  <button
                    type="button"
                    title="删除"
                    aria-label="删除任务"
                    onClick={() => void remove(task)}
                    style={{ ...taskIconButtonStyle, color: "#dc2626" }}
                  >
                    <DeleteIcon />
                  </button>
                </div>
              </div>
              <div
                style={{
                  marginTop: 6,
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 8,
                  fontSize: 12,
                  color: "var(--text-secondary)",
                }}
              >
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  <span>{task.enabled ? "已启用" : "已停用"}</span>
                  <span>{task.task_cron}</span>
                  {task.new_session_cron ? (
                    <span>新 session: {task.new_session_cron}</span>
                  ) : null}
                  {task.running ? (
                    <span style={{ color: "var(--accent-color)" }}>运行中</span>
                  ) : null}
                </span>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  <AgentIcon agentName={task.agent} size={14} />
                  <span>{task.agent}</span>
                </span>
              </div>
              <div
                style={{
                  marginTop: 10,
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 8,
                  fontSize: 12,
                  color: "var(--text-secondary)",
                }}
              >
                <span>最近执行：{formatTime(task.last_run_at)}</span>
                <span>下次执行：{formatTime(task.next_run_at)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );

  const renderForm = () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <label
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          fontSize: 12,
          color: "var(--text-secondary)",
        }}
      >
        任务名称
        <input
          className="scheduled-agent-task-input"
          value={form.name}
          onChange={(event) =>
            setForm((prev) => ({ ...prev, name: event.target.value }))
          }
          placeholder="请输入任务名称"
          required
          style={fieldStyle}
        />
      </label>
      <CronEditor
        label="任务计划（标准 crontab 规则）"
        value={form.task_cron}
        onChange={(value) => setForm((prev) => ({ ...prev, task_cron: value }))}
        placeholder="0 9 * * 1-5"
      />
      <CronEditor
        label="新会话计划"
        value={form.new_session_cron}
        onChange={(value) =>
          setForm((prev) => ({ ...prev, new_session_cron: value }))
        }
        placeholder="     "
        allowEmpty
        headerRight={
          <>
            <button
              type="button"
              onClick={() =>
                setForm((prev) => ({
                  ...prev,
                  new_session_cron: prev.task_cron,
                }))
              }
              style={strategyButtonStyle}
            >
              总是开启新会话
            </button>
            <button
              type="button"
              onClick={() =>
                setForm((prev) => ({ ...prev, new_session_cron: "" }))
              }
              style={strategyButtonStyle}
            >
              总是复用已有会话
            </button>
          </>
        }
      />
      <label
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          fontSize: 12,
          color: "var(--text-secondary)",
        }}
      >
        任务提示词
        <textarea
          className="scheduled-agent-task-input"
          value={form.prompt}
          onChange={(event) =>
            setForm((prev) => ({ ...prev, prompt: event.target.value }))
          }
          rows={4}
          style={{ ...fieldStyle, resize: "vertical", lineHeight: 1.5 }}
        />
      </label>
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
          paddingTop: 4,
        }}
      >
        <button
          type="button"
          onClick={() => setView("list")}
          style={menuButtonStyle}
        >
          取消
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          style={{
            ...menuButtonStyle,
            background: "var(--accent-color)",
            color: "#fff",
            borderColor: "var(--accent-color)",
            opacity: saving ? 0.65 : 1,
          }}
        >
          {saving ? "保存中..." : "保存"}
        </button>
      </div>
    </div>
  );

  return (
    <div
      className="scheduled-agent-task-overlay"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(15, 23, 42, 0.32)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
      onMouseDown={onClose}
    >
      <div
        className="scheduled-agent-task-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="定时任务"
        onMouseDown={(event) => event.stopPropagation()}
        style={{
          width: "min(760px, 100%)",
          maxHeight: "86vh",
          overflow: "hidden",
          borderRadius: 10,
          border: "1px solid var(--border-color)",
          background: "var(--menu-bg)",
          boxShadow: "0 24px 60px rgba(15, 23, 42, 0.24)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <style>{`
	          .scheduled-agent-task-input:focus {
	            border-color: var(--accent-color) !important;
            box-shadow: none;
          }
            @media (max-width: 640px) {
              .scheduled-agent-task-overlay {
                top: 36px !important;
                align-items: flex-start !important;
                padding: 8px 12px 12px !important;
              }
              .scheduled-agent-task-dialog {
                width: 100% !important;
                max-height: calc(100dvh - 56px) !important;
              }
              .scheduled-agent-task-dialog-body {
                -webkit-overflow-scrolling: touch;
              }
            }
        `}</style>
        <div
          style={{
            height: 48,
            padding: "0 16px",
            borderBottom: "1px solid var(--border-color)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexShrink: 0,
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 700 }}>
            {view === "list"
              ? "定时任务"
              : view === "create"
                ? "新建定时任务"
                : "编辑定时任务"}
          </div>
          {view === "list" ? (
            <button
              type="button"
              onClick={startCreate}
              style={{
                ...menuButtonStyle,
                background: "var(--accent-color)",
                color: "#fff",
                borderColor: "var(--accent-color)",
              }}
            >
              新建
            </button>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <AgentSelector
                agent={form.agent}
                model={form.model}
                mode={form.mode}
                effort={form.effort}
                fastService={form.fast_service}
                agents={agents}
                compact
                menuPlacement="bottom"
                showChevron
                onAgentChange={(agent, model) =>
                  setForm((prev) => ({
                    ...prev,
                    agent,
                    model: model || "",
                    mode: "",
                    effort: "",
                    fast_service: "",
                  }))
                }
                onModeChange={(mode) =>
                  setForm((prev) => ({ ...prev, mode: mode || "" }))
                }
                onEffortChange={(effort) =>
                  setForm((prev) => ({ ...prev, effort: effort || "" }))
                }
                onFastServiceChange={(fastService) =>
                  setForm((prev) => ({
                    ...prev,
                    fast_service: fastService || "",
                  }))
                }
              />
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 13,
                  color: "var(--text-primary)",
                }}
              >
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      enabled: event.target.checked,
                    }))
                  }
                />
                启用
              </label>
            </div>
          )}
        </div>
        <div
          className="scheduled-agent-task-dialog-body"
          data-dialog-view={view === "list" ? "list" : "form"}
          ref={dialogBodyRef}
          style={{
            padding: "16px 16px max(16px, env(safe-area-inset-bottom))",
            overflow: "auto",
            overscrollBehavior: "contain",
            flex: 1,
            minHeight: 0,
          }}
        >
          {error ? (
            <div
              style={{
                marginBottom: 12,
                border: "1px solid #fecaca",
                borderRadius: 8,
                background: "#fef2f2",
                color: "#b91c1c",
                padding: "8px 10px",
                fontSize: 12,
              }}
            >
              {error}
            </div>
          ) : null}
          {view === "list" ? renderList() : renderForm()}
        </div>
      </div>
    </div>
  );
}

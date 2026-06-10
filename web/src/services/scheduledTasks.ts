import { appPath } from "./base";
import { protectedJSON } from "./api";

export type ScheduledAgentTask = {
  id: string;
  root_id: string;
  name: string;
  enabled: boolean;
  task_cron: string;
  agent: string;
  model?: string;
  mode?: string;
  effort?: string;
  fast_service?: "" | "on" | "off";
  prompt: string;
  new_session_cron?: string;
  session_key?: string;
  last_run_at?: string;
  last_success_at?: string;
  last_error?: string;
  last_session_reset_at?: string;
  next_run_at?: string;
  next_new_session_at?: string;
  running?: boolean;
  created_at: string;
  updated_at: string;
};

export type ScheduledAgentTaskInput = {
  root_id: string;
  name?: string;
  enabled: boolean;
  task_cron: string;
  agent: string;
  model?: string;
  mode?: string;
  effort?: string;
  fast_service?: "" | "on" | "off";
  prompt: string;
  new_session_cron?: string;
};

function taskURL(rootId: string): string {
  const params = new URLSearchParams({ root: rootId });
  return `${appPath("/api/scheduled-agent-tasks")}?${params.toString()}`;
}

function taskItemURL(rootId: string, id: string, suffix = ""): string {
  const params = new URLSearchParams({ root: rootId });
  return `${appPath(`/api/scheduled-agent-tasks/${encodeURIComponent(id)}${suffix}`)}?${params.toString()}`;
}

export async function fetchScheduledAgentTasks(rootId: string): Promise<ScheduledAgentTask[]> {
  const data = await protectedJSON<{ tasks?: ScheduledAgentTask[] }>(taskURL(rootId));
  return Array.isArray(data.tasks) ? data.tasks : [];
}

export async function createScheduledAgentTask(input: ScheduledAgentTaskInput): Promise<ScheduledAgentTask> {
  const data = await protectedJSON<{ task: ScheduledAgentTask }>(appPath("/api/scheduled-agent-tasks"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return data.task;
}

export async function updateScheduledAgentTask(
  id: string,
  input: ScheduledAgentTaskInput,
): Promise<ScheduledAgentTask> {
  const data = await protectedJSON<{ task: ScheduledAgentTask }>(
    appPath(`/api/scheduled-agent-tasks/${encodeURIComponent(id)}`),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  return data.task;
}

export async function deleteScheduledAgentTask(rootId: string, id: string): Promise<void> {
  await protectedJSON<{ ok: boolean }>(taskItemURL(rootId, id), { method: "DELETE" });
}

export async function runScheduledAgentTask(rootId: string, id: string): Promise<ScheduledAgentTask> {
  const data = await protectedJSON<{ task: ScheduledAgentTask }>(taskItemURL(rootId, id, "/run"), {
    method: "POST",
  });
  return data.task;
}

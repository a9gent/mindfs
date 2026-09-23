import { appURL } from "./base";
import { protectedJSON } from "./api";

export type StageRole = "user" | "agent";
export type TaskStatus =
  | "pending"
  | "queued"
  | "running"
  | "waiting_user"
  | "paused"
  | "success"
  | "fail"
  | "cancelled";

export type StageTemplate = {
  id?: string;
  name: string;
  role: StageRole;
  auto_advance?: boolean;
  agent?: string;
  model?: string;
  mode?: string;
  effort?: string;
  fast_service?: string;
  plan_mode?: boolean;
  session_reuse_policy?: "task_main" | "same_stage" | "always_new";
  prompt_template?: string;
  created_at?: string;
  updated_at?: string;
};

export type TaskTemplateStage = {
  id?: string;
  stage_template_id?: string;
  position: number;
  snapshot: StageTemplate;
};

export type TaskTemplate = {
  id?: string;
  name: string;
  description?: string;
  max_concurrency?: number;
  stages: TaskTemplateStage[];
  created_at?: string;
  updated_at?: string;
};

export type KanbanTask = {
  group_id?: string;
  agent?: string;
  model?: string | null;
  published?: boolean;
  block_reason?: string;
  depends_on?: string[];
  id: string;
  task_number?: number;
  root_id: string;
  task_template_id: string;
  task_template_name: string;
  create_worktree?: boolean;
  worktree_branch_mode?: "new" | "existing";
  worktree_branch?: string;
  current_stage_index: number;
  status: TaskStatus;
  scheduler_admitted?: boolean;
  main_session_key?: string;
  worktree_root_id?: string;
  worktree_path?: string;
  labels?: string[];
  created_at: string;
  updated_at: string;
  completed_at?: string;
  current_stage_name?: string;
  current_stage_status?: string;
  aux_flags?: {
    ask_user_waiting?: boolean;
    has_plan?: boolean;
    has_todos?: boolean;
    has_task?: boolean;
    session_error?: string;
  };
};

export type StageRun = {
  result?: string;
  trigger?: string;
  id: string;
  task_id: string;
  stage_index: number;
  stage_name: string;
  role: StageRole;
  status: string;
  session_key?: string;
  input?: string;
  rendered_prompt?: string;
  started_at?: string;
  finished_at?: string;
  created_at: string;
  updated_at: string;
};

export type TaskEvent = {
  receiver_task_id?: string;
  handled_at?: string;
  id: string;
  task_id: string;
  stage_run_id?: string;
  type: string;
  payload_json?: string;
  created_at: string;
};

export type TaskDetail = {
  task: KanbanTask;
  stage_runs: StageRun[];
  events: TaskEvent[];
};

type CachedTaskRecord = {
  cacheKey: string;
  rootId: string;
  taskId: string;
  updatedAt: string;
  detail: TaskDetail;
};

type CachedTaskMeta = {
  key: string;
  rootId: string;
  newestUpdatedAt: string;
  oldestUpdatedAt: string;
  lastSyncedAt: string;
};

const TASK_CACHE_DB = "mindfs-task-cache";
const TASK_CACHE_VERSION = 1;
const TASK_STORE = "tasks";
const TASK_META_STORE = "meta";

function taskCacheKey(rootId: string, taskId: string): string {
  return `${rootId}::${taskId}`;
}

function taskMetaKey(rootId: string): string {
  return `root::${rootId}`;
}

function taskRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("indexeddb request failed"));
  });
}

function openTaskCacheDB(): Promise<IDBDatabase> {
  if (typeof window === "undefined" || !("indexedDB" in window)) {
    return Promise.reject(new Error("indexeddb unavailable"));
  }
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(TASK_CACHE_DB, TASK_CACHE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(TASK_STORE)) {
        const store = db.createObjectStore(TASK_STORE, { keyPath: "cacheKey" });
        store.createIndex("rootId", "rootId", { unique: false });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(TASK_META_STORE)) {
        db.createObjectStore(TASK_META_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("indexeddb open failed"));
  });
}

async function withTaskStore<T>(
  mode: IDBTransactionMode,
  fn: (stores: { tasks: IDBObjectStore; meta: IDBObjectStore }) => Promise<T> | T,
): Promise<T> {
  const db = await openTaskCacheDB();
  try {
    const tx = db.transaction([TASK_STORE, TASK_META_STORE], mode);
    const result = await fn({
      tasks: tx.objectStore(TASK_STORE),
      meta: tx.objectStore(TASK_META_STORE),
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("indexeddb transaction failed"));
      tx.onabort = () => reject(tx.error || new Error("indexeddb transaction aborted"));
    });
    return result;
  } finally {
    db.close();
  }
}

export async function getCachedTaskDetails(rootId: string): Promise<TaskDetail[]> {
  try {
    return await withTaskStore("readonly", async ({ tasks }) => {
      const index = tasks.index("rootId");
      const records = await taskRequest(index.getAll(rootId) as IDBRequest<CachedTaskRecord[]>);
      return (records || [])
        .map((record) => record.detail)
        .filter((detail) => detail?.task?.id)
        .sort((a, b) => String(b.task.updated_at || "").localeCompare(String(a.task.updated_at || "")));
    });
  } catch {
    return [];
  }
}

export async function getCachedTaskMeta(rootId: string): Promise<CachedTaskMeta | null> {
  try {
    return await withTaskStore("readonly", async ({ meta }) => {
      const value = await taskRequest(meta.get(taskMetaKey(rootId)) as IDBRequest<CachedTaskMeta | undefined>);
      return value || null;
    });
  } catch {
    return null;
  }
}

export async function upsertCachedTaskDetails(rootId: string, details: TaskDetail[]): Promise<void> {
  const valid = details.filter((detail) => detail?.task?.id);
  if (valid.length === 0) return;
  try {
    await withTaskStore("readwrite", async ({ tasks, meta }) => {
      let currentMeta = await taskRequest(meta.get(taskMetaKey(rootId)) as IDBRequest<CachedTaskMeta | undefined>);
      const updatedValues = valid
        .map((detail) => String(detail.task.updated_at || ""))
        .filter(Boolean);
      for (const detail of valid) {
        const taskId = detail.task.id;
        await taskRequest(tasks.put({
          cacheKey: taskCacheKey(rootId, taskId),
          rootId,
          taskId,
          updatedAt: String(detail.task.updated_at || ""),
          detail,
        } satisfies CachedTaskRecord));
      }
      const newest = updatedValues.reduce((max, value) => value > max ? value : max, currentMeta?.newestUpdatedAt || "");
      const oldest = updatedValues.reduce((min, value) => !min || value < min ? value : min, currentMeta?.oldestUpdatedAt || "");
      currentMeta = {
        key: taskMetaKey(rootId),
        rootId,
        newestUpdatedAt: newest,
        oldestUpdatedAt: oldest,
        lastSyncedAt: new Date().toISOString(),
      };
      await taskRequest(meta.put(currentMeta));
    });
  } catch {}
}

export async function fetchStageTemplates(): Promise<StageTemplate[]> {
  const payload = await protectedJSON<any>(appURL("/api/task-stage-templates"));
  return Array.isArray(payload?.items) ? payload.items : [];
}

export async function saveStageTemplate(template: StageTemplate): Promise<StageTemplate> {
  return protectedJSON<StageTemplate>(appURL("/api/task-stage-templates"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(template),
  });
}

export async function deleteStageTemplate(id: string): Promise<void> {
  await protectedJSON(appURL(`/api/task-stage-templates/${encodeURIComponent(id)}`), {
    method: "DELETE",
  });
}

export async function fetchTaskTemplates(): Promise<TaskTemplate[]> {
  const payload = await protectedJSON<any>(appURL("/api/task-templates"));
  return Array.isArray(payload?.items) ? payload.items : [];
}

export async function saveTaskTemplate(template: TaskTemplate): Promise<TaskTemplate> {
  const path = template.id ? `/api/task-templates/${encodeURIComponent(template.id)}` : "/api/task-templates";
  return protectedJSON<TaskTemplate>(appURL(path), {
    method: template.id ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(template),
  });
}

export async function deleteTaskTemplate(id: string): Promise<void> {
  await protectedJSON(appURL(`/api/task-templates/${encodeURIComponent(id)}`), {
    method: "DELETE",
  });
}

export async function fetchTaskDetails(rootId: string, filters?: {
  templateId?: string;
  status?: string;
  stage?: number;
  after?: string;
  before?: string;
  limit?: number;
}): Promise<TaskDetail[]> {
  const params = new URLSearchParams({ root: rootId });
  if (filters?.templateId) params.set("template_id", filters.templateId);
  if (filters?.status) params.set("status", filters.status);
  if (typeof filters?.stage === "number") params.set("stage", String(filters.stage));
  if (filters?.after) params.set("after", filters.after);
  if (filters?.before) params.set("before", filters.before);
  if (typeof filters?.limit === "number" && filters.limit > 0) params.set("limit", String(filters.limit));
  const payload = await protectedJSON<any>(appURL("/api/tasks", params));
  return Array.isArray(payload?.items) ? payload.items : [];
}

export async function createTask(
  rootId: string,
  taskTemplateId: string,
  input: string,
  createWorktree = false,
  worktreeBranchMode: "new" | "existing" = "new",
  worktreeBranch = "",
  execution?: { agent?: string; model?: string },
): Promise<TaskDetail> {
  return protectedJSON<TaskDetail>(appURL("/api/tasks"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      root_id: rootId,
      task_template_id: taskTemplateId,
      ...execution,
      input,
      create_worktree: createWorktree,
      worktree_branch_mode: worktreeBranchMode,
      worktree_branch: worktreeBranch,
    }),
  });
}

export async function updateTaskInput(
  rootId: string,
  taskId: string,
  input: string,
  createWorktree?: boolean,
  worktreeBranchMode?: "new" | "existing",
  worktreeBranch?: string,
): Promise<TaskDetail> {
  return protectedJSON<TaskDetail>(appURL(`/api/tasks/${encodeURIComponent(taskId)}/input`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      root_id: rootId,
      input,
      ...(typeof createWorktree === "boolean" ? { create_worktree: createWorktree } : {}),
      ...(worktreeBranchMode ? { worktree_branch_mode: worktreeBranchMode } : {}),
      ...(typeof worktreeBranch === "string" ? { worktree_branch: worktreeBranch } : {}),
    }),
  });
}

export async function moveTask(rootId: string, taskId: string, action: "next" | "run-now" | "prev" | "pause" | "resume" | "complete" | "cancel" | "fail", reason = ""): Promise<TaskDetail> {
  return protectedJSON<TaskDetail>(appURL(`/api/tasks/${encodeURIComponent(taskId)}/${action}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root_id: rootId, reason }),
  });
}

export async function patchTask(root: string, id: string, patch: Record<string,unknown>): Promise<TaskDetail> {
 return protectedJSON<TaskDetail>(appURL(`/api/tasks/${encodeURIComponent(id)}`), {method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({root_id:root,...patch})});
}

export async function fetchTaskDetail(root: string,id: string): Promise<TaskDetail> {
 return protectedJSON<TaskDetail>(appURL(`/api/tasks/${encodeURIComponent(id)}`,new URLSearchParams({root})));
}

export async function deleteCachedTask(root:string,id:string):Promise<void> {
 await withTaskStore("readwrite",async({tasks})=>{await taskRequest(tasks.delete(taskCacheKey(root,id)))});
}

export type TaskGroup = {
  id: string; root_id: string; session_key: string; title: string;
  project_context: string; published: boolean;
  plan_version: number; status: string; block_reason: string; updated_at: string;
};
export type GroupMessage = { from: string; to: string; message: string; timestamp: string };
export type GroupGraph = { group: TaskGroup; tasks: TaskDetail[]; edges: Record<string,string[]>; messages: TaskEvent[]; message_history?: GroupMessage[] };
export async function fetchTaskGroups(root: string): Promise<TaskGroup[]> {
  const data = await protectedJSON<{items:TaskGroup[]}>(appURL(`/api/task-groups?root=${encodeURIComponent(root)}`));
  return data.items || [];
}
export function fetchGroupGraph(root:string,id:string):Promise<GroupGraph> {
  return protectedJSON(appURL(`/api/task-groups/${encodeURIComponent(id)}?root=${encodeURIComponent(root)}`));
}
export function groupOperation(root:string,id:string,operation:string,input:Record<string,unknown>={}):Promise<TaskGroup> {
  return protectedJSON(appURL(`/api/task-groups/${encodeURIComponent(id)}/${operation}`),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...input,root_id:root})});
}

export function updateGroupContext(root: string, id: string, projectContext: string, planVersion: number): Promise<TaskGroup> {
  return protectedJSON(appURL(`/api/task-groups/${encodeURIComponent(id)}/context`), {
    method: "PATCH", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({root_id: root, project_context: projectContext, plan_version: planVersion}),
  });
}

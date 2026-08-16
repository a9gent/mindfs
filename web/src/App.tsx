import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getViewModeSystemPrompt } from "./renderer/viewCatalog";
import { Renderer } from "./renderer/Renderer";
import {
  clearCachedSessionsForRoot,
  deleteCachedSession,
  getCachedSession,
  sessionService,
  setCachedSessionRelatedFiles,
  syncSession,
  type MultiRootSessionGroup,
  type SyncSessionResult,
  type RelatedFile,
  type RelatedWorktree,
  type Session,
  type QueuedUserMessage,
} from "./services/session";
import { buildClientContext } from "./services/context";
import { e2eeService, type E2EEState } from "./services/e2ee";
import {
  bootstrapService,
  type BootstrapState,
  type RelayStatusPayload,
} from "./services/bootstrap";
import {
  fetchTokenStationInfo,
  startTokenStationBinding,
  type TokenStationInfo,
} from "./services/tokenStation";
import { syncAgentAPIProviders } from "./services/agentConfig";
import { syncNativeReplyPollerE2EE } from "./services/replyPoller";
import {
  ProtectedAPIError,
  protectedAPIReady,
  protectedJSON as apiProtectedJSON,
} from "./services/api";
import { reportError } from "./services/error";
import {
  fetchFile,
  clearFileCacheForRoot,
  getCachedFile,
  invalidateFileCache,
  type FilePayload,
} from "./services/file";
import {
  buildGitDiffCacheSignature,
  checkoutGitBranch,
  clearGitHistoryCache,
  commitGit,
  createGitWorktree,
  discardGitItem,
  fetchGitCommitDiff,
  fetchGitDiff,
  fetchGitRelatedFileDiff,
  fetchGitBranches,
  fetchGitHistory,
  fetchGitStatus,
  fetchGitStatusByPath,
  fetchGitWorktrees,
  getCachedGitHistory,
  getCachedGitHistoryHead,
  pullGit,
  pushGit,
  removeGitWorktree,
  stageGitItem,
  unstageGitItem,
  type GitBranchesPayload,
  type GitDiffPayload,
  type GitHistoryItem,
  type GitHistoryPayload,
  type GitStatusItem,
  type GitStatusPayload,
  type GitWorktreeItem,
} from "./services/git";
import {
  DEFAULT_DIRECTORY_SORT_MODE,
  type DirectorySortMode,
  type FileEntry,
} from "./services/directorySort";
import { isUploadAbortError, uploadFiles, type UploadProgress } from "./services/upload";
import {
  PluginManager,
  loadPluginsFromSources,
  scanPluginSources,
  snapshotFromPluginSources,
  type PluginSourceBundle,
  type PluginInput,
} from "./plugins/manager";
import {
  isPluginSnapshotTrusted,
  readTrustedPluginSet,
  saveTrustedPluginSet,
} from "./plugins/trust";
import { appPath, appURL, isRelayNodePage } from "./services/base";
import { useRefreshSpin } from "./hooks";
import { copyText } from "./services/clipboard";
import { triggerUpdate, type UpdateState } from "./services/update";
import {
  cancelScheduledWebViewCacheClear,
  scheduleWebViewCacheClearOnNextLaunch,
} from "./services/nativeCacheControl";
import { storeRelayNodes } from "./services/launcherNodeSync";
import { isNativeShellRuntime } from "./services/runtime";
import {
  applyPinnedSnapshotToSessions,
  mergeSessionItems,
} from "./services/sessionListMerge";
// 直接导入标准组件
import { AppShell } from "./layout/AppShell";
import { ModeIcon } from "./components/ModeIcon";
import { FileTree, type AgentConfigSwitchRequest } from "./components/FileTree";
import { FileViewer } from "./components/FileViewer";
import { GitDiffViewer } from "./components/GitDiffViewer";
import { GitHistoryPanel } from "./components/GitHistoryPanel";
import { GitStatusPanel } from "./components/GitStatusPanel";
import { SessionViewer } from "./components/SessionViewer";
import { DefaultListView, type MainContentViewMode } from "./components/DefaultListView";
import { MultiProjectSessionList, SessionList, type ProjectSessionGroup } from "./components/SessionList";
import { ExternalSessionList } from "./components/ExternalSessionList";
import { InlineTokenText } from "./components/InlineTokenText";
import { AgentIcon } from "./components/AgentIcon";
import { AgentMenuList } from "./components/AgentMenuList";
import { ActionBar } from "./components/ActionBar";
import { CompactUploadProgress } from "./components/CompactUploadProgress";
import { ToastContainer } from "./components/Toast";
import { BottomSheet } from "./components/BottomSheet";
import { ScheduledAgentTaskDialog } from "./components/ScheduledAgentTaskDialog";
import { TaskTemplateDialog } from "./components/TaskTemplateDialog";
import { OnboardingTour } from "./components/OnboardingTour";
import { WorktreeBranchSelector } from "./components/WorktreeBranchSelector";
import { NoWorktreeIcon } from "./components/NoWorktreeIcon";
import { renderToolIcon } from "./components/stream/ToolCallCard";
import TokenEditor, { type TokenEditorHandle } from "./components/editor/TokenEditor";
import {
  type GitHubImportState,
  type LocalDirBrowserState,
  ProjectAddPopover,
  type ProjectAddMode,
} from "./components/ProjectAddPopover";
import { fetchAgents, restartAgent, type AgentStatus } from "./services/agents";
import { fetchCandidates, type CandidateItem } from "./services/candidates";
import {
  createTask,
  deleteTaskTemplate,
  fetchTaskDetails,
  fetchTaskTemplates,
  getCachedTaskDetails,
  getCachedTaskMeta,
  moveTask,
  saveTaskTemplate,
  upsertCachedTaskDetails,
  updateTaskInput,
  type KanbanTask,
  type StageRun,
  type TaskDetail,
  type StageTemplate,
  type TaskTemplate,
} from "./services/tasks";
import { shouldApplyTaskDetail } from "./services/taskDetailOrder";
import { mergeRelatedFileGroups, taskIdsForUpdatedSession } from "./services/taskRelatedFiles";
import { useI18n, type MessageKey, type MessageParams } from "./i18n";
import {
  completeOnboarding,
  dismissOnboarding,
  shouldAutoStartOnboarding,
} from "./services/onboarding";

// 类型定义
type SessionMode = "chat" | "plugin" | "command";
type WSStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

const CHILD_SESSION_PAGE_SIZE = 100;
const MULTI_PROJECT_SESSION_LIMIT = 6;
const SESSION_PAGE_SIZE = 50;
const MULTI_PROJECT_SESSION_STORAGE_KEY = "mindfs-multi-project-session-list";
const APP_DOCUMENT_TITLE = "MindFS";

function formatDocumentTitle(relayStatus: RelayStatusPayload | null): string {
  if (!isRelayNodePage()) {
    return APP_DOCUMENT_TITLE;
  }
  const nodeName = String(relayStatus?.node_name || "").trim();
  return nodeName ? `${nodeName} - ${APP_DOCUMENT_TITLE}` : APP_DOCUMENT_TITLE;
}

function isTopLevelSessionItem(session: SessionItem): boolean {
  return !String(session?.parent_session_key || "").trim();
}

function firstUserInputTemplate(template: TaskTemplate | null): string {
  const first = template?.stages?.[0]?.snapshot;
  return first?.role === "user" ? first.prompt_template || "" : "";
}

function firstAgentStage(template: TaskTemplate | null): StageTemplate | null {
  return template?.stages?.map((stage) => stage.snapshot).find((stage) => stage.role === "agent") || null;
}

function isUnfinishedKanbanTask(task: KanbanTask): boolean {
  return task.status !== "success" && task.status !== "fail" && task.status !== "cancelled";
}

function isTerminalKanbanTask(task: KanbanTask): boolean {
  return task.status === "success" || task.status === "fail" || task.status === "cancelled";
}

function parseTaskSessionErrorMessage(error?: string): string {
  const raw = String(error || "").trim();
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as { message?: unknown };
    return typeof parsed.message === "string" && parsed.message.trim() ? parsed.message.trim() : raw;
  } catch {
    return raw;
  }
}

function parseTaskSessionErrorDetails(error?: string): string[] {
  const raw = String(error || "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { data?: unknown };
    if (Array.isArray(parsed.data)) return parsed.data.map((item) => String(item)).filter(Boolean);
    if (parsed.data === undefined || parsed.data === null) return [];
    return [String(parsed.data)];
  } catch {
    return [];
  }
}

function taskStatusLabel(status: string, t: (key: MessageKey, params?: MessageParams) => string): string {
  const labels: Record<string, MessageKey> = {
    pending: "task.status.pending",
    queued: "task.status.queued",
    running: "task.status.running",
    waiting_user: "task.status.waitingUser",
    paused: "task.status.paused",
    success: "task.status.success",
    fail: "task.status.fail",
    cancelled: "task.status.cancelled",
    approved: "task.status.approved",
    rejected: "task.status.rejected",
  };
  return labels[status] ? t(labels[status]) : status || "-";
}

function firstTaskInputFromDetail(detail: TaskDetail): string {
  return detail.stage_runs.find((run) => run.stage_index === 0)?.input || "";
}

function latestTaskStageRun(detail: TaskDetail, stageIndex: number): StageRun | null {
  const runs = detail.stage_runs
    .filter((run) => run.stage_index === stageIndex)
    .sort((a, b) => {
      const aTime = Date.parse(a.created_at || a.updated_at || "");
      const bTime = Date.parse(b.created_at || b.updated_at || "");
      return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
    });
  return runs[0] || null;
}

function currentTaskInputFromDetail(detail: TaskDetail): string {
  return latestTaskStageRun(detail, detail.task.current_stage_index)?.input || "";
}

function previousTaskInputsFromDetail(detail: TaskDetail, t: (key: MessageKey, params?: MessageParams) => string): Array<{ id: string; label: string; input: string }> {
  const items: Array<{ id: string; label: string; input: string }> = [];
  for (let index = 0; index < detail.task.current_stage_index; index += 1) {
    const run = latestTaskStageRun(detail, index);
    const input = run?.input || "";
    if (!run || !input.trim()) continue;
    items.push({
      id: run.id,
      label: run.stage_name || t("task.stageLabel", { index: index + 1 }),
      input,
    });
  }
  return items;
}

function taskSessionKeysFromDetail(detail: TaskDetail): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const run of detail.stage_runs) {
    const key = String(run.session_key || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  const mainKey = String(detail.task.main_session_key || "").trim();
  if (mainKey && !seen.has(mainKey)) {
    keys.push(mainKey);
  }
  return keys;
}

function normalizeFastService(
  value: unknown,
): "" | "on" | "off" {
  return value === "on" || value === "off" ? value : "";
}

export type SessionItem = {
  key: string;
  session_key: string;
  root_id?: string;
  name?: string;
  type?: SessionMode;
  parent_session_key?: string;
  parent_tool_call_id?: string;
  agent?: string;
  model?: string;
  shell?: string;
  source?: string;
  task_id?: string;
  mode?: string;
  effort?: string;
  fast_service?: "" | "on" | "off";
  plan_mode?: boolean;
  scope?: string;
  purpose?: string;
  created_at?: string;
  updated_at?: string;
  pinned_at?: string | null;
  closed_at?: string;
  title?: string;
  agent_session_id?: string;
  context_window?: {
    totalTokens: number;
    modelContextWindow: number;
  };
  search_seq?: number;
  search_target_id?: string;
  search_snippet?: string;
  search_match_type?: "name" | "user" | "reply";
  related_files?: RelatedFile[];
  related_worktree?: RelatedWorktree | null;
  exchanges?: Array<{
    seq?: number;
    role?: string;
    agent?: string;
    content?: string;
    thought_id?: string;
    timestamp?: string;
    model?: string;
    model_display_name?: string;
	    mode?: string;
	    effort?: string;
	    fast_service?: "" | "on" | "off";
	    context_window?: {
      totalTokens: number;
      modelContextWindow: number;
    };
  }>;
  pending?: boolean;
};

type MultiProjectSessionGroup = {
  rootId: string;
  rootName: string;
  latestSessionTime: string;
  sessions: SessionItem[];
  totalCount: number;
};

type SlashCommandResult = {
  rootId: string;
  sessionKey: string;
  requestId: string;
  command: string;
  content: string;
  status: "running" | "complete" | "failed";
  error?: string;
  createdAt?: number;
  loginNotice?: {
    status?: string;
    loginId?: string;
    verificationUrl?: string;
    userCode?: string;
    error?: string;
    authMode?: string;
    planType?: string;
  };
};

type TaskInlineAttachment = {
  id: string;
  file: File;
  previewUrl?: string;
  isImage: boolean;
};

type TaskInlineEditState = {
  taskId?: string;
  templateId: string;
  templateName: string;
  text: string;
  previousInputs: Array<{ id: string; label: string; input: string }>;
  createWorktree: boolean;
  worktreeBranchMode: "new" | "existing";
  worktreeBranch: string;
  canToggleWorktree: boolean;
  attachments: TaskInlineAttachment[];
};

function latestExchangeText(
  exchanges: unknown,
  field: "agent" | "mode" | "effort" | "fast_service",
): string {
  if (!Array.isArray(exchanges)) {
    return "";
  }
  for (let i = exchanges.length - 1; i >= 0; i -= 1) {
    const value = (exchanges[i] as Record<string, unknown> | null)?.[field];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return "";
}

function sessionInputHistory(session: { exchanges?: Array<{ role?: string; content?: string }> } | null | undefined): string[] {
  const exchanges = Array.isArray(session?.exchanges) ? session.exchanges : [];
  const items: string[] = [];
  for (const exchange of exchanges) {
    if (exchange?.role !== "user") {
      continue;
    }
    const content = String(exchange.content || "").trim();
    if (content) {
      items.push(content);
    }
  }
  return items;
}

function toSessionItem(
  rootID: string | null | undefined,
  session: any,
): SessionItem | null {
  if (!session) {
    return null;
  }
  const key = session?.key || session?.session_key || "";
  const nextRoot =
    (session?.root_id as string | undefined) || String(rootID || "");
  if (!key || !nextRoot) {
    return null;
  }
  return {
    key,
    session_key: key,
    root_id: nextRoot,
    name: typeof session?.name === "string" ? session.name : "",
    type: normalizeMode(session?.type),
    parent_session_key:
      typeof session?.parent_session_key === "string"
        ? session.parent_session_key
        : undefined,
    parent_tool_call_id:
      typeof session?.parent_tool_call_id === "string"
        ? session.parent_tool_call_id
        : undefined,
    source: typeof session?.source === "string" ? session.source : undefined,
    task_id: typeof session?.task_id === "string" ? session.task_id : undefined,
    agent:
      typeof session?.agent === "string" && session.agent.trim()
        ? session.agent
        : latestExchangeText(session?.exchanges, "agent"),
    model: typeof session?.model === "string" ? session.model : "",
    shell: typeof session?.shell === "string" ? session.shell : "",
    mode:
      typeof session?.mode === "string" && session.mode.trim()
        ? session.mode
        : latestExchangeText(session?.exchanges, "mode"),
    effort:
      typeof session?.effort === "string" && session.effort.trim()
        ? session.effort
        : latestExchangeText(session?.exchanges, "effort"),
    fast_service:
      normalizeFastService(session?.fast_service) ||
      normalizeFastService(latestExchangeText(session?.exchanges, "fast_service")),
    plan_mode:
      typeof session?.plan_mode === "boolean"
        ? session.plan_mode
        : false,
    scope: typeof session?.scope === "string" ? session.scope : "",
    purpose: typeof session?.purpose === "string" ? session.purpose : "",
    created_at:
      typeof session?.created_at === "string" ? session.created_at : undefined,
    updated_at:
      typeof session?.updated_at === "string" ? session.updated_at : undefined,
    pinned_at:
      typeof session?.pinned_at === "string" && session.pinned_at
        ? session.pinned_at
        : undefined,
    closed_at:
      typeof session?.closed_at === "string" ? session.closed_at : undefined,
    context_window:
      session?.context_window &&
      Number(session.context_window.totalTokens) > 0 &&
      Number(session.context_window.modelContextWindow) > 0
        ? {
            totalTokens: Number(session.context_window.totalTokens),
            modelContextWindow: Number(session.context_window.modelContextWindow),
          }
        : undefined,
    search_seq:
      typeof session?.search_seq === "number" ? session.search_seq : undefined,
    search_target_id:
      typeof session?.search_target_id === "string"
        ? session.search_target_id
        : undefined,
    search_snippet:
      typeof session?.search_snippet === "string"
        ? session.search_snippet
        : undefined,
    search_match_type:
      session?.search_match_type === "name" ||
      session?.search_match_type === "user" ||
      session?.search_match_type === "reply"
        ? session.search_match_type
        : undefined,
    related_files: Array.isArray(session?.related_files)
      ? session.related_files
      : undefined,
    related_worktree:
      session?.related_worktree === null
        ? null
        : session?.related_worktree && typeof session.related_worktree === "object"
          ? session.related_worktree
          : undefined,
    pending: typeof session?.pending === "boolean" ? session.pending : undefined,
  };
}
type Exchange = {
  role: string;
  agent?: string;
  model?: string;
  model_display_name?: string;
  mode?: string;
  effort?: string;
  fast_service?: "" | "on" | "off";
  content?: string;
  thought_id?: string;
  context_window?: {
    totalTokens: number;
    modelContextWindow: number;
  };
  timestamp?: string;
  toolCall?: any;
  todoUpdate?: any;
  planUpdate?: any;
  compactNotice?: any;
  pending_ack?: boolean;
};
type PendingSend = {
  rootId: string;
  mode: SessionMode;
  agent: string;
  model?: string;
  agentMode?: string;
  effort?: string;
  fastService?: "" | "on" | "off";
  shell?: string;
  message: string;
  timestamp: string;
  requestId?: string;
  sessionKey?: string;
  tempKey?: string;
};
type SessionQueueItem = QueuedUserMessage;
type ViewerSelection = {
  filePath: string;
  text?: string;
  startLine?: number;
  endLine?: number;
};

type AttachedFileContext = {
  filePath: string;
  fileName: string;
  startLine?: number;
  endLine?: number;
  text?: string;
};
type GitFileStat = {
  status: string;
  additions: number;
  deletions: number;
};
type RelatedFileClickTarget = {
  path: string;
  head?: string;
  repo_path?: string;
  repo_name?: string;
  repo_kind?: string;
};

function relatedFileSelectionKey(file: RelatedFileClickTarget | null | undefined): string {
  if (!file?.path) return "";
  return [
    file.repo_kind || "",
    file.repo_path || "",
    file.head || "",
    file.path,
  ].join("\0");
}
type URLState = {
  root: string;
  file: string;
  session: string;
  cursor: number;
  pluginQuery: Record<string, string>;
};
type ManagedRootPayload = {
  id: string;
  display_name?: string;
  root_path?: string;
  is_git_repo?: boolean;
  is_git_worktree?: boolean;
  size?: number;
  mtime?: string;
};
type LocalDirItemPayload = {
  name?: string;
  path?: string;
  is_dir?: boolean;
  is_added_root?: boolean;
  root_id?: string;
};
type LocalDirsPayload = {
  path?: string;
  parent?: string;
  volumes?: LocalDirItemPayload[];
  items?: LocalDirItemPayload[];
};

function managedDirAddErrorMessage(error: unknown, fallback: string, t: (key: MessageKey, params?: MessageParams) => string): string {
  const message = error instanceof Error ? error.message : String(error || "");
  if (message.includes("root name already exists")) {
    return t("root.nameAlreadyExists");
  }
  return message || fallback;
}

const RELAY_LAST_NODE_ID_STORAGE_KEY = "mindfs.relay.last_node_id";
const PLUGIN_QUERY_STORAGE_PREFIX = "vp-progress:";
const TREE_SORT_STORAGE_KEY = "mindfs-tree-sort-mode";
const DIRECTORY_SORT_OVERRIDES_STORAGE_KEY = "mindfs-directory-sort-overrides";
const FILE_SCROLL_STORAGE_KEY = "mindfs-file-scroll-positions";
const LAST_ROOT_STORAGE_KEY = "mindfs-last-root-id";
const GIT_STATUS_EXPANDED_STORAGE_KEY = "mindfs-git-status-expanded";
const GIT_HISTORY_EXPANDED_STORAGE_KEY = "mindfs-git-history-expanded";
const TASK_TEMPLATE_SELECTION_STORAGE_KEY = "mindfs-task-template-selection";
const TASK_TEMPLATE_ALL_FILTER = "__all__";
const CANDIDATE_FETCH_DEBOUNCE_MS = 512;
const FILE_TOKEN_PATTERN = /\[(?:read file|file):\s*[^\]]+\]/i;

function normalizeUpdateState(
  input: UpdateState | null | undefined,
): UpdateState {
  return {
    current_version: input?.current_version || "",
    latest_version: input?.latest_version || "",
    has_update: input?.has_update === true,
    status: input?.status || "idle",
    message: input?.message || "",
    release_name: input?.release_name || "",
    release_body: input?.release_body || "",
    release_url: input?.release_url || "",
    published_at: input?.published_at || "",
    last_checked_at: input?.last_checked_at || "",
    auto_update_supported: input?.auto_update_supported === true,
  };
}

function updateButtonLabel(state: UpdateState, t: (key: MessageKey, params?: MessageParams) => string): string {
  const status = (state.status || "idle").toLowerCase();
  switch (status) {
    case "available":
      if (state.current_version && state.latest_version) {
        return t("update.available", { current: state.current_version, latest: state.latest_version });
      }
      return state.latest_version ? t("update.toVersion", { version: state.latest_version }) : t("update.newVersion");
    case "downloading":
      return t("update.downloading");
    case "installing":
      return t("update.installing");
    case "restarting":
      return t("update.restarting");
    case "failed":
      return t("update.failed");
    default:
      return t("update.latest");
  }
}

function updateSummaryText(state: UpdateState, t: (key: MessageKey, params?: MessageParams) => string): string {
  const body = String(state.release_body || "").trim();
  if (body) {
    return body;
  }
  const name = String(state.release_name || "").trim();
  if (name) {
    return name;
  }
  if (state.latest_version) {
    return t("update.foundVersion", { version: state.latest_version });
  }
  return "";
}

function shouldShowUpdateButton(state: UpdateState): boolean {
  const status = (state.status || "idle").toLowerCase();
  if (
    status === "downloading" ||
    status === "installing" ||
    status === "restarting" ||
    status === "failed"
  ) {
    return true;
  }
  return state.auto_update_supported === true && state.has_update === true;
}

function buildFileScrollKey(
  rootId: string | null | undefined,
  path: string | null | undefined,
): string {
  if (!rootId || !path) {
    return "";
  }
  return `${rootId}::${path}`;
}

function hasSessionExchanges(session: Session | null | undefined): boolean {
  return Array.isArray(session?.exchanges) && session.exchanges.length > 0;
}

function openPendingPopup(): Window | null {
  if (typeof window === "undefined") {
    return null;
  }
  const popup = window.open("", "_blank");
  if (!popup) {
    return null;
  }
  try {
    popup.document.title = "Opening Relayer...";
    popup.document.body.innerHTML =
      '<p style="font-family: system-ui, sans-serif; padding: 16px; color: #111827;">Opening Relayer...</p>';
  } catch {}
  return popup;
}

function navigatePopup(popup: Window | null, url: string): void {
  if (!popup || popup.closed) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  try {
    popup.opener = null;
  } catch {}
  try {
    popup.location.replace(url);
  } catch {
    popup.location.href = url;
  }
}

function relayNodeIdFromPathname(pathname: string): string {
  const match = /^\/n\/([^/]+)/.exec(String(pathname || ""));
  return match?.[1] || "";
}

function isStandaloneDisplayMode(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const navigatorWithStandalone = navigator as Navigator & {
    standalone?: boolean;
  };
  return (
    window.matchMedia?.("(display-mode: standalone)")?.matches === true ||
    navigatorWithStandalone.standalone === true
  );
}

function isRelayPWAContext(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return (
    isStandaloneDisplayMode() &&
    (/^\/n\/[^/]+/.test(window.location.pathname) ||
      window.location.pathname === "/nodes" ||
      window.location.pathname === "/login")
  );
}

function isRelayNodesPage(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return (window.location.pathname.replace(/\/+$/, "") || "/") === "/nodes";
}

function relayNodeURL(rootID: string): string {
  if (typeof window === "undefined") {
    return "";
  }
  const trimmed = String(rootID || "").trim();
  if (!trimmed) {
    return "";
  }
  return new URL(`/n/${encodeURIComponent(trimmed)}/`, window.location.origin).toString();
}

function syncRelayNodesToNative(dirs: ManagedRootPayload[]): void {
  if ((!isNativeShellRuntime() && !isRelayPWAContext()) || !isRelayNodesPage()) {
    return;
  }
  const nodes = dirs
    .map((dir) => {
      const id = String(dir.id || "").trim();
      const url = relayNodeURL(id);
      const name = String(
        dir.display_name || dir.root_path?.split("/").filter(Boolean).pop() || id,
      ).trim();
      if (!id || !url || !name) {
        return null;
      }
      return { name, url };
    })
    .filter((node): node is { name: string; url: string } => node !== null);
  void storeRelayNodes(nodes);
}

function extractHTTPStatusFromErrorMessage(message: string): number | null {
  const match = /status=(\d{3})|(?:^|:\s)(\d{3})\s[A-Z]/.exec(
    String(message || ""),
  );
  const raw = match?.[1] || match?.[2];
  if (!raw) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function loadPersistedFileScrollPositions(): Record<string, number> {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(FILE_SCROLL_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const next: Record<string, number> = {};
    Object.entries(parsed).forEach(([key, value]) => {
      const scrollTop = Number(value);
      if (!key || !Number.isFinite(scrollTop) || scrollTop < 0) {
        return;
      }
      next[key] = scrollTop;
    });
    return next;
  } catch {
    return {};
  }
}

function persistFileScrollPositions(positions: Record<string, number>): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      FILE_SCROLL_STORAGE_KEY,
      JSON.stringify(positions),
    );
  } catch {}
}

function normalizeMode(mode: SessionMode | undefined): SessionMode {
  if (mode === "plugin") return mode;
  if (mode === "command") return mode;
  return "chat";
}

function parsePluginQuery(search: string): Record<string, string> {
  const params = new URLSearchParams(search);
  const query: Record<string, string> = {};
  params.forEach((value, key) => {
    if (key.startsWith("vp_")) {
      query[key.slice("vp_".length)] = value;
    }
  });
  return query;
}

function waitForNextPaint(): Promise<void> {
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

function parseCursor(value: string | null): number {
  if (!value) return 0;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function normalizeCursor(value: unknown): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function isDirectorySortMode(
  value: string | null | undefined,
): value is DirectorySortMode {
  return (
    value === "name-asc" ||
    value === "name-desc" ||
    value === "mtime-desc" ||
    value === "mtime-asc" ||
    value === "size-desc" ||
    value === "size-asc"
  );
}

function readURLState(): URLState {
  const params = new URLSearchParams(window.location.search);
  return {
    root: params.get("root") || "",
    file: params.get("file") || "",
    session: params.get("session") || "",
    cursor: parseCursor(params.get("cursor")),
    pluginQuery: parsePluginQuery(window.location.search),
  };
}

function buildURLSearch(next: URLState): string {
  const params = new URLSearchParams();
  if (next.root) params.set("root", next.root);
  if (next.file) params.set("file", next.file);
  if (next.session) params.set("session", next.session);
  if (next.cursor > 0) params.set("cursor", String(next.cursor));
  Object.entries(next.pluginQuery).forEach(([key, value]) => {
    if (!key) return;
    params.set(`vp_${key}`, String(value));
  });
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

function pluginQueryStorageKey(root: string, file: string): string {
  return `${PLUGIN_QUERY_STORAGE_PREFIX}${root}:${file}`;
}

function loadPersistedPluginQuery(
  root: string,
  file: string,
): Record<string, string> {
  if (!root || !file) return {};
  try {
    const raw = window.localStorage.getItem(pluginQueryStorageKey(root, file));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    const next: Record<string, string> = {};
    Object.entries(parsed as Record<string, unknown>).forEach(
      ([key, value]) => {
        if (!key) return;
        next[key] = String(value);
      },
    );
    return next;
  } catch {
    return {};
  }
}

function persistPluginQuery(
  root: string,
  file: string,
  query: Record<string, string>,
): void {
  if (!root || !file) return;
  try {
    window.localStorage.setItem(
      pluginQueryStorageKey(root, file),
      JSON.stringify(query || {}),
    );
  } catch {}
}

function removeLocalStorageByPrefix(prefix: string): void {
  if (typeof window === "undefined" || !prefix) {
    return;
  }
  try {
    for (const key of Array.from(
      { length: window.localStorage.length },
      (_, index) => window.localStorage.key(index),
    ).filter(Boolean) as string[]) {
      if (key.startsWith(prefix)) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {}
}

function toPluginInput(
  file: FilePayload,
  query: Record<string, string>,
): PluginInput {
  return {
    name: file.name,
    path: file.path,
    content: file.content,
    ext: file.ext || "",
    mime: file.mime || "",
    size: typeof file.size === "number" ? file.size : 0,
    truncated: !!file.truncated,
    next_cursor:
      typeof file.next_cursor === "number" ? file.next_cursor : undefined,
    query,
  };
}

function inferReadModeFromPlugin(plugin: any): "incremental" | "full" {
  if (!plugin) return "incremental";
  if (plugin?.fileLoadMode === "full") return "full";
  if (plugin?.fileLoadMode === "incremental") return "incremental";
  return "incremental";
}

function buildMatchInputFromPath(
  path: string,
  query: Record<string, string>,
): PluginInput {
  const normalized = (path || "").replace(/\\/g, "/");
  const name = normalized.split("/").pop() || normalized;
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  return {
    name,
    path: normalized,
    content: "",
    ext,
    mime: "",
    size: 0,
    truncated: false,
    query,
  };
}

function formatPluginViewContext(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2).trim();
  } catch {
    return String(value).trim();
  }
}

function buildMessageWithViewContext(
  message: string,
  viewContext: unknown,
): string {
  const contextText = formatPluginViewContext(viewContext);
  if (!contextText) return message;
  return [contextText, "", message].join("\n");
}

function normalizePath(value: string): string {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

function normalizePathForRoot(value: string, rootPath?: string): string {
  const normalized = normalizePath(value);
  if (!normalized) return "";
  const normalizedRoot = normalizePath(rootPath || "");
  if (!normalizedRoot) return normalized;
  if (normalized === normalizedRoot) return "";
  if (normalized.startsWith(`${normalizedRoot}/`)) {
    return normalized.slice(normalizedRoot.length + 1);
  }
  return normalized;
}

function relativeDisplayPathFromRoot(rootPath: string | undefined, absolutePath: string): string {
  const root = normalizePath(rootPath || "");
  const target = normalizePath(absolutePath);
  if (!target) return "";
  if (!root) return target;
  if (target === root) return ".";
  if (target.startsWith(`${root}/`)) {
    return target.slice(root.length + 1);
  }
  const rootParts = root.split("/").filter(Boolean);
  const targetParts = target.split("/").filter(Boolean);
  let shared = 0;
  while (
    shared < rootParts.length &&
    shared < targetParts.length &&
    rootParts[shared] === targetParts[shared]
  ) {
    shared += 1;
  }
  const upward = Array(Math.max(0, rootParts.length - shared)).fill("..");
  const downward = targetParts.slice(shared);
  return [...upward, ...downward].join("/") || ".";
}

function joinDisplayPath(base: string, path: string): string {
  const normalizedBase = normalizePath(base);
  const normalizedPath = normalizePath(path);
  if (!normalizedBase) return normalizedPath;
  if (!normalizedPath) return normalizedBase;
  return `${normalizedBase}/${normalizedPath}`;
}

function parseFileLocation(path: string): {
  path: string;
  targetLine?: number;
  targetColumn?: number;
} {
  const raw = String(path || "");
  const [base, fragment = ""] = raw.split("#", 2);
  if (fragment) {
    const match = /^L(\d+)(?:C(\d+))?$/i.exec(fragment.trim());
    if (match) {
      const targetLine = Number.parseInt(match[1], 10);
      const targetColumn = match[2] ? Number.parseInt(match[2], 10) : undefined;
      return {
        path: base,
        targetLine:
          Number.isFinite(targetLine) && targetLine > 0 ? targetLine : undefined,
        targetColumn:
          targetColumn && Number.isFinite(targetColumn) && targetColumn > 0
            ? targetColumn
            : undefined,
      };
    }
  }

  const colonMatch = /^(.*):(\d+)(?::(\d+))?$/.exec(base.trim());
  if (!colonMatch) {
    return { path: base };
  }
  const targetLine = Number.parseInt(colonMatch[2], 10);
  const targetColumn = colonMatch[3]
    ? Number.parseInt(colonMatch[3], 10)
    : undefined;
  return {
    path: colonMatch[1],
    targetLine:
      Number.isFinite(targetLine) && targetLine > 0 ? targetLine : undefined,
    targetColumn:
      targetColumn && Number.isFinite(targetColumn) && targetColumn > 0
        ? targetColumn
        : undefined,
  };
}

function parentDirsOfFile(path: string): string[] {
  const normalized = normalizePath(path);
  if (!normalized) return [];
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 1) return [];
  const dirs: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    dirs.push(parts.slice(0, i).join("/"));
  }
  return dirs;
}

function dirnameOfPath(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized) return ".";
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 1) return ".";
  return parts.slice(0, -1).join("/");
}

function basenameOfPath(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized) return "";
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || normalized;
}

function mapManagedRootsToEntries(dirs: ManagedRootPayload[]): FileEntry[] {
  return dirs.map((dir) => ({
    name: dir.display_name || dir.id.split("/").filter(Boolean).pop() || dir.id,
    path: dir.id,
    is_dir: true,
    is_root: true,
    size: typeof dir.size === "number" ? dir.size : undefined,
    mtime: typeof dir.mtime === "string" ? dir.mtime : undefined,
  }));
}

function comparableManagedRootPath(value: string | undefined): string {
  return String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

function buildDirectorySelectionKey(
  root: string,
  path: string,
  isRoot: boolean,
): string {
  return isRoot ? root : `${root}:${path}`;
}

function loadLastRootId(): string {
  if (typeof window === "undefined") {
    return "";
  }
  return window.localStorage.getItem(LAST_ROOT_STORAGE_KEY) || "";
}

function loadBooleanRecord(key: string): Record<string, boolean> {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || "{}") as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => typeof value === "boolean"),
    ) as Record<string, boolean>;
  } catch {
    return {};
  }
}

function loadStringBooleanRecord(key: string): Record<string, Record<string, boolean>> {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || "{}") as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).map(([root, value]) => [
        root,
        value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value as Record<string, unknown>).filter(([, expanded]) => typeof expanded === "boolean"),
            )
          : {},
      ]),
    ) as Record<string, Record<string, boolean>>;
  } catch {
    return {};
  }
}

const NEW_API_QUOTA_PER_UNIT = 500000;

function formatTokenStationBalance(info: TokenStationInfo | null): string {
  const data = info?.data;
  if (!info?.success || !data) {
    return "--";
  }
  const text = data.balance_text || data.quota_display_text || "";
  const formattedText = formatBalanceText(text);
  if (formattedText) {
    return formattedText;
  }
  const raw = typeof data.balance === "number" ? data.balance : data.quota;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return (raw / NEW_API_QUOTA_PER_UNIT).toFixed(2);
  }
  return text || "--";
}

function parseTokenStationBalance(info: TokenStationInfo | null): number {
  const data = info?.data;
  if (!info?.success || !data) {
    return 0;
  }
  const text = data.balance_text || data.quota_display_text || "";
  const parsed = parseFirstNumber(text);
  if (parsed !== null) {
    return parsed;
  }
  const raw = typeof data.balance === "number" ? data.balance : data.quota;
  return typeof raw === "number" && Number.isFinite(raw)
    ? raw / NEW_API_QUOTA_PER_UNIT
    : 0;
}

function formatBalanceText(text: string): string {
  const value = String(text || "").trim();
  if (!value) {
    return "";
  }
  const match = value.match(/(-?\d+(?:\.\d+)?)/);
  if (!match || match.index === undefined) {
    return "";
  }
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  return `${value.slice(0, match.index)}${parsed.toFixed(2)}${value.slice(match.index + match[1].length)}`;
}

function parseFirstNumber(text: string): number | null {
  const match = String(text || "").match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return null;
  }
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function tokenStationWalletURL(baseURL: string): string {
  const fallback = "http://localhost:3000";
  const trimmed = String(baseURL || "").trim().replace(/\/+$/, "");
  const target = `${trimmed || fallback}/wallet`;
  try {
    return new URL(target).toString();
  } catch {
    return `${fallback}/wallet`;
  }
}

function normalizeTokenStationAPIKey(value: string): string {
  const apiKey = String(value || "").trim();
  if (!apiKey) {
    return "";
  }
  return apiKey.toLowerCase().startsWith("sk-") ? apiKey : `sk-${apiKey}`;
}

function hasExplicitFileContext(message: string): boolean {
  return FILE_TOKEN_PATTERN.test(message);
}

// Hook for responsive detection
function useResponsive() {
  const [isMobile, setIsMobile] = useState(false);
  const [isTablet, setIsTablet] = useState(false);
  useEffect(() => {
    const checkSize = () => {
      const width = window.innerWidth;
      setIsMobile(width < 768);
      setIsTablet(width >= 768 && width < 1024);
    };
    checkSize();
    window.addEventListener("resize", checkSize);
    return () => window.removeEventListener("resize", checkSize);
  }, []);
  return { isMobile, isTablet };
}

type AppProps = {
  onGoHome?: () => void;
};

const MOBILE_ENTER_KEY_SEND_STORAGE_KEY = "mindfs-mobile-enter-key-sends";
const SIDEBARS_SWAPPED_STORAGE_KEY = "mindfs-sidebars-swapped";
const GIT_DIFF_SIDE_BY_SIDE_STORAGE_KEY = "mindfs-git-diff-side-by-side";
const TASK_CREATE_WORKTREE_PREF_STORAGE_KEY = "mindfs-task-create-worktree-pref";
const MAIN_CONTENT_VIEW_STORAGE_KEY = "mindfs-main-content-view";

type TaskCreateWorktreePreference = {
  createWorktree: boolean;
  worktreeBranchMode: "new" | "existing";
  worktreeBranch: string;
};

function isMainContentViewMode(value: unknown): value is MainContentViewMode {
  return value === "task-kanban" || value === "file-browser";
}

function loadMainContentViewByRoot(): Record<string, MainContentViewMode> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(MAIN_CONTENT_VIEW_STORAGE_KEY) || "{}") as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => isMainContentViewMode(value)),
    ) as Record<string, MainContentViewMode>;
  } catch {
    return {};
  }
}

function loadMobileEnterKeySends(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(MOBILE_ENTER_KEY_SEND_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function loadSidebarsSwapped(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(SIDEBARS_SWAPPED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function loadGitDiffSideBySide(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(GIT_DIFF_SIDE_BY_SIDE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function loadTaskCreateWorktreePreference(rootId: string): TaskCreateWorktreePreference {
  if (typeof window === "undefined" || !rootId) {
    return { createWorktree: false, worktreeBranchMode: "new", worktreeBranch: "" };
  }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(TASK_CREATE_WORKTREE_PREF_STORAGE_KEY) || "{}") as Record<string, unknown>;
    const value = parsed[rootId] as Record<string, unknown> | undefined;
    return {
      createWorktree: value?.createWorktree === true,
      worktreeBranchMode: value?.worktreeBranchMode === "existing" ? "existing" : "new",
      worktreeBranch: typeof value?.worktreeBranch === "string" ? value.worktreeBranch : "",
    };
  } catch {
    return { createWorktree: false, worktreeBranchMode: "new", worktreeBranch: "" };
  }
}

function saveTaskCreateWorktreePreference(rootId: string, pref: TaskCreateWorktreePreference): void {
  if (typeof window === "undefined" || !rootId) return;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(TASK_CREATE_WORKTREE_PREF_STORAGE_KEY) || "{}") as Record<string, unknown>;
    window.localStorage.setItem(TASK_CREATE_WORKTREE_PREF_STORAGE_KEY, JSON.stringify({
      ...parsed,
      [rootId]: pref,
    }));
  } catch {
    // Ignore storage failures; the current dialog state can still be used.
  }
}

export function App({ onGoHome }: AppProps) {
  const { t } = useI18n();
  const pluginManagerRef = useRef<PluginManager>(new PluginManager());
  const completionAudioContextRef = useRef<AudioContext | null>(null);
  const completionAudioUnlockedRef = useRef(false);
  const managedRootIdsRef = useRef<Set<string>>(new Set());
  const expandedRef = useRef<string[]>([]);
  const selectedDirRef = useRef<string | null>(null);
  const fileRef = useRef<FilePayload | null>(null);
  const selectedSessionRef = useRef<SessionItem | null>(null);
  const lastMainSessionSnapshotRef = useRef<Session | null>(null);
  const sessionSearchTargetCounterRef = useRef(0);
  const currentSessionRef = useRef<SessionItem | null>(null);
  const interactionModeRef = useRef<"main" | "drawer">("main");
  const pendingDraftRef = useRef<PendingSend | null>(null);
  const pendingBySessionRef = useRef<Record<string, PendingSend>>({});
  const pendingRequestRef = useRef<Record<string, PendingSend>>({});
  const queuedMessagesBySessionRef = useRef<Record<string, SessionQueueItem[]>>({});
  const queueFrozenBySessionRef = useRef<Record<string, boolean>>({});
  const optimisticDequeuedIdsRef = useRef<Record<string, Set<string>>>({});
  const cancelRequestedBySessionRef = useRef<Record<string, boolean>>({});
  const sessionCacheRef = useRef<Record<string, Session>>({});
  const loadedSessionRef = useRef<Record<string, boolean>>({});
  const loadingSessionRef = useRef<Partial<Record<string, Promise<SyncSessionResult>>>>({});
  const staleSessionKeysRef = useRef<Set<string>>(new Set());
  const invalidTreeCacheKeysRef = useRef<Set<string>>(new Set());
  const boundSessionByRootRef = useRef<Record<string, string | null>>({});
  const suppressedAutoBindSessionByRootRef = useRef<Record<string, string | null>>({});
  const drawerSessionByRootRef = useRef<Record<string, SessionItem | null>>({});
  const selectedSessionByRootRef = useRef<Record<string, string | null>>({});
  const mainViewPreferenceByRootRef = useRef<
    Record<string, "session" | "file" | "directory" | "git-diff">
  >({});
  const drawerOpenByRootRef = useRef<Record<string, boolean>>({});
  const fileCursorRef = useRef<number>(0);
  const fileScrollPositionsRef = useRef<Record<string, number>>(
    loadPersistedFileScrollPositions(),
  );
  const pluginContentRef = useRef<HTMLDivElement | null>(null);
  const lastPluginChapterRef = useRef<string>("");
  const viewerSelectionRef = useRef<ViewerSelection | null>(null);
  const lastViewerSelectionRef = useRef<ViewerSelection | null>(null);
  const dismissedSelectionFileRef = useRef<string | null>(null);
  const lastPluginResetFileKeyRef = useRef<string>("");
  const pluginBypassRef = useRef<boolean>(false);
  const fileOpenRequestRef = useRef(0);
  const fullUpgradeAttemptRef = useRef("");
  const pluginsLoadedByRootRef = useRef<Record<string, boolean>>({});
  const pluginsLoadingByRootRef = useRef<Record<string, Promise<void>>>({});
  const pluginsTrustPendingByRootRef = useRef<Record<string, boolean>>({});
  const didInitRef = useRef(false);
  const relayWSAuthCheckRef = useRef(false);
  const managedRootsRequestRef = useRef<Promise<ManagedRootPayload[] | null> | null>(null);
  const handleSelectSessionRef = useRef<
    ((session: any) => Promise<void>) | null
  >(null);

  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const sessionsRef = useRef<SessionItem[]>([]);
  const [multiProjectSessionsEnabled, setMultiProjectSessionsEnabled] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(MULTI_PROJECT_SESSION_STORAGE_KEY) === "1";
  });
  const [multiProjectSessionGroups, setMultiProjectSessionGroups] = useState<MultiProjectSessionGroup[]>([]);
  const [multiProjectSessionsLoading, setMultiProjectSessionsLoading] = useState(false);
  const [multiProjectPendingByKey, setMultiProjectPendingByKey] = useState<Record<string, boolean>>({});
  const multiProjectPendingRef = useRef<Record<string, boolean>>({});
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [sessionSearchResultsMode, setSessionSearchResultsMode] = useState(false);
  const [sessionSearchQuery, setSessionSearchQuery] = useState("");
  const [sessionSearchAppliedQuery, setSessionSearchAppliedQuery] = useState("");
  const [sessionSearchResults, setSessionSearchResults] = useState<SessionItem[]>([]);
  const [sessionSearchLoading, setSessionSearchLoading] = useState(false);
  const [syncingSessionKeys, setSyncingSessionKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [hasMoreSessions, setHasMoreSessions] = useState(false);
  const [loadingOlderSessions, setLoadingOlderSessions] = useState(false);
  const [sessionListMode, setSessionListMode] = useState<"local" | "import">(
    "local",
  );
  const sessionListModeRef = useRef<"local" | "import">("local");
  const [externalSessions, setExternalSessions] = useState<SessionItem[]>([]);
  const externalSessionsRef = useRef<SessionItem[]>([]);
  const [hasMoreExternalSessions, setHasMoreExternalSessions] = useState(false);
  const [loadingOlderExternalSessions, setLoadingOlderExternalSessions] =
    useState(false);
  const [loadingExternalSessions, setLoadingExternalSessions] = useState(false);
  const [externalSessionsError, setExternalSessionsError] = useState("");
  const [externalSelectedKey, setExternalSelectedKey] = useState("");
  const [externalImportAgent, setExternalImportAgent] = useState("");
  const externalImportAgentRef = useRef("");
  const [externalFilterBound, setExternalFilterBound] = useState(true);
  const [selectedExternalImportKeys, setSelectedExternalImportKeys] = useState<
    Set<string>
  >(() => new Set());
  const [importingExternalSessionKeys, setImportingExternalSessionKeys] =
    useState<Set<string>>(() => new Set());
  const [confirmingExternalImport, setConfirmingExternalImport] =
    useState(false);
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const importMenuRef = useRef<HTMLDivElement | null>(null);
  const projectAddPopoverRef = useRef<HTMLDivElement | null>(null);
  const worktreeCreatePopoverRef = useRef<HTMLDivElement | null>(null);
  const worktreeSwitchPopoverRef = useRef<HTMLDivElement | null>(null);
  const taskTemplateActionMenuRef = useRef<HTMLDivElement | null>(null);
  const taskCreateTemplateMenuRef = useRef<HTMLDivElement | null>(null);
  const [availableAgents, setAvailableAgents] = useState<AgentStatus[]>([]);
  const [scheduledAgentDialogOpen, setScheduledAgentDialogOpen] = useState(false);
  const [taskTemplates, setTaskTemplates] = useState<TaskTemplate[]>([]);
  const [taskTemplateDialogOpen, setTaskTemplateDialogOpen] = useState(false);
  const [taskTemplateDialogTemplate, setTaskTemplateDialogTemplate] = useState<TaskTemplate | null>(null);
	  const [kanbanTasks, setKanbanTasks] = useState<KanbanTask[]>([]);
	  const [kanbanTaskCountItems, setKanbanTaskCountItems] = useState<KanbanTask[]>([]);
	  const [taskDetailsById, setTaskDetailsById] = useState<Record<string, TaskDetail>>({});
	  const [taskFirstInputById, setTaskFirstInputById] = useState<Record<string, string>>({});
	  const [taskSessionKeysById, setTaskSessionKeysById] = useState<Record<string, string[]>>({});
	  const [taskRelatedFilesById, setTaskRelatedFilesById] = useState<Record<string, RelatedFile[]>>({});
	  const taskDetailsByIdRef = useRef<Record<string, TaskDetail>>({});
	  const taskSessionKeysByIdRef = useRef<Record<string, string[]>>({});
	  const [selectedKanbanTaskId, setSelectedKanbanTaskId] = useState("");
	  const [expandedTaskInputIds, setExpandedTaskInputIds] = useState<Set<string>>(() => new Set());
  const [collapsedTaskCompletionGroups, setCollapsedTaskCompletionGroups] = useState<Set<string>>(() => new Set(["success", "fail", "cancelled"]));
  const [taskInlineEdit, setTaskInlineEdit] = useState<TaskInlineEditState | null>(null);
  const [taskSessionErrorDialog, setTaskSessionErrorDialog] = useState<{ title: string; message: string; details: string[] } | null>(null);
  const [taskInlineActiveToken, setTaskInlineActiveToken] = useState<{ type: "file" | "slash" | "prompt" | "command"; query: string } | null>(null);
  const [taskInlineCandidates, setTaskInlineCandidates] = useState<CandidateItem[]>([]);
  const [taskInlineCandidateIndex, setTaskInlineCandidateIndex] = useState(0);
  const [taskInlineSaving, setTaskInlineSaving] = useState(false);
  const [taskInlineUploadProgress, setTaskInlineUploadProgress] = useState<UploadProgress | null>(null);
	  const [directoryUploadProgress, setDirectoryUploadProgress] = useState<UploadProgress | null>(null);
	  const [taskWorktreeBranches, setTaskWorktreeBranches] = useState<GitBranchesPayload>({ branches: [] });
	  const [taskWorktreeBranchesLoading, setTaskWorktreeBranchesLoading] = useState(false);
	  const [taskWorktreeBranchError, setTaskWorktreeBranchError] = useState("");
	  const [kanbanTasksLoading, setKanbanTasksLoading] = useState(false);
  const [taskTemplateFilter, setTaskTemplateFilter] = useState("");
  const [taskTemplateActionMenuOpen, setTaskTemplateActionMenuOpen] = useState(false);
  const [taskTemplateConcurrencyOpen, setTaskTemplateConcurrencyOpen] = useState(false);
  const [taskCreateTemplateMenuOpen, setTaskCreateTemplateMenuOpen] = useState(false);
  const taskInlineEditorRef = useRef<TokenEditorHandle | null>(null);
  const taskInlineCandidateItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const taskInlineAttachmentInputRef = useRef<HTMLInputElement | null>(null);
	  const taskInlineUploadAbortRef = useRef<AbortController | null>(null);
	  const directoryUploadAbortRef = useRef<AbortController | null>(null);

	  useEffect(() => {
	    taskDetailsByIdRef.current = taskDetailsById;
	  }, [taskDetailsById]);

	  useEffect(() => {
	    taskSessionKeysByIdRef.current = taskSessionKeysById;
	  }, [taskSessionKeysById]);
  const knownTaskWorktreePathsRef = useRef<Set<string>>(new Set());
  const [selectedSession, setSelectedSession] = useState<SessionItem | null>(
    null,
  );
  const [selectedSessionLoading, setSelectedSessionLoading] = useState(false);
  const [drawerLoadingSessionByRoot, setDrawerLoadingSessionByRoot] = useState<
    Record<string, string>
  >({});
  const [activeBoundSessionKey, setActiveBoundSessionKey] = useState<
    string | null
  >(null);
  const [pendingPlanMode, setPendingPlanMode] = useState(false);
  const [currentSession, setCurrentSession] = useState<SessionItem | null>(null);
  const [cacheVersion, setCacheVersion] = useState(0);
  const [slashCommandResults, setSlashCommandResults] = useState<
    Record<string, SlashCommandResult>
  >({});
  const [copiedSlashCommandKeys, setCopiedSlashCommandKeys] = useState<
    Record<string, true>
  >({});
  const slashCopyResetTimersRef = useRef<Record<string, number>>({});
  const [queueVersion, setQueueVersion] = useState(0);
  const [interactionMode, setInteractionMode] = useState<"main" | "drawer">(
    "main",
  );
  const [agentsVersion, setAgentsVersion] = useState(0);
  const [codexRateLimitsRefreshToken, setCodexRateLimitsRefreshToken] = useState(0);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const { isMobile, isTablet } = useResponsive();
  const [mobileEnterKeySends, setMobileEnterKeySends] = useState(loadMobileEnterKeySends);
  const [sidebarsSwapped, setSidebarsSwapped] = useState(loadSidebarsSwapped);
  const [gitDiffSideBySide, setGitDiffSideBySide] = useState(loadGitDiffSideBySide);
  const [isLeftOpen, setIsLeftOpen] = useState(() => window.innerWidth >= 768);
  const [isRightOpen, setIsRightOpen] = useState(
    () => window.innerWidth >= 768,
  );
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const onboardingAutoStartRef = useRef(false);
  const [currentRootId, setCurrentRootId] = useState<string | null>(null);
  const currentRootIdRef = useRef<string | null>(null);

  const loadTaskTemplates = useCallback(async () => {
    if (!protectedAPIReady()) {
      return;
    }
    try {
      setTaskTemplates(await fetchTaskTemplates());
    } catch (err) {
      reportError("file.write_failed", String((err as Error)?.message || t("taskTemplate.loadFailed")));
    }
  }, [t]);

  const openTaskTemplateEditor = useCallback((template: TaskTemplate | null) => {
    setTaskTemplateDialogTemplate(template);
    setTaskTemplateDialogOpen(true);
  }, []);

  const handleTaskTemplateSaved = useCallback((template: TaskTemplate) => {
    setTaskTemplates((prev) => {
      const id = template.id || "";
      if (!id) return prev;
      const index = prev.findIndex((item) => item.id === id);
      if (index < 0) return [template, ...prev];
      const next = [...prev];
      next[index] = template;
      return next;
    });
    setTaskTemplateDialogTemplate(template);
  }, []);

  const handleDeleteTaskTemplate = useCallback(async (template: TaskTemplate) => {
    const id = template.id || "";
    if (!id) return;
    if (!window.confirm(t("taskTemplate.deleteConfirm", { name: template.name || id }))) return;
    try {
      await deleteTaskTemplate(id);
      setTaskTemplates((prev) => prev.filter((item) => item.id !== id));
      setTaskTemplateDialogTemplate((prev) => prev?.id === id ? null : prev);
      setTaskTemplateFilter((prev) => prev === id ? "" : prev);
    } catch (err) {
      reportError("file.write_failed", String((err as Error)?.message || t("taskTemplate.deleteFailed")));
    }
  }, [t]);

  const handleTaskTemplateConcurrencyChange = useCallback(async (templateId: string, value: number) => {
    const template = taskTemplates.find((item) => item.id === templateId);
    if (!template) return;
    const nextValue = Math.max(1, Math.min(10, value || 1));
    const optimistic = { ...template, max_concurrency: nextValue };
    setTaskTemplates((prev) => prev.map((item) => item.id === templateId ? optimistic : item));
    try {
      const saved = await saveTaskTemplate(optimistic);
      setTaskTemplates((prev) => prev.map((item) => item.id === templateId ? saved : item));
      setTaskTemplateDialogTemplate((prev) => prev?.id === templateId ? saved : prev);
    } catch (err) {
      setTaskTemplates((prev) => prev.map((item) => item.id === templateId ? template : item));
      reportError("file.write_failed", String((err as Error)?.message || t("taskTemplate.concurrencySaveFailed")));
    }
  }, [taskTemplates, t]);

  useEffect(() => {
    void loadTaskTemplates();
  }, [loadTaskTemplates]);

  useEffect(() => {
    if (!currentRootId) {
      if (taskTemplateFilter) setTaskTemplateFilter("");
      return;
    }
    if (taskTemplateFilter === TASK_TEMPLATE_ALL_FILTER || (taskTemplateFilter && taskTemplates.some((template) => template.id === taskTemplateFilter))) {
      return;
    }
    let remembered = "";
    try {
      const parsed = JSON.parse(window.localStorage.getItem(TASK_TEMPLATE_SELECTION_STORAGE_KEY) || "{}") as Record<string, unknown>;
      const value = parsed[currentRootId];
      remembered = typeof value === "string" ? value : "";
    } catch {
      remembered = "";
    }
    const rememberedValid = remembered === TASK_TEMPLATE_ALL_FILTER || taskTemplates.some((template) => template.id === remembered);
    const next = rememberedValid ? remembered : TASK_TEMPLATE_ALL_FILTER;
    if (next && next !== taskTemplateFilter) {
      setTaskTemplateFilter(next);
    }
  }, [currentRootId, taskTemplateFilter, taskTemplates]);

  useEffect(() => {
    if (!currentRootId || !taskTemplateFilter) return;
    try {
      const parsed = JSON.parse(window.localStorage.getItem(TASK_TEMPLATE_SELECTION_STORAGE_KEY) || "{}") as Record<string, unknown>;
      window.localStorage.setItem(TASK_TEMPLATE_SELECTION_STORAGE_KEY, JSON.stringify({
        ...parsed,
        [currentRootId]: taskTemplateFilter,
      }));
    } catch {
    }
  }, [currentRootId, taskTemplateFilter]);

  useEffect(() => {
    if (!taskTemplateActionMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (taskTemplateActionMenuRef.current?.contains(event.target as Node)) {
        return;
      }
      setTaskTemplateActionMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [taskTemplateActionMenuOpen]);

  useEffect(() => {
    if (!taskCreateTemplateMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (taskCreateTemplateMenuRef.current?.contains(event.target as Node)) {
        return;
      }
      setTaskCreateTemplateMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [taskCreateTemplateMenuOpen]);

  useEffect(() => {
    if (!taskTemplateActionMenuOpen) {
      setTaskTemplateConcurrencyOpen(false);
    } else {
      setTaskCreateTemplateMenuOpen(false);
    }
  }, [taskTemplateActionMenuOpen]);

  useEffect(() => {
    if (!taskInlineEdit) return;
    window.setTimeout(() => {
      taskInlineEditorRef.current?.setText(taskInlineEdit.text || "");
    }, 0);
  }, [taskInlineEdit?.taskId, taskInlineEdit?.templateId]);

  useEffect(() => {
    if (!taskInlineActiveToken || !currentRootId) {
      setTaskInlineCandidates([]);
      setTaskInlineCandidateIndex(0);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const selectedTemplate = taskTemplates.find((template) => template.id === taskTemplateFilter) || null;
      const agent = firstAgentStage(selectedTemplate)?.agent || "";
      fetchCandidates({
        rootId: currentRootId,
        type: taskInlineActiveToken.type === "file"
          ? "file"
          : taskInlineActiveToken.type === "prompt"
            ? "prompt"
            : taskInlineActiveToken.type === "command"
              ? "command"
              : "skill",
        query: taskInlineActiveToken.query,
        agent: taskInlineActiveToken.type === "slash" ? agent : undefined,
        signal: controller.signal,
      })
        .then((items) => {
          setTaskInlineCandidates(items);
          setTaskInlineCandidateIndex(0);
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          console.error("Failed to fetch task candidates:", err);
          setTaskInlineCandidates([]);
          setTaskInlineCandidateIndex(0);
        });
    }, CANDIDATE_FETCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [currentRootId, taskInlineActiveToken, taskTemplateFilter, taskTemplates]);

  const applyTaskDetails = useCallback((rootId: string, details: TaskDetail[], persist = true) => {
    const accepted = details.filter(
      (detail) =>
        detail?.task?.id &&
        shouldApplyTaskDetail(taskDetailsByIdRef.current[detail.task.id], detail),
    );
    if (accepted.length === 0) return;
    const nextSnapshot = { ...taskDetailsByIdRef.current };
    accepted.forEach((detail) => {
      nextSnapshot[detail.task.id] = detail;
    });
    taskDetailsByIdRef.current = nextSnapshot;
    setTaskDetailsById((prev) => {
      const next = { ...prev };
      accepted.forEach((detail) => {
        if (shouldApplyTaskDetail(next[detail.task.id], detail)) {
          next[detail.task.id] = detail;
        }
      });
      return next;
    });
    setTaskFirstInputById((prev) => {
      const next = { ...prev };
      accepted.forEach((detail) => {
        next[detail.task.id] = firstTaskInputFromDetail(detail);
      });
      return next;
    });
    setTaskSessionKeysById((prev) => {
      const next = { ...prev };
      accepted.forEach((detail) => {
        next[detail.task.id] = taskSessionKeysFromDetail(detail);
      });
      return next;
    });
    setKanbanTaskCountItems((prev) => {
      const byId = new Map(prev.map((task) => [task.id, task]));
      accepted.forEach((detail) => byId.set(detail.task.id, detail.task));
      return Array.from(byId.values()).sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    });
    if (persist) {
      void upsertCachedTaskDetails(rootId, accepted);
    }
  }, []);

  const loadKanbanTasks = useCallback(async (rootId?: string | null, force = false) => {
    if (!protectedAPIReady()) {
      return;
    }
    const targetRoot = rootId || currentRootIdRef.current;
    if (!targetRoot) {
      setKanbanTasks([]);
      setKanbanTaskCountItems([]);
      setTaskDetailsById({});
      setTaskFirstInputById({});
      setTaskSessionKeysById({});
      return;
    }
    setKanbanTasksLoading(true);
    try {
      const cached = await getCachedTaskDetails(targetRoot);
      if (cached.length > 0) {
        applyTaskDetails(targetRoot, cached, false);
      }
      const meta = await getCachedTaskMeta(targetRoot);
      const details = await fetchTaskDetails(targetRoot, force ? undefined : { after: meta?.newestUpdatedAt || "" });
      if (details.length > 0) {
        applyTaskDetails(targetRoot, details);
      }
      if (!force && meta?.newestUpdatedAt) {
        const recent = await fetchTaskDetails(targetRoot, { limit: 20 });
        applyTaskDetails(targetRoot, recent);
      }
    } catch (err) {
      reportError("file.write_failed", String((err as Error)?.message || t("task.loadFailed")));
    } finally {
      setKanbanTasksLoading(false);
    }
  }, [applyTaskDetails, t]);

  const kanbanRefreshSpin = useRefreshSpin(() => loadKanbanTasks(currentRootId));

	  useEffect(() => {
	    void loadKanbanTasks(currentRootId);
	  }, [currentRootId, loadKanbanTasks]);

	  useEffect(() => {
	    const allTasks = Object.values(taskDetailsById)
	      .map((detail) => detail.task)
	      .filter((task) => !currentRootId || task.root_id === currentRootId)
	      .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
	    const selectedTemplateId = taskTemplateFilter || "";
	    const allTemplatesSelected = selectedTemplateId === TASK_TEMPLATE_ALL_FILTER;
	    const filtered = selectedTemplateId && !allTemplatesSelected
	      ? allTasks.filter((task) => task.task_template_id === selectedTemplateId)
	      : allTasks;
	    setKanbanTaskCountItems(allTasks);
	    setKanbanTasks(allTemplatesSelected ? filtered : filtered.filter(isUnfinishedKanbanTask));
	  }, [currentRootId, taskDetailsById, taskTemplateFilter]);

	  useEffect(() => {
	    if (!selectedKanbanTaskId) return;
	    if (kanbanTasks.some((task) => task.id === selectedKanbanTaskId)) return;
	    setSelectedKanbanTaskId("");
	  }, [kanbanTasks, selectedKanbanTaskId]);

	  const handleMoveKanbanTask = useCallback(async (task: KanbanTask, action: "next" | "run-now" | "prev" | "pause" | "resume" | "complete" | "cancel") => {
    const rootId = task.root_id || currentRootIdRef.current;
    if (!rootId) return;
    let reason = "";
    if (action === "prev" || action === "pause") {
      const label = action === "prev" ? t("task.actionPrevious") : t("task.actionPause");
      const input = window.prompt(t("task.reasonPrompt", { action: label }), "");
      if (input === null) {
        return;
      }
      reason = input.trim();
    }
    try {
      const detail = await moveTask(rootId, task.id, action, reason);
      applyTaskDetails(rootId, [detail]);
      if (detail.task.worktree_path) {
        void refreshTaskWorktree(rootId, detail.task.worktree_path);
      }
    } catch (err) {
      reportError("file.write_failed", String((err as Error)?.message || t("task.actionFailed")));
    }
  }, [applyTaskDetails, t]);

  const openTaskEditDialog = useCallback(async (task: KanbanTask, openAttachmentPicker = false) => {
    const rootId = task.root_id || currentRootIdRef.current;
    if (!rootId) return;
    try {
      const detail = taskDetailsById[task.id];
      if (!detail) {
        reportError("file.write_failed", t("task.detailNotSynced"));
        return;
      }
      const firstInput = firstTaskInputFromDetail(detail);
      const currentInput = currentTaskInputFromDetail(detail);
	      setTaskInlineEdit({
	        taskId: task.id,
	        templateId: task.task_template_id,
	        templateName: task.task_template_name || t("task.defaultTitle"),
	        text: currentInput,
	        previousInputs: previousTaskInputsFromDetail(detail, t),
	        createWorktree: detail.task.create_worktree === true,
	        worktreeBranchMode: detail.task.worktree_branch_mode === "existing" ? "existing" : "new",
	        worktreeBranch: detail.task.worktree_branch || "",
	        canToggleWorktree: detail.task.current_stage_index === 0 && !detail.task.worktree_path,
	        attachments: [],
	      });
      setTaskInlineActiveToken(null);
      setTaskInlineCandidates([]);
      setTaskInlineCandidateIndex(0);
      setTaskFirstInputById((prev) => ({ ...prev, [task.id]: firstInput }));
      window.setTimeout(() => {
        if (openAttachmentPicker) {
          taskInlineAttachmentInputRef.current?.click();
        }
      }, 0);
    } catch (err) {
      reportError("file.write_failed", String((err as Error)?.message || t("task.editFailed")));
    }
  }, [taskDetailsById, t]);

  const loadTaskWorktreeBranches = useCallback(async (rootId: string) => {
    if (!rootId) return;
    setTaskWorktreeBranchesLoading(true);
    setTaskWorktreeBranchError("");
    try {
      setTaskWorktreeBranches(await fetchGitBranches(rootId));
    } catch (error) {
      setTaskWorktreeBranches({ branches: [] });
      setTaskWorktreeBranchError(error instanceof Error ? error.message : t("worktree.loadBranchFailed"));
    } finally {
      setTaskWorktreeBranchesLoading(false);
    }
  }, [t]);

	  useEffect(() => {
	    if (
	      !taskInlineEdit?.createWorktree ||
	      !taskInlineEdit.canToggleWorktree ||
      !currentRootId ||
      managedRootByIdRef.current[currentRootId]?.is_git_repo !== true
    ) {
      setTaskWorktreeBranchError("");
      return;
    }
	    void loadTaskWorktreeBranches(currentRootId);
	  }, [currentRootId, loadTaskWorktreeBranches, taskInlineEdit?.canToggleWorktree, taskInlineEdit?.createWorktree]);

	  useEffect(() => {
	    if (!taskInlineEdit || taskInlineEdit.taskId || !taskInlineEdit.canToggleWorktree) return;
	    const rootId = currentRootIdRef.current || "";
	    if (!rootId) return;
	    saveTaskCreateWorktreePreference(rootId, {
	      createWorktree: taskInlineEdit.createWorktree,
	      worktreeBranchMode: taskInlineEdit.worktreeBranchMode,
	      worktreeBranch: taskInlineEdit.worktreeBranch,
	    });
	  }, [
	    taskInlineEdit?.canToggleWorktree,
	    taskInlineEdit?.createWorktree,
	    taskInlineEdit?.taskId,
	    taskInlineEdit?.worktreeBranch,
	    taskInlineEdit?.worktreeBranchMode,
	  ]);

	  const openTaskCreateDialog = useCallback((template: TaskTemplate | null) => {
	    const templateId = template?.id || "";
	    if (!templateId) return;
	    const initialText = firstUserInputTemplate(template);
	    const rootId = currentRootIdRef.current || "";
	    const taskCanCreateWorktree = managedRootByIdRef.current[rootId]?.is_git_repo === true;
	    const worktreePref = loadTaskCreateWorktreePreference(rootId);
	    setTaskInlineEdit({
	      templateId,
	      templateName: template?.name || t("task.defaultTitle"),
	      text: initialText,
	      previousInputs: [],
	      createWorktree: taskCanCreateWorktree && worktreePref.createWorktree,
	      worktreeBranchMode: worktreePref.worktreeBranchMode,
	      worktreeBranch: worktreePref.worktreeBranch,
	      canToggleWorktree: true,
	      attachments: [],
	    });
    setTaskInlineActiveToken(null);
    setTaskInlineCandidates([]);
    setTaskInlineCandidateIndex(0);
  }, [t]);

  const closeTaskEditDialog = useCallback(() => {
    setTaskInlineEdit((prev) => {
      prev?.attachments.forEach((attachment) => {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      });
      return null;
    });
    setTaskInlineActiveToken(null);
    setTaskInlineCandidates([]);
    setTaskInlineCandidateIndex(0);
    setTaskInlineSaving(false);
    setTaskInlineUploadProgress(null);
    taskInlineUploadAbortRef.current?.abort();
    taskInlineUploadAbortRef.current = null;
  }, []);

  const applyTaskInlineCandidate = useCallback((candidate: CandidateItem) => {
    setTaskInlineCandidates([]);
    setTaskInlineCandidateIndex(0);
    taskInlineEditorRef.current?.insertCandidate(candidate.type, candidate.name);
    taskInlineEditorRef.current?.focus();
  }, []);

  useEffect(() => {
    if (taskInlineCandidates.length === 0) {
      taskInlineCandidateItemRefs.current = [];
      return;
    }
    const activeItem = taskInlineCandidateItemRefs.current[taskInlineCandidateIndex];
    activeItem?.scrollIntoView({ block: "nearest" });
  }, [taskInlineCandidates, taskInlineCandidateIndex]);

  const appendTaskInlineAttachments = useCallback((files: File[]) => {
    if (files.length === 0) return;
    setTaskInlineEdit((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        attachments: [
          ...prev.attachments,
          ...files.map((file) => ({
            id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
            file,
            isImage: file.type.startsWith("image/"),
            previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
          })),
        ],
      };
    });
  }, []);

  const handleTaskInlineAttachmentChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (files.length > 0) {
      appendTaskInlineAttachments(files);
    }
    event.currentTarget.value = "";
  }, [appendTaskInlineAttachments]);

  const handleTaskInlinePaste = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
    if (taskInlineSaving || !currentRootIdRef.current) return;
    const clipboardItems = Array.from(event.clipboardData?.items || []);
    const imageFiles = clipboardItems
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
    if (imageFiles.length === 0) return;
    event.preventDefault();
    appendTaskInlineAttachments(imageFiles);
  }, [appendTaskInlineAttachments, taskInlineSaving]);

  const removeTaskInlineAttachment = useCallback((id: string) => {
    setTaskInlineEdit((prev) => prev
      ? {
          ...prev,
          attachments: prev.attachments.filter((attachment) => {
            const keep = attachment.id !== id;
            if (!keep && attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
            return keep;
          }),
        }
      : prev);
  }, []);

  async function refreshTaskWorktree(rootId: string, worktreePath: string, force = true) {
    const normalizedRootId = String(rootId || "").trim();
    const normalizedWorktreePath = String(worktreePath || "").trim();
    if (!normalizedRootId || !normalizedWorktreePath) {
      return;
    }
    if (!force && knownTaskWorktreePathsRef.current.has(normalizedWorktreePath)) {
      return;
    }
    knownTaskWorktreePathsRef.current.add(normalizedWorktreePath);
    setExpandedWorktreeByRoot((prev) => ({ ...prev, [normalizedRootId]: normalizedWorktreePath }));
    setWorktreeLoadingByRoot((prev) => ({ ...prev, [normalizedRootId]: true }));
    setWorktreeErrorByRoot((prev) => ({ ...prev, [normalizedRootId]: "" }));
    try {
      const payload = await fetchGitWorktrees(normalizedRootId);
      (payload.items || []).forEach((item) => {
        if (item.path) {
          knownTaskWorktreePathsRef.current.add(item.path);
        }
      });
      setWorktreeItemsByRoot((prev) => ({
        ...prev,
        [normalizedRootId]: (payload.items || []).filter((item) => !!item.branch),
      }));
    } catch (error) {
      knownTaskWorktreePathsRef.current.delete(normalizedWorktreePath);
      setWorktreeErrorByRoot((prev) => ({
        ...prev,
        [normalizedRootId]: error instanceof Error ? error.message : t("worktree.loadFailed"),
      }));
    } finally {
      setWorktreeLoadingByRoot((prev) => ({ ...prev, [normalizedRootId]: false }));
    }
    setWorktreeStatusLoadingByPath((prev) => ({ ...prev, [normalizedWorktreePath]: true }));
    try {
      const status = await fetchGitStatusByPath(normalizedWorktreePath);
      setWorktreeStatusByPath((prev) => ({ ...prev, [normalizedWorktreePath]: status }));
    } catch {
      setWorktreeStatusByPath((prev) => ({ ...prev, [normalizedWorktreePath]: null }));
    } finally {
      setWorktreeStatusLoadingByPath((prev) => ({ ...prev, [normalizedWorktreePath]: false }));
    }
  }

  const saveTaskInlineEdit = useCallback(async () => {
    const edit = taskInlineEdit;
    const rootId = currentRootIdRef.current;
    if (!edit || !rootId) return;
    setTaskInlineSaving(true);
    setTaskInlineUploadProgress(null);
    try {
      let attachmentTokens = "";
      if (edit.attachments.length > 0) {
        const uploadAbort = new AbortController();
        taskInlineUploadAbortRef.current = uploadAbort;
        const uploaded = await uploadFiles({
          rootId,
          files: edit.attachments.map((attachment) => attachment.file),
          onProgress: setTaskInlineUploadProgress,
          signal: uploadAbort.signal,
        });
        attachmentTokens = uploaded.map((file) => `[file: ${file.path}]`).join("\n");
      }
      const payload = [edit.text.trim(), attachmentTokens].filter(Boolean).join("\n");
      const taskCanCreateWorktree = managedRootByIdRef.current[rootId]?.is_git_repo === true;
      const createWorktree = taskCanCreateWorktree && edit.createWorktree;
      const detail = edit.taskId
        ? await updateTaskInput(
            rootId,
            edit.taskId,
            payload,
            edit.canToggleWorktree ? createWorktree : undefined,
            edit.canToggleWorktree && createWorktree ? edit.worktreeBranchMode : undefined,
            edit.canToggleWorktree && createWorktree ? edit.worktreeBranch : undefined,
          )
        : await createTask(rootId, edit.templateId, payload, createWorktree, edit.worktreeBranchMode, edit.worktreeBranch);
      applyTaskDetails(rootId, [detail]);
      if (detail.task.worktree_path) {
        void refreshTaskWorktree(rootId, detail.task.worktree_path);
      }
      closeTaskEditDialog();
    } catch (err) {
      if (!isUploadAbortError(err)) {
        reportError("file.write_failed", String((err as Error)?.message || t("task.saveFailed")));
      }
      setTaskInlineSaving(false);
      setTaskInlineUploadProgress(null);
      taskInlineUploadAbortRef.current = null;
    }
  }, [applyTaskDetails, closeTaskEditDialog, taskInlineEdit, t]);

  const handleTaskInlineEditorKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (taskInlineCandidates.length === 0) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setTaskInlineCandidateIndex((prev) => (prev + 1) % taskInlineCandidates.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setTaskInlineCandidateIndex((prev) => (prev - 1 + taskInlineCandidates.length) % taskInlineCandidates.length);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      applyTaskInlineCandidate(taskInlineCandidates[taskInlineCandidateIndex] || taskInlineCandidates[0]);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setTaskInlineCandidates([]);
      setTaskInlineCandidateIndex(0);
    }
  }, [applyTaskInlineCandidate, taskInlineCandidates, taskInlineCandidateIndex]);

  const handleTaskInlineEditorEnter = useCallback((event: KeyboardEvent | null) => {
    if (event?.shiftKey) {
      return false;
    }
    if (taskInlineCandidates.length > 0) {
      event?.preventDefault();
      event?.stopPropagation();
      applyTaskInlineCandidate(taskInlineCandidates[taskInlineCandidateIndex] || taskInlineCandidates[0]);
      return true;
    }
    void saveTaskInlineEdit();
    return true;
  }, [applyTaskInlineCandidate, saveTaskInlineEdit, taskInlineCandidates, taskInlineCandidateIndex]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        MOBILE_ENTER_KEY_SEND_STORAGE_KEY,
        mobileEnterKeySends ? "1" : "0",
      );
    } catch {
      // Ignore storage failures; the setting can still apply for this session.
    }
  }, [mobileEnterKeySends]);

  useEffect(() => {
    return () => {
      Object.values(slashCopyResetTimersRef.current).forEach((timer) =>
        window.clearTimeout(timer),
      );
      slashCopyResetTimersRef.current = {};
    };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        SIDEBARS_SWAPPED_STORAGE_KEY,
        sidebarsSwapped ? "1" : "0",
      );
    } catch {
      // Ignore storage failures; the setting can still apply for this session.
    }
  }, [sidebarsSwapped]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        GIT_DIFF_SIDE_BY_SIDE_STORAGE_KEY,
        gitDiffSideBySide ? "1" : "0",
      );
    } catch {
      // Ignore storage failures; the setting can still apply for this session.
    }
  }, [gitDiffSideBySide]);

  const [managedRootIds, setManagedRootIds] = useState<string[]>([]);
  const managedRootByIdRef = useRef<Record<string, ManagedRootPayload>>({});
  const [rootEntries, setRootEntries] = useState<FileEntry[]>([]);
  const [creatingRootName, setCreatingRootName] = useState<string | null>(null);
  const [creatingRootParentPath, setCreatingRootParentPath] = useState<string | null>(null);
  const [creatingRootKind, setCreatingRootKind] = useState<"root" | "worktree">("root");
  const [creatingRootBusy, setCreatingRootBusy] = useState(false);
  const [worktreeBranches, setWorktreeBranches] = useState<GitBranchesPayload>({
    branches: [],
  });
  const [worktreeBranchesLoading, setWorktreeBranchesLoading] = useState(false);
  const [worktreeBranchError, setWorktreeBranchError] = useState("");
  const [worktreeBranchMode, setWorktreeBranchMode] = useState<"new" | "existing">("new");
  const [worktreeBranch, setWorktreeBranch] = useState("");
  const [worktreeSwitchOpen, setWorktreeSwitchOpen] = useState(false);
  const [worktreeSwitchItems, setWorktreeSwitchItems] = useState<GitWorktreeItem[]>([]);
  const [worktreeSwitchLoading, setWorktreeSwitchLoading] = useState(false);
  const [worktreeSwitchError, setWorktreeSwitchError] = useState("");
  const [switchingWorktreePath, setSwitchingWorktreePath] = useState("");
  const [projectAddMode, setProjectAddMode] = useState<ProjectAddMode | null>(
    null,
  );
  const [localDirState, setLocalDirState] = useState<LocalDirBrowserState>({
    path: "",
    parent: "",
    volumes: [],
    items: [],
    loading: false,
    selectedPath: "",
    adding: false,
    error: "",
  });
  const [githubImportState, setGitHubImportState] = useState<GitHubImportState>({
    url: "",
    parentPath: "",
    taskId: "",
    status: "",
    message: "",
    running: false,
    submitting: false,
    done: false,
    error: "",
  });
  const [relayStatus, setRelayStatus] = useState<RelayStatusPayload | null>(
    null,
  );
  const [tokenStationInfo, setTokenStationInfo] =
    useState<TokenStationInfo | null>(null);
  const [tokenStationLoading, setTokenStationLoading] = useState(false);
  const [tokenStationBusy, setTokenStationBusy] = useState(false);
  const [tokenStationApplyBusy, setTokenStationApplyBusy] = useState(false);
  const [tokenStationErrorOpen, setTokenStationErrorOpen] = useState(false);
  const [agentConfigSwitchRequest, setAgentConfigSwitchRequest] =
    useState<AgentConfigSwitchRequest | null>(null);
  const tokenStationRefreshRef = useRef<(() => void) | null>(null);
  const [bootstrapState, setBootstrapState] = useState<BootstrapState>(() =>
    bootstrapService.snapshot(),
  );
  const [e2eeState, setE2eeState] = useState<E2EEState>(() =>
    e2eeService.snapshot(),
  );
  useEffect(() => {
    if (
      isMobile ||
      onboardingAutoStartRef.current ||
      !currentRootId ||
      bootstrapState.phase !== "ready" ||
      (e2eeState.required && !e2eeState.unlocked)
    ) {
      return;
    }
    onboardingAutoStartRef.current = true;
    if (!shouldAutoStartOnboarding()) return;
    const timer = window.setTimeout(() => setOnboardingOpen(true), 700);
    return () => window.clearTimeout(timer);
  }, [bootstrapState.phase, currentRootId, e2eeState.required, e2eeState.unlocked, isMobile]);
  useEffect(() => {
    if (isMobile && onboardingOpen) {
      setOnboardingOpen(false);
    }
  }, [isMobile, onboardingOpen]);
  const [e2eeSecretInput, setE2eeSecretInput] = useState("");
  const [e2eePromptError, setE2eePromptError] = useState("");
  const [e2eePromptBusy, setE2eePromptBusy] = useState(false);
  const [editDraftRequest, setEditDraftRequest] = useState<{
    id: number;
    content: string;
  } | null>(null);
  const [entriesByPath, setEntriesByPath] = useState<
    Record<string, FileEntry[]>
  >({});
  const entriesByPathRef = useRef<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<string[]>([]);
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  const [selectedDirKey, setSelectedDirKey] = useState<string | null>(null);
  const [mainEntries, setMainEntries] = useState<FileEntry[]>([]);
  const [mainDirectoryError, setMainDirectoryError] = useState("");
  const [gitStatus, setGitStatus] = useState<GitStatusPayload | null>(null);
  const [gitStatusLoading, setGitStatusLoading] = useState(false);
  const [gitHistory, setGitHistory] = useState<GitHistoryPayload | null>(null);
  const [gitHistoryLoading, setGitHistoryLoading] = useState(false);
  const [gitHistoryLoadingMore, setGitHistoryLoadingMore] = useState(false);
  const [gitStatusByRoot, setGitStatusByRoot] = useState<Record<string, GitStatusPayload | null>>({});
  const [gitStatusLoadingByRoot, setGitStatusLoadingByRoot] = useState<Record<string, boolean>>({});
  const [gitHistoryByRoot, setGitHistoryByRoot] = useState<Record<string, GitHistoryPayload | null>>({});
  const [gitHistoryLoadingByRoot, setGitHistoryLoadingByRoot] = useState<Record<string, boolean>>({});
  const [gitStatusExpandedByRoot, setGitStatusExpandedByRoot] = useState<Record<string, boolean>>(() =>
    loadBooleanRecord(GIT_STATUS_EXPANDED_STORAGE_KEY),
  );
  const [gitHistoryExpandedByRoot, setGitHistoryExpandedByRoot] = useState<Record<string, Record<string, boolean>>>(() =>
    loadStringBooleanRecord(GIT_HISTORY_EXPANDED_STORAGE_KEY),
  );
  const [gitDiff, setGitDiff] = useState<GitDiffPayload | null>(null);
  const [relatedSelectedFileKey, setRelatedSelectedFileKey] = useState("");
  const [treeSortMode, setTreeSortMode] = useState<DirectorySortMode>(() => {
    if (typeof window === "undefined") {
      return DEFAULT_DIRECTORY_SORT_MODE;
    }
    const saved = window.localStorage.getItem(TREE_SORT_STORAGE_KEY);
    return isDirectorySortMode(saved) ? saved : DEFAULT_DIRECTORY_SORT_MODE;
  });
  const [directorySortOverrides, setDirectorySortOverrides] = useState<
    Record<string, DirectorySortMode>
  >(() => {
    if (typeof window === "undefined") {
      return {};
    }
    try {
      const saved = window.localStorage.getItem(
        DIRECTORY_SORT_OVERRIDES_STORAGE_KEY,
      );
      if (!saved) {
        return {};
      }
      const parsed = JSON.parse(saved) as Record<string, string>;
      return Object.fromEntries(
        Object.entries(parsed).filter(([, value]) =>
          isDirectorySortMode(value),
        ),
      ) as Record<string, DirectorySortMode>;
    } catch {
      return {};
    }
  });
  const [mainContentViewByRoot, setMainContentViewByRoot] = useState<Record<string, MainContentViewMode>>(
    () => loadMainContentViewByRoot(),
  );
  const [status, setStatus] = useState<WSStatus>("disconnected");
  const [file, setFile] = useState<FilePayload | null>(null);
  const [viewerSelection, setViewerSelection] =
    useState<ViewerSelection | null>(null);
  const [attachedFileContext, setAttachedFileContext] =
    useState<AttachedFileContext | null>(null);
  const [pluginVersion, setPluginVersion] = useState(0);
  const [pluginLoading, setPluginLoading] = useState(false);
  const [pendingPluginTrust, setPendingPluginTrust] = useState<{
    rootId: string;
    bundle: PluginSourceBundle;
  } | null>(null);
  const [pluginBypass, setPluginBypass] = useState(false);
  const [pluginQuery, setPluginQuery] = useState<Record<string, string>>(
    () => readURLState().pluginQuery,
  );
  const pluginQueryRef = useRef<Record<string, string>>(
    readURLState().pluginQuery,
  );
  const [showHiddenFiles, setShowHiddenFiles] = useState(false);
  const [projectTreeTabRequest, setProjectTreeTabRequest] = useState<{
    tab: "files" | "git" | "worktrees" | "related";
    nonce: number;
  } | null>(null);
  const [projectTreeTab, setProjectTreeTab] = useState<"files" | "git" | "worktrees" | "related">("files");
  const [worktreeItemsByRoot, setWorktreeItemsByRoot] = useState<Record<string, GitWorktreeItem[]>>({});
  const [worktreeLoadingByRoot, setWorktreeLoadingByRoot] = useState<Record<string, boolean>>({});
  const [worktreeErrorByRoot, setWorktreeErrorByRoot] = useState<Record<string, string>>({});
  const [expandedWorktreeByRoot, setExpandedWorktreeByRoot] = useState<Record<string, string>>({});
  const [worktreeStatusByPath, setWorktreeStatusByPath] = useState<Record<string, GitStatusPayload | null>>({});
  const [worktreeStatusLoadingByPath, setWorktreeStatusLoadingByPath] = useState<Record<string, boolean>>({});
  const [updateState, setUpdateState] = useState<UpdateState>(() =>
    normalizeUpdateState(null),
  );
  const [updateSubmitting, setUpdateSubmitting] = useState(false);

  const ensureCompletionAudioContext = useCallback((): AudioContext | null => {
    if (typeof window === "undefined") {
      return null;
    }
    const AudioContextCtor =
      window.AudioContext ||
      (
        window as typeof window & {
          webkitAudioContext?: typeof AudioContext;
        }
      ).webkitAudioContext;
    if (!AudioContextCtor) {
      return null;
    }
    if (!completionAudioContextRef.current) {
      completionAudioContextRef.current = new AudioContextCtor();
    }
    return completionAudioContextRef.current;
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const unlockAudio = () => {
      const audioContext = ensureCompletionAudioContext();
      if (!audioContext) {
        return;
      }
      if (audioContext.state === "running") {
        completionAudioUnlockedRef.current = true;
        return;
      }
      void audioContext
        .resume()
        .then(() => {
          completionAudioUnlockedRef.current = audioContext.state === "running";
        })
        .catch(() => {});
    };
    const options: AddEventListenerOptions = { passive: true };
    window.addEventListener("pointerdown", unlockAudio, options);
    window.addEventListener("keydown", unlockAudio, options);
    window.addEventListener("touchstart", unlockAudio, options);
    return () => {
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
      window.removeEventListener("touchstart", unlockAudio);
    };
  }, [ensureCompletionAudioContext]);

  const handleStartUpdate = useCallback(async () => {
    const next = normalizeUpdateState(updateState);
    const status = (next.status || "idle").toLowerCase();
    if (
      status === "downloading" ||
      status === "installing" ||
      status === "restarting"
    ) {
      return;
    }
    if (next.has_update && status === "available") {
      const target = next.latest_version
        ? `v${next.latest_version}`
        : "the latest version";
      if (
        !window.confirm(
          `Install ${target} now? MindFS will restart after the update finishes.`,
        )
      ) {
        return;
      }
    }
    setUpdateSubmitting(true);
    try {
      await scheduleWebViewCacheClearOnNextLaunch();
      setUpdateState(normalizeUpdateState(await triggerUpdate()));
    } catch (error) {
      await cancelScheduledWebViewCacheClear();
      const message =
        error instanceof Error ? error.message : "Failed to start update";
      setUpdateState((prev) =>
        normalizeUpdateState({
          ...prev,
          status: "failed",
          message,
        }),
      );
    } finally {
      setUpdateSubmitting(false);
    }
  }, [updateState]);

  const playCompletionSound = useCallback(() => {
    const audioContext = ensureCompletionAudioContext();
    if (!audioContext) {
      return;
    }
    try {
      if (audioContext.state !== "running") {
        return;
      }
      completionAudioUnlockedRef.current = true;
      const now = audioContext.currentTime;
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(880, now);
      oscillator.frequency.exponentialRampToValueAtTime(1174, now + 0.09);
      gainNode.gain.setValueAtTime(0.0001, now);
      gainNode.gain.exponentialRampToValueAtTime(0.24, now + 0.012);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);
      oscillator.start(now);
      oscillator.stop(now + 0.2);
    } catch (error) {
      if (completionAudioUnlockedRef.current) {
        console.error("Failed to play completion sound:", error);
      }
    }
  }, [ensureCompletionAudioContext]);

  useEffect(() => {
    currentRootIdRef.current = currentRootId;
  }, [currentRootId]);
  useEffect(() => {
    let cancelled = false;
    if (!e2eeState.configured || (e2eeState.required && !e2eeState.unlocked)) {
      return;
    }
    fetchAgents(true)
      .then((items) => {
        if (cancelled) return;
        setAvailableAgents(items);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [agentsVersion, e2eeState.configured, e2eeState.required, e2eeState.unlocked]);
  useEffect(() => {
    if (!importMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!importMenuRef.current?.contains(event.target as Node)) {
        setImportMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [importMenuOpen]);
  useEffect(() => {
    if (!projectAddMode) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (!projectAddPopoverRef.current?.contains(event.target as Node)) {
        setProjectAddMode(null);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [projectAddMode]);
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (currentRootId) {
      window.localStorage.setItem(LAST_ROOT_STORAGE_KEY, currentRootId);
    }
  }, [currentRootId]);
  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);
  useEffect(() => {
    selectedDirRef.current = selectedDir;
  }, [selectedDir]);
  useEffect(() => {
    entriesByPathRef.current = entriesByPath;
  }, [entriesByPath]);
  useEffect(() => {
    fileRef.current = file;
  }, [file]);
  useEffect(() => {
    viewerSelectionRef.current = viewerSelection;
  }, [viewerSelection]);
  useEffect(() => {
    pluginQueryRef.current = pluginQuery;
  }, [pluginQuery]);
  useEffect(() => {
    if (!file?.path || !currentRootId) return;
    const nextKey = `${currentRootId}:${file.path}`;
    if (lastPluginResetFileKeyRef.current !== nextKey) {
      pluginBypassRef.current = false;
      setPluginBypass(false);
      lastPluginResetFileKeyRef.current = nextKey;
    }
  }, [file?.path, currentRootId]);
  useEffect(() => {
    pluginBypassRef.current = pluginBypass;
  }, [pluginBypass]);
  useEffect(() => {
    selectedSessionRef.current = selectedSession;
  }, [selectedSession]);
  useEffect(() => {
    if (selectedSession || activeBoundSessionKey || interactionMode !== "main") {
      setPendingPlanMode(false);
    }
  }, [selectedSession, activeBoundSessionKey, interactionMode]);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  useEffect(() => {
    multiProjectPendingRef.current = multiProjectPendingByKey;
  }, [multiProjectPendingByKey]);
  useEffect(() => {
    window.localStorage.setItem(
      MULTI_PROJECT_SESSION_STORAGE_KEY,
      multiProjectSessionsEnabled ? "1" : "0",
    );
  }, [multiProjectSessionsEnabled]);
  useEffect(() => {
    sessionListModeRef.current = sessionListMode;
    if (sessionListMode !== "local") {
      setSessionSearchOpen(false);
      setSessionSearchResultsMode(false);
      setSessionSearchQuery("");
      setSessionSearchAppliedQuery("");
      setSessionSearchResults([]);
      setSessionSearchLoading(false);
    }
  }, [sessionListMode]);
  useEffect(() => {
    setSessionSearchQuery("");
    setSessionSearchResultsMode(false);
    setSessionSearchAppliedQuery("");
    setSessionSearchResults([]);
    setSessionSearchLoading(false);
  }, [currentRootId]);
  useEffect(() => {
    setPendingPlanMode(false);
  }, [currentRootId]);
  useEffect(() => {
    externalSessionsRef.current = externalSessions;
  }, [externalSessions]);
  useEffect(() => {
    externalImportAgentRef.current = externalImportAgent;
  }, [externalImportAgent]);
  useEffect(() => {
    currentSessionRef.current = currentSession;
  }, [currentSession]);
  useEffect(() => {
    interactionModeRef.current = interactionMode;
  }, [interactionMode]);
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(TREE_SORT_STORAGE_KEY, treeSortMode);
  }, [treeSortMode]);
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(GIT_STATUS_EXPANDED_STORAGE_KEY, JSON.stringify(gitStatusExpandedByRoot));
  }, [gitStatusExpandedByRoot]);
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(GIT_HISTORY_EXPANDED_STORAGE_KEY, JSON.stringify(gitHistoryExpandedByRoot));
  }, [gitHistoryExpandedByRoot]);
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(
      DIRECTORY_SORT_OVERRIDES_STORAGE_KEY,
      JSON.stringify(directorySortOverrides),
    );
  }, [directorySortOverrides]);
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(
      MAIN_CONTENT_VIEW_STORAGE_KEY,
      JSON.stringify(mainContentViewByRoot),
    );
  }, [mainContentViewByRoot]);
  useEffect(() => {
    const rootID = currentRootId;
    if (!rootID) return;
    setActiveBoundSessionKey(boundSessionByRootRef.current[rootID] || null);
    setCurrentSession(drawerSessionByRootRef.current[rootID] || null);
    setIsDrawerOpen(!!drawerOpenByRootRef.current[rootID]);
  }, [currentRootId]);

  const setBoundSessionForRoot = useCallback(
    (rootID: string | null | undefined, key: string | null) => {
      if (!rootID) return;
      boundSessionByRootRef.current[rootID] = key;
      if (currentRootIdRef.current === rootID) {
        setActiveBoundSessionKey(key);
      }
    },
    [],
  );

  const setDrawerSessionForRoot = useCallback(
    (rootID: string | null | undefined, session: Session | SessionItem | null) => {
      if (!rootID) return;
      const next = toSessionItem(rootID, session);
      drawerSessionByRootRef.current[rootID] = next;
      if (currentRootIdRef.current === rootID) {
        setCurrentSession(next);
      }
    },
    [],
  );

  const setDrawerOpenForRoot = useCallback(
    (rootID: string | null | undefined, open: boolean) => {
      if (!rootID) return;
      drawerOpenByRootRef.current[rootID] = open;
      if (currentRootIdRef.current === rootID) {
        setIsDrawerOpen(open);
      }
    },
    [],
  );

  const setMainViewPreferenceForRoot = useCallback(
    (
      rootID: string | null | undefined,
      preference: "session" | "file" | "directory" | "git-diff",
    ) => {
      if (!rootID) return;
      mainViewPreferenceByRootRef.current[rootID] = preference;
    },
    [],
  );

  const getDirectorySortKey = useCallback(
    (rootID: string | null | undefined, dirPath: string | null | undefined) => {
      if (!rootID) {
        return "";
      }
      const normalizedDir = !dirPath || dirPath === rootID ? "." : dirPath;
      return `${rootID}:${normalizedDir}`;
    },
    [],
  );

  const currentDirectorySortKey = getDirectorySortKey(
    currentRootId,
    selectedDir,
  );
  const currentDirectorySortOverride = currentDirectorySortKey
    ? directorySortOverrides[currentDirectorySortKey]
    : undefined;
  const currentMainContentView: MainContentViewMode =
    (currentRootId && mainContentViewByRoot[currentRootId]) || "task-kanban";
  const handleMainContentViewChange = useCallback((mode: MainContentViewMode) => {
    const rootID = currentRootIdRef.current;
    if (!rootID) return;
    setMainContentViewByRoot((prev) => {
      if (prev[rootID] === mode) return prev;
      return { ...prev, [rootID]: mode };
    });
  }, []);
  const currentDirectorySortMode = currentDirectorySortOverride || treeSortMode;

  const replaceURLState = useCallback((next: URLState) => {
    const search = buildURLSearch(next);
    const target = `${window.location.pathname}${search}`;
    window.history.replaceState(null, "", target);
  }, []);

  const handleOnboardingStepChange = useCallback((stepId: string) => {
    const showingSidebar = stepId === "sidebar-menu" || stepId === "project-tabs";
    const showingSessions = stepId === "session-actions";
    const showingTasks = stepId === "project-home" || stepId === "main-menu" || stepId === "task-templates" || stepId === "task-template-menu" || stepId === "tasks";

    if (showingTasks && currentRootId) {
      selectedSessionRef.current = null;
      setSelectedSession(null);
      setSelectedSessionLoading(false);
      setFile(null);
      setGitDiff(null);
      setSelectedDir(currentRootId);
      handleMainContentViewChange("task-kanban");
      replaceURLState({ root: currentRootId, file: "", session: "", cursor: 0, pluginQuery: {} });
    }

    if (!isMobile) {
      setIsLeftOpen(true);
      setIsRightOpen(true);
      return;
    }
    setIsLeftOpen(showingSidebar);
    setIsRightOpen(showingSessions);
  }, [currentRootId, handleMainContentViewChange, isMobile, replaceURLState]);

  const redirectToRelayLogin = useCallback(() => {
    const next = encodeURIComponent(
      `${window.location.pathname}${window.location.search}`,
    );
    window.location.replace(`/login?next=${next}`);
  }, []);

  const redirectToRelayNodes = useCallback(() => {
    window.location.replace("/nodes");
  }, []);

  const handleRelayWebSocketClosed = useCallback(async () => {
    if (!isRelayNodePage() || relayWSAuthCheckRef.current) {
      return;
    }
    relayWSAuthCheckRef.current = true;
    try {
      const response = await fetch("/api/auth/me", { cache: "no-cache" });
      if (!response.ok) {
        redirectToRelayLogin();
        return;
      }
      const nodeID = relayNodeIdFromPathname(window.location.pathname);
      if (!nodeID) {
        return;
      }
      const nodeResponse = await fetch(`/n/${encodeURIComponent(nodeID)}/`, {
        cache: "no-cache",
        headers: {
          Accept: "application/json",
        },
      });
      if (
        nodeResponse.status === 403 ||
        nodeResponse.status === 404 ||
        nodeResponse.status === 502 ||
        nodeResponse.status === 503
      ) {
        redirectToRelayNodes();
      }
    } catch {
      // Network failures and connector outages also close the socket. Keep the
      // normal reconnect path unless the auth probe can prove the session died.
    } finally {
      relayWSAuthCheckRef.current = false;
    }
  }, [redirectToRelayLogin, redirectToRelayNodes]);

  const handleRelayNavigationFailure = useCallback(
    async (status: number, errorCode?: string | null) => {
      if (!isRelayPWAContext()) {
        return false;
      }
      const code = String(errorCode || "").trim();
      if (status === 401 || code === "unauthorized") {
        try {
          const response = await fetch("/api/auth/me");
          if (response.ok) {
            return false;
          }
        } catch {}
        redirectToRelayLogin();
        return true;
      }
      if (
        status === 403 ||
        status === 404 ||
        status === 502 ||
        status === 503 ||
        code === "forbidden" ||
        code === "node_not_found" ||
        code === "node_offline" ||
        code === "connector_unavailable"
      ) {
        redirectToRelayNodes();
        return true;
      }
      return false;
    },
    [redirectToRelayLogin, redirectToRelayNodes],
  );

  const rootSessionKey = useCallback(
    (rootId: string, sessionKey: string) => `${rootId}::${sessionKey}`,
    [],
  );
  const bumpCacheVersion = useCallback(() => setCacheVersion((v) => v + 1), []);
  const clearRootScopedClientState = useCallback((rootID: string, options?: { removeLastRoot?: boolean }) => {
    const root = String(rootID || "").trim();
    if (!root) {
      return;
    }
    const sessionPrefix = `${root}::`;
    const treePrefix = `${root}:`;

    const deleteRecordKeys = <T,>(record: Record<string, T>, predicate: (key: string) => boolean) => {
      for (const key of Object.keys(record)) {
        if (predicate(key)) {
          delete record[key];
        }
      }
    };
    const deleteSessionRecordKeys = <T,>(record: Record<string, T>) => {
      deleteRecordKeys(record, (key) => key.startsWith(sessionPrefix));
    };

    clearGitHistoryCache(root);
    clearFileCacheForRoot(root);
    void clearCachedSessionsForRoot(root);

    delete boundSessionByRootRef.current[root];
    delete suppressedAutoBindSessionByRootRef.current[root];
    delete drawerSessionByRootRef.current[root];
    delete selectedSessionByRootRef.current[root];
    delete mainViewPreferenceByRootRef.current[root];
    delete drawerOpenByRootRef.current[root];
    delete pluginsLoadedByRootRef.current[root];
    delete pluginsLoadingByRootRef.current[root];
    delete pluginsTrustPendingByRootRef.current[root];

    deleteSessionRecordKeys(sessionCacheRef.current);
    deleteSessionRecordKeys(loadedSessionRef.current);
    deleteSessionRecordKeys(loadingSessionRef.current);
    deleteSessionRecordKeys(pendingBySessionRef.current);
    deleteSessionRecordKeys(queuedMessagesBySessionRef.current);
    deleteSessionRecordKeys(queueFrozenBySessionRef.current);
    deleteSessionRecordKeys(cancelRequestedBySessionRef.current);
    deleteSessionRecordKeys(pendingRequestRef.current);
    deleteRecordKeys(optimisticDequeuedIdsRef.current, (key) => key.startsWith(sessionPrefix));
    staleSessionKeysRef.current = new Set(
      Array.from(staleSessionKeysRef.current).filter((key) => !key.startsWith(sessionPrefix)),
    );

    deleteRecordKeys(entriesByPathRef.current, (key) => key === root || key.startsWith(treePrefix));
    setEntriesByPath((prev) => {
      const next = { ...prev };
      deleteRecordKeys(next, (key) => key === root || key.startsWith(treePrefix));
      return next;
    });
    invalidTreeCacheKeysRef.current = new Set(
      Array.from(invalidTreeCacheKeysRef.current).filter(
        (key) => key !== root && !key.startsWith(treePrefix),
      ),
    );

    setGitStatusExpandedByRoot((prev) => {
      if (!(root in prev)) return prev;
      const next = { ...prev };
      delete next[root];
      return next;
    });
    setGitHistoryExpandedByRoot((prev) => {
      if (!(root in prev)) return prev;
      const next = { ...prev };
      delete next[root];
      return next;
    });
    setMainContentViewByRoot((prev) => {
      if (!(root in prev)) return prev;
      const next = { ...prev };
      delete next[root];
      return next;
    });
    setDirectorySortOverrides((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        if (key === root || key.startsWith(treePrefix)) {
          delete next[key];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setMultiProjectPendingByKey((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        if (key.startsWith(sessionPrefix)) {
          delete next[key];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setMultiProjectSessionGroups((prev) => {
      const next = prev.filter((group) => group.rootId !== root);
      return next.length === prev.length ? prev : next;
    });
    multiProjectPendingRef.current = Object.fromEntries(
      Object.entries(multiProjectPendingRef.current).filter(([key]) => !key.startsWith(sessionPrefix)),
    );
    setSlashCommandResults((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        if (key.startsWith(sessionPrefix)) {
          delete next[key];
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    deleteRecordKeys(fileScrollPositionsRef.current, (key) => key.startsWith(sessionPrefix));
    persistFileScrollPositions(fileScrollPositionsRef.current);
    removeLocalStorageByPrefix(`${PLUGIN_QUERY_STORAGE_PREFIX}${root}:`);
    if (
      options?.removeLastRoot === true &&
      typeof window !== "undefined" &&
      window.localStorage.getItem(LAST_ROOT_STORAGE_KEY) === root
    ) {
      window.localStorage.removeItem(LAST_ROOT_STORAGE_KEY);
    }

    bumpCacheVersion();
    setQueueVersion((value) => value + 1);
  }, [bumpCacheVersion]);
  const clearSlashCommandResultForSession = useCallback(
    (rootID: string, sessionKey: string) => {
      const key = rootSessionKey(rootID, sessionKey);
      setSlashCommandResults((prev) => {
        if (!prev[key]) {
          return prev;
        }
        const next = { ...prev };
        delete next[key];
        return next;
      });
    },
    [rootSessionKey],
  );
  const applyPendingToMultiProjectGroups = useCallback(
    (groups: MultiProjectSessionGroup[], pendingByKey: Record<string, boolean>) =>
      groups.map((group) => ({
        ...group,
        sessions: group.sessions.map((session) => ({
          ...(session as any),
          pending: !!pendingByKey[rootSessionKey(group.rootId, session.key || session.session_key)],
        }) as SessionItem),
      })),
    [rootSessionKey],
  );
  const setMultiProjectSessionPending = useCallback(
    (rootID: string | null | undefined, sessionKey: string | null | undefined, pending: boolean) => {
      const resolvedRoot = String(rootID || "");
      const resolvedKey = String(sessionKey || "");
      if (!resolvedRoot || !resolvedKey) {
        return;
      }
      const key = rootSessionKey(resolvedRoot, resolvedKey);
      setMultiProjectPendingByKey((prev) => {
        const next = { ...prev };
        if (pending) {
          next[key] = true;
        } else {
          delete next[key];
        }
        multiProjectPendingRef.current = next;
        setMultiProjectSessionGroups((groups) => applyPendingToMultiProjectGroups(groups, next));
        return next;
      });
    },
    [applyPendingToMultiProjectGroups, rootSessionKey],
  );
  const resolveRootForSessionKey = useCallback(
    (sessionKey: string): string | null => {
      if (!sessionKey) return null;
      const currentRoot = currentRootIdRef.current;
      if (
        currentRoot &&
        sessionCacheRef.current[rootSessionKey(currentRoot, sessionKey)]
      ) {
        return currentRoot;
      }
      for (const [rootID, key] of Object.entries(
        boundSessionByRootRef.current,
      )) {
        if (key === sessionKey) {
          return rootID;
        }
      }
      for (const [rootID, session] of Object.entries(
        drawerSessionByRootRef.current,
      )) {
        if (session?.key === sessionKey) {
          return rootID;
        }
      }
      const suffix = `::${sessionKey}`;
      const matched = Object.keys(sessionCacheRef.current).find((key) =>
        key.endsWith(suffix),
      );
      if (!matched) return null;
      return matched.slice(0, matched.length - suffix.length);
    },
    [rootSessionKey],
  );
  const getSessionSnapshot = useCallback(
    (
      rootId: string | null | undefined,
      session: Session | SessionItem | null | undefined,
    ) => {
      if (!rootId || !session) return null;
      const key = (session as any).key || (session as any).session_key;
      if (!key) return null;
      const ck = rootSessionKey(rootId, key);
      const cached = sessionCacheRef.current[ck];
      const drawerSession = drawerSessionByRootRef.current[rootId];
      const fallbackExchanges = Array.isArray((session as any).exchanges)
        ? ((session as any).exchanges as Exchange[])
        : [];
      const exchanges = Array.isArray((cached as any)?.exchanges)
        ? ((cached as any).exchanges as Exchange[]) || []
        : fallbackExchanges;
      const pending =
        drawerSession?.key === key
          ? !!(drawerSession as any)?.pending
          : typeof (session as any)?.pending === "boolean"
            ? !!(session as any).pending
            : typeof (cached as any)?.pending === "boolean"
              ? !!(cached as any).pending
              : undefined;
      return {
        ...(session as any),
        ...(cached as any),
        ...(drawerSession?.key === key ? (drawerSession as any) : null),
        key,
        search_seq: (session as any).search_seq,
        search_target_id: (session as any).search_target_id,
        search_snippet: (session as any).search_snippet,
        search_match_type: (session as any).search_match_type,
        exchanges,
        pending,
      } as any;
    },
    [rootSessionKey, cacheVersion],
  );

  const setSelectedPendingByKey = useCallback(
    (sessionKey: string, pending: boolean) => {
      setSelectedSession((prev) => {
        const prevKey = prev?.key || prev?.session_key;
        if (!prev || prevKey !== sessionKey) return prev;
        return { ...(prev as any), pending } as SessionItem;
      });
    },
    [],
  );

  const resolvePendingForSession = useCallback(
    (
      rootID: string | null | undefined,
      sessionKey: string | null | undefined,
      fallback?: boolean,
    ): boolean => {
      const resolvedRoot = String(rootID || "");
      const resolvedKey = String(sessionKey || "");
      if (!resolvedRoot || !resolvedKey) {
        return !!fallback;
      }
      const cacheKey = rootSessionKey(resolvedRoot, resolvedKey);
      if (pendingBySessionRef.current[cacheKey]) {
        return true;
      }
      const drawer = drawerSessionByRootRef.current[resolvedRoot] as
        | ({ pending?: boolean; key?: string; session_key?: string } & Record<string, unknown>)
        | null
        | undefined;
      if (
        drawer &&
        (drawer.key || drawer.session_key) === resolvedKey &&
        typeof drawer.pending === "boolean"
      ) {
        return drawer.pending;
      }
      const selected = selectedSessionRef.current as
        | ({ pending?: boolean; key?: string; session_key?: string; root_id?: string } & Record<string, unknown>)
        | null
        | undefined;
      if (
        selected &&
        ((selected.root_id as string | undefined) || currentRootIdRef.current) ===
          resolvedRoot &&
        (selected.key || selected.session_key) === resolvedKey &&
        typeof selected.pending === "boolean"
      ) {
        return selected.pending;
      }
      const cached = sessionCacheRef.current[cacheKey] as
        | ({ pending?: boolean } & Record<string, unknown>)
        | null
        | undefined;
      if (cached && typeof cached.pending === "boolean") {
        return cached.pending;
      }
      return !!fallback;
    },
    [rootSessionKey],
  );

  const clearLocalPendingForSession = useCallback(
    (rootID: string | null | undefined, sessionKey: string | null | undefined) => {
      const resolvedRoot = String(rootID || "");
      const resolvedKey = String(sessionKey || "");
      if (!resolvedRoot || !resolvedKey) {
        return;
      }
      const clearPendingAck = <T,>(session: T): T => {
        const exchanges = (session as any)?.exchanges;
        if (!Array.isArray(exchanges)) {
          return session;
        }
        return {
          ...(session as any),
          exchanges: exchanges.map((exchange: any) =>
            exchange?.pending_ack === true
              ? { ...exchange, pending_ack: false }
              : exchange,
          ),
        } as T;
      };
      const cacheKey = rootSessionKey(resolvedRoot, resolvedKey);
      delete pendingBySessionRef.current[cacheKey];
      const cached = sessionCacheRef.current[cacheKey];
      if (cached && (cached.key || (cached as any).session_key) === resolvedKey) {
        sessionCacheRef.current[cacheKey] = clearPendingAck({
          ...(cached as any),
          pending: false,
        } as Session);
      }
      setSelectedSession((prev) => {
        const prevKey = prev?.key || prev?.session_key;
        const prevRoot =
          (prev?.root_id as string | undefined) || currentRootIdRef.current;
        if (!prev || prevKey !== resolvedKey || prevRoot !== resolvedRoot) {
          return prev;
        }
        return clearPendingAck({
          ...(prev as any),
          pending: false,
        } as SessionItem);
      });
      const drawer = drawerSessionByRootRef.current[resolvedRoot];
      if (drawer && (drawer.key || (drawer as any).session_key) === resolvedKey) {
        setDrawerSessionForRoot(resolvedRoot, clearPendingAck({
          ...(drawer as any),
          pending: false,
        } as Session));
      }
      if (currentRootIdRef.current === resolvedRoot) {
        setSessions((prev) =>
          prev.map((item) => {
            const itemKey = item.key || item.session_key;
            if (itemKey !== resolvedKey) {
              return item;
            }
            return clearPendingAck({
              ...(item as any),
              pending: false,
            } as SessionItem);
          }),
        );
      }
      setMultiProjectSessionPending(resolvedRoot, resolvedKey, false);
      bumpCacheVersion();
    },
    [bumpCacheVersion, rootSessionKey, setDrawerSessionForRoot, setMultiProjectSessionPending],
  );

  const markSessionStale = useCallback(
    (rootID: string | null | undefined, sessionKey: string | null | undefined) => {
      const resolvedRoot = String(rootID || "");
      const resolvedKey = String(sessionKey || "");
      if (!resolvedRoot || !resolvedKey || resolvedKey.startsWith("pending-")) {
        return;
      }
      staleSessionKeysRef.current.add(rootSessionKey(resolvedRoot, resolvedKey));
    },
    [rootSessionKey],
  );

  const clearSessionStale = useCallback(
    (rootID: string | null | undefined, sessionKey: string | null | undefined) => {
      const resolvedRoot = String(rootID || "");
      const resolvedKey = String(sessionKey || "");
      if (!resolvedRoot || !resolvedKey) {
        return;
      }
      staleSessionKeysRef.current.delete(rootSessionKey(resolvedRoot, resolvedKey));
    },
    [rootSessionKey],
  );

  const isSessionStale = useCallback(
    (rootID: string | null | undefined, sessionKey: string | null | undefined): boolean => {
      const resolvedRoot = String(rootID || "");
      const resolvedKey = String(sessionKey || "");
      if (!resolvedRoot || !resolvedKey) {
        return false;
      }
      return staleSessionKeysRef.current.has(rootSessionKey(resolvedRoot, resolvedKey));
    },
    [rootSessionKey],
  );

  const restoreActiveSession = useCallback(
    async (
      rootID: string | null | undefined,
      sessionKey: string | null | undefined,
    ): Promise<Session | null> => {
      const resolvedRoot = String(rootID || "");
      const resolvedKey = String(sessionKey || "");
      if (!resolvedRoot || !resolvedKey || resolvedKey.startsWith("pending-")) {
        return null;
      }
      const cacheKey = rootSessionKey(resolvedRoot, resolvedKey);
      const inflight = loadingSessionRef.current[cacheKey];
      const request =
        inflight ||
        syncSession(resolvedRoot, resolvedKey).finally(() => {
          delete loadingSessionRef.current[cacheKey];
        });
      if (!inflight) {
        loadingSessionRef.current[cacheKey] = request;
      }
      const syncResult = await request;
      const fullSession = syncResult?.session;
      if (!fullSession) {
        return null;
      }
      const serverPending =
        typeof (fullSession as any)?.pending === "boolean"
          ? !!(fullSession as any).pending
          : undefined;
      if (serverPending === false) {
        clearLocalPendingForSession(resolvedRoot, resolvedKey);
      }
      const pending =
        serverPending === false
          ? false
          : resolvePendingForSession(resolvedRoot, resolvedKey, !!serverPending);
      sessionCacheRef.current[cacheKey] = {
        ...(fullSession as any),
        key: resolvedKey,
        pending,
      } as Session;
      bumpCacheVersion();
      await sessionService.markSessionReady(resolvedRoot, resolvedKey);
      return {
        ...(fullSession as any),
        key: resolvedKey,
        pending,
      } as Session;
    },
    [bumpCacheVersion, clearLocalPendingForSession, resolvePendingForSession, rootSessionKey],
  );

  const updateSessionRelatedFilesForKey = useCallback(
    (rootID: string, sessionKey: string, relatedFiles: RelatedFile[]) => {
      if (!rootID || !sessionKey) return;
      const cacheKey = rootSessionKey(rootID, sessionKey);
      const cached = sessionCacheRef.current[cacheKey];
      const nextRelatedFiles = Array.isArray(relatedFiles)
        ? [...relatedFiles]
        : [];
      if (cached) {
        sessionCacheRef.current[cacheKey] = {
          ...(cached as any),
          related_files: nextRelatedFiles,
        } as Session;
      }
      const lastMain = lastMainSessionSnapshotRef.current;
      const lastMainKey = lastMain?.key || lastMain?.session_key;
      const lastMainRoot =
        (lastMain?.root_id as string | undefined) || currentRootIdRef.current;
      if (lastMain && lastMainKey === sessionKey && lastMainRoot === rootID) {
        lastMainSessionSnapshotRef.current = {
          ...(lastMain as any),
          related_files: nextRelatedFiles,
        } as Session;
      }
      setSelectedSession((prev) => {
        const prevKey = prev?.key || prev?.session_key;
        const prevRoot =
          (prev?.root_id as string | undefined) || currentRootIdRef.current;
        if (!prev || prevKey !== sessionKey || prevRoot !== rootID) return prev;
        return {
          ...(prev as any),
          related_files: nextRelatedFiles,
        } as SessionItem;
      });
      const current = drawerSessionByRootRef.current[rootID];
      if (current && current.key === sessionKey) {
        setDrawerSessionForRoot(rootID, {
          ...(current as any),
          related_files: nextRelatedFiles,
        } as Session);
      }
      bumpCacheVersion();
    },
    [rootSessionKey, setDrawerSessionForRoot, bumpCacheVersion],
  );

  const updateSessionRelatedWorktreeForKey = useCallback(
    (rootID: string, sessionKey: string, relatedWorktree: RelatedWorktree | null | undefined) => {
      if (!rootID || !sessionKey || !relatedWorktree) return;
      const cacheKey = rootSessionKey(rootID, sessionKey);
      const cached = sessionCacheRef.current[cacheKey];
      if (cached) {
        sessionCacheRef.current[cacheKey] = {
          ...(cached as any),
          related_worktree: relatedWorktree,
        } as Session;
      }

      const lastMain = lastMainSessionSnapshotRef.current;
      const lastMainKey = lastMain?.key || lastMain?.session_key;
      const lastMainRoot =
        (lastMain?.root_id as string | undefined) || currentRootIdRef.current;
      if (lastMain && lastMainKey === sessionKey && lastMainRoot === rootID) {
        lastMainSessionSnapshotRef.current = {
          ...(lastMain as any),
          related_worktree: relatedWorktree,
        } as Session;
      }

      setSelectedSession((prev) => {
        const prevKey = prev?.key || prev?.session_key;
        const prevRoot =
          (prev?.root_id as string | undefined) || currentRootIdRef.current;
        if (!prev || prevKey !== sessionKey || prevRoot !== rootID) return prev;
        return {
          ...(prev as any),
          related_worktree: relatedWorktree,
        } as SessionItem;
      });

      const current = drawerSessionByRootRef.current[rootID];
      if (current && current.key === sessionKey) {
        setDrawerSessionForRoot(rootID, {
          ...(current as any),
          related_worktree: relatedWorktree,
        } as Session);
      }
      bumpCacheVersion();
    },
    [rootSessionKey, setDrawerSessionForRoot, bumpCacheVersion],
  );

  const updateSessionAgentForKey = useCallback(
    (
      rootID: string,
      sessionKey: string,
      agent: string,
      model?: string,
      agentMode?: string,
      effort?: string,
      fastService?: "" | "on" | "off",
      planMode?: boolean,
      shell?: string,
    ) => {
      if (!rootID || !sessionKey || !agent) return;
      const hasPlanMode = typeof planMode === "boolean";
      const cacheKey = rootSessionKey(rootID, sessionKey);
      const cached = sessionCacheRef.current[cacheKey];
      if (cached) {
        sessionCacheRef.current[cacheKey] = {
          ...(cached as any),
          agent,
          model: model || "",
          mode: agentMode || "",
          effort: effort || "",
          fast_service: fastService || "",
          ...(hasPlanMode ? { plan_mode: planMode } : {}),
          updated_at: new Date().toISOString(),
        } as Session;
      }
      setSelectedSession((prev) => {
        const prevKey = prev?.key || prev?.session_key;
        const prevRoot =
          (prev?.root_id as string | undefined) || currentRootIdRef.current;
        if (!prev || prevKey !== sessionKey || prevRoot !== rootID) return prev;
        return {
          ...(prev as any),
          agent,
          model: model || "",
          mode: agentMode || "",
          effort: effort || "",
          fast_service: fastService || "",
          ...(hasPlanMode ? { plan_mode: planMode } : {}),
        } as SessionItem;
      });
      const current = drawerSessionByRootRef.current[rootID];
      if (
        current &&
        current.key === sessionKey &&
        (current.agent !== agent ||
          (current as any).model !== (model || "") ||
          (current as any).mode !== (agentMode || "") ||
          (current as any).effort !== (effort || "") ||
          ((current as any).fast_service || "") !== (fastService || "") ||
          (hasPlanMode && !!(current as any).plan_mode !== planMode))
      ) {
        setDrawerSessionForRoot(rootID, {
          ...(current as any),
          agent,
          model: model || "",
          mode: agentMode || "",
          effort: effort || "",
          fast_service: fastService || "",
          ...(hasPlanMode ? { plan_mode: planMode } : {}),
        } as Session);
      }
      bumpCacheVersion();
    },
    [rootSessionKey, setDrawerSessionForRoot, bumpCacheVersion],
  );

  const syncSessionHeaderFromListItem = useCallback(
    (rootID: string, item: SessionItem | null | undefined) => {
      const sessionKey = item?.key || item?.session_key || "";
      const sessionName = typeof item?.name === "string" ? item.name : "";
      if (!rootID || !sessionKey || !sessionName) return;

      const cacheKey = rootSessionKey(rootID, sessionKey);
      const cached = sessionCacheRef.current[cacheKey];
      let changed = false;
      if (cached && cached.name !== sessionName) {
        sessionCacheRef.current[cacheKey] = {
          ...(cached as any),
          name: sessionName,
          updated_at: item?.updated_at || cached.updated_at,
        } as Session;
        changed = true;
      }

      setSelectedSession((prev) => {
        const prevKey = prev?.key || prev?.session_key;
        const prevRoot =
          (prev?.root_id as string | undefined) || currentRootIdRef.current;
        if (!prev || prevKey !== sessionKey || prevRoot !== rootID) return prev;
        if (prev.name === sessionName) return prev;
        return {
          ...(prev as any),
          name: sessionName,
          updated_at: item?.updated_at || prev.updated_at,
        } as SessionItem;
      });

      const drawer = drawerSessionByRootRef.current[rootID];
      if (drawer?.key === sessionKey && drawer.name !== sessionName) {
        setDrawerSessionForRoot(rootID, {
          ...(drawer as any),
          name: sessionName,
          updated_at: item?.updated_at || drawer.updated_at,
        } as Session);
        changed = true;
      }

      if (changed) {
        bumpCacheVersion();
      }
    },
    [rootSessionKey, setDrawerSessionForRoot, bumpCacheVersion],
  );
  useEffect(() => {
    const rootID = currentRootIdRef.current;
    if (!rootID || sessions.length === 0) return;
    for (const item of sessions) {
      syncSessionHeaderFromListItem(rootID, item);
    }
  }, [sessions, syncSessionHeaderFromListItem]);

  const handleSetPlanMode = useCallback(
    async (enabled: boolean, targetSessionKey?: string, targetRootId?: string) => {
      const activeRoot = targetRootId || currentRootIdRef.current;
      const session = currentSessionRef.current || drawerSessionByRootRef.current[activeRoot || ""];
      const sessionKey = targetSessionKey || session?.key || (session as any)?.session_key;
      if (!activeRoot) {
        reportError("session.sync_failed", t("session.planModeSelectFirst"));
        return;
      }
      if (!sessionKey || String(sessionKey).startsWith("pending-")) {
        setPendingPlanMode(enabled);
        return;
      }
      const now = new Date().toISOString();
      const cacheKey = rootSessionKey(activeRoot, sessionKey);
      const cached = sessionCacheRef.current[cacheKey];
      if (cached) {
        sessionCacheRef.current[cacheKey] = {
          ...(cached as any),
          plan_mode: enabled,
          updated_at: now,
        } as Session;
      }
      setSelectedSession((prev) => {
        const prevKey = prev?.key || prev?.session_key;
        const prevRoot = (prev?.root_id as string | undefined) || activeRoot;
        if (!prev || prevKey !== sessionKey || prevRoot !== activeRoot) return prev;
        return { ...(prev as any), plan_mode: enabled, updated_at: now } as SessionItem;
      });
      const drawer = drawerSessionByRootRef.current[activeRoot];
      if (drawer?.key === sessionKey) {
        setDrawerSessionForRoot(activeRoot, {
          ...(drawer as any),
          plan_mode: enabled,
          updated_at: now,
        } as Session);
      }
      bumpCacheVersion();
      const sent = await sessionService.setPlanMode(activeRoot, sessionKey, enabled);
      if (!sent) {
        reportError("network.disconnected", t("session.planModeSwitchFailedNotReady"));
      }
    },
    [rootSessionKey, setDrawerSessionForRoot, bumpCacheVersion, t],
  );

  const promotePendingSessionForRoot = useCallback(
    (
      rootID: string,
      tempKey: string | undefined,
      sessionKey: string,
      fallback?: Session | null,
    ) => {
      const pendingKey = (tempKey || "").trim();
      if (!rootID || !pendingKey || !sessionKey || pendingKey === sessionKey) {
        return;
      }

      const pendingCacheKey = rootSessionKey(rootID, pendingKey);
      const realCacheKey = rootSessionKey(rootID, sessionKey);
      const pendingCached = sessionCacheRef.current[pendingCacheKey];
      const realCached = sessionCacheRef.current[realCacheKey];
      const drawer = drawerSessionByRootRef.current[rootID];
      const selected = selectedSessionRef.current;
      const selectedKey = selected?.key || selected?.session_key;
      const selectedRoot =
        (selected?.root_id as string | undefined) || currentRootIdRef.current;
      const pendingName =
        (typeof (pendingCached as any)?.name === "string" &&
        (pendingCached as any).name
          ? (pendingCached as any).name
          : "") ||
        (drawer?.key === pendingKey && typeof (drawer as any)?.name === "string"
          ? ((drawer as any).name as string)
          : "") ||
        (selectedKey === pendingKey &&
        selectedRoot === rootID &&
        typeof selected?.name === "string"
          ? selected.name
          : "") ||
        t("session.new");
      const realExchanges = Array.isArray((realCached as any)?.exchanges)
        ? ((realCached as any).exchanges as Exchange[])
        : [];
      const pendingExchanges = Array.isArray((pendingCached as any)?.exchanges)
        ? ((pendingCached as any).exchanges as Exchange[])
        : [];
      const latestReal =
        pendingCached && realCached
          ? ({
              ...(pendingCached as any),
              ...(realCached as any),
              exchanges:
                realExchanges.length > 0 ? realExchanges : pendingExchanges,
            } as Session)
          : realCached || pendingCached || fallback || drawer;
      let cacheChanged = false;

      if (pendingCached) {
        sessionCacheRef.current[realCacheKey] = {
          ...(latestReal as any),
          key: sessionKey,
          name:
            (typeof (realCached as any)?.name === "string" &&
            (realCached as any).name
              ? (realCached as any).name
              : "") || pendingName,
        } as Session;
        delete sessionCacheRef.current[pendingCacheKey];
        delete loadedSessionRef.current[pendingCacheKey];
        delete loadingSessionRef.current[pendingCacheKey];
        cacheChanged = true;
      }

      if (boundSessionByRootRef.current[rootID] === pendingKey) {
        setBoundSessionForRoot(rootID, sessionKey);
      }
      if (selectedSessionByRootRef.current[rootID] === pendingKey) {
        selectedSessionByRootRef.current[rootID] = sessionKey;
      }
      if (drawer?.key === pendingKey) {
        setDrawerSessionForRoot(rootID, {
          ...(drawer as any),
          ...(latestReal as any),
          key: sessionKey,
          name:
            (typeof (latestReal as any)?.name === "string" &&
            (latestReal as any).name
              ? (latestReal as any).name
              : "") || pendingName,
        } as Session);
      }
      if (currentRootIdRef.current === rootID) {
        setSessions((prev) =>
          prev.map((item) => {
            const itemKey = item.key || item.session_key;
            if (itemKey !== pendingKey) {
              return item;
            }
            return {
              ...(item as any),
              ...(latestReal as any),
              key: sessionKey,
              session_key: sessionKey,
              root_id: rootID,
              name:
                (typeof (latestReal as any)?.name === "string" &&
                (latestReal as any).name
                  ? (latestReal as any).name
                  : "") || pendingName,
              pending: true,
            } as SessionItem;
          }),
        );
      }

      setSelectedSession((prev) => {
        const prevKey = prev?.key || prev?.session_key;
        const prevRoot =
          (prev?.root_id as string | undefined) || currentRootIdRef.current;
        if (!prev || prevKey !== pendingKey || prevRoot !== rootID) return prev;
        return toSessionItem(rootID, {
          ...(prev as any),
          ...(latestReal as any),
          key: sessionKey,
          session_key: sessionKey,
          root_id: rootID,
          name:
            (typeof (latestReal as any)?.name === "string" &&
            (latestReal as any).name
              ? (latestReal as any).name
              : "") || pendingName,
        });
      });

      if (cacheChanged) {
        bumpCacheVersion();
      }
    },
    [rootSessionKey, setBoundSessionForRoot, setDrawerSessionForRoot, bumpCacheVersion],
  );

  const resolveRuntimeMetaForSession = useCallback(
    (
      rootID: string,
      sessionKey: string,
      fallback?: {
        agent?: string;
        model?: string;
	        mode?: string;
	        effort?: string;
	        fast_service?: "" | "on" | "off";
	      },
    ) => {
      const cacheKey = rootSessionKey(rootID, sessionKey);
      const cachedSession = sessionCacheRef.current[cacheKey] as any;
      const exchanges = Array.isArray(cachedSession?.exchanges)
        ? ((cachedSession.exchanges || []) as Exchange[])
        : [];
      const latestMatchingExchange = [...exchanges]
        .reverse()
        .find(
          (item) =>
            item?.agent ||
	            item?.model ||
	            item?.mode ||
	            item?.effort ||
	            item?.fast_service,
        );
      const candidates = [
        fallback,
        latestMatchingExchange as any,
        sessionCacheRef.current[cacheKey] as any,
        currentSessionRef.current?.key === sessionKey
          ? (currentSessionRef.current as any)
          : null,
        (selectedSessionRef.current?.key ||
          selectedSessionRef.current?.session_key) === sessionKey
          ? (selectedSessionRef.current as any)
          : null,
      ];

      const pickText = (field: "agent" | "model" | "mode" | "effort") => {
        for (const item of candidates) {
          const value = `${item?.[field] || ""}`.trim();
          if (value) return value;
        }
        return "";
      };
      const pickFastService = (): "" | "on" | "off" => {
        for (const item of candidates) {
          const value = normalizeFastService(item?.fast_service);
          if (value) return value;
        }
        return "";
      };
	      return {
	        agent: pickText("agent"),
	        model: pickText("model"),
	        mode: pickText("mode"),
	        effort: pickText("effort"),
	        fast_service: pickFastService(),
	      };
    },
    [rootSessionKey],
  );

  const appendAgentChunkForSession = useCallback(
    (
      rootID: string,
      sessionKey: string,
      content: string,
      runtimeHint?: {
        agent?: string;
        model?: string;
	        mode?: string;
	        effort?: string;
	        fast_service?: "" | "on" | "off";
	      },
    ) => {
      if (!content) return;
      const now = new Date().toISOString();
      const cacheKey = rootSessionKey(rootID, sessionKey);
      const runtimeMeta = resolveRuntimeMetaForSession(
        rootID,
        sessionKey,
        runtimeHint,
      );
      const updateList = (prevList: Exchange[]) => {
        const list = [...(prevList || [])];
        const last = list.length > 0 ? list[list.length - 1] : null;
        if (last && (last.role === "agent" || last.role === "assistant")) {
          list[list.length - 1] = {
            ...last,
            agent: runtimeMeta.agent || last.agent,
            model: runtimeMeta.model || last.model,
	            mode: runtimeMeta.mode || last.mode,
	            effort: runtimeMeta.effort || last.effort,
	            fast_service: runtimeMeta.fast_service || last.fast_service,
	            content: `${last.content || ""}${content}`,
            timestamp: now,
          };
          return list;
        }
        list.push({
          role: "agent",
          agent: runtimeMeta.agent,
          model: runtimeMeta.model,
	          mode: runtimeMeta.mode,
	          effort: runtimeMeta.effort,
	          fast_service: runtimeMeta.fast_service,
	          content,
          timestamp: now,
        });
        return list;
      };
      const cached = sessionCacheRef.current[cacheKey];
      const base =
        cached ||
        ({
          key: sessionKey,
          type: "chat",
          agent: runtimeMeta.agent,
          model: runtimeMeta.model,
	          mode: runtimeMeta.mode,
	          effort: runtimeMeta.effort,
	          fast_service: runtimeMeta.fast_service,
	          name: "",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          exchanges: [],
        } as any);
      const nextList = updateList(
        ((base as any).exchanges || []) as Exchange[],
      );
      sessionCacheRef.current[cacheKey] = {
        ...(base as any),
        agent: runtimeMeta.agent || (base as any).agent,
        model: runtimeMeta.model || (base as any).model,
	        mode: runtimeMeta.mode || (base as any).mode,
	        effort: runtimeMeta.effort || (base as any).effort,
	        fast_service: runtimeMeta.fast_service || (base as any).fast_service,
	        exchanges: nextList,
        updated_at: new Date().toISOString(),
      } as Session;
      bumpCacheVersion();
    },
    [rootSessionKey, resolveRuntimeMetaForSession, bumpCacheVersion],
  );

  const appendThoughtChunkForSession = useCallback(
    (rootID: string, sessionKey: string, content: string, thoughtID?: string) => {
      if (!content) return;
      const now = new Date().toISOString();
      const cacheKey = rootSessionKey(rootID, sessionKey);
      const updateList = (prevList: Exchange[]) => {
        const list = [...(prevList || [])];
        if (thoughtID) {
          const existingIndex = list.findIndex(
            (item) => item.role === "thought" && item.thought_id === thoughtID,
          );
          if (existingIndex >= 0) {
            const existing = list[existingIndex];
            const existingContent = existing.content || "";
            let nextContent = existingContent;
            if (content.includes(existingContent)) {
              nextContent = content;
            } else if (!existingContent.includes(content)) {
              nextContent = `${existingContent}${content}`;
            }
            list[existingIndex] = {
              ...existing,
              content: nextContent,
              timestamp: now,
            };
            return list;
          }
        }
        const last = list.length > 0 ? list[list.length - 1] : null;
        if (last && last.role === "thought" && (!thoughtID || !last.thought_id)) {
          list[list.length - 1] = {
            ...last,
            content: `${last.content || ""}${content}`,
            thought_id: thoughtID || last.thought_id,
            timestamp: now,
          };
          return list;
        }
        list.push({ role: "thought", content, thought_id: thoughtID, timestamp: now });
        return list;
      };
      const cached = sessionCacheRef.current[cacheKey];
      const base =
        cached ||
        ({
          key: sessionKey,
          type: "chat",
          agent: "",
          name: "",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          exchanges: [],
        } as any);
      const nextList = updateList(
        ((base as any).exchanges || []) as Exchange[],
      );
      sessionCacheRef.current[cacheKey] = {
        ...(base as any),
        exchanges: nextList,
        updated_at: new Date().toISOString(),
      } as Session;
      bumpCacheVersion();
    },
    [rootSessionKey, bumpCacheVersion],
  );

  const appendToolCallForSession = useCallback(
    (rootID: string, sessionKey: string, toolCall: any, update: boolean) => {
      if (!toolCall) return;
      const now = new Date().toISOString();
      const cacheKey = rootSessionKey(rootID, sessionKey);
      const mergeToolCall = (existing: any, incoming: any) => {
        const merged = { ...(existing || {}), ...incoming };
        const incomingMeta = (incoming?.meta || {}) as Record<string, unknown>;
        if (existing?.meta || incoming?.meta) {
          merged.meta = { ...(existing?.meta || {}), ...incomingMeta };
        }
        const isUserShellStream =
          incomingMeta.source === "userShell" && incomingMeta.phase === "stream";
        if (isUserShellStream) {
          const mergedContent = [
            ...((existing?.content || []) as any[]),
            ...((incoming?.content || []) as any[]),
          ];
          const totalText = mergedContent.map((item) => item?.text || "").join("");
          if (totalText.length > 256 * 1024) {
            merged.content = [{ type: "text", text: totalText.slice(-256 * 1024) }];
          } else {
            merged.content = mergedContent;
          }
          merged.meta = { ...(existing?.meta || {}), ...incomingMeta };
        }
        if (!incoming.kind && existing?.kind) merged.kind = existing.kind;
        if (!incoming.title && existing?.title) merged.title = existing.title;
        const existingStatus = `${existing?.status || ""}`.toLowerCase();
        const incomingStatus = `${incoming?.status || ""}`.toLowerCase();
        if (
          (existingStatus === "failed" ||
            existingStatus === "error" ||
            existingStatus === "complete" ||
            existingStatus === "success") &&
          (incomingStatus === "running" ||
            incomingStatus === "pending" ||
            incomingStatus === "in_progress")
        ) {
          merged.status = existing.status;
        }
        return merged;
      };
      const updateList = (prevList: Exchange[]) => {
        const list = [...(prevList || [])];
        const callId =
          toolCall.callId || toolCall.toolCallId || toolCall.tool_call_id || "";
        if (callId) {
          for (let i = list.length - 1; i >= 0; i--) {
            if (
              list[i]?.role === "tool" &&
              (list[i]?.toolCall?.callId === callId ||
                list[i]?.toolCall?.toolCallId === callId ||
                list[i]?.toolCall?.tool_call_id === callId)
            ) {
              list[i] = {
                ...list[i],
                timestamp: now,
                toolCall: mergeToolCall(list[i].toolCall, toolCall),
              };
              return list;
            }
          }
        }
        list.push({ role: "tool", content: "", timestamp: now, toolCall });
        return list;
      };
      const cached = sessionCacheRef.current[cacheKey];
      const base =
        cached ||
        ({
          key: sessionKey,
          type: "chat",
          agent: "",
          name: "",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          exchanges: [],
        } as any);
      const nextList = updateList(
        ((base as any).exchanges || []) as Exchange[],
      );
      sessionCacheRef.current[cacheKey] = {
        ...(base as any),
        exchanges: nextList,
        updated_at: new Date().toISOString(),
      } as Session;
      bumpCacheVersion();
    },
    [rootSessionKey, bumpCacheVersion],
  );

  const appendTodoUpdateForSession = useCallback(
    (rootID: string, sessionKey: string, todoUpdate: any) => {
      if (!todoUpdate) return;
      const now = new Date().toISOString();
      const cacheKey = rootSessionKey(rootID, sessionKey);
      const updateList = (prevList: Exchange[]) => {
        const list = [...(prevList || [])];
        for (let i = list.length - 1; i >= 0; i -= 1) {
          if (list[i]?.role !== "todo") continue;
          list[i] = {
            ...list[i],
            timestamp: now,
            todoUpdate,
          };
          return list;
        }
        list.push({ role: "todo", content: "", timestamp: now, todoUpdate });
        return list;
      };
      const cached = sessionCacheRef.current[cacheKey];
      const base =
        cached ||
        ({
          key: sessionKey,
          type: "chat",
          agent: "",
          name: "",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          exchanges: [],
        } as any);
      const nextList = updateList(
        ((base as any).exchanges || []) as Exchange[],
      );
      sessionCacheRef.current[cacheKey] = {
        ...(base as any),
        exchanges: nextList,
        updated_at: new Date().toISOString(),
      } as Session;
      bumpCacheVersion();
    },
    [rootSessionKey, bumpCacheVersion],
  );

  const appendPlanUpdateForSession = useCallback(
    (rootID: string, sessionKey: string, planUpdate: any) => {
      if (!planUpdate) return;
      const content = `${planUpdate.content || ""}`;
      if (!content) return;
      const now = new Date().toISOString();
      const cacheKey = rootSessionKey(rootID, sessionKey);
      const updateList = (prevList: Exchange[]) => {
        const list = [...(prevList || [])];
        const planId = `${planUpdate.id || ""}`;
        if (planId) {
          for (let i = list.length - 1; i >= 0; i -= 1) {
            if (list[i]?.role !== "plan") continue;
            if (`${list[i]?.planUpdate?.id || ""}` !== planId) continue;
            const existingContent = `${list[i].planUpdate?.content || ""}`;
            const nextContent = planUpdate.delta
              ? `${existingContent}${content}`
              : content;
            list[i] = {
              ...list[i],
              timestamp: now,
              planUpdate: { ...list[i].planUpdate, ...planUpdate, content: nextContent },
            };
            return list;
          }
        }
        const last = list.length > 0 ? list[list.length - 1] : null;
        if (last?.role === "plan" && !planId) {
          const existingContent = `${last.planUpdate?.content || ""}`;
          list[list.length - 1] = {
            ...last,
            timestamp: now,
            planUpdate: {
              ...last.planUpdate,
              ...planUpdate,
              content: planUpdate.delta ? `${existingContent}${content}` : content,
            },
          };
          return list;
        }
        list.push({ role: "plan", content: "", timestamp: now, planUpdate });
        return list;
      };
      const cached = sessionCacheRef.current[cacheKey];
      const base =
        cached ||
        ({
          key: sessionKey,
          type: "chat",
          agent: "",
          name: "",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          exchanges: [],
        } as any);
      sessionCacheRef.current[cacheKey] = {
        ...(base as any),
        exchanges: updateList(((base as any).exchanges || []) as Exchange[]),
        updated_at: new Date().toISOString(),
      } as Session;
      bumpCacheVersion();
    },
    [rootSessionKey, bumpCacheVersion],
  );

  const appendCompactNoticeForSession = useCallback(
    (rootID: string, sessionKey: string, compactNotice: any) => {
      if (!compactNotice) return;
      const now = new Date().toISOString();
      const cacheKey = rootSessionKey(rootID, sessionKey);
      const updateList = (prevList: Exchange[]) => {
        const list = [...(prevList || [])];
        const compactId = `${compactNotice.id || ""}`;
        if (compactId) {
          for (let i = list.length - 1; i >= 0; i -= 1) {
            if (list[i]?.role !== "compact") continue;
            if (`${list[i]?.compactNotice?.id || ""}` !== compactId) continue;
            list[i] = {
              ...list[i],
              timestamp: now,
              compactNotice: { ...list[i].compactNotice, ...compactNotice },
            };
            return list;
          }
        }
        list.push({ role: "compact", content: "", timestamp: now, compactNotice });
        return list;
      };
      const cached = sessionCacheRef.current[cacheKey];
      const base =
        cached ||
        ({
          key: sessionKey,
          type: "chat",
          agent: "",
          name: "",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          exchanges: [],
        } as any);
      sessionCacheRef.current[cacheKey] = {
        ...(base as any),
        exchanges: updateList(((base as any).exchanges || []) as Exchange[]),
        updated_at: new Date().toISOString(),
      } as Session;
      bumpCacheVersion();
    },
    [rootSessionKey, bumpCacheVersion],
  );

  const attachContextWindowToLatestAssistant = useCallback(
    (
      rootID: string,
      sessionKey: string,
      contextWindow?: { totalTokens?: number; modelContextWindow?: number },
    ) => {
      const totalTokens = Math.max(0, Number(contextWindow?.totalTokens || 0));
      const modelContextWindow = Math.max(0, Number(contextWindow?.modelContextWindow || 0));
      if (!totalTokens || !modelContextWindow) {
        return;
      }
      const cacheKey = rootSessionKey(rootID, sessionKey);
      const stampList = (prevList: Exchange[]) => {
        const list = [...(prevList || [])];
        for (let i = list.length - 1; i >= 0; i -= 1) {
          const item = list[i];
          if (
            (item?.role === "agent" || item?.role === "assistant") &&
            String(item?.content || "").trim()
          ) {
            list[i] = {
              ...item,
              context_window: {
                totalTokens,
                modelContextWindow,
              },
            };
            break;
          }
        }
        return list;
      };
      const cached = sessionCacheRef.current[cacheKey];
      if (cached) {
        const exchanges = stampList((((cached as any).exchanges || []) as Exchange[]));
        sessionCacheRef.current[cacheKey] = {
          ...(cached as any),
          exchanges,
          context_window: {
            totalTokens,
            modelContextWindow,
          },
          updated_at: new Date().toISOString(),
        } as Session;
      }
      setSelectedSession((prev) => {
        const prevRoot =
          (prev?.root_id as string | undefined) || currentRootIdRef.current;
        if (!prev || prevRoot !== rootID || (prev.key || prev.session_key) !== sessionKey) {
          return prev;
        }
        return {
          ...(prev as any),
          exchanges: stampList((((prev as any).exchanges || []) as Exchange[])),
          context_window: {
            totalTokens,
            modelContextWindow,
          },
        } as SessionItem;
      });
      const drawer = drawerSessionByRootRef.current[rootID];
      if (drawer && drawer.key === sessionKey) {
        setDrawerSessionForRoot(rootID, {
          ...(drawer as any),
          exchanges: stampList((((drawer as any).exchanges || []) as Exchange[])),
          context_window: {
            totalTokens,
            modelContextWindow,
          },
        } as Session);
      }
      bumpCacheVersion();
    },
    [bumpCacheVersion, rootSessionKey],
  );

  const normalizeTreeResponse = useCallback((payload: any) => {
    if (payload && payload.entries)
      return { entries: payload.entries as FileEntry[] };
    return { entries: [] };
  }, []);

  const formatDirectoryLoadError = useCallback((message?: string | null) => {
    const text = String(message || "").trim();
    if (!text) {
      return t("directory.readFailed");
    }
    const lower = text.toLowerCase();
    if (
      lower.includes("access is denied") ||
      lower.includes("permission denied") ||
      lower.includes("operation not permitted") ||
      lower.includes("拒绝访问") ||
      lower.includes("权限")
    ) {
      return t("directory.permissionDenied");
    }
    return text;
  }, [t]);

  const treeCacheKey = useCallback(
    (rootID: string, dirPath: string) => `${rootID}:${dirPath || "."}`,
    [],
  );

  const refreshTreeDir = useCallback(
    async (rootID: string, dirPath: string, syncMain: boolean) => {
      try {
        const payload = await apiProtectedJSON<any>(
          appURL("/api/tree", new URLSearchParams({ root: rootID, dir: dirPath })),
        );
        const parsed = normalizeTreeResponse(payload);
        invalidTreeCacheKeysRef.current.delete(treeCacheKey(rootID, dirPath));
        setMainDirectoryError("");
        setEntriesByPath((prev) => ({
          ...prev,
          [treeCacheKey(rootID, dirPath)]: parsed.entries,
        }));
        if (syncMain) {
          setMainEntries(parsed.entries);
        }
      } catch {}
    },
    [normalizeTreeResponse, treeCacheKey],
  );

  const refreshCurrentFileContent = useCallback(
    async (rootID: string, changedPath: string) => {
      const currentFile = fileRef.current;
      if (!currentFile) return;
      const currentRoot = currentFile.root || currentRootIdRef.current || "";
      if (currentRoot !== rootID || currentFile.path !== changedPath) return;

      let readMode: "incremental" | "full" = "incremental";
      if (!pluginBypassRef.current) {
        try {
          const plugin = pluginManagerRef.current.match(
            rootID,
            buildMatchInputFromPath(changedPath, pluginQueryRef.current),
          );
          readMode = inferReadModeFromPlugin(plugin);
        } catch {
          readMode = "incremental";
        }
      }

      try {
        const next = await fetchFile({
          rootId: rootID,
          path: changedPath,
          readMode,
          cursor: fileCursorRef.current || 0,
        });
        const latestFile = fileRef.current;
        const latestRoot = latestFile?.root || currentRootIdRef.current || "";
        if (
          !next ||
          !latestFile ||
          latestRoot !== rootID ||
          latestFile.path !== changedPath
        ) {
          return;
        }
        setFile({
          ...next,
          targetLine: latestFile.targetLine,
          targetColumn: latestFile.targetColumn,
        });
      } catch (err) {
        console.error("[file.refresh.changed] failed", {
          rootID,
          changedPath,
          err,
        });
      }
    },
    [],
  );

  const refreshGitStatus = useCallback(async (rootID: string) => {
    if (!rootID) {
      if (!currentRootIdRef.current) {
        setGitStatus(null);
        setGitStatusLoading(false);
      }
      return null;
    }
    const shouldApply = () => currentRootIdRef.current === rootID;
    if (managedRootByIdRef.current[rootID]?.is_git_repo !== true) {
      const fallback = {
        available: false,
        dirty_count: 0,
        items: [],
      } as GitStatusPayload;
      setGitStatusByRoot((prev) => ({ ...prev, [rootID]: fallback }));
      setGitStatusLoadingByRoot((prev) => ({ ...prev, [rootID]: false }));
      if (shouldApply()) {
        setGitStatus(fallback);
        setGitStatusLoading(false);
      }
      return fallback;
    }
    setGitStatusLoadingByRoot((prev) => ({ ...prev, [rootID]: true }));
    if (shouldApply()) {
      setGitStatusLoading(true);
    }
    try {
      const next = await fetchGitStatus(rootID);
      setGitStatusByRoot((prev) => ({ ...prev, [rootID]: next }));
      if (shouldApply()) {
        setGitStatus(next);
      }
      return next;
    } catch (err) {
      console.error("[git.status] failed", { rootID, err });
      const fallback = {
        available: false,
        dirty_count: 0,
        items: [],
      } as GitStatusPayload;
      setGitStatusByRoot((prev) => ({ ...prev, [rootID]: fallback }));
      if (shouldApply()) {
        setGitStatus(fallback);
      }
      return fallback;
    } finally {
      setGitStatusLoadingByRoot((prev) => ({ ...prev, [rootID]: false }));
      if (shouldApply()) {
        setGitStatusLoading(false);
      }
    }
  }, []);

  const refreshGitHistory = useCallback(async (rootID: string, options?: { force?: boolean }) => {
    if (!rootID) {
      setGitHistory(null);
      setGitHistoryLoading(false);
      return null;
    }
    if (!options?.force) {
      const cachedHead = getCachedGitHistoryHead(rootID);
      if (cachedHead && cachedHead.items.length > 0) {
        setGitHistoryByRoot((prev) => ({ ...prev, [rootID]: cachedHead }));
        if (currentRootIdRef.current === rootID) {
          setGitHistory(cachedHead);
        }
        const newest = cachedHead.items[0]?.hash || "";
        if (newest) {
          void fetchGitHistory(rootID, { afterCommit: newest })
            .then((next) => {
              if (next.commit_missing) {
                clearGitHistoryCache(rootID);
                return fetchGitHistory(rootID, { force: true });
              }
              if ((next.items || []).length > 0) {
                clearGitHistoryCache(rootID);
                return fetchGitHistory(rootID, { force: true });
              }
              return getCachedGitHistoryHead(rootID) || next;
            })
            .then((fresh) => {
              setGitHistoryByRoot((prev) => ({ ...prev, [rootID]: fresh }));
              if (currentRootIdRef.current === rootID) {
                setGitHistory(fresh);
              }
            })
            .catch((err) => {
              console.error("[git.history.after] failed", { rootID, afterCommit: newest, err });
            });
        }
        return cachedHead;
      }
    }
    setGitHistoryLoadingByRoot((prev) => ({ ...prev, [rootID]: true }));
    if (currentRootIdRef.current === rootID) {
      setGitHistoryLoading(true);
    }
    try {
      const next = await fetchGitHistory(rootID, { force: options?.force });
      if (next.commit_missing) {
        clearGitHistoryCache(rootID);
        const fresh = await fetchGitHistory(rootID, { force: true });
        setGitHistoryByRoot((prev) => ({ ...prev, [rootID]: fresh }));
        if (currentRootIdRef.current === rootID) {
          setGitHistory(fresh);
        }
        return fresh;
      }
      setGitHistoryByRoot((prev) => ({ ...prev, [rootID]: next }));
      if (currentRootIdRef.current === rootID) {
        setGitHistory(next);
      }
      return next;
    } catch (err) {
      console.error("[git.history] failed", { rootID, err });
      const fallback = { available: false, items: [], has_more: false } as GitHistoryPayload;
      setGitHistoryByRoot((prev) => ({ ...prev, [rootID]: fallback }));
      if (currentRootIdRef.current === rootID) {
        setGitHistory(fallback);
      }
      return fallback;
    } finally {
      setGitHistoryLoadingByRoot((prev) => ({ ...prev, [rootID]: false }));
      if (currentRootIdRef.current === rootID) {
        setGitHistoryLoading(false);
      }
    }
  }, []);

  const loadMoreGitHistory = useCallback(async (targetRootID?: string) => {
    const rootID = targetRootID || currentRootIdRef.current;
    if (!rootID || gitHistoryLoadingMore) {
      return;
    }
    const currentItems =
      (targetRootID ? gitHistoryByRoot[rootID]?.items : gitHistory?.items) || [];
    const beforeCommit = currentItems[currentItems.length - 1]?.hash || "";
    if (!beforeCommit) {
      return;
    }
    setGitHistoryLoadingMore(true);
    try {
      const next = await fetchGitHistory(rootID, { beforeCommit });
      if (next.commit_missing) {
        clearGitHistoryCache(rootID);
        const fresh = await fetchGitHistory(rootID, { force: true });
        setGitHistoryByRoot((prev) => ({ ...prev, [rootID]: fresh }));
        if (currentRootIdRef.current === rootID) {
          setGitHistory(fresh);
        }
        return;
      }
      const cached = getCachedGitHistory(rootID);
      const loadedCount = currentItems.length + next.items.length;
      if (currentRootIdRef.current === rootID) {
        if (cached) {
          setGitHistory({
            ...cached,
            items: cached.items.slice(0, loadedCount),
            has_more: cached.items.length > loadedCount || cached.has_more,
          });
        } else {
          setGitHistory(next);
        }
      }
      setGitHistoryByRoot((prev) => ({
        ...prev,
        [rootID]: cached
          ? {
              ...cached,
              items: cached.items.slice(0, loadedCount),
              has_more: cached.items.length > loadedCount || cached.has_more,
            }
          : next,
      }));
    } catch (err) {
      console.error("[git.history.more] failed", { rootID, beforeCommit, err });
    } finally {
      setGitHistoryLoadingMore(false);
    }
  }, [gitHistory, gitHistoryByRoot, gitHistoryLoadingMore]);

  const loadSessionsForRoot = useCallback(
    async (
      rootID: string,
      options?: {
        beforeTime?: string;
        afterTime?: string;
        replace?: boolean;
        force?: boolean;
      },
    ) => {
      try {
        const payload = await sessionService.fetchSessions(rootID, {
          beforeTime: options?.beforeTime,
          afterTime: options?.afterTime,
        });
        const next = [
          ...payload.items,
          ...payload.pinnedItems,
        ].map((item) => toSessionItem(rootID, item)).filter((item): item is SessionItem => !!item);
        if (!options?.force && currentRootIdRef.current !== rootID) return;
        setHasMoreSessions(payload.totalCount > payload.items.length);
        if (options?.replace || (!options?.beforeTime && !options?.afterTime)) {
          setSessions(applyPinnedSnapshotToSessions(mergeSessionItems([], next), rootID, payload.pinnedKeys));
          return;
        }
        setSessions((prev) =>
          applyPinnedSnapshotToSessions(mergeSessionItems(prev, next), rootID, payload.pinnedKeys),
        );
      } catch {}
    },
    [],
  );

  const loadChildSessionsForParent = useCallback(
    async (
      parent: SessionItem,
      options?: { beforeTime?: string },
    ): Promise<{ hasMore: boolean }> => {
      const rootID =
        (parent.root_id as string | undefined) || currentRootIdRef.current || "";
      const parentKey = parent.key || parent.session_key || "";
      if (!rootID || !parentKey) {
        return { hasMore: false };
      }
      const items = await sessionService.fetchChildSessions(rootID, parentKey, {
        beforeTime: options?.beforeTime,
        limit: CHILD_SESSION_PAGE_SIZE,
      });
      const next = items
        .map((item) => toSessionItem(rootID, item))
        .filter((item): item is SessionItem => !!item);
      if (currentRootIdRef.current === rootID && next.length > 0) {
        setSessions((prev) => mergeSessionItems(prev, next));
      }
      if (next.length > 0) {
        setMultiProjectSessionGroups((prev) =>
          applyPendingToMultiProjectGroups(
            prev.map((group) =>
              group.rootId === rootID
                ? { ...group, sessions: mergeSessionItems(group.sessions, next) }
                : group,
            ),
            multiProjectPendingRef.current,
          ),
        );
      }
      return { hasMore: items.length >= CHILD_SESSION_PAGE_SIZE };
    },
    [applyPendingToMultiProjectGroups, mergeSessionItems],
  );

  const loadMultiProjectSessionGroups = useCallback(async () => {
    if (!multiProjectSessionsEnabled || !protectedAPIReady()) {
      return;
    }
    setMultiProjectSessionsLoading(true);
    try {
      const groups = await sessionService.fetchMultiRootSessions(MULTI_PROJECT_SESSION_LIMIT);
      const nextGroups = groups.map((group: MultiRootSessionGroup): MultiProjectSessionGroup => ({
        rootId: group.rootId,
        rootName: group.rootName || managedRootByIdRef.current[group.rootId]?.display_name || group.rootId,
        latestSessionTime: group.latestSessionTime,
        sessions: applyPinnedSnapshotToSessions(
          mergeSessionItems(
            [],
            [...group.items, ...group.pinnedItems]
              .map((item) => toSessionItem(group.rootId, { ...(item as any), root_id: group.rootId }))
              .filter((item): item is SessionItem => !!item),
          ),
          group.rootId,
          group.pinnedKeys,
        )
          .filter((item): item is SessionItem => !!item),
        totalCount: group.totalCount,
      }));
      setMultiProjectSessionGroups(
        applyPendingToMultiProjectGroups(nextGroups, multiProjectPendingRef.current),
      );
    } finally {
      setMultiProjectSessionsLoading(false);
    }
  }, [applyPendingToMultiProjectGroups, multiProjectSessionsEnabled]);

  const loadMoreMultiProjectSessions = useCallback(
    async (group: ProjectSessionGroup) => {
      const topLevelSessions = group.sessions.filter(isTopLevelSessionItem);
      const oldest = topLevelSessions[topLevelSessions.length - 1]?.updated_at || "";
      if (!group.rootId || !oldest) {
        return;
      }
      const previousLoaded = topLevelSessions.length;
      const payload = await sessionService.fetchSessions(group.rootId, {
        beforeTime: oldest,
        limit: SESSION_PAGE_SIZE,
        topLevel: true,
        includeChildren: true,
      });
      const nextItems = payload.items
        .concat(payload.pinnedItems)
        .map((item) => toSessionItem(group.rootId, { ...(item as any), root_id: group.rootId }))
        .filter((item): item is SessionItem => !!item);
      setMultiProjectSessionGroups((prev) =>
        applyPendingToMultiProjectGroups(
          prev.map((current) => {
            if (current.rootId !== group.rootId) {
              return current;
            }
            const sessions = applyPinnedSnapshotToSessions(
              mergeSessionItems(current.sessions, nextItems),
              group.rootId,
              payload.pinnedKeys,
            );
            return {
              ...current,
              sessions,
              totalCount: previousLoaded + payload.totalCount,
            };
          }),
          multiProjectPendingRef.current,
        ),
      );
    },
    [applyPendingToMultiProjectGroups, mergeSessionItems],
  );

  const refreshMultiProjectReplyingSessions = useCallback(async () => {
    try {
      const payload = await apiProtectedJSON<any>(appPath("/api/replying-sessions"));
      const items = Array.isArray(payload?.sessions) ? payload.sessions : [];
      const next: Record<string, boolean> = {};
      for (const item of items) {
        const rootID = String(item?.rootId || item?.root_id || "");
        const sessionKey = String(item?.sessionKey || item?.session_key || "");
        if (rootID && sessionKey) {
          next[rootSessionKey(rootID, sessionKey)] = true;
        }
      }
      multiProjectPendingRef.current = next;
      setMultiProjectPendingByKey(next);
      setMultiProjectSessionGroups((groups) => applyPendingToMultiProjectGroups(groups, next));
    } catch (error) {
      console.warn("[multi-project-sessions] replying refresh failed", error);
    }
  }, [applyPendingToMultiProjectGroups, rootSessionKey]);

  useEffect(() => {
    if (!multiProjectSessionsEnabled) {
      return;
    }
    void refreshMultiProjectReplyingSessions();
    void loadMultiProjectSessionGroups();
  }, [loadMultiProjectSessionGroups, multiProjectSessionsEnabled, refreshMultiProjectReplyingSessions]);

  const executeSessionSearch = useCallback(() => {
    const trimmed = sessionSearchQuery.trim();
    if (trimmed.length < 2) {
      return;
    }
    setSessionSearchResultsMode(true);
    setSessionSearchAppliedQuery(trimmed);
  }, [sessionSearchQuery]);

  useEffect(() => {
    if (
      sessionListMode !== "local" ||
      !sessionSearchOpen ||
      !currentRootId ||
      !sessionSearchAppliedQuery
    ) {
      setSessionSearchLoading(false);
      return;
    }

    let cancelled = false;
    const searchAcrossRoots = multiProjectSessionsEnabled;
    setSessionSearchLoading(true);
    void sessionService
      .searchSessions(currentRootId, sessionSearchAppliedQuery, 20, {
        multiRoot: searchAcrossRoots,
      })
      .then((hits) => {
        if (cancelled) return;
        const mapped = hits
          .map((hit) => {
            const hitRootId = String(hit.root_id || currentRootId || "");
            const item = toSessionItem(hitRootId, {
              ...hit,
              root_id: hitRootId,
              search_seq: hit.seq,
              search_snippet: hit.snippet,
              search_match_type: hit.match_type,
            });
            return item;
          })
          .filter((item): item is SessionItem => !!item);
        setSessionSearchResults(mapped);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[session.search] failed", {
          rootId: currentRootId,
          query: sessionSearchAppliedQuery,
          err,
        });
        setSessionSearchResults([]);
      })
      .finally(() => {
        if (!cancelled) {
          setSessionSearchLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentRootId, multiProjectSessionsEnabled, sessionListMode, sessionSearchAppliedQuery, sessionSearchOpen]);

  const openGitDiff = useCallback(
    async (rootID: string, item: GitStatusItem, options?: { preserveRelatedSelection?: boolean; repoPath?: string }) => {
      if (!rootID || !item?.path) {
        return;
      }
      fileOpenRequestRef.current += 1;
      if (!options?.preserveRelatedSelection) {
        setRelatedSelectedFileKey("");
      }
      setMainViewPreferenceForRoot(rootID, "git-diff");
      setSelectedSession(null);
      setSelectedSessionLoading(false);
      setFile(null);
      setGitDiff(null);
      replaceURLState({
        root: rootID,
        file: "",
        session: "",
        cursor: 0,
        pluginQuery: {},
      });
      try {
        const next = await fetchGitDiff(rootID, item.path, {
          cacheSignature: buildGitDiffCacheSignature(item),
          repoPath: options?.repoPath,
        });
        setGitDiff(next);
        if (currentRootIdRef.current !== rootID) {
          setCurrentRootId(rootID);
        }
        if (isMobile) {
          setIsLeftOpen(false);
        }
      } catch (err) {
        console.error("[git.diff] failed", { rootID, path: item.path, err });
      }
    },
    [isMobile, replaceURLState, setMainViewPreferenceForRoot],
  );

  const openGitCommitDiff = useCallback(
    async (rootID: string, commit: GitHistoryItem, item: GitStatusItem) => {
      if (!rootID || !commit?.hash || !item?.path) {
        return;
      }
      fileOpenRequestRef.current += 1;
      setRelatedSelectedFileKey("");
      setMainViewPreferenceForRoot(rootID, "git-diff");
      setSelectedSession(null);
      setSelectedSessionLoading(false);
      setFile(null);
      setGitDiff(null);
      replaceURLState({
        root: rootID,
        file: "",
        session: "",
        cursor: 0,
        pluginQuery: {},
      });
      try {
        const next = await fetchGitCommitDiff(rootID, commit.hash, item);
        setGitDiff(next);
        if (currentRootIdRef.current !== rootID) {
          setCurrentRootId(rootID);
        }
        if (isMobile) {
          setIsLeftOpen(false);
        }
      } catch (err) {
        console.error("[git.commit.diff] failed", {
          rootID,
          commit: commit.hash,
          path: item.path,
          err,
        });
      }
    },
    [isMobile, replaceURLState, setMainViewPreferenceForRoot],
  );

  const switchGitBranch = useCallback(
    async (rootID: string, branch: string) => {
      if (!rootID || !branch) {
        return;
      }
      try {
        const nextStatus = await checkoutGitBranch(rootID, branch);
        clearGitHistoryCache(rootID);
        setGitStatusByRoot((prev) => ({ ...prev, [rootID]: nextStatus }));
        await refreshGitHistory(rootID, { force: true });
        if (currentRootIdRef.current === rootID) {
          setGitStatus(nextStatus);
          setGitDiff(null);
          setFile(null);
          await refreshTreeDir(rootID, selectedDirRef.current || ".", true);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : t("git.checkoutFailed");
        console.error("[git.checkout] failed", {
          rootID,
          branch,
          message,
          payload: err instanceof ProtectedAPIError ? err.payload : undefined,
          err,
        });
        reportError("git.checkout_failed", message, {
          severity: "error",
          recoverable: true,
          details: {
            root: rootID,
            branch,
            payload: err instanceof ProtectedAPIError ? err.payload : undefined,
          },
        });
        throw err;
      }
    },
    [refreshGitHistory, refreshTreeDir, t],
  );

  const applyGitActionResult = useCallback(
    async (rootID: string, nextStatus: GitStatusPayload, options?: { refreshHistory?: boolean; clearDiff?: boolean }) => {
      clearGitHistoryCache(rootID);
      setGitStatusByRoot((prev) => ({ ...prev, [rootID]: nextStatus }));
      if (options?.refreshHistory !== false) {
        await refreshGitHistory(rootID, { force: true });
      }
      if (currentRootIdRef.current !== rootID) {
        return;
      }
      setGitStatus(nextStatus);
      if (options?.clearDiff) {
        setGitDiff(null);
      }
      await refreshTreeDir(rootID, selectedDirRef.current || ".", true);
    },
    [refreshGitHistory, refreshTreeDir],
  );

  const runGitAction = useCallback(
    async (
      rootID: string,
      action: string,
      run: () => Promise<{ status: GitStatusPayload; output?: string }>,
      options?: { refreshHistory?: boolean; clearDiff?: boolean },
    ) => {
      if (!rootID) {
        return;
      }
      try {
        const result = await run();
        await applyGitActionResult(rootID, result.status, options);
      } catch (err) {
        const message = err instanceof Error ? err.message : t("common.actionFailed", { action });
        console.error(`[git.${action}] failed`, {
          rootID,
          message,
          payload: err instanceof ProtectedAPIError ? err.payload : undefined,
          err,
        });
        window.alert(message);
        throw err;
      }
    },
    [applyGitActionResult, t],
  );

  const handleGitPull = useCallback(
    (rootID: string) =>
      runGitAction(rootID, "pull", () => pullGit(rootID), { clearDiff: true }),
    [runGitAction],
  );

  const handleGitPush = useCallback(
    (rootID: string) =>
      runGitAction(rootID, "push", () => pushGit(rootID)),
    [runGitAction],
  );

  const handleGitCommit = useCallback(
    (rootID: string, message: string) =>
      runGitAction(rootID, "commit", () => commitGit(rootID, message), { clearDiff: true }),
    [runGitAction],
  );

  const handleGitStageItem = useCallback(
    (rootID: string, item: GitStatusItem) =>
      runGitAction(rootID, "stage", () => stageGitItem(rootID, item), {
        refreshHistory: false,
        clearDiff: true,
      }),
    [runGitAction],
  );

  const handleGitUnstageItem = useCallback(
    (rootID: string, item: GitStatusItem) =>
      runGitAction(rootID, "unstage", () => unstageGitItem(rootID, item), {
        refreshHistory: false,
        clearDiff: true,
      }),
    [runGitAction],
  );

  const handleGitDiscardItem = useCallback(
    (rootID: string, item: GitStatusItem) =>
      runGitAction(rootID, "discard", () => discardGitItem(rootID, item), {
        refreshHistory: false,
        clearDiff: true,
      }),
    [runGitAction],
  );

  const handleTreeUpload = useCallback(
    async (files: File[]) => {
      const rootID = currentRootIdRef.current;
      if (!rootID || files.length === 0) return;

      const selectedDirPath =
        selectedDirRef.current === rootID ? "." : selectedDirRef.current;
      const targetDir =
        selectedDirPath ||
        (fileRef.current?.path ? dirnameOfPath(fileRef.current.path) : ".");
      setDirectoryUploadProgress(null);
      try {
        const uploadAbort = new AbortController();
        directoryUploadAbortRef.current = uploadAbort;
        const uploaded = await uploadFiles({
          rootId: rootID,
          dir: targetDir,
          files,
          onProgress: setDirectoryUploadProgress,
          signal: uploadAbort.signal,
        });
        uploaded.forEach((item) => {
          if (typeof item?.path === "string" && item.path) {
            invalidateFileCache(rootID, item.path);
          }
        });
        const currentDir =
          (selectedDirRef.current === rootID ? "." : selectedDirRef.current) ||
          ".";
        const syncMain =
          rootID === currentRootIdRef.current && currentDir === targetDir;
        await refreshTreeDir(rootID, targetDir, syncMain);
        setExpanded((prev) =>
          Array.from(
            new Set([
              ...prev,
              rootID,
              targetDir === "." ? rootID : `${rootID}:${targetDir}`,
            ]),
          ),
        );
      } catch (err) {
        if (!isUploadAbortError(err)) {
          reportError(
            "file.write_failed",
            String((err as Error)?.message || t("file.uploadFailed")),
          );
        }
      } finally {
        directoryUploadAbortRef.current = null;
        setDirectoryUploadProgress(null);
      }
    },
    [refreshTreeDir, t],
  );

  const handleSelectSession = useCallback(
    async (
      session: any,
      options?: { preserveTaskSelection?: boolean },
    ) => {
      const key = session?.key || session?.session_key;
      const targetRoot =
        (session?.root_id as string | undefined) || currentRootIdRef.current;
      if (!targetRoot || !key) return;
      if (!options?.preserveTaskSelection) {
        setSelectedKanbanTaskId("");
      }
      if (currentRootIdRef.current !== targetRoot) {
        setCurrentRootId(targetRoot);
      }
      setSelectedDir(targetRoot);
      setSelectedDirKey(
        buildDirectorySelectionKey(targetRoot, targetRoot, true),
      );
      setMainViewPreferenceForRoot(targetRoot, "session");
      const currentDrawer = drawerSessionByRootRef.current[targetRoot];
      const preservePending =
        currentDrawer?.key === key
          ? !!(currentDrawer as any)?.pending
          : !!(session as any)?.pending;
      const searchTargetId =
        typeof session?.search_seq === "number"
          ? `${key}:${session.search_seq}:${++sessionSearchTargetCounterRef.current}`
          : undefined;
      replaceURLState({
        root: targetRoot,
        file: "",
        session: key,
        cursor: 0,
        pluginQuery: {},
      });
      selectedSessionByRootRef.current[targetRoot] = key;
      const cacheKey = rootSessionKey(targetRoot, key);
      const wasStale = isSessionStale(targetRoot, key);
      const hadInMemoryState =
        !!pendingBySessionRef.current[cacheKey] ||
        hasSessionExchanges(sessionCacheRef.current[cacheKey]);
      const shouldSyncHistory = wasStale || !hadInMemoryState;
      setSelectedSessionLoading(true);
      setSelectedSession(
        toSessionItem(targetRoot, {
          ...(session as any),
          pending: preservePending,
          search_target_id: searchTargetId || session?.search_target_id,
        }),
      );
      setInteractionMode("main");
      setDrawerOpenForRoot(targetRoot, false);
      if (isMobile) setIsRightOpen(false);
      await waitForNextPaint();
      const applySession = (
        fullSession: Session,
        options?: { writeCache?: boolean },
      ) => {
        const shouldWriteCache = options?.writeCache !== false;
        const serverPending =
          typeof (fullSession as any)?.pending === "boolean"
            ? !!(fullSession as any).pending
            : undefined;
        const pending =
          serverPending !== undefined
            ? serverPending
            : resolvePendingForSession(targetRoot, key, preservePending);
        const normalized = {
          ...(fullSession as any),
          key,
          pending,
        } as Session;
        if (shouldWriteCache) {
          sessionCacheRef.current[cacheKey] = normalized;
        }
        setSelectedSession((prev) => {
          const prevKey = prev?.key || prev?.session_key;
          const prevRoot =
            (prev?.root_id as string | undefined) || currentRootIdRef.current;
          if (prevKey !== key || prevRoot !== targetRoot) {
            return prev;
          }
          return toSessionItem(targetRoot, {
            ...(prev as any),
            ...(normalized as any),
            key,
            session_key: key,
            root_id: targetRoot,
          });
        });
        if ((boundSessionByRootRef.current[targetRoot] || null) === key) {
          setDrawerSessionForRoot(targetRoot, {
            ...(normalized as any),
          } as Session);
        }
        setSelectedSessionLoading(false);
        if (shouldWriteCache) {
          bumpCacheVersion();
        }
      };
      const cached = sessionCacheRef.current[cacheKey];
      if (cached) {
        applySession(cached);
        if (!shouldSyncHistory && hasSessionExchanges(cached)) {
          loadedSessionRef.current[cacheKey] = true;
          return;
        }
      } else {
        const persisted = await getCachedSession(targetRoot, key);
        if (persisted) {
          applySession(persisted);
          if (!shouldSyncHistory && hasSessionExchanges(persisted)) {
            loadedSessionRef.current[cacheKey] = true;
            return;
          }
        }
      }
      if (!shouldSyncHistory && loadedSessionRef.current[cacheKey]) {
        return;
      }
      try {
        const restored = await restoreActiveSession(targetRoot, key);
        if (restored) {
          applySession(restored, { writeCache: false });
          loadedSessionRef.current[cacheKey] = true;
          clearSessionStale(targetRoot, key);
        } else {
          setSelectedSessionLoading(false);
        }
      } catch (err) {
        setSelectedSessionLoading(false);
      }
    },
    [
      isMobile,
      rootSessionKey,
      bumpCacheVersion,
      clearSessionStale,
      isSessionStale,
      resolvePendingForSession,
      restoreActiveSession,
      setDrawerOpenForRoot,
      setDrawerSessionForRoot,
      setMainViewPreferenceForRoot,
      replaceURLState,
    ],
  );

  const tryShowBoundSessionForRoot = useCallback(
    async (
      rootID: string | null | undefined,
      options?: {
        pluginQuery?: Record<string, string>;
        closeLeftSidebar?: boolean;
      },
    ): Promise<boolean> => {
      const resolvedRoot = String(rootID || "");
      if (!resolvedRoot) {
        return false;
      }
      if (mainViewPreferenceByRootRef.current[resolvedRoot] !== "session") {
        return false;
      }
      const selectedKey = String(
        selectedSessionByRootRef.current[resolvedRoot] || "",
      ).trim();
      const boundKey = String(
        boundSessionByRootRef.current[resolvedRoot] || "",
      ).trim();
      const drawerKey = String(
        drawerSessionByRootRef.current[resolvedRoot]?.key || "",
      ).trim();
      const preferredKey =
        (selectedKey && !selectedKey.startsWith("pending-") ? selectedKey : "") ||
        (boundKey && !boundKey.startsWith("pending-") ? boundKey : "") ||
        (drawerKey && !drawerKey.startsWith("pending-") ? drawerKey : "");
      if (!preferredKey) {
        return false;
      }
      if (currentRootIdRef.current !== resolvedRoot) {
        setCurrentRootId(resolvedRoot);
      }
      setGitDiff(null);
      setFile(null);
      setMainEntries([]);
      setPluginQuery(options?.pluginQuery || {});
      setSelectedDir(resolvedRoot);
      setSelectedDirKey(
        buildDirectorySelectionKey(resolvedRoot, resolvedRoot, true),
      );
      fileCursorRef.current = 0;
      const cacheKey = rootSessionKey(resolvedRoot, preferredKey);
      let initialSession =
        sessionCacheRef.current[cacheKey] ||
        (await getCachedSession(resolvedRoot, preferredKey));
      if (initialSession) {
        sessionCacheRef.current[cacheKey] = {
          ...(initialSession as any),
          key: preferredKey,
        } as Session;
      }
      await handleSelectSession(
        initialSession
          ? ({
              ...(initialSession as any),
              key: preferredKey,
              session_key: preferredKey,
              root_id: resolvedRoot,
            } as SessionItem)
          : {
              key: preferredKey,
              session_key: preferredKey,
              root_id: resolvedRoot,
            },
      );
      if (options?.closeLeftSidebar && isMobile) {
        setIsLeftOpen(false);
      }
      return true;
    },
    [handleSelectSession, isMobile, rootSessionKey, bumpCacheVersion],
  );

  const handleDeleteSession = useCallback(
    async (session: SessionItem) => {
      const sessionKey = session?.key || session?.session_key;
      const rootID =
        (session?.root_id as string | undefined) || currentRootIdRef.current;
      if (!rootID || !sessionKey) return;

      const deleted = await sessionService.deleteSession(rootID, sessionKey);
      if (!deleted) {
        reportError("session.delete_failed", t("session.deleteFailed"));
        return;
      }

      const deletedKeys = new Set<string>();
      const collectDeletedKeys = (key: string) => {
        if (!key || deletedKeys.has(key)) return;
        deletedKeys.add(key);
        for (const item of sessionsRef.current) {
          const itemKey = item.key || item.session_key || "";
          if (String(item.parent_session_key || "").trim() === key) {
            collectDeletedKeys(itemKey);
          }
        }
      };
      collectDeletedKeys(sessionKey);

      setSessions((prev) =>
        prev.filter((item) => !deletedKeys.has(item.key || item.session_key || "")),
      );

      for (const deletedKey of deletedKeys) {
        const cacheKey = rootSessionKey(rootID, deletedKey);
        delete sessionCacheRef.current[cacheKey];
        delete loadedSessionRef.current[cacheKey];
        delete loadingSessionRef.current[cacheKey];
        delete pendingBySessionRef.current[cacheKey];
        delete cancelRequestedBySessionRef.current[cacheKey];
        staleSessionKeysRef.current.delete(cacheKey);
        void deleteCachedSession(rootID, deletedKey);
      }

      if (deletedKeys.has(boundSessionByRootRef.current[rootID] || "")) {
        setBoundSessionForRoot(rootID, null);
      }
      if (deletedKeys.has(selectedSessionByRootRef.current[rootID] || "")) {
        selectedSessionByRootRef.current[rootID] = null;
      }
      if (deletedKeys.has(drawerSessionByRootRef.current[rootID]?.key || "")) {
        setDrawerSessionForRoot(rootID, null);
        setDrawerOpenForRoot(rootID, false);
      }
      setMultiProjectSessionGroups((prev) =>
        prev.map((group) => {
          if (group.rootId !== rootID) {
            return group;
          }
          const sessions = group.sessions.filter(
            (item) => !deletedKeys.has(item.key || item.session_key || ""),
          );
          return {
            ...group,
            sessions,
            totalCount: Math.max(0, group.totalCount - (group.sessions.length - sessions.length)),
          };
        }).filter((group) => group.totalCount > 0 || group.sessions.length > 0),
      );
      for (const deletedKey of deletedKeys) {
        setMultiProjectSessionPending(rootID, deletedKey, false);
      }

      const selectedKey =
        selectedSessionRef.current?.key ||
        selectedSessionRef.current?.session_key;
      const selectedRoot =
        (selectedSessionRef.current?.root_id as string | undefined) ||
        currentRootIdRef.current;
      if (deletedKeys.has(selectedKey || "") && selectedRoot === rootID) {
        setSelectedSession(null);
        setSelectedSessionLoading(false);
        replaceURLState({
          root: rootID,
          file: fileRef.current?.root === rootID ? fileRef.current.path : "",
          session: "",
          cursor: fileCursorRef.current || 0,
          pluginQuery: fileRef.current?.root === rootID ? pluginQuery : {},
        });
      }

      bumpCacheVersion();
    },
    [
      bumpCacheVersion,
      pluginQuery,
      replaceURLState,
      rootSessionKey,
      setBoundSessionForRoot,
      setDrawerOpenForRoot,
      setDrawerSessionForRoot,
      setMultiProjectSessionPending,
    ],
  );

  const handleRenameSession = useCallback(
    async (session: SessionItem, nextName: string) => {
      const sessionKey = session?.key || session?.session_key;
      const rootID =
        (session?.root_id as string | undefined) || currentRootIdRef.current;
      if (!rootID || !sessionKey) return false;

      const trimmedName = nextName.trim();
      if (!trimmedName || trimmedName === String(session?.name || "").trim()) {
        return true;
      }

      const renamed = await sessionService.renameSession(
        rootID,
        sessionKey,
        trimmedName,
      );
      if (!renamed) {
        reportError("session.rename_failed", t("session.renameFailed"));
        return false;
      }

      setSessions((prev) =>
        prev.map((item) =>
          (item.key || item.session_key) === sessionKey
            ? ({
                ...item,
                name: renamed.name,
                updated_at: renamed.updated_at,
              } as SessionItem)
            : item,
        ),
      );

      const cacheKey = rootSessionKey(rootID, sessionKey);
      const cached = sessionCacheRef.current[cacheKey];
      if (cached) {
        sessionCacheRef.current[cacheKey] = {
          ...cached,
          name: renamed.name,
          updated_at: renamed.updated_at,
        } as Session;
      }

      if (
        (selectedSessionRef.current?.key ||
          selectedSessionRef.current?.session_key) === sessionKey
      ) {
        setSelectedSession((prev) =>
          prev
            ? ({
                ...prev,
                name: renamed.name,
                updated_at: renamed.updated_at,
              } as SessionItem)
            : prev,
        );
      }

      if (boundSessionByRootRef.current[rootID] === sessionKey) {
        const latest = sessionCacheRef.current[cacheKey];
        if (latest) {
          setDrawerSessionForRoot(rootID, latest);
        }
      }
      setMultiProjectSessionGroups((prev) =>
        prev.map((group) =>
          group.rootId === rootID
            ? {
                ...group,
                sessions: group.sessions.map((item) =>
                  (item.key || item.session_key) === sessionKey
                    ? ({
                        ...item,
                        name: renamed.name,
                        updated_at: renamed.updated_at,
                      } as SessionItem)
                    : item,
                ),
              }
            : group,
        ),
      );

      bumpCacheVersion();
      return true;
    },
    [bumpCacheVersion, rootSessionKey, setDrawerSessionForRoot],
  );

  const handlePinSession = useCallback(
    async (session: SessionItem, pinned: boolean) => {
      const sessionKey = session?.key || session?.session_key;
      const rootID =
        (session?.root_id as string | undefined) || currentRootIdRef.current;
      if (!rootID || !sessionKey) return false;

      const updated = await sessionService.setSessionPinned(rootID, sessionKey, pinned);
      if (!updated) {
        reportError("session.pin_failed", t("session.pinFailed"));
        return false;
      }

      const nextItem = toSessionItem(rootID, updated);
      if (nextItem) {
        setSessions((prev) => mergeSessionItems(prev, [nextItem]));
        setMultiProjectSessionGroups((prev) =>
          prev.map((group) =>
            group.rootId === rootID
              ? {
                  ...group,
                  sessions: mergeSessionItems(group.sessions, [nextItem]),
                }
              : group,
          ),
        );
      }

      const cacheKey = rootSessionKey(rootID, sessionKey);
      const cached = sessionCacheRef.current[cacheKey];
      if (cached) {
        sessionCacheRef.current[cacheKey] = {
          ...cached,
          pinned_at: updated.pinned_at || undefined,
        } as Session;
      }

      if (
        (selectedSessionRef.current?.key ||
          selectedSessionRef.current?.session_key) === sessionKey
      ) {
        setSelectedSession((prev) =>
          prev
            ? ({
                ...prev,
                pinned_at: updated.pinned_at || undefined,
              } as SessionItem)
            : prev,
        );
      }

      if (boundSessionByRootRef.current[rootID] === sessionKey) {
        const latest = sessionCacheRef.current[cacheKey];
        if (latest) {
          setDrawerSessionForRoot(rootID, latest);
        }
      }

      bumpCacheVersion();
      return true;
    },
    [bumpCacheVersion, rootSessionKey, setDrawerSessionForRoot, t],
  );

  const handleSyncSession = useCallback(
    async (session: SessionItem) => {
      const sessionKey = session?.key || session?.session_key;
      const rootID =
        (session?.root_id as string | undefined) || currentRootIdRef.current;
      if (!rootID || !sessionKey || sessionKey.startsWith("pending-")) return;

      const cacheKey = rootSessionKey(rootID, sessionKey);
      setSyncingSessionKeys((prev) => {
        const next = new Set(prev);
        next.add(cacheKey);
        next.add(sessionKey);
        return next;
      });
      try {
        const result = await syncSession(rootID, sessionKey, { full: true });
        const synced = result.session;
        if (!synced) {
          reportError("session.sync_failed", t("session.syncFailed"));
          return;
        }
        const normalized = {
          ...(synced as any),
          key: sessionKey,
        } as Session;
        sessionCacheRef.current[cacheKey] = normalized;
        loadedSessionRef.current[cacheKey] = true;
        clearSessionStale(rootID, sessionKey);

        const nextItem = toSessionItem(rootID, normalized);
        if (nextItem) {
          setSessions((prev) => mergeSessionItems(prev, [nextItem]));
        }

        setSelectedSession((prev) => {
          const prevKey = prev?.key || prev?.session_key;
          const prevRoot =
            (prev?.root_id as string | undefined) || currentRootIdRef.current;
          if (!prev || prevKey !== sessionKey || prevRoot !== rootID) {
            return prev;
          }
          return toSessionItem(rootID, {
            ...(prev as any),
            ...(normalized as any),
            key: sessionKey,
            session_key: sessionKey,
            root_id: rootID,
          });
        });

        if (drawerSessionByRootRef.current[rootID]?.key === sessionKey) {
          setDrawerSessionForRoot(rootID, normalized);
        }

        bumpCacheVersion();
      } catch {
        reportError("session.sync_failed", t("session.syncFailed"));
      } finally {
        setSyncingSessionKeys((prev) => {
          const next = new Set(prev);
          next.delete(cacheKey);
          next.delete(sessionKey);
          return next;
        });
      }
    },
    [
      bumpCacheVersion,
      clearSessionStale,
      mergeSessionItems,
      rootSessionKey,
      setDrawerSessionForRoot,
    ],
  );

  const handleForkAgentMessage = useCallback(
    async (
      rootID: string | null | undefined,
      sessionKey: string | null | undefined,
      seq: number,
    ) => {
      const resolvedRoot = String(rootID || currentRootIdRef.current || "").trim();
      const resolvedKey = String(sessionKey || "").trim();
      if (!resolvedRoot || !resolvedKey || seq <= 0) {
        reportError("session.sync_failed", t("session.forkMissing"));
        return;
      }
      const result = await sessionService.forkSession(resolvedRoot, resolvedKey, seq);
      const forked = result?.session;
      const forkedKey = String(result?.session_key || forked?.key || "").trim();
      if (!forkedKey) {
        reportError("session.sync_failed", t("session.forkFailed"));
        return;
      }
      if (forked) {
        const normalized = {
          ...(forked as any),
          key: forkedKey,
          session_key: forkedKey,
          root_id: resolvedRoot,
        } as Session;
        const cacheKey = rootSessionKey(resolvedRoot, forkedKey);
        sessionCacheRef.current[cacheKey] = normalized;
        loadedSessionRef.current[cacheKey] = true;
        const item = toSessionItem(resolvedRoot, normalized);
        if (item) {
          setSessions((prev) => mergeSessionItems(prev, [item]));
          await handleSelectSession(item);
        } else {
          await handleSelectSession({ key: forkedKey, session_key: forkedKey, root_id: resolvedRoot });
        }
      } else {
        await handleSelectSession({ key: forkedKey, session_key: forkedKey, root_id: resolvedRoot });
      }
      void loadSessionsForRoot(resolvedRoot, { replace: true, force: true });
      bumpCacheVersion();
    },
    [
      bumpCacheVersion,
      handleSelectSession,
      loadSessionsForRoot,
      mergeSessionItems,
      rootSessionKey,
    ],
  );

  useEffect(() => {
    handleSelectSessionRef.current = handleSelectSession;
  }, [handleSelectSession]);

  const loadExternalSessions = useCallback(
    async (
      rootID: string,
      agent: string,
      options?: { beforeTime?: string; afterTime?: string; replace?: boolean },
    ) => {
      if (!rootID || !agent) {
        setExternalSessions([]);
        setHasMoreExternalSessions(false);
        setExternalSessionsError("");
        return;
      }
      try {
        if (!options?.beforeTime) {
          setLoadingExternalSessions(true);
        }
        const next = (await sessionService.fetchExternalSessions(
          rootID,
          agent,
          {
            beforeTime: options?.beforeTime,
            afterTime: options?.afterTime,
            filterBound: externalFilterBound,
            limit: 50,
          },
        )) as SessionItem[];
        setExternalSessionsError("");
        setHasMoreExternalSessions(next.length >= 50);
        if (options?.replace || (!options?.beforeTime && !options?.afterTime)) {
          setExternalSessions(next);
          return;
        }
        setExternalSessions((prev) => mergeSessionItems(prev, next));
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err || t("session.importLoadFailed"));
        setExternalSessionsError(message || t("session.importLoadFailed"));
        if (options?.replace || (!options?.beforeTime && !options?.afterTime)) {
          setExternalSessions([]);
          setHasMoreExternalSessions(false);
        }
        console.error("[Session] Failed to fetch external sessions:", err);
      } finally {
        setLoadingExternalSessions(false);
      }
    },
    [externalFilterBound, mergeSessionItems],
  );

  const exitImportMode = useCallback(() => {
    setSessionListMode("local");
    setExternalSelectedKey("");
    setExternalSessionsError("");
    setSelectedExternalImportKeys(new Set());
    setImportingExternalSessionKeys(new Set());
    setImportMenuOpen(false);
  }, []);

  const enterImportMode = useCallback(
    async (agentName: string) => {
      const rootID = currentRootIdRef.current || "";
      const trimmedAgent = String(agentName || "").trim();
      if (!rootID || !trimmedAgent) {
        return;
      }
      setExternalImportAgent(trimmedAgent);
      setExternalSelectedKey("");
      setExternalSessionsError("");
      setSelectedExternalImportKeys(new Set());
      setImportingExternalSessionKeys(new Set());
      setSessionListMode("import");
      await loadExternalSessions(rootID, trimmedAgent, { replace: true });
    },
    [loadExternalSessions],
  );

  const handleLoadOlderExternalSessions = useCallback(async () => {
    const rootID = currentRootIdRef.current || "";
    const oldest =
      externalSessionsRef.current[externalSessionsRef.current.length - 1]
        ?.updated_at || "";
    if (
      !rootID ||
      !externalImportAgent ||
      !oldest ||
      loadingOlderExternalSessions
    ) {
      return;
    }
    setLoadingOlderExternalSessions(true);
    try {
      await loadExternalSessions(rootID, externalImportAgent, {
        beforeTime: oldest,
      });
    } finally {
      setLoadingOlderExternalSessions(false);
    }
  }, [externalImportAgent, loadExternalSessions, loadingOlderExternalSessions]);

  const toggleExternalImportSelection = useCallback((session: SessionItem) => {
    const sessionKey = String(
      session.agent_session_id || session.key || "",
    ).trim();
    if (!sessionKey) {
      return;
    }
    setSelectedExternalImportKeys((current) => {
      const next = new Set(current);
      if (next.has(sessionKey)) {
        next.delete(sessionKey);
      } else {
        next.add(sessionKey);
      }
      return next;
    });
  }, []);

  const toggleAllExternalImportSelection = useCallback((checked: boolean) => {
    const visibleKeys = externalSessionsRef.current
      .map((session) =>
        String(session.agent_session_id || session.key || "").trim(),
      )
      .filter(Boolean);
    setSelectedExternalImportKeys((current) => {
      const next = new Set(current);
      visibleKeys.forEach((key) => {
        if (checked) {
          next.add(key);
        } else {
          next.delete(key);
        }
      });
      return next;
    });
  }, []);

  const handleConfirmExternalImport = useCallback(async () => {
    const rootID = currentRootIdRef.current || "";
    const sessionKeys = [...selectedExternalImportKeys].filter(Boolean);
    if (
      !rootID ||
      !externalImportAgent ||
      !sessionKeys.length ||
      confirmingExternalImport
    ) {
      return;
    }
    setConfirmingExternalImport(true);
    setImportingExternalSessionKeys(new Set(sessionKeys));
    try {
      const imported = await sessionService.importExternalSessionsBatch(
        rootID,
        externalImportAgent,
        sessionKeys,
      );
      const results = imported?.items || [];
      const successItems = results.filter((item) => item.success && item.session_key);
      if (!imported || !successItems.length) {
        const firstError = results.find((item) => !item.success)?.error;
        reportError(
          "session.import_failed",
          firstError ? t("session.importFailedWithReason", { reason: firstError }) : t("session.importFailed"),
        );
        return;
      }
      setConfirmingExternalImport(false);
      setImportingExternalSessionKeys(new Set());
      const failedKeys = new Set(
        results
          .filter((item) => !item.success)
          .map((item) => String(item.agent_session_id || "").trim())
          .filter(Boolean),
      );
      if (failedKeys.size > 0) {
        const firstError = results.find((item) => !item.success)?.error;
        const message = firstError
          ? t("session.importPartialFailedWithReason", { count: failedKeys.size, reason: firstError })
          : t("session.importPartialFailed", { count: failedKeys.size });
        reportError(
          "session.import_failed",
          message,
        );
      }
      setSelectedExternalImportKeys(failedKeys);
      if (failedKeys.size === 0) {
        exitImportMode();
      }
      const payload = await sessionService.fetchSessions(rootID, {});
      const next = [...payload.items, ...payload.pinnedItems]
        .map((item) => toSessionItem(rootID, item))
        .filter((item): item is SessionItem => !!item);
      setHasMoreSessions(payload.totalCount > payload.items.length);
      setSessions(applyPinnedSnapshotToSessions(mergeSessionItems([], next), rootID, payload.pinnedKeys));
      const firstImported = successItems[0];
      if (firstImported?.session_key) {
        const source = externalSessionsRef.current.find((item) =>
          String(item.agent_session_id || item.key || "").trim() ===
          String(firstImported.agent_session_id || "").trim(),
        );
        await handleSelectSession({
          key: firstImported.session_key,
          root_id: rootID,
          type: "chat",
          agent: externalImportAgent,
          name: source?.name,
        } as SessionItem);
      }
      if (isMobile && failedKeys.size === 0) {
        setIsRightOpen(false);
      }
    } finally {
      setConfirmingExternalImport(false);
      setImportingExternalSessionKeys(new Set());
    }
  }, [
    confirmingExternalImport,
    exitImportMode,
    externalImportAgent,
    handleSelectSession,
    isMobile,
    selectedExternalImportKeys,
  ]);

  const handleSendMessage = useCallback(
    async (
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
    ) => {
      const activeRoot = currentRootIdRef.current;
      if (!activeRoot) return;
      const selected = selectedSessionRef.current;
      const selectedKey = selected?.key || selected?.session_key;
      const selectedRoot =
        (selected?.root_id as string | undefined) || activeRoot;
      const currentBoundSessionKey =
        boundSessionByRootRef.current[activeRoot] || null;
      const isMainSessionView =
        interactionModeRef.current !== "drawer" &&
        !!selectedKey &&
        selectedRoot === activeRoot;
      let sendSessionKey: string | null | undefined =
        isMainSessionView && selectedKey && !selectedKey.startsWith("pending-")
          ? selectedKey
          : currentBoundSessionKey;
      let session: Session | null = null;
      if (sendSessionKey) {
        session =
          sessionCacheRef.current[rootSessionKey(activeRoot, sendSessionKey)];
        if (!session) {
          const current = currentSessionRef.current;
          if (current?.key === sendSessionKey) {
            session = current as Session;
          }
        }
        if (!session && selectedKey === sendSessionKey) {
          session = { ...(selected as any), key: sendSessionKey } as Session;
        }
      } else {
        if (
          selectedRoot === activeRoot &&
          selectedKey &&
          !selectedKey.startsWith("pending-")
        ) {
          sendSessionKey = selectedKey;
          session =
            sessionCacheRef.current[
              rootSessionKey(activeRoot, sendSessionKey)
            ] || ({ ...selected, key: selectedKey } as Session);
        }
      }
      let effectiveMode = mode,
        effectiveAgent = agent,
        effectiveModel = model || "",
        effectiveAgentMode = agentMode || "",
        effectiveEffort = effort || "",
        effectiveFastService = (fastService || "") as "" | "on" | "off",
        effectiveShell = shell || "";
      const messageRequestsPlanMode =
        message.trim().toLowerCase() === "/plan" ||
        message.trim().toLowerCase().startsWith("/plan ");
      const normalizedMessage = message.trim().toLowerCase();
      const messageRequestsStatus = normalizedMessage === "/status";
      const messageRequestsLogin = normalizedMessage === "/login";
      const transientSlashCommand = messageRequestsStatus
        ? "status"
        : messageRequestsLogin
          ? "login"
          : "";
      const isQueueSend =
        !!sendSessionKey &&
        !!session &&
        (((session as any).pending === true) ||
          (currentSessionRef.current?.key === sendSessionKey &&
            currentSessionRef.current?.pending === true));
      if (sendSessionKey && session) {
        const targetSessionKey = sendSessionKey;
        const previousAgent = session.agent || "";
        const useTargetSessionDefaults =
          !!currentBoundSessionKey && currentBoundSessionKey !== targetSessionKey;
        effectiveMode = normalizeMode(session.type as any);
        effectiveAgent =
          (useTargetSessionDefaults ? previousAgent : agent) ||
          previousAgent ||
          "";
        effectiveModel =
          (useTargetSessionDefaults ? session.model || "" : model) ||
          (effectiveAgent === previousAgent ? session.model || "" : "");
        effectiveAgentMode =
          (useTargetSessionDefaults ? (session as any).mode || "" : agentMode) ||
          (effectiveAgent === previousAgent ? (session as any).mode || "" : "");
        effectiveEffort =
          (useTargetSessionDefaults ? (session as any).effort || "" : effort) ||
          (effectiveAgent === previousAgent ? (session as any).effort || "" : "");
        effectiveFastService =
          (useTargetSessionDefaults
            ? (((session as any).fast_service || "") as "" | "on" | "off")
            : ((fastService || "") as "" | "on" | "off")) ||
          (effectiveAgent === previousAgent
            ? (((session as any).fast_service || "") as "" | "on" | "off")
            : "");
        effectiveShell =
          effectiveMode === "command"
            ? ((useTargetSessionDefaults ? (session as any).shell || "" : shell) ||
                (session as any).shell ||
                "")
            : "";
        updateSessionAgentForKey(
          activeRoot,
          targetSessionKey,
          effectiveAgent,
          effectiveModel,
          effectiveAgentMode,
          effectiveEffort,
          effectiveFastService,
        );
        session = {
          ...(session as any),
          agent: effectiveAgent,
          model: effectiveModel,
          mode: effectiveAgentMode,
          effort: effectiveEffort,
          fast_service: effectiveFastService,
          shell: effectiveShell,
        } as Session;
        setBoundSessionForRoot(activeRoot, targetSessionKey);
        if (!isQueueSend) {
          setSelectedPendingByKey(targetSessionKey, true);
          setDrawerSessionForRoot(activeRoot, {
            ...(session as any),
            pending: true,
          } as Session);
        }
      } else {
        if (transientSlashCommand) {
          sendSessionKey = `transient-${Date.now()}`;
          session = null;
        } else {
          sendSessionKey = undefined;
          const tempKey = `pending-${Date.now()}`;
          session = {
            key: tempKey,
            type: mode,
            agent,
            model: effectiveModel,
            mode: effectiveAgentMode,
            effort: effectiveEffort,
            fast_service: effectiveFastService,
            shell: effectiveShell,
            plan_mode: pendingPlanMode || messageRequestsPlanMode,
            name: t("session.new"),
            pending: true,
          } as any;
          setBoundSessionForRoot(activeRoot, tempKey);
        }
      }
      if (transientSlashCommand) {
        if (!sendSessionKey) return;
        if (effectiveAgent !== "codex") {
          reportError(
            "session.slash_command_failed",
            t("session.slashCommandCodexOnly", { command: transientSlashCommand }),
          );
          return;
        }
	        const requestId = sessionService.createRequestId("slash");
	        const targetSessionKey = sendSessionKey;
	        const resultKey = rootSessionKey(activeRoot, targetSessionKey);
        const runningTransientLoginKeys = Array.from(
          new Set(
            Object.values(slashCommandResults)
              .filter(
                (value) =>
                  value.rootId === activeRoot &&
                  value.command === "login" &&
                  value.status === "running",
              )
              .map((value) => value.sessionKey),
          ),
        );
        if (runningTransientLoginKeys.length > 0) {
          await Promise.all(
            runningTransientLoginKeys.map((sessionKey) =>
              sessionService.cancelMessage(activeRoot, sessionKey),
            ),
          );
        }
	        if (session) {
	          setSelectedPendingByKey(targetSessionKey, false);
	          setMultiProjectSessionPending(activeRoot, targetSessionKey, false);
	        }
	        setSessions((prev) =>
	          prev.map((item) => {
	            const itemKey = item.key || item.session_key;
	            if (itemKey !== targetSessionKey) {
	              return item;
	            }
	            return { ...(item as any), pending: false } as SessionItem;
	          }),
	        );
	        const drawerSession = drawerSessionByRootRef.current[activeRoot];
	        if (drawerSession && drawerSession.key === targetSessionKey) {
	          setDrawerSessionForRoot(activeRoot, {
	            ...(drawerSession as any),
	            pending: false,
	          } as Session);
	        }
	        setSlashCommandResults((prev) => {
          const next = { ...prev };
          for (const [key, value] of Object.entries(prev)) {
            if (
              value.rootId === activeRoot &&
              value.sessionKey.startsWith("transient-")
            ) {
              delete next[key];
            }
          }
          next[resultKey] = {
            rootId: activeRoot,
            sessionKey: targetSessionKey,
            requestId,
            command: transientSlashCommand,
            content: "",
            status: "running",
            createdAt: Date.now(),
          };
          return next;
        });
        const sent = await sessionService.runSlashCommand(
          activeRoot,
          targetSessionKey,
          transientSlashCommand,
          effectiveAgent,
          effectiveModel || undefined,
          effectiveAgentMode || undefined,
          effectiveEffort || undefined,
          effectiveFastService,
          requestId,
        );
        if (!sent) {
          setSlashCommandResults((prev) => ({
            ...prev,
            [resultKey]: {
              rootId: activeRoot,
              sessionKey: targetSessionKey,
              requestId,
              command: transientSlashCommand,
              content: "",
              status: "failed",
              error: t("session.connectionNotReady"),
              createdAt: Date.now(),
            },
          }));
          reportError(
            "network.disconnected",
            t("session.commandSendFailedNotReady"),
          );
        }
        return;
      }
      if (sendSessionKey) {
        clearSlashCommandResultForSession(activeRoot, sendSessionKey);
      }
      const runningTransientLoginKeys = Array.from(
        new Set(
          Object.values(slashCommandResults)
            .filter(
              (value) =>
                value.rootId === activeRoot &&
                value.command === "login" &&
                value.status === "running",
            )
            .map((value) => value.sessionKey),
        ),
      );
      if (runningTransientLoginKeys.length > 0) {
        await Promise.all(
          runningTransientLoginKeys.map((sessionKey) =>
            sessionService.cancelMessage(activeRoot, sessionKey),
          ),
        );
      }
      setSlashCommandResults((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const [key, value] of Object.entries(prev)) {
          if (value.rootId === activeRoot && value.sessionKey.startsWith("transient-")) {
            delete next[key];
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      const now = new Date().toISOString();
      const requestId = sessionService.createRequestId("msg");
      const tempKey = sendSessionKey ? "" : session?.key || "";
      const userEx: Exchange = {
        role: "user",
        agent: effectiveAgent,
        model: effectiveModel,
        mode: effectiveAgentMode,
        effort: effectiveEffort,
        fast_service: effectiveFastService,
        content: message,
        timestamp: now,
        pending_ack: true,
      };
      if (sendSessionKey) {
        const targetSessionKey = sendSessionKey;
        setMultiProjectSessionPending(activeRoot, targetSessionKey, true);
        setSessions((prev) =>
          prev.map((item) => {
            const itemKey = item.key || item.session_key;
            if (itemKey !== targetSessionKey) {
              return item;
            }
            return {
              ...(item as any),
              pending: true,
              updated_at: now,
              agent: effectiveAgent,
              model: effectiveModel,
              mode: effectiveAgentMode,
              effort: effectiveEffort,
              fast_service: effectiveFastService,
              shell: effectiveShell,
            } as SessionItem;
          }),
        );
      }
      pendingRequestRef.current[requestId] = {
        rootId: activeRoot,
        mode: effectiveMode,
        agent: effectiveAgent,
        model: effectiveModel,
        agentMode: effectiveAgentMode,
        effort: effectiveEffort,
        fastService: effectiveFastService,
        shell: effectiveShell,
        message,
        timestamp: now,
        requestId,
        sessionKey: sendSessionKey || undefined,
        tempKey,
      };
      if (sendSessionKey && !isQueueSend) {
        const ck = rootSessionKey(activeRoot, sendSessionKey);
        const cached =
          sessionCacheRef.current[ck] || ({ ...(session as any) } as Session);
        const prevExchanges = Array.isArray((cached as any).exchanges)
          ? ((cached as any).exchanges as Exchange[])
          : [];
        sessionCacheRef.current[ck] = {
          ...(cached as any),
          exchanges: [...prevExchanges, userEx],
          mode: effectiveAgentMode,
          effort: effectiveEffort,
          fast_service: effectiveFastService,
          shell: effectiveShell,
          updated_at: now,
        } as Session;
        session = sessionCacheRef.current[ck];
        bumpCacheVersion();
      } else if (!sendSessionKey) {
        const tempSessionKey = session?.key || "";
        pendingDraftRef.current = {
          rootId: activeRoot,
          mode: effectiveMode,
          agent: effectiveAgent,
          model: effectiveModel,
          agentMode: effectiveAgentMode,
          effort: effectiveEffort,
          fastService: effectiveFastService,
          shell: effectiveShell,
          message,
          timestamp: now,
          requestId,
          tempKey,
        };
        const draftSession = {
          ...(session as any),
          exchanges: [userEx],
          updated_at: now,
        } as Session;
        if (tempSessionKey) {
          setMultiProjectSessionPending(activeRoot, tempSessionKey, true);
          sessionCacheRef.current[rootSessionKey(activeRoot, tempSessionKey)] =
            draftSession;
          const draftItem = toSessionItem(activeRoot, {
            ...(draftSession as any),
            key: tempSessionKey,
            session_key: tempSessionKey,
            root_id: activeRoot,
            created_at: now,
            updated_at: now,
            pending: true,
          });
          if (draftItem) {
            setSessions((prev) => mergeSessionItems(prev, [draftItem]));
          }
          bumpCacheVersion();
        }
        session = draftSession;
      }
      const isBoundInMain =
        !!selectedSessionRef.current &&
        selectedSessionRef.current.key === sendSessionKey &&
        interactionModeRef.current !== "drawer";
      if (!isBoundInMain) {
        setInteractionMode("drawer");
        setDrawerOpenForRoot(activeRoot, true);
      }
      if (!isQueueSend) {
        setDrawerSessionForRoot(activeRoot, {
          ...(session as any),
          pending: true,
        } as Session);
      }
      const explicitFileContext = hasExplicitFileContext(message);
      const selection =
        explicitFileContext || !attachedFileContext?.filePath
          ? undefined
          : {
              filePath: attachedFileContext.filePath,
              startLine: attachedFileContext.startLine,
              endLine: attachedFileContext.endLine,
              text: attachedFileContext.text,
            };
      const context = buildClientContext({
        currentRoot: activeRoot,
        selection,
        pluginCatalog:
          effectiveMode === "plugin" ? getViewModeSystemPrompt() : undefined,
      });
      let outgoingMessage = message;
      const applyPendingPlanPrefix = pendingPlanMode && !sendSessionKey;
      const currentFile = fileRef.current;
      if (currentFile && !pluginBypassRef.current) {
        try {
          const pluginInput = toPluginInput(currentFile, pluginQueryRef.current);
          const plugin = pluginManagerRef.current.match(activeRoot, pluginInput);
          if (plugin?.viewContext) {
            outgoingMessage = buildMessageWithViewContext(
              message,
              pluginManagerRef.current.viewContext(plugin, pluginInput),
            );
          }
        } catch (err) {
          console.warn("[plugin/view-context] failed", err);
        }
      }
      if (applyPendingPlanPrefix) {
        outgoingMessage = `/plan ${outgoingMessage}`;
      }
      const sent = await sessionService.sendMessage(
        activeRoot,
        sendSessionKey || undefined,
        outgoingMessage,
        effectiveMode,
        effectiveAgent,
        effectiveModel || undefined,
        effectiveAgentMode || undefined,
        effectiveEffort || undefined,
        effectiveFastService,
        context,
        effectiveShell || undefined,
        requestId,
        newSessionWorktree,
      );
      if (sent && applyPendingPlanPrefix) {
        setPendingPlanMode(false);
      }
      console.info("[session/send] dispatched", { requestId, rootId: activeRoot, sessionKey: sendSessionKey || null, tempKey: tempKey || null, sent });
      if (!sent) {
        console.warn("[session/send] dispatch_failed", { requestId, rootId: activeRoot, sessionKey: sendSessionKey || null });
        reportError("network.disconnected", t("session.messageSendFailedNotReady"), {
          details: {
            requestId,
            rootId: activeRoot,
            sessionKey: sendSessionKey || null,
          },
        });
        delete pendingRequestRef.current[requestId];
      }
      if (!sent && sendSessionKey) {
        const failedSessionKey = sendSessionKey;
        setSelectedPendingByKey(failedSessionKey, false);
        setSessions((prev) =>
          prev.map((item) => {
            const itemKey = item.key || item.session_key;
            if (itemKey !== failedSessionKey) {
              return item;
            }
            return { ...(item as any), pending: false } as SessionItem;
          }),
        );
        const latest = drawerSessionByRootRef.current[activeRoot];
        if (latest && latest.key === failedSessionKey) {
          setDrawerSessionForRoot(activeRoot, {
            ...(latest as any),
            pending: false,
          } as Session);
        }
      }
      if (!sent && !sendSessionKey && tempKey) {
        setMultiProjectSessionPending(activeRoot, tempKey, false);
        setSessions((prev) =>
          prev.filter((item) => (item.key || item.session_key) !== tempKey),
        );
        delete sessionCacheRef.current[rootSessionKey(activeRoot, tempKey)];
        if (boundSessionByRootRef.current[activeRoot] === tempKey) {
          setBoundSessionForRoot(activeRoot, null);
        }
        const latest = drawerSessionByRootRef.current[activeRoot];
        if (latest && latest.key === tempKey) {
          setDrawerSessionForRoot(activeRoot, {
            ...(latest as any),
            pending: false,
          } as Session);
        }
      }
    },
    [
      attachedFileContext,
      rootSessionKey,
      mergeSessionItems,
      setSelectedPendingByKey,
      bumpCacheVersion,
      clearSlashCommandResultForSession,
      slashCommandResults,
      setBoundSessionForRoot,
      setDrawerOpenForRoot,
      setDrawerSessionForRoot,
      setMultiProjectSessionPending,
      updateSessionAgentForKey,
      pendingPlanMode,
    ],
  );

  const handleRunAgentLifecycleCommand = useCallback(
    async (agentName: string, action: "install" | "update", commands: string[]) => {
      const activeRoot = currentRootIdRef.current;
      if (!activeRoot) {
        throw new Error(t("root.noProjectForCommand"));
      }
      const script = commands.map((command) => command.trim()).filter(Boolean).join("\n");
      if (!script) {
        throw new Error(t("agentConfig.noCommand"));
      }
      const previousBoundKey = boundSessionByRootRef.current[activeRoot];
      if (previousBoundKey && !previousBoundKey.startsWith("pending-")) {
        suppressedAutoBindSessionByRootRef.current[activeRoot] = previousBoundKey;
      }
      selectedSessionRef.current = null;
      currentSessionRef.current = null;
      setSelectedSession(null);
      selectedSessionByRootRef.current[activeRoot] = null;
      setBoundSessionForRoot(activeRoot, null);
      setDrawerSessionForRoot(activeRoot, null);
      setInteractionMode("drawer");
      setDrawerOpenForRoot(activeRoot, true);
      await handleSendMessage(script, "command", "");
      console.info("[agent/lifecycle] command dispatched", {
        agent: agentName,
        action,
        commandCount: commands.length,
      });
    },
    [
      handleSendMessage,
      setBoundSessionForRoot,
      setDrawerOpenForRoot,
      setDrawerSessionForRoot,
      t,
    ],
  );

  const handleRestartAgent = useCallback(async (agentName: string) => {
    await restartAgent(agentName);
    const items = await fetchAgents(true);
    setAvailableAgents(items);
    setAgentsVersion((v) => v + 1);
  }, []);

  const handleCancelCurrentTurn = useCallback(
    async (sessionKey: string) => {
      const activeRoot = currentRootIdRef.current;
      if (!activeRoot || !sessionKey) return;
      const cacheKey = rootSessionKey(activeRoot, sessionKey);
      cancelRequestedBySessionRef.current[cacheKey] = true;
      const sent = await sessionService.cancelMessage(activeRoot, sessionKey);
      if (!sent) {
        delete cancelRequestedBySessionRef.current[cacheKey];
        return;
      }
      clearLocalPendingForSession(activeRoot, sessionKey);
    },
    [clearLocalPendingForSession, rootSessionKey],
  );

  const markSessionPending = useCallback(
    (rootID: string, sessionKey: string) => {
      if (!rootID || !sessionKey) return;
      const now = new Date().toISOString();
      const cacheKey = rootSessionKey(rootID, sessionKey);
      const cached = sessionCacheRef.current[cacheKey];
      if (cached) {
        sessionCacheRef.current[cacheKey] = {
          ...(cached as any),
          pending: true,
          updated_at: now,
        } as Session;
        bumpCacheVersion();
      }
      setSelectedPendingByKey(sessionKey, true);
      const drawer = drawerSessionByRootRef.current[rootID];
      if (drawer && (drawer.key || (drawer as any).session_key) === sessionKey) {
        setDrawerSessionForRoot(rootID, {
          ...(drawer as any),
          pending: true,
          updated_at: now,
        } as Session);
      }
      if (currentRootIdRef.current === rootID) {
        setSessions((prev) =>
          prev.map((item) => {
            const itemKey = item.key || item.session_key;
            if (itemKey !== sessionKey) {
              return item;
            }
            return {
              ...(item as any),
              pending: true,
              updated_at: now,
            } as SessionItem;
          }),
        );
      }
      setMultiProjectSessionPending(rootID, sessionKey, true);
    },
    [bumpCacheVersion, rootSessionKey, setDrawerSessionForRoot, setMultiProjectSessionPending, setSelectedPendingByKey],
  );

  const handleRemoveQueuedMessage = useCallback(
    async (queueId: string) => {
      const activeRoot = currentRootIdRef.current;
      const selected = selectedSessionRef.current;
      const selectedRoot =
        (selected?.root_id as string | undefined) || activeRoot || "";
      const selectedKey = selected?.key || selected?.session_key || "";
      const sessionKey =
        interactionModeRef.current !== "drawer" &&
        selectedRoot === activeRoot &&
        selectedKey &&
        !selectedKey.startsWith("pending-")
          ? selectedKey
          : boundSessionByRootRef.current[activeRoot || ""] || "";
      if (!activeRoot || !sessionKey || !queueId) return;
      await sessionService.removeQueuedMessage(activeRoot, sessionKey, queueId);
    },
    [],
  );

  const handleUpdateQueuedMessage = useCallback(
    async (queueId: string, content: string) => {
      const activeRoot = currentRootIdRef.current;
      const selected = selectedSessionRef.current;
      const selectedRoot =
        (selected?.root_id as string | undefined) || activeRoot || "";
      const selectedKey = selected?.key || selected?.session_key || "";
      const sessionKey =
        interactionModeRef.current !== "drawer" &&
        selectedRoot === activeRoot &&
        selectedKey &&
        !selectedKey.startsWith("pending-")
          ? selectedKey
          : boundSessionByRootRef.current[activeRoot || ""] || "";
      if (!activeRoot || !sessionKey || !queueId || !content.trim()) return;
      await sessionService.updateQueuedMessage(activeRoot, sessionKey, queueId, content);
    },
    [],
  );

  const handleSendQueuedMessageNow = useCallback(
    async (queueId: string) => {
      const activeRoot = currentRootIdRef.current;
      const selected = selectedSessionRef.current;
      const selectedRoot =
        (selected?.root_id as string | undefined) || activeRoot || "";
      const selectedKey = selected?.key || selected?.session_key || "";
      const sessionKey =
        interactionModeRef.current !== "drawer" &&
        selectedRoot === activeRoot &&
        selectedKey &&
        !selectedKey.startsWith("pending-")
          ? selectedKey
          : boundSessionByRootRef.current[activeRoot || ""] || "";
      if (!activeRoot || !sessionKey || !queueId) return;
      const cacheKey = rootSessionKey(activeRoot, sessionKey);
      const previousQueue = queuedMessagesBySessionRef.current[cacheKey] || [];
      const nextQueue = previousQueue.filter((item) => item.id !== queueId);
      queuedMessagesBySessionRef.current[cacheKey] = nextQueue;
      if (!optimisticDequeuedIdsRef.current[cacheKey]) {
        optimisticDequeuedIdsRef.current[cacheKey] = new Set();
      }
      optimisticDequeuedIdsRef.current[cacheKey].add(queueId);
      setQueueVersion((v) => v + 1);
      markSessionPending(activeRoot, sessionKey);
      const sent = await sessionService.sendQueuedMessageNow(activeRoot, sessionKey, queueId);
      if (!sent) {
        optimisticDequeuedIdsRef.current[cacheKey]?.delete(queueId);
        queuedMessagesBySessionRef.current[cacheKey] = previousQueue;
        setQueueVersion((v) => v + 1);
      }
    },
    [markSessionPending, rootSessionKey],
  );

  const handleNewSession = useCallback(() => {
    const rootID = currentRootIdRef.current;
    const previousBoundKey = rootID ? boundSessionByRootRef.current[rootID] : "";
    if (rootID && previousBoundKey && !previousBoundKey.startsWith("pending-")) {
      suppressedAutoBindSessionByRootRef.current[rootID] = previousBoundKey;
    }
    setMainViewPreferenceForRoot(rootID, "session");
    selectedSessionRef.current = null;
    currentSessionRef.current = null;
    interactionModeRef.current = "main";
    setSelectedSession(null);
    if (rootID) {
      selectedSessionByRootRef.current[rootID] = null;
    }
    setBoundSessionForRoot(rootID, null);
    setDrawerSessionForRoot(rootID, null);
    setInteractionMode("main");
    setDrawerOpenForRoot(rootID, false);
  }, [
    setBoundSessionForRoot,
    setDrawerOpenForRoot,
    setDrawerSessionForRoot,
    setMainViewPreferenceForRoot,
  ]);

  const currentSelectionSource = useMemo(() => {
    if (file?.path) {
      return {
        path: file.path,
        name: file.name || basenameOfPath(file.path),
      };
    }
    if (gitDiff?.path) {
      return {
        path: gitDiff.path,
        name: basenameOfPath(gitDiff.path),
      };
    }
    return null;
  }, [file, gitDiff]);

  const buildAttachedFileContext = useCallback(
    (
      currentSource: { path: string; name: string } | null,
      selection: ViewerSelection | null,
    ): AttachedFileContext | null => {
      if (!currentSource?.path) {
        return null;
      }
      const matchesCurrentFile = selection?.filePath === currentSource.path;
      return {
        filePath: currentSource.path,
        fileName: currentSource.name,
        startLine: matchesCurrentFile ? selection?.startLine : undefined,
        endLine: matchesCurrentFile ? selection?.endLine : undefined,
        text: matchesCurrentFile ? selection?.text : undefined,
      };
    },
    [],
  );

  const handleRequestFileContext = useCallback(() => {
    const currentSource = currentSelectionSource;
    if (
      dismissedSelectionFileRef.current &&
      dismissedSelectionFileRef.current === currentSource?.path
    ) {
      return;
    }
    const liveSelection = viewerSelectionRef.current;
    const fallbackSelection = lastViewerSelectionRef.current;
    const nextSelection =
      liveSelection?.filePath === currentSource?.path
        ? liveSelection
        : fallbackSelection?.filePath === currentSource?.path
          ? fallbackSelection
          : null;
    const next = buildAttachedFileContext(currentSource, nextSelection);
    setAttachedFileContext(next);
  }, [buildAttachedFileContext, currentSelectionSource]);

  const handleClearFileContext = useCallback(() => {
    dismissedSelectionFileRef.current = currentSelectionSource?.path || null;
    lastViewerSelectionRef.current = null;
    setAttachedFileContext(null);
  }, [currentSelectionSource]);

  const handleViewerSelectionChange = useCallback(
    (next: ViewerSelection | null) => {
      setViewerSelection(next);
      if (next?.filePath) {
        dismissedSelectionFileRef.current = null;
        lastViewerSelectionRef.current = next;
      }
    },
    [],
  );

  useEffect(() => {
    const currentPath = currentSelectionSource?.path;
    if (!currentPath) {
      dismissedSelectionFileRef.current = null;
      lastViewerSelectionRef.current = null;
      setViewerSelection(null);
      setAttachedFileContext(null);
      return;
    }
    if (
      dismissedSelectionFileRef.current &&
      dismissedSelectionFileRef.current !== currentPath
    ) {
      dismissedSelectionFileRef.current = null;
    }
    if (lastViewerSelectionRef.current?.filePath !== currentPath) {
      lastViewerSelectionRef.current = null;
    }
    setViewerSelection((prev) =>
      prev?.filePath === currentPath ? prev : null,
    );
    setAttachedFileContext((prev) => {
      if (!prev) {
        return prev;
      }
      if (prev.filePath !== currentPath) {
        return null;
      }
      return prev;
    });
  }, [currentSelectionSource?.path]);

  useEffect(() => {
    const currentPath = currentSelectionSource?.path;
    setAttachedFileContext((prev) => {
      if (!prev || prev.filePath !== currentPath) {
        return prev;
      }
      if (!viewerSelection || viewerSelection.filePath !== currentPath) {
        return prev;
      }
      return buildAttachedFileContext(currentSelectionSource, viewerSelection);
    });
  }, [buildAttachedFileContext, currentSelectionSource, viewerSelection]);

  const rememberCurrentFileScroll = useCallback(() => {
    const currentFile = fileRef.current;
    const key = buildFileScrollKey(
      currentFile?.root || currentRootIdRef.current,
      currentFile?.path,
    );
    if (!key) return;
    if (!(key in fileScrollPositionsRef.current)) {
      fileScrollPositionsRef.current[key] = 0;
      persistFileScrollPositions(fileScrollPositionsRef.current);
    }
  }, []);

  const actionHandlers = useMemo(
    () => ({
      open: async (params: any) => {
        const requestId = ++fileOpenRequestRef.current;
        if (!params?.preserveRelatedSelection) {
          setRelatedSelectedFileKey("");
        }
        const isStale = () => fileOpenRequestRef.current !== requestId;
        const parsedLocation = parseFileLocation(String(params.path || ""));
        const root = params.root || currentRootIdRef.current;
        const rootInfo = root
          ? managedRootByIdRef.current[String(root)]
          : undefined;
        const path = normalizePathForRoot(
          parsedLocation.path,
          rootInfo?.root_path,
        );
        if (!path || !root) return;
        setMainViewPreferenceForRoot(String(root), "file");
        rememberCurrentFileScroll();
        setGitDiff(null);
        const currentFilePath = fileRef.current?.path || "";
        const currentFileRoot =
          fileRef.current?.root || currentRootIdRef.current || "";
        const isFileSwitch =
          currentFilePath !== String(path) || currentFileRoot !== String(root);
        if (isFileSwitch) {
          pluginBypassRef.current = false;
          setPluginBypass(false);
          // Only tear down the current file view when switching to a different file/root.
          // Reopening the same file (for example from session view back to file view) should
          // preserve the existing scroll position and DOM state until fresh content arrives.
          setFile(null);
        }
        if (currentRootIdRef.current !== root) {
          setCurrentRootId(root);
        }
        setSelectedDir(String(root));
        setSelectedDirKey(null);
        const requestedCursor = normalizeCursor(params.cursor);
        const cursor = requestedCursor === null ? 0 : requestedCursor;
        const preserveQuery = !!params.preservePluginQuery;
        const persistedQuery = loadPersistedPluginQuery(
          String(root),
          String(path),
        );
        const urlQuery = preserveQuery
          ? parsePluginQuery(window.location.search)
          : {};
        // Priority: URL query > localStorage persisted query.
        const nextPluginQuery = preserveQuery
          ? { ...persistedQuery, ...urlQuery }
          : persistedQuery;
        setPluginQuery(nextPluginQuery);
        replaceURLState({
          root,
          file: path,
          session: "",
          cursor,
          pluginQuery: nextPluginQuery,
        });
        persistPluginQuery(String(root), String(path), nextPluginQuery);

        const expandAndLoadTreeForFile = async () => {
          const dirs = parentDirsOfFile(String(path));
          setExpanded((prev) => {
            const next = new Set(prev);
            next.add(String(root));
            dirs.forEach((dir) => next.add(`${root}:${dir}`));
            return Array.from(next);
          });
          const toLoad = [".", ...dirs];
          for (const dir of toLoad) {
            const cacheKey = treeCacheKey(String(root), dir);
            if (
              Object.prototype.hasOwnProperty.call(
                entriesByPathRef.current,
                cacheKey,
              ) &&
              !invalidTreeCacheKeysRef.current.has(cacheKey)
            ) {
              continue;
            }
            try {
              const payload = await apiProtectedJSON<any>(
                appURL(
                  "/api/tree",
                  new URLSearchParams({ root: String(root), dir }),
                ),
              );
              const parsed = normalizeTreeResponse(payload);
              invalidTreeCacheKeysRef.current.delete(cacheKey);
              setEntriesByPath((prev) => ({
                ...prev,
                [cacheKey]: parsed.entries,
              }));
            } catch {}
          }
        };

        void expandAndLoadTreeForFile();
        try {
          const fetchFileWithMode = async (
            mode: "full" | "incremental",
            timeoutMs?: number,
          ) =>
            fetchFile({
              rootId: String(root),
              path: String(path),
              readMode: mode,
              cursor,
              timeoutMs,
            });

          let readMode: "incremental" | "full" =
            params.readMode === "full" ? "full" : "incremental";
          let requiresFull = params.readMode === "full";
          if (params.readMode !== "full" && params.readMode !== "incremental") {
            const currentFilePath = fileRef.current?.path || "";
            const currentFileRoot =
              fileRef.current?.root || currentRootIdRef.current || "";
            const targetPath = String(path);
            const targetRoot = String(root);
            const sameFileReload =
              pluginBypassRef.current &&
              currentFilePath === targetPath &&
              currentFileRoot === targetRoot;

            if (sameFileReload) {
              readMode = "incremental";
            } else {
              try {
                const plugin = pluginManagerRef.current.match(
                  root,
                  buildMatchInputFromPath(path, nextPluginQuery),
                );
                readMode = inferReadModeFromPlugin(plugin);
                requiresFull = readMode === "full";
              } catch {
                readMode = "incremental";
              }
            }
          }
          const cached = await getCachedFile({
            rootId: String(root),
            path: String(path),
            readMode,
            cursor,
          });
          if (cached && !isStale()) {
            setFile({
              ...cached,
              targetLine: parsedLocation.targetLine,
              targetColumn: parsedLocation.targetColumn,
            });
          }

          let next: FilePayload | null;
          try {
            next = await fetchFileWithMode(
              readMode,
              requiresFull ? undefined : readMode === "full" ? 1500 : undefined,
            );
          } catch (err) {
            if (readMode === "full" && !requiresFull) {
              next = await fetchFileWithMode("incremental");
              readMode = "incremental";
            } else {
              throw err;
            }
          }
          if (isStale()) {
            return;
          }
          if (next) {
            setFile({
              ...next,
              targetLine: parsedLocation.targetLine,
              targetColumn: parsedLocation.targetColumn,
            });
          }
          fileCursorRef.current = cursor;
          setSelectedSession(null);
          setSelectedSessionLoading(false);
          setDrawerOpenForRoot(root, false);
          if (isMobile) setIsLeftOpen(false);
        } catch (err) {
          const status = extractHTTPStatusFromErrorMessage(
            (err as Error)?.message || "",
          );
          if (status && (await handleRelayNavigationFailure(status, ""))) {
            return;
          }
          console.error("[file.open] failed", { root, path, cursor, err });
        }
      },
      open_dir: async (params: any) => {
        fileOpenRequestRef.current += 1;
        const path = params.path,
          rootParam = params.root || currentRootIdRef.current,
          isToggle = !!params.toggle,
          forceDirectory = !!params.forceDirectory,
          suppressTreeExpand = !!params.suppressTreeExpand;
        if (!path || !rootParam) return;
        setGitDiff(null);
        const isActuallyRoot = params.isRoot === true;
        const root = isActuallyRoot ? path : rootParam;
        const expandedKey = isActuallyRoot ? path : `${root}:${path}`;
        const preserveCollapsedRoot =
          isActuallyRoot &&
          suppressTreeExpand &&
          !expandedRef.current.includes(expandedKey);
        const restoreSuppressedRootExpansion = () => {
          if (!preserveCollapsedRoot) {
            return;
          }
          setExpanded((prev) => prev.filter((k) => k !== expandedKey));
        };
        const preserveQuery = !!params.preservePluginQuery;
        const nextPluginQuery = preserveQuery
          ? parsePluginQuery(window.location.search)
          : {};
        const loadDirectoryView = async (
          targetPath: string,
          targetIsRoot: boolean,
        ) => {
          const apiDir = targetIsRoot ? "." : targetPath;
          const cacheKey = treeCacheKey(root, apiDir);
          if (currentRootIdRef.current !== root) {
            setCurrentRootId(root);
          }
          setMainViewPreferenceForRoot(root, "directory");
          setFile(null);
          setSelectedSession(null);
          setSelectedSessionLoading(false);
          setMainEntries([]);
          setMainDirectoryError("");
          setPluginQuery(nextPluginQuery);
          replaceURLState({
            root,
            file: "",
            session: "",
            cursor: 0,
            pluginQuery: nextPluginQuery,
          });
          const cachedEntries = entriesByPathRef.current[cacheKey];
          if (
            Object.prototype.hasOwnProperty.call(
              entriesByPathRef.current,
              cacheKey,
            ) &&
            !invalidTreeCacheKeysRef.current.has(cacheKey)
          ) {
            setMainEntries(cachedEntries || []);
            setMainDirectoryError("");
            setSelectedDir(targetPath);
            setSelectedDirKey(
              buildDirectorySelectionKey(root, targetPath, targetIsRoot),
            );
            setFile(null);
            setSelectedSession(null);
            setSelectedSessionLoading(false);
            fileCursorRef.current = 0;
            setDrawerOpenForRoot(root, false);
            if (!isToggle && isMobile) setIsLeftOpen(false);
            return;
          }
          try {
            const payload = await apiProtectedJSON<any>(
              appURL("/api/tree", new URLSearchParams({ root, dir: apiDir })),
            );
            const parsed = normalizeTreeResponse(payload);
            invalidTreeCacheKeysRef.current.delete(cacheKey);
            setMainDirectoryError("");
            setEntriesByPath((prev) => ({
              ...prev,
              [cacheKey]: parsed.entries,
            }));
            setMainEntries(parsed.entries);
            setSelectedDir(targetPath);
            setSelectedDirKey(
              buildDirectorySelectionKey(root, targetPath, targetIsRoot),
            );
            setFile(null);
            setSelectedSession(null);
            setSelectedSessionLoading(false);
            fileCursorRef.current = 0;
            setDrawerOpenForRoot(root, false);
            if (!isToggle && isMobile) setIsLeftOpen(false);
          } catch (error) {
            if (error instanceof ProtectedAPIError) {
              if (
                await handleRelayNavigationFailure(
                  error.status,
                  typeof error.payload?.error === "string" ? error.payload.error : "",
                )
              ) {
                return;
              }
              const message = formatDirectoryLoadError(
                typeof error.payload?.error === "string" ? error.payload.error : "",
              );
              setSelectedDir(targetPath);
              setSelectedDirKey(
                buildDirectorySelectionKey(root, targetPath, targetIsRoot),
              );
              setMainEntries([]);
              setMainDirectoryError(message);
              reportError("file.read_failed", message);
              return;
            }
            const message = t("directory.loadFailedRetry");
            setSelectedDir(targetPath);
            setSelectedDirKey(
              buildDirectorySelectionKey(root, targetPath, targetIsRoot),
            );
            setMainEntries([]);
            setMainDirectoryError(message);
            reportError("file.read_failed", message);
          }
        };
        const isExpanded = expandedRef.current.includes(expandedKey);
        const isCurrentExpandedRoot =
          isActuallyRoot && isExpanded && currentRootIdRef.current === root;
        if (
          isToggle &&
          ((!isActuallyRoot && isExpanded) || isCurrentExpandedRoot)
        ) {
          setExpanded((prev) => prev.filter((k) => k !== expandedKey));
          if (!isActuallyRoot) {
            const parentDir = dirnameOfPath(path);
            const parentPath = parentDir === "." ? root : parentDir;
            await loadDirectoryView(parentPath, parentDir === ".");
          }
          return;
        }
        if (isActuallyRoot) {
          setCurrentRootId(path);
          if (!suppressTreeExpand) {
            setExpanded((prev) => Array.from(new Set([...prev, path])));
          }
          if (!forceDirectory) {
            const restored = await tryShowBoundSessionForRoot(path, {
              pluginQuery: nextPluginQuery,
              closeLeftSidebar: !isToggle,
            });
            if (restored) {
              void loadSessionsForRoot(path, { replace: true, force: true });
              await refreshTreeDir(path, ".", false);
              restoreSuppressedRootExpansion();
              return;
            }
          }
        } else {
          setExpanded((prev) => Array.from(new Set([...prev, expandedKey])));
        }
        await loadDirectoryView(path, isActuallyRoot);
        restoreSuppressedRootExpansion();
      },
    }),
    [
      handleRelayNavigationFailure,
      isMobile,
      normalizeTreeResponse,
      setMainViewPreferenceForRoot,
      setDrawerOpenForRoot,
      replaceURLState,
      rememberCurrentFileScroll,
      treeCacheKey,
      tryShowBoundSessionForRoot,
      loadSessionsForRoot,
    ],
  );
  const actionHandlersRef = useRef(actionHandlers);
  useEffect(() => {
    actionHandlersRef.current = actionHandlers;
  }, [actionHandlers]);

  const openRelatedFileDiff = useCallback(
    async (rootID: string, file: RelatedFileClickTarget) => {
      const path = String(file?.path || "").trim();
      const head = String(file?.head || "").trim();
      const repoKind = String(file?.repo_kind || "").trim();
      if (!rootID || !path) {
        return;
      }
      setRelatedSelectedFileKey(relatedFileSelectionKey(file));
      if (repoKind === "plain") {
        actionHandlers.open({ path, root: rootID, preserveRelatedSelection: true });
        return;
      }
      if (!head && !file?.repo_path) {
        const gitItem = (gitStatus?.items || []).find(
          (item) => item.path === path,
        );
        if (gitItem) {
          void openGitDiff(rootID, gitItem, { preserveRelatedSelection: true });
          return;
        }
        actionHandlers.open({ path, root: rootID, preserveRelatedSelection: true });
        return;
      }
      fileOpenRequestRef.current += 1;
      setMainViewPreferenceForRoot(rootID, "git-diff");
      setSelectedSession(null);
      setSelectedSessionLoading(false);
      setFile(null);
      setGitDiff(null);
      replaceURLState({
        root: rootID,
        file: "",
        session: "",
        cursor: 0,
        pluginQuery: {},
      });
      try {
        const next = await fetchGitRelatedFileDiff(rootID, file);
        const rootPath = managedRootByIdRef.current[rootID]?.root_path;
        const repoPath = String(file?.repo_path || "").trim();
        const displayPath = repoPath
          ? relativeDisplayPathFromRoot(rootPath, joinDisplayPath(repoPath, path))
          : path;
        if (displayPath) {
          next.display_path = displayPath;
        }
        setGitDiff(next);
        if (currentRootIdRef.current !== rootID) {
          setCurrentRootId(rootID);
        }
        if (isMobile) {
          setIsLeftOpen(false);
        }
      } catch (err) {
        const message =
      err instanceof Error ? err.message : t("git.relatedFileDiffFailed");
        console.error("[git.related-file.diff] failed", {
          rootID,
          path,
          head,
          err,
        });
        reportError("git.related_file_diff_failed", message, {
          severity: "warning",
          recoverable: true,
          details: {
            root: rootID,
            path,
            head,
            payload: err instanceof ProtectedAPIError ? err.payload : undefined,
          },
        });
      }
    },
    [
      actionHandlers,
      gitStatus,
      isMobile,
      openGitDiff,
      replaceURLState,
      setMainViewPreferenceForRoot,
    ],
  );

  const loadManagedRootPayloads = useCallback(async () => {
    if (bootstrapService.snapshot().phase !== "ready") {
      return null;
    }
    if (managedRootsRequestRef.current) {
      return managedRootsRequestRef.current;
    }
    const request = (async () => {
      try {
        const dirs = await apiProtectedJSON<ManagedRootPayload[]>(appPath("/api/dirs"));
        return Array.isArray(dirs) ? dirs : [];
      } catch (error) {
        if (!(error instanceof ProtectedAPIError)) {
          return null;
        }
        if (
          await handleRelayNavigationFailure(
            error.status,
            typeof error.payload?.error === "string" ? error.payload.error : "",
          )
        ) {
          return null;
        }
        return null;
      }
    })().finally(() => {
      managedRootsRequestRef.current = null;
    });
    managedRootsRequestRef.current = request;
    return request;
  }, [bootstrapState.phase, handleRelayNavigationFailure]);

  const refreshManagedRoots = useCallback(async () => {
    const dirs = await loadManagedRootPayloads();
    if (!dirs) {
      return;
    }
    const nextDirs = Array.isArray(dirs) ? dirs : [];
    syncRelayNodesToNative(nextDirs);
    const nextRootIds = nextDirs.map((dir) => dir.id).filter(Boolean);
    const previousRootById = managedRootByIdRef.current;
    const nextRootById = Object.fromEntries(
      nextDirs.filter((dir) => !!dir.id).map((dir) => [dir.id, dir]),
    );
    let clearedRootScopedState = false;
    for (const rootID of Object.keys(previousRootById)) {
      if (!(rootID in nextRootById)) {
        clearRootScopedClientState(rootID, { removeLastRoot: true });
        clearedRootScopedState = true;
      }
    }
    for (const rootID of nextRootIds) {
      const previousPath = comparableManagedRootPath(previousRootById[rootID]?.root_path);
      const nextPath = comparableManagedRootPath(nextRootById[rootID]?.root_path);
      if (previousPath && nextPath && previousPath !== nextPath) {
        clearRootScopedClientState(rootID);
        clearedRootScopedState = true;
      }
    }
    managedRootByIdRef.current = nextRootById;
    if (clearedRootScopedState && multiProjectSessionsEnabled) {
      void refreshMultiProjectReplyingSessions();
      void loadMultiProjectSessionGroups();
    }

    managedRootIdsRef.current = new Set(nextRootIds);
    setManagedRootIds(nextRootIds);
    setRootEntries(mapManagedRootsToEntries(nextDirs));
    Object.keys(selectedSessionByRootRef.current).forEach((rootID) => {
      if (!nextRootIds.includes(rootID)) {
        delete selectedSessionByRootRef.current[rootID];
      }
    });

    if (nextRootIds.length === 0) {
      setCurrentRootId(null);
      setSelectedDir(null);
      setSelectedDirKey(null);
      setMainEntries([]);
      setFile(null);
      setSelectedSession(null);
      setSelectedSessionLoading(false);
      setSessions([]);
      setCurrentSession(null);
      setActiveBoundSessionKey(null);
      selectedSessionByRootRef.current = {};
      setInteractionMode("main");
      setIsDrawerOpen(false);
      replaceURLState({
        root: "",
        file: "",
        session: "",
        cursor: 0,
        pluginQuery: {},
      });
      return;
    }

    const currentRoot = currentRootIdRef.current;
    if (currentRoot && nextRootIds.includes(currentRoot)) {
      return;
    }

    const lastRoot = loadLastRootId();
    const nextRoot =
      lastRoot && nextRootIds.includes(lastRoot) ? lastRoot : nextRootIds[0];
    await actionHandlersRef.current.open_dir({
      path: nextRoot,
      root: nextRoot,
      preservePluginQuery: true,
      isRoot: true,
    });
  }, [
    clearRootScopedClientState,
    loadManagedRootPayloads,
    loadMultiProjectSessionGroups,
    multiProjectSessionsEnabled,
    refreshMultiProjectReplyingSessions,
    replaceURLState,
  ]);

  const applyManagedRootRename = useCallback(
    (oldRootID: string, rootPayload: ManagedRootPayload | null | undefined) => {
      const oldID = String(oldRootID || "").trim();
      const nextID = String(rootPayload?.id || "").trim();
      if (!oldID || !nextID) {
        return false;
      }

      const previousRoot =
        managedRootByIdRef.current[oldID] ||
        managedRootByIdRef.current[nextID] ||
        ({} as ManagedRootPayload);
      const nextRoot = {
        ...previousRoot,
        ...rootPayload,
        id: nextID,
      } as ManagedRootPayload;

      const nextRootById = { ...managedRootByIdRef.current };
      delete nextRootById[oldID];
      nextRootById[nextID] = nextRoot;
      managedRootByIdRef.current = nextRootById;

      const moveRecordKey = <T,>(record: Record<string, T>) => {
        if (oldID === nextID || !(oldID in record)) {
          return;
        }
        record[nextID] = record[oldID];
        delete record[oldID];
      };
      moveRecordKey(boundSessionByRootRef.current);
      moveRecordKey(suppressedAutoBindSessionByRootRef.current);
      moveRecordKey(drawerSessionByRootRef.current);
      moveRecordKey(selectedSessionByRootRef.current);
      moveRecordKey(mainViewPreferenceByRootRef.current);
      moveRecordKey(drawerOpenByRootRef.current);
      moveRecordKey(pluginsLoadedByRootRef.current);
      moveRecordKey(pluginsLoadingByRootRef.current);

      const moveStateRecord = <T,>(record: Record<string, T>) => {
        if (oldID === nextID || !(oldID in record)) {
          return record;
        }
        const next = { ...record, [nextID]: record[oldID] };
        delete next[oldID];
        return next;
      };
      setGitStatusExpandedByRoot((prev) => moveStateRecord(prev));
      setGitHistoryExpandedByRoot((prev) => moveStateRecord(prev));
      setMainContentViewByRoot((prev) => moveStateRecord(prev));

      const moveCacheRecord = <T,>(record: Record<string, T>) => {
        if (oldID === nextID) {
          return;
        }
        const oldPrefix = `${oldID}::`;
        for (const key of Object.keys(record)) {
          if (!key.startsWith(oldPrefix)) {
            continue;
          }
          const nextKey = `${nextID}::${key.slice(oldPrefix.length)}`;
          record[nextKey] = record[key];
          delete record[key];
        }
      };
      moveCacheRecord(sessionCacheRef.current);
      moveCacheRecord(loadedSessionRef.current);
      if (oldID !== nextID) {
        staleSessionKeysRef.current = new Set(
          Array.from(staleSessionKeysRef.current).map((key) =>
            key.startsWith(`${oldID}::`)
              ? `${nextID}::${key.slice(`${oldID}::`.length)}`
              : key,
          ),
        );
      }

      const moveTreeRecord = <T,>(record: Record<string, T>) => {
        if (oldID === nextID) {
          return record;
        }
        const next = { ...record };
        const oldPrefix = `${oldID}:`;
        for (const key of Object.keys(record)) {
          if (!key.startsWith(oldPrefix)) {
            continue;
          }
          const nextKey = `${nextID}:${key.slice(oldPrefix.length)}`;
          next[nextKey] = record[key];
          delete next[key];
        }
        return next;
      };
      entriesByPathRef.current = moveTreeRecord(entriesByPathRef.current);
      setEntriesByPath((prev) => moveTreeRecord(prev));
      if (oldID !== nextID) {
        invalidTreeCacheKeysRef.current = new Set(
          Array.from(invalidTreeCacheKeysRef.current).map((key) =>
            key.startsWith(`${oldID}:`)
              ? `${nextID}:${key.slice(`${oldID}:`.length)}`
              : key,
          ),
        );
      }

      setManagedRootIds((prev) => {
        const source = prev.length ? prev : Array.from(managedRootIdsRef.current);
        let replaced = false;
        const nextIds = source.map((id) => {
          if (id !== oldID) {
            return id;
          }
          replaced = true;
          return nextID;
        });
        if (!replaced && !nextIds.includes(nextID)) {
          nextIds.push(nextID);
        }
        const deduped = Array.from(new Set(nextIds.filter(Boolean)));
        managedRootIdsRef.current = new Set(deduped);
        setRootEntries(
          mapManagedRootsToEntries(
            deduped
              .map((id) => managedRootByIdRef.current[id])
              .filter((dir): dir is ManagedRootPayload => !!dir),
          ),
        );
        return deduped;
      });
      return true;
    },
    [],
  );

  const startRelayBinding = useCallback(async () => {
    return bootstrapService.startRelayBinding();
  }, []);

  const normalizeComparableRootPath = useCallback((value: string): string => {
    let normalized = String(value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
    if (/^[a-z]:/i.test(normalized)) {
      normalized = normalized.toLowerCase();
    }
    return normalized;
  }, []);

  const findManagedRootByPath = useCallback((path: string): ManagedRootPayload | null => {
    const target = normalizeComparableRootPath(path);
    if (!target) {
      return null;
    }
    for (const root of Object.values(managedRootByIdRef.current)) {
      if (normalizeComparableRootPath(root.root_path || "") === target) {
        return root;
      }
    }
    return null;
  }, [normalizeComparableRootPath]);

  const handleCreateRootStart = useCallback((parentPath?: string | null) => {
    if (creatingRootBusy) {
      return;
    }
    const existing = new Set(managedRootIdsRef.current);
    let nextName = "new-root";
    let suffix = 2;
    while (existing.has(nextName)) {
      nextName = `new-root-${suffix}`;
      suffix += 1;
    }
    setCreatingRootParentPath(
      parentPath && String(parentPath).trim() ? String(parentPath).trim() : null,
    );
    setCreatingRootKind("root");
    setCreatingRootName(nextName);
  }, [creatingRootBusy]);

  const loadWorktreeBranches = useCallback(async (rootID: string) => {
    setWorktreeBranchesLoading(true);
    setWorktreeBranchError("");
    try {
      const payload = await fetchGitBranches(rootID);
      setWorktreeBranches(payload);
    } catch (error) {
      setWorktreeBranches({ branches: [] });
      setWorktreeBranchError(error instanceof Error ? error.message : t("worktree.loadBranchFailed"));
    } finally {
      setWorktreeBranchesLoading(false);
    }
  }, [t]);

  const loadWorktreeList = useCallback(async (rootID: string) => {
    setWorktreeSwitchLoading(true);
    setWorktreeSwitchError("");
    try {
      const payload = await fetchGitWorktrees(rootID);
      setWorktreeSwitchItems(payload.items || []);
    } catch (error) {
      setWorktreeSwitchItems([]);
      setWorktreeSwitchError(error instanceof Error ? error.message : t("worktree.loadFailed"));
    } finally {
      setWorktreeSwitchLoading(false);
    }
  }, [t]);

  const loadProjectTreeWorktrees = useCallback(async (rootID: string) => {
    if (!rootID) {
      return;
    }
    setWorktreeLoadingByRoot((prev) => ({ ...prev, [rootID]: true }));
    setWorktreeErrorByRoot((prev) => ({ ...prev, [rootID]: "" }));
    try {
      const payload = await fetchGitWorktrees(rootID);
      (payload.items || []).forEach((item) => {
        if (item.path) {
          knownTaskWorktreePathsRef.current.add(item.path);
        }
      });
      setWorktreeItemsByRoot((prev) => ({
        ...prev,
        [rootID]: (payload.items || []).filter((item) => !!item.branch),
      }));
    } catch (error) {
      setWorktreeItemsByRoot((prev) => ({ ...prev, [rootID]: [] }));
      setWorktreeErrorByRoot((prev) => ({
        ...prev,
        [rootID]: error instanceof Error ? error.message : t("worktree.loadFailed"),
      }));
    } finally {
      setWorktreeLoadingByRoot((prev) => ({ ...prev, [rootID]: false }));
    }
  }, [t]);

  const loadProjectTreeWorktreeStatus = useCallback(async (worktreePath: string) => {
    if (!worktreePath) {
      return;
    }
    setWorktreeStatusLoadingByPath((prev) => ({ ...prev, [worktreePath]: true }));
    try {
      const status = await fetchGitStatusByPath(worktreePath);
      setWorktreeStatusByPath((prev) => ({ ...prev, [worktreePath]: status }));
    } catch (error) {
      console.error("[git.worktree.status] failed", { worktreePath, error });
      setWorktreeStatusByPath((prev) => ({
        ...prev,
        [worktreePath]: { available: false, dirty_count: 0, items: [] } as GitStatusPayload,
      }));
    } finally {
      setWorktreeStatusLoadingByPath((prev) => ({ ...prev, [worktreePath]: false }));
    }
  }, []);

  const handleCreateWorktreeStart = useCallback((parentPath: string) => {
    if (creatingRootBusy) {
      return;
    }
    const rootID = currentRootIdRef.current;
    if (!rootID) {
      return;
    }
    const existing = new Set(managedRootIdsRef.current);
    const baseName = `${rootID}-worktree`;
    let nextName = baseName;
    let suffix = 2;
    while (existing.has(nextName)) {
      nextName = `${baseName}-${suffix}`;
      suffix += 1;
    }
    setCreatingRootKind("worktree");
    setCreatingRootParentPath(parentPath);
    setCreatingRootName(nextName);
    setWorktreeBranchMode("new");
    setWorktreeBranch("");
    setWorktreeBranches({ branches: [] });
    setWorktreeBranchError("");
    void loadWorktreeBranches(rootID);
  }, [creatingRootBusy, loadWorktreeBranches]);

  const handleSwitchWorktreeStart = useCallback(() => {
    const rootID = currentRootIdRef.current;
    if (!rootID) {
      return;
    }
    setProjectAddMode(null);
    setCreatingRootName(null);
    setWorktreeSwitchOpen(true);
    setWorktreeSwitchItems([]);
    setWorktreeSwitchError("");
    void loadWorktreeList(rootID);
  }, [loadWorktreeList]);

  useEffect(() => {
    if (projectTreeTab !== "worktrees" || !currentRootId) {
      return;
    }
    if (worktreeItemsByRoot[currentRootId] || worktreeLoadingByRoot[currentRootId]) {
      return;
    }
    void loadProjectTreeWorktrees(currentRootId);
  }, [currentRootId, loadProjectTreeWorktrees, projectTreeTab, worktreeItemsByRoot, worktreeLoadingByRoot]);

  const handleSwitchWorktree = useCallback(async (item: GitWorktreeItem) => {
    const targetPath = String(item.path || "").trim();
    if (!targetPath || switchingWorktreePath) {
      return;
    }
    setSwitchingWorktreePath(targetPath);
    try {
      let targetRoot = findManagedRootByPath(targetPath);
      if (!targetRoot?.id) {
        const created = await apiProtectedJSON<ManagedRootPayload>(appPath("/api/dirs"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: targetPath, create: false }),
        });
        targetRoot = created;
        await refreshManagedRoots();
      }
      if (targetRoot?.id) {
        setWorktreeSwitchOpen(false);
        await actionHandlersRef.current.open_dir({
          path: targetRoot.id,
          root: targetRoot.id,
          isRoot: true,
          forceDirectory: true,
        });
        return targetRoot.id;
      }
    } catch (error) {
      reportError(
        "git.worktree_switch_failed",
        managedDirAddErrorMessage(error, t("root.switchWorktreeFailed"), t),
      );
    } finally {
      setSwitchingWorktreePath("");
    }
    return undefined;
  }, [findManagedRootByPath, refreshManagedRoots, switchingWorktreePath, t]);

  const handleOpenProjectAdd = useCallback(() => {
    if (creatingRootBusy) {
      return;
    }
    setProjectAddMode("mode");
  }, [creatingRootBusy]);

  const inferParentPath = useCallback((absolutePath: string): string => {
    const trimmed = absolutePath.trim().replace(/[\\/]+$/, "");
    const parts = trimmed.split(/[\\/]/).filter(Boolean);
    if (parts.length <= 1) {
      return "";
    }
    if (/^[A-Za-z]:/.test(trimmed)) {
      const drive = parts[0];
      const rest = parts.slice(1, -1);
      return rest.length > 0 ? `${drive}\\${rest.join("\\")}` : `${drive}\\`;
    }
    if (trimmed.startsWith("/")) {
      return `/${parts.slice(0, -1).join("/")}`;
    }
    return parts.slice(0, -1).join("/");
  }, []);

  const loadLocalDirs = useCallback(async (path: string) => {
    const trimmed = String(path || "").trim();
    setLocalDirState((prev) => ({
      ...prev,
      loading: true,
      error: "",
      path: trimmed,
      selectedPath: "",
    }));
    try {
      const params = trimmed ? new URLSearchParams({ path: trimmed }) : undefined;
      const payload = await apiProtectedJSON<LocalDirsPayload>(
        appURL("/api/local_dirs", params),
      );
      setLocalDirState({
        path: String(payload.path || trimmed),
        parent: String(payload.parent || ""),
        volumes: Array.isArray(payload.volumes)
          ? payload.volumes.map((item) => ({
              name: String(item.name || ""),
              path: String(item.path || ""),
              is_dir: item.is_dir !== false,
              is_added_root: item.is_added_root === true,
              root_id: String(item.root_id || ""),
            }))
          : [],
        items: Array.isArray(payload.items)
          ? payload.items.map((item) => ({
              name: String(item.name || ""),
              path: String(item.path || ""),
              is_dir: item.is_dir !== false,
              is_added_root: item.is_added_root === true,
              root_id: String(item.root_id || ""),
            }))
          : [],
        loading: false,
        selectedPath: "",
        adding: false,
        error: "",
      });
    } catch (error) {
      setLocalDirState((prev) => ({
        ...prev,
        loading: false,
        error: error instanceof Error ? error.message : t("directory.loadFailed"),
      }));
    }
  }, [t]);

  const openDirectoryPicker = useCallback((nextMode: ProjectAddMode) => {
    const rootID = currentRootIdRef.current;
    const rootPath = rootID
      ? String(managedRootByIdRef.current[rootID]?.root_path || "")
      : "";
    const initialPath = rootPath ? inferParentPath(rootPath) : "";
    setProjectAddMode(nextMode);
    if (!initialPath || initialPath === ".") {
      if (!rootPath) {
        void loadLocalDirs("");
        return;
      }
      setLocalDirState((prev) => ({
        ...prev,
        path: rootPath,
        parent: "",
        items: [],
        loading: false,
        selectedPath: "",
        adding: false,
        error: t("directory.noBrowsableParent"),
      }));
      return;
    }
    void loadLocalDirs(initialPath);
  }, [inferParentPath, loadLocalDirs, t]);

  const handleOpenLocalProjectAdd = useCallback(() => {
    void openDirectoryPicker("local");
  }, [openDirectoryPicker]);

  const handleOpenBlankProjectLocation = useCallback(() => {
    void openDirectoryPicker("blank_location");
  }, [openDirectoryPicker]);

  const handleOpenGitHubProjectAdd = useCallback(() => {
    void openDirectoryPicker("github_location");
    setGitHubImportState((prev) => ({
      ...prev,
      parentPath: "",
      taskId: "",
      status: "",
      message: "",
      running: false,
      submitting: false,
      done: false,
      error: "",
    }));
  }, [openDirectoryPicker]);

  const handleOpenWorktreeLocation = useCallback(() => {
    setWorktreeSwitchOpen(false);
    void openDirectoryPicker("worktree_location");
  }, [openDirectoryPicker]);

  const handleSelectBlankProject = useCallback(() => {
    setProjectAddMode(null);
    handleCreateRootStart();
  }, [handleCreateRootStart]);

  const handleCreateRootCancel = useCallback(() => {
    if (creatingRootBusy) {
      return;
    }
    setCreatingRootName(null);
    setCreatingRootParentPath(null);
    setCreatingRootKind("root");
    setWorktreeBranchMode("new");
    setWorktreeBranch("");
    setWorktreeBranchError("");
    setWorktreeSwitchOpen(false);
  }, [creatingRootBusy]);

  useEffect(() => {
    if (creatingRootKind !== "worktree" || creatingRootName === null) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (worktreeCreatePopoverRef.current?.contains(event.target as Node)) {
        return;
      }
      handleCreateRootCancel();
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [creatingRootKind, creatingRootName, handleCreateRootCancel]);

  useEffect(() => {
    if (!worktreeSwitchOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (worktreeSwitchPopoverRef.current?.contains(event.target as Node)) {
        return;
      }
      setWorktreeSwitchOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [worktreeSwitchOpen]);

  const handleCreateRootSubmit = useCallback(async () => {
    const name = String(creatingRootName || "").trim();
    if (!name) {
      setCreatingRootName(null);
      setCreatingRootParentPath(null);
      return;
    }
    if (creatingRootBusy) {
      return;
    }
    setCreatingRootBusy(true);
    try {
      if (creatingRootKind === "worktree") {
        const rootID = currentRootIdRef.current;
        const parentPath = String(creatingRootParentPath || "").trim();
        if (!rootID || !parentPath) {
          throw new Error(t("worktree.createLocationMissing"));
        }
        const created = await createGitWorktree({
          rootId: rootID,
          parentPath,
          name,
          branchMode: worktreeBranchMode,
          branch: worktreeBranchMode === "existing" ? worktreeBranch : "",
        }) as ManagedRootPayload;
        setCreatingRootName(null);
        setCreatingRootParentPath(null);
        setCreatingRootKind("root");
        setWorktreeBranchMode("new");
        setWorktreeBranch("");
        await refreshManagedRoots();
        if (created?.id) {
          await actionHandlersRef.current.open_dir({
            path: created.id,
            root: created.id,
            isRoot: true,
          });
        }
        return;
      }
      const targetPath =
        creatingRootParentPath && creatingRootParentPath.trim()
          ? `${creatingRootParentPath.replace(/[\\/]+$/, "")}/${name}`
          : name;
      const payload = await apiProtectedJSON<any>(appPath("/api/dirs"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: targetPath, create: true }),
      });
      const created = payload as ManagedRootPayload;
      setCreatingRootName(null);
      setCreatingRootParentPath(null);
      await refreshManagedRoots();
      if (created?.id) {
        await actionHandlersRef.current.open_dir({
          path: created.id,
          root: created.id,
          isRoot: true,
        });
      }
    } catch (err) {
      reportError(
        "root.create_failed",
        managedDirAddErrorMessage(err, t("root.createProjectFailed"), t),
      );
    } finally {
      setCreatingRootBusy(false);
    }
  }, [
    creatingRootBusy,
    creatingRootKind,
    creatingRootName,
    creatingRootParentPath,
    refreshManagedRoots,
    t,
    worktreeBranch,
    worktreeBranchMode,
  ]);

  const handleRenameCurrentRoot = useCallback(
    async (nextName: string) => {
      const rootID = currentRootIdRef.current;
      const trimmedName = String(nextName || "").trim();
      if (!rootID || !trimmedName) {
        return false;
      }
      if (trimmedName === rootID) {
        return true;
      }
      try {
        const renamed = await apiProtectedJSON<ManagedRootPayload>(
          appPath(`/api/dirs/${encodeURIComponent(rootID)}/rename`),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: trimmedName }),
          },
        );
        applyManagedRootRename(rootID, renamed);
        if (renamed?.id) {
          await actionHandlersRef.current.open_dir({
            path: renamed.id,
            root: renamed.id,
            isRoot: true,
            forceDirectory: true,
          });
        }
        return true;
      } catch (err) {
        reportError(
          "root.rename_failed",
          managedDirAddErrorMessage(err, t("root.renameProjectFailed"), t),
        );
        return false;
      }
    },
    [applyManagedRootRename, t],
  );

  const handleLocalDirSelect = useCallback((path: string) => {
    setLocalDirState((prev) => {
      const target = prev.items.find((item) => item.path === path);
      if (!target) {
        return prev;
      }
      if (projectAddMode === "local" && target.is_added_root) {
        return prev;
      }
      return { ...prev, selectedPath: path };
    });
  }, [projectAddMode]);

  const handleLocalDirAdd = useCallback(async () => {
    const path = String(localDirState.selectedPath || "").trim();
    if (localDirState.adding) {
      return;
    }
    if (projectAddMode === "blank_location") {
      setProjectAddMode(null);
      handleCreateRootStart(localDirState.path);
      return;
    }
    if (projectAddMode === "github_location") {
      setProjectAddMode("github");
      setGitHubImportState((prev) => ({
        ...prev,
        parentPath: localDirState.path,
        taskId: "",
        status: "",
        message: "",
        running: false,
        submitting: false,
        done: false,
        error: "",
      }));
      return;
    }
    if (projectAddMode === "worktree_location") {
      setProjectAddMode(null);
      handleCreateWorktreeStart(localDirState.path);
      return;
    }
    if (!path) {
      return;
    }
    setLocalDirState((prev) => ({ ...prev, adding: true, error: "" }));
    try {
      const payload = await apiProtectedJSON<any>(appPath("/api/dirs"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, create: false }),
      });
      setLocalDirState((prev) => ({
        ...prev,
        adding: false,
        selectedPath: "",
      }));
      setProjectAddMode(null);
      await refreshManagedRoots();
      const created = payload as ManagedRootPayload;
      if (created?.id) {
        await actionHandlersRef.current.open_dir({
          path: created.id,
          root: created.id,
          isRoot: true,
        });
      }
      void loadLocalDirs(localDirState.path);
    } catch (error) {
      setLocalDirState((prev) => ({
        ...prev,
        adding: false,
        error: managedDirAddErrorMessage(error, t("root.addDirectoryFailed"), t),
      }));
    }
  }, [handleCreateRootStart, handleCreateWorktreeStart, loadLocalDirs, localDirState.adding, localDirState.path, localDirState.selectedPath, projectAddMode, refreshManagedRoots, t]);

  const handleGitHubImportStart = useCallback(async () => {
    const url = String(githubImportState.url || "").trim();
    const parentPath = String(githubImportState.parentPath || "").trim();
    if (
      !url ||
      !parentPath ||
      githubImportState.running ||
      githubImportState.submitting
    ) {
      return;
    }
    setGitHubImportState((prev) => ({
      ...prev,
      submitting: true,
      done: false,
      error: "",
      taskId: "",
      status: "",
      message: "",
    }));
    try {
      const payload = await apiProtectedJSON<any>(appPath("/api/imports/github"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, parent_path: parentPath }),
      });
      setGitHubImportState((prev) => ({
        ...prev,
        taskId: String(payload?.task_id || ""),
        status: "pending",
        message: t("projectAdd.cloning"),
        submitting: false,
        running: true,
        done: false,
        error: "",
      }));
    } catch (error) {
      setGitHubImportState((prev) => ({
        ...prev,
        submitting: false,
        running: false,
        done: false,
        error: error instanceof Error ? error.message : t("root.githubImportFailed"),
      }));
    }
  }, [githubImportState.parentPath, githubImportState.running, githubImportState.submitting, githubImportState.url, t]);

  const projectAddOverlay = projectAddMode ? (
    <div ref={projectAddPopoverRef}>
      <ProjectAddPopover
        mode={projectAddMode}
        onSelectMode={() => setProjectAddMode("mode")}
        onSelectLocal={handleOpenLocalProjectAdd}
        onSelectBlankLocation={handleOpenBlankProjectLocation}
        onSelectGitHubLocation={handleOpenGitHubProjectAdd}
        onSelectGitHub={handleOpenGitHubProjectAdd}
        onSelectBlank={handleSelectBlankProject}
        localState={localDirState}
        onLocalNavigate={(path) => {
          void loadLocalDirs(path);
        }}
        onLocalSelect={handleLocalDirSelect}
        onLocalAdd={() => {
          void handleLocalDirAdd();
        }}
        localActionLabel={
          projectAddMode === "local" ? t("projectAdd.add") : t("projectAdd.placeHere")
        }
        localDisabledAddedRoot={projectAddMode === "local"}
        localBrowseOnly={
          projectAddMode === "blank_location" ||
          projectAddMode === "github_location" ||
          projectAddMode === "worktree_location"
        }
        githubState={githubImportState}
        onGitHubUrlChange={(value) =>
          setGitHubImportState((prev) => ({
            ...prev,
            url: value,
            error: "",
            done: false,
          }))
        }
        onGitHubImport={() => {
          void handleGitHubImportStart();
        }}
      />
    </div>
  ) : null;

  const handleRemoveCurrentRoot = useCallback(async () => {
    const rootID = currentRootIdRef.current;
    if (!rootID) {
      return;
    }
    const rootInfo = managedRootByIdRef.current[rootID];
    const rootPath = rootInfo?.root_path || "";
    if (!rootPath) {
      reportError("root.delete_failed", t("root.missingPathRemove"));
      return;
    }
    if (!window.confirm(t("root.confirmRemove", { name: rootID }))) {
      return;
    }
    try {
      await apiProtectedJSON<any>(
        appURL("/api/dirs", new URLSearchParams({ path: rootPath })),
        {
          method: "DELETE",
        },
      );
      clearRootScopedClientState(rootID, { removeLastRoot: true });
      await refreshManagedRoots();
    } catch (err) {
      reportError(
        "root.delete_failed",
        String((err as Error)?.message || t("root.removeFailed")),
      );
    }
  }, [clearRootScopedClientState, refreshManagedRoots, t]);

  const handleRemoveCurrentWorktree = useCallback(async () => {
    const rootID = currentRootIdRef.current;
    if (!rootID) {
      return;
    }
    if (!window.confirm(t("worktree.confirmRemove", { name: rootID }))) {
      return;
    }
    try {
      await removeGitWorktree(rootID);
      clearRootScopedClientState(rootID, { removeLastRoot: true });
      await refreshManagedRoots();
    } catch (err) {
      reportError(
        "git.worktree_remove_failed",
        String((err as Error)?.message || t("worktree.removeFailed")),
      );
    }
  }, [clearRootScopedClientState, refreshManagedRoots, t]);

  const ensurePluginsLoaded = useCallback(async (rootId: string) => {
    if (!rootId || pluginsLoadedByRootRef.current[rootId]) {
      return;
    }
    if (pluginsTrustPendingByRootRef.current[rootId]) {
      return;
    }
    const inflight = pluginsLoadingByRootRef.current[rootId];
    if (inflight) {
      await inflight;
      return;
    }
    setPluginLoading(true);
    const request = scanPluginSources(rootId, managedRootByIdRef.current[rootId]?.root_path || rootId)
      .then(async (bundle) => {
        const snapshot = snapshotFromPluginSources(bundle);
        if (bundle.plugins.length > 0 && !isPluginSnapshotTrusted(snapshot, readTrustedPluginSet(rootId))) {
          pluginManagerRef.current.clear(rootId);
          pluginsTrustPendingByRootRef.current[rootId] = true;
          setPendingPluginTrust({ rootId, bundle });
          setPluginVersion((v) => v + 1);
          return;
        }
        const plugins = await loadPluginsFromSources(bundle.plugins);
        pluginManagerRef.current.set(rootId, plugins);
        pluginsLoadedByRootRef.current[rootId] = true;
        setPluginVersion((v) => v + 1);
      })
      .catch(() => {
        pluginManagerRef.current.clear(rootId);
        pluginsLoadedByRootRef.current[rootId] = true;
        setPluginVersion((v) => v + 1);
      })
      .finally(() => {
        delete pluginsLoadingByRootRef.current[rootId];
        setPluginLoading(false);
      });
    pluginsLoadingByRootRef.current[rootId] = request;
    await request;
  }, []);

  const handleTrustPendingPlugins = useCallback(async () => {
    const pending = pendingPluginTrust;
    if (!pending) return;
    setPluginLoading(true);
    try {
      const snapshot = snapshotFromPluginSources(pending.bundle);
      saveTrustedPluginSet(pending.rootId, snapshot);
      const plugins = await loadPluginsFromSources(pending.bundle.plugins);
      pluginManagerRef.current.set(pending.rootId, plugins);
      pluginsLoadedByRootRef.current[pending.rootId] = true;
      delete pluginsTrustPendingByRootRef.current[pending.rootId];
      setPendingPluginTrust((current) => current?.rootId === pending.rootId ? null : current);
      setPluginVersion((v) => v + 1);
    } finally {
      setPluginLoading(false);
    }
  }, [pendingPluginTrust]);

  const handleDisablePendingPlugins = useCallback(() => {
    const pending = pendingPluginTrust;
    if (!pending) return;
    pluginManagerRef.current.clear(pending.rootId);
    pluginsLoadedByRootRef.current[pending.rootId] = true;
    delete pluginsTrustPendingByRootRef.current[pending.rootId];
    setPendingPluginTrust((current) => current?.rootId === pending.rootId ? null : current);
    setPluginVersion((v) => v + 1);
  }, [pendingPluginTrust]);

  const invalidatePluginsForRoot = useCallback((rootId: string) => {
    if (!rootId) return;
    pluginManagerRef.current.clear(rootId);
    delete pluginsLoadedByRootRef.current[rootId];
    delete pluginsLoadingByRootRef.current[rootId];
    delete pluginsTrustPendingByRootRef.current[rootId];
    setPendingPluginTrust((current) => current?.rootId === rootId ? null : current);
    setPluginVersion((v) => v + 1);
    if (rootId === currentRootIdRef.current) {
      void ensurePluginsLoaded(rootId).catch(() => {});
    }
  }, [ensurePluginsLoaded]);

  const pluginHandlers = useMemo(
    () => ({
      open: async (params: Record<string, unknown>) => {
        await actionHandlers.open(params);
      },
      open_dir: async (params: Record<string, unknown>) => {
        await actionHandlers.open_dir(params);
      },
      select_session: async (params: Record<string, unknown>) => {
        const key = typeof params?.key === "string" ? params.key : "";
        if (!key) return;
        const root = currentRootIdRef.current;
        if (!root) return;
        const matched = sessions.find(
          (item) => (item.key || item.session_key) === key,
        );
        if (matched) {
          await handleSelectSession(matched);
          return;
        }
        await handleSelectSession({ key, session_key: key, root_id: root });
      },
      navigate: async (params: Record<string, unknown>) => {
        const current = readURLState();
        const nextRoot = current.root || currentRootIdRef.current || "";
        const nextPath =
          typeof params?.path === "string" ? params.path : current.file;
        const explicitCursor = normalizeCursor(params?.cursor);
        const rawQuery =
          params?.query &&
          typeof params.query === "object" &&
          !Array.isArray(params.query)
            ? (params.query as Record<string, unknown>)
            : null;

        const nextPluginQuery: Record<string, string> = {
          ...current.pluginQuery,
        };
        if (rawQuery) {
          Object.entries(rawQuery).forEach(([key, value]) => {
            if (!key) return;
            nextPluginQuery[key] = String(value);
          });
        }

        let nextCursor = current.cursor;
        if (explicitCursor !== null) {
          nextCursor = explicitCursor;
        } else if (
          typeof params?.path === "string" &&
          params.path !== current.file
        ) {
          nextCursor = 0;
        }
        if (!nextPath) {
          nextCursor = 0;
        }

        const nextState: URLState = {
          root: nextRoot || "",
          file: nextPath || "",
          session: "",
          cursor: nextCursor,
          pluginQuery: nextPluginQuery,
        };
        replaceURLState(nextState);
        if (nextState.file) {
          persistPluginQuery(
            nextState.root,
            nextState.file,
            nextState.pluginQuery,
          );
        }

        const rootChanged =
          (nextState.root || "") !== (currentRootIdRef.current || "");
        const fileChanged =
          (nextState.file || "") !== (fileRef.current?.path || "");
        const pluginChanged =
          JSON.stringify(nextState.pluginQuery) !==
          JSON.stringify(current.pluginQuery);

        if (pluginChanged) {
          setPluginQuery(nextState.pluginQuery);
        }

        if (!nextState.file) {
          if (nextState.root) {
            await actionHandlers.open_dir({
              path: nextState.root,
              root: nextState.root,
              preservePluginQuery: true,
              isRoot: true,
            });
          }
          return;
        }

        const cursorChanged = nextState.cursor !== fileCursorRef.current;
        if (rootChanged || fileChanged || cursorChanged) {
          await actionHandlers.open({
            path: nextState.file,
            root: nextState.root,
            cursor: nextState.cursor,
            preservePluginQuery: true,
          });
        }
      },
    }),
    [actionHandlers, sessions, handleSelectSession, replaceURLState],
  );

  const handleSessionChipClick = useCallback(
    (sessionKey: string, rootOverride?: string | null) => {
      if (!sessionKey) return;
      const root = rootOverride || file?.root || currentRootIdRef.current;
      if (!root) return;
      const matched = sessions.find((item) => {
        const key = item.key || item.session_key;
        return key === sessionKey;
      });
      if (matched) {
        handleSelectSession(matched);
        return;
      }
      handleSelectSession({
        key: sessionKey,
        session_key: sessionKey,
        root_id: root,
      });
    },
    [file, sessions, handleSelectSession],
  );

	  const handleTaskSessionDrawerOpen = useCallback(
    (sessionKey: string, rootOverride?: string | null, taskId?: string) => {
      const key = String(sessionKey || "").trim();
      if (!key) return;
      const root = rootOverride || currentRootIdRef.current;
      if (!root) return;
      const matched = sessions.find((item) => (item.key || item.session_key) === key);
      const cacheKey = rootSessionKey(root, key);
      const cached = sessionCacheRef.current[cacheKey];
      const initial = cached || matched || {
        key,
        session_key: key,
        root_id: root,
        task_id: taskId || "",
      };
      setDrawerLoadingSessionByRoot((prev) => ({
        ...prev,
        [root]: hasSessionExchanges(initial) ? "" : key,
      }));
      setDrawerSessionForRoot(root, {
        ...(initial as any),
        key,
        session_key: key,
        root_id: root,
        task_id: (initial as any)?.task_id || taskId || "",
      } as SessionItem);
      setBoundSessionForRoot(root, key);
      interactionModeRef.current = "drawer";
      setInteractionMode("drawer");
      setDrawerOpenForRoot(root, true);
      const applyDrawerSession = (session: Session) => {
        const activeDrawer = drawerSessionByRootRef.current[root];
        if ((activeDrawer?.key || activeDrawer?.session_key) !== key) return;
        setDrawerLoadingSessionByRoot((prev) =>
          prev[root] === key ? { ...prev, [root]: "" } : prev,
        );
        setDrawerSessionForRoot(root, {
          ...(activeDrawer as any),
          ...(session as any),
          key,
          session_key: key,
          root_id: root,
          task_id: (session as any)?.task_id || taskId || "",
        } as Session);
      };
      void (async () => {
        const restorePromise = restoreActiveSession(root, key);
        if (!hasSessionExchanges(cached)) {
          const persisted = await getCachedSession(root, key);
          const latest = sessionCacheRef.current[cacheKey];
          const immediate = hasSessionExchanges(latest) ? latest : persisted;
          if (immediate) {
            sessionCacheRef.current[cacheKey] = {
              ...(immediate as any),
              key,
            } as Session;
            bumpCacheVersion();
            applyDrawerSession(immediate);
          }
        }
        const restored = await restorePromise;
        if (!restored) {
          setDrawerLoadingSessionByRoot((prev) =>
            prev[root] === key ? { ...prev, [root]: "" } : prev,
          );
          return;
        }
        applyDrawerSession(restored);
        loadedSessionRef.current[cacheKey] = true;
        clearSessionStale(root, key);
      })().catch((error) => {
        setDrawerLoadingSessionByRoot((prev) =>
          prev[root] === key ? { ...prev, [root]: "" } : prev,
        );
        console.error("[task.session] failed to open drawer session", {
          root,
          sessionKey: key,
          error,
        });
      });
    },
    [
      bumpCacheVersion,
      clearSessionStale,
      restoreActiveSession,
      rootSessionKey,
      sessions,
      setBoundSessionForRoot,
      setDrawerOpenForRoot,
      setDrawerSessionForRoot,
	    ],
	  );

	  const refreshTaskRelatedFiles = useCallback(async (
	    root: string,
	    taskId: string,
	    sessionKeys: string[],
	  ) => {
	    const keys = Array.from(new Set(
	      sessionKeys
	        .map((key) => String(key || "").trim())
	        .filter(Boolean),
	    ));
	    if (!root || !taskId || keys.length === 0) return;
	    const relatedFileGroups = await Promise.all(
	      keys.map(async (sessionKey) => {
	        const relatedFiles = await sessionService.getSessionRelatedFiles(root, sessionKey);
	        await setCachedSessionRelatedFiles(root, sessionKey, relatedFiles);
	        updateSessionRelatedFilesForKey(root, sessionKey, relatedFiles);
	        return relatedFiles;
	      }),
	    );
	    setTaskRelatedFilesById((prev) => ({ ...prev, [taskId]: mergeRelatedFileGroups(relatedFileGroups) }));
	  }, [updateSessionRelatedFilesForKey]);

	  const refreshTasksForRelatedSession = useCallback((root: string, sessionKey: string) => {
	    const taskIds = taskIdsForUpdatedSession(taskSessionKeysByIdRef.current, sessionKey);
	    taskIds.forEach((taskId) => {
	      const detail = taskDetailsByIdRef.current[taskId];
	      const task = detail?.task;
	      if (!task || task.root_id !== root) return;
	      const sessionKeys = Array.from(new Set(
	        [...(taskSessionKeysByIdRef.current[taskId] || []), task.main_session_key]
	          .map((key) => String(key || "").trim())
	          .filter(Boolean),
	      ));
	      void refreshTaskRelatedFiles(root, taskId, sessionKeys).catch((error) => {
	        console.error("[task.related_files] refresh from session event failed", { root, taskId, sessionKey, error });
	      });
	    });
	  }, [refreshTaskRelatedFiles]);

	  const handleSelectKanbanTask = useCallback((task: KanbanTask) => {
	    const taskId = String(task.id || "");
	    if (!taskId) return;
	    setSelectedKanbanTaskId((prev) => prev === taskId ? "" : taskId);
	    const root = task.root_id || currentRootIdRef.current || "";
	    const sessionKeys = Array.from(new Set(
	      [...(taskSessionKeysById[taskId] || []), task.main_session_key]
	        .map((key) => String(key || "").trim())
	        .filter(Boolean),
	    ));
	    if (!root || sessionKeys.length === 0) return;
	    void refreshTaskRelatedFiles(root, taskId, sessionKeys)
	      .catch((error) => {
	        console.error("[task.related_files] failed", { root, taskId, sessionKeys, error });
	      });
	  }, [refreshTaskRelatedFiles, taskSessionKeysById]);

	  useEffect(() => {
    function openReplySession(detail: any) {
      const rootId = typeof detail?.rootId === "string" ? detail.rootId.trim() : "";
      const sessionKey = typeof detail?.sessionKey === "string" ? detail.sessionKey.trim() : "";
      if (!rootId || !sessionKey) {
        return;
      }
      handleSessionChipClick(sessionKey, rootId);
    }

    function handleOpenReplySession(event: Event) {
      openReplySession((event as CustomEvent).detail);
    }

    window.addEventListener("mindfs:open-reply-session", handleOpenReplySession);
    openReplySession((window as any).__mindfsPendingReplySession);
    delete (window as any).__mindfsPendingReplySession;
    return () => {
      window.removeEventListener("mindfs:open-reply-session", handleOpenReplySession);
    };
  }, [handleSessionChipClick]);

  const handleFileViewerPathClick = useCallback(
    (path: string) => {
      if (!file) return;
      const root = file.root || currentRootIdRef.current;
      if (!root) return;
      actionHandlers.open_dir({
        path: path === "." ? root : path,
        root,
        isRoot: path === ".",
        suppressTreeExpand: path === ".",
      });
    },
    [file, actionHandlers],
  );

  const handleFileViewerFileClick = useCallback(
    (path: string) => {
      if (!file) return;
      const root = file.root || currentRootIdRef.current;
      if (!root) return;
      actionHandlers.open({ path, root });
    },
    [file, actionHandlers],
  );

  const handleGitDiffPathClick = useCallback(
    (path: string) => {
      const root = currentRootIdRef.current;
      if (!root) return;
      setGitDiff(null);
      actionHandlers.open_dir({
        path: path === "." ? root : path,
        root,
        isRoot: path === ".",
        suppressTreeExpand: path === ".",
      });
    },
    [actionHandlers],
  );

  const handleDirectoryPathClick = useCallback(
    (path: string) => {
      const root = currentRootIdRef.current;
      if (!root) return;
      actionHandlers.open_dir({
        path: path === "." ? root : path,
        root,
        isRoot: path === ".",
        suppressTreeExpand: path === ".",
      });
    },
    [actionHandlers],
  );

  const visibleMainEntries = useMemo(
    () =>
      showHiddenFiles
        ? mainEntries
        : mainEntries.filter((entry) => !entry.name.startsWith(".")),
    [mainEntries, showHiddenFiles],
  );

  const gitFileStatsByPath = useMemo<Record<string, GitFileStat>>(() => {
    const items = gitStatus?.items || [];
    return Object.fromEntries(
      items.map((item) => [
        item.path,
        {
          status: item.status,
          additions: item.additions,
          deletions: item.deletions,
        },
      ]),
    );
  }, [gitStatus]);

  useEffect(() => {
    if (!currentRootId) return;
    sessionService.connect(currentRootId);
  }, [currentRootId]);

  useEffect(() => {
    if (sessionListMode !== "import") return;
    const rootID = currentRootIdRef.current || "";
    if (!rootID || !externalImportAgent) return;
    setSelectedExternalImportKeys(new Set());
    void loadExternalSessions(rootID, externalImportAgent, { replace: true });
  }, [
    sessionListMode,
    externalImportAgent,
    externalFilterBound,
    loadExternalSessions,
  ]);

  useEffect(
    () => () => {
      sessionService.disconnect();
      setStatus("disconnected");
    },
    [],
  );

  useEffect(() => {
    if (!currentRootId) {
      setGitStatus(null);
      setGitHistory(null);
      setGitDiff(null);
      setSessionListMode("local");
      setExternalSessions([]);
      setExternalSelectedKey("");
      return;
    }
    void refreshGitStatus(currentRootId);
    void refreshGitHistory(currentRootId);
    setGitDiff(null);
  }, [currentRootId, refreshGitHistory, refreshGitStatus]);

  useEffect(() => {
    if (!currentRootId) return;
    let cancelled = false;
    const reloadSessionForReplay = async (
      rootID: string,
      sessionKey: string,
    ) => {
      if (!rootID || !sessionKey) return;
      const restored = await restoreActiveSession(rootID, sessionKey);
      if (cancelled) return;
      if (!restored) return;
      const cacheKey = rootSessionKey(rootID, sessionKey);
      loadedSessionRef.current[cacheKey] = true;
      clearSessionStale(rootID, sessionKey);
      if (
        (selectedSessionRef.current?.key ||
          selectedSessionRef.current?.session_key) === sessionKey
      ) {
        setSelectedSession((prev) =>
          prev
            ? toSessionItem(rootID, {
                ...(prev as any),
                ...(restored as any),
              })
            : prev,
        );
      }
      if (boundSessionByRootRef.current[rootID] === sessionKey) {
        setDrawerSessionForRoot(rootID, restored);
      }
    };
    const getReplayTargetsForRoot = (rootID: string): string[] => {
      if (!rootID) return [];
      const keys = new Set<string>();
      const rememberedSelectedKey =
        selectedSessionByRootRef.current[rootID] || "";
      if (
        rememberedSelectedKey &&
        !rememberedSelectedKey.startsWith("pending-")
      ) {
        keys.add(rememberedSelectedKey);
      }
      const boundKey = boundSessionByRootRef.current[rootID] || "";
      if (boundKey && !boundKey.startsWith("pending-")) {
        keys.add(boundKey);
      }
      const drawerKey = drawerSessionByRootRef.current[rootID]?.key || "";
      if (drawerKey && !drawerKey.startsWith("pending-")) {
        keys.add(drawerKey);
      }
      const selected = selectedSessionRef.current;
      const selectedKey = selected?.key || selected?.session_key || "";
      const selectedRoot =
        (selected?.root_id as string | undefined) || currentRootIdRef.current;
      if (
        selectedRoot === rootID &&
        selectedKey &&
        !selectedKey.startsWith("pending-")
      ) {
        keys.add(selectedKey);
      }
      return Array.from(keys);
    };
    const replayTargetsForAllRoots = () => {
      const replayCacheKeys = new Set<string>();
      for (const rootID of managedRootIdsRef.current) {
        if (!rootID) continue;
        const replayTargets = getReplayTargetsForRoot(rootID);
        for (const sessionKey of replayTargets) {
          replayCacheKeys.add(rootSessionKey(rootID, sessionKey));
          void reloadSessionForReplay(rootID, sessionKey);
        }
      }
      for (const cacheKey of Object.keys(sessionCacheRef.current)) {
        if (replayCacheKeys.has(cacheKey)) {
          continue;
        }
        const separator = cacheKey.indexOf("::");
        if (separator <= 0) {
          continue;
        }
        const rootID = cacheKey.slice(0, separator);
        const sessionKey = cacheKey.slice(separator + 2);
        if (!rootID || !sessionKey || !hasSessionExchanges(sessionCacheRef.current[cacheKey])) {
          continue;
        }
        markSessionStale(rootID, sessionKey);
      }
    };
    const refreshSessionRelatedFiles = async (
      rootID: string,
      sessionKey: string,
    ) => {
      if (!rootID || !sessionKey) return;
      const relatedFiles = await sessionService.getSessionRelatedFiles(
        rootID,
        sessionKey,
      );
      if (cancelled) return;
      await setCachedSessionRelatedFiles(rootID, sessionKey, relatedFiles);
      updateSessionRelatedFilesForKey(rootID, sessionKey, relatedFiles);
    };
    const handleSessionStreamDone = (rootID: string, sessionKey: string) => {
      const cacheKey = rootSessionKey(rootID, sessionKey);
      const wasCanceled = !!cancelRequestedBySessionRef.current[cacheKey];
      if (wasCanceled) {
        delete cancelRequestedBySessionRef.current[cacheKey];
      }
      delete pendingBySessionRef.current[cacheKey];
      const clearPendingAck = <T,>(session: T): T => {
        const exchanges = (session as any)?.exchanges;
        if (!wasCanceled || !Array.isArray(exchanges)) {
          return session;
        }
        return {
          ...(session as any),
          exchanges: exchanges.map((exchange: any) =>
            exchange?.pending_ack === true
              ? { ...exchange, pending_ack: false }
              : exchange,
          ),
        } as T;
      };
      const queued = queuedMessagesBySessionRef.current[cacheKey] || [];
      const queueFrozen = !!queueFrozenBySessionRef.current[cacheKey];
      const hiddenQueued = optimisticDequeuedIdsRef.current[cacheKey];
      const hasQueuedContinuation =
        (queued.length > 0 && !queueFrozen) ||
        !!(hiddenQueued && hiddenQueued.size > 0);
      if (hasQueuedContinuation && !wasCanceled) {
        markSessionPending(rootID, sessionKey);
        return;
      }
      const cached = sessionCacheRef.current[cacheKey];
      if (cached && cached.key === sessionKey) {
        sessionCacheRef.current[cacheKey] = clearPendingAck({
          ...(cached as any),
          pending: false,
        } as Session);
      }
      setSelectedPendingByKey(sessionKey, false);
      setSelectedSession((prev) => {
        const prevKey = prev?.key || prev?.session_key;
        const prevRoot =
          (prev?.root_id as string | undefined) || currentRootIdRef.current;
        if (
          !prev ||
          prevKey !== sessionKey ||
          prevRoot !== rootID ||
          !(prev as any).pending
        ) {
          return prev;
        }
        return clearPendingAck({
          ...(prev as any),
          pending: false,
        } as SessionItem);
      });
      const drawer = drawerSessionByRootRef.current[rootID];
      if (drawer && drawer.key === sessionKey) {
        const latest = wasCanceled
          ? sessionCacheRef.current[cacheKey] || drawer
          : drawer;
        setDrawerSessionForRoot(rootID, clearPendingAck({
          ...(latest as any),
          pending: false,
        } as Session));
      }
      if (currentRootIdRef.current === rootID) {
        setSessions((prev) =>
          prev.map((item) => {
            const itemKey = item.key || item.session_key;
            if (itemKey !== sessionKey) {
              return item;
            }
            return clearPendingAck({
              ...(item as any),
              pending: false,
            } as SessionItem);
          }),
        );
      }
      setMultiProjectSessionPending(rootID, sessionKey, false);
      bumpCacheVersion();
    };

    const handleSessionStream = (payload: any) => {
      const streamKey =
        typeof payload?.session_key === "string" ? payload.session_key : "";
      const activeRoot =
        typeof payload?.root_id === "string" && payload.root_id
          ? payload.root_id
          : resolveRootForSessionKey(streamKey) || currentRootIdRef.current;
      if (!streamKey || !activeRoot) return;
      const ck = rootSessionKey(activeRoot, streamKey);
      let pending = pendingBySessionRef.current[ck];
      if (!pending) {
        const draft = pendingDraftRef.current;
        if (
          draft &&
          draft.rootId === activeRoot &&
          streamKey !==
            (suppressedAutoBindSessionByRootRef.current[activeRoot] || "")
        ) {
          pending = draft;
          pendingBySessionRef.current[ck] = draft;
          pendingDraftRef.current = null;
          console.info("[session/stream] attach_pending_draft", { rootId: activeRoot, streamKey, requestId: draft.requestId, tempKey: draft.tempKey || null });
        }
      }
      const boundKey = boundSessionByRootRef.current[activeRoot] || "";
      const suppressedAutoBindKey =
        suppressedAutoBindSessionByRootRef.current[activeRoot] || "";
      if (
        streamKey !== suppressedAutoBindKey &&
        (!boundKey ||
          (typeof boundKey === "string" && boundKey.startsWith("pending-")))
      ) {
        if (suppressedAutoBindKey && streamKey !== suppressedAutoBindKey) {
          suppressedAutoBindSessionByRootRef.current[activeRoot] = null;
        }
        setBoundSessionForRoot(activeRoot, streamKey);
        if (pending) {
          const pendingName =
            (drawerSessionByRootRef.current[activeRoot]?.key ===
            pending.tempKey &&
            typeof (drawerSessionByRootRef.current[activeRoot] as any)?.name ===
              "string"
              ? ((drawerSessionByRootRef.current[activeRoot] as any).name as string)
              : "") ||
            ((selectedSessionRef.current?.key ||
              selectedSessionRef.current?.session_key) === pending.tempKey &&
            (((selectedSessionRef.current?.root_id as string | undefined) ||
              currentRootIdRef.current) === activeRoot) &&
            typeof selectedSessionRef.current?.name === "string"
              ? selectedSessionRef.current.name
              : "") ||
            t("session.new");
          const userEx = {
            role: "user",
            content: pending.message,
            timestamp: pending.timestamp,
            model: pending.model,
	            mode: pending.agentMode,
	            effort: pending.effort,
	            fast_service: pending.fastService || "",
	            shell: pending.shell || "",
          };
          const cached =
            sessionCacheRef.current[ck] ||
            ({
              key: streamKey,
              type: pending.mode,
              agent: pending.agent,
              model: pending.model,
	              mode: pending.agentMode,
	              effort: pending.effort,
	              fast_service: pending.fastService || "",
	              shell: pending.shell || "",
              name: pendingName,
              created_at: pending.timestamp,
              updated_at: pending.timestamp,
              exchanges: [],
            } as any);
          const prevExchanges = Array.isArray((cached as any).exchanges)
            ? ((cached as any).exchanges as Exchange[])
            : [];
          sessionCacheRef.current[ck] = {
            ...(cached as any),
            exchanges: prevExchanges.length > 0 ? prevExchanges : [userEx],
            updated_at: new Date().toISOString(),
          } as Session;
          bumpCacheVersion();
        }
        const seeded = sessionCacheRef.current[ck];
        if (seeded) {
          setDrawerSessionForRoot(activeRoot, {
            ...(seeded as any),
            pending: true,
          } as Session);
        }
      }
      if (pending?.tempKey) {
        console.info("[session/stream] promote_pending", { rootId: activeRoot, tempKey: pending.tempKey, streamKey, requestId: pending.requestId });
        promotePendingSessionForRoot(
          activeRoot,
          pending.tempKey,
          streamKey,
          sessionCacheRef.current[ck] || null,
        );
      }
      const event = payload.event;
      if (!event?.type) return;
      const markStreamPending = () => {
        if (event.type === "message_done" || event.type === "error") return;
        markSessionPending(activeRoot, streamKey);
      };
      const updateDrawerIfShowingStream = () => {
        const drawerKey = drawerSessionByRootRef.current[activeRoot]?.key || "";
        if (
          drawerKey !== streamKey &&
          (!pending?.tempKey || drawerKey !== pending.tempKey)
        ) {
          return;
        }
        const latest = sessionCacheRef.current[ck];
        if (latest) {
          setDrawerSessionForRoot(activeRoot, {
            ...(latest as any),
            pending: true,
          } as Session);
        }
      };
      markStreamPending();
      switch (event.type) {
        case "message_chunk":
          appendAgentChunkForSession(
            activeRoot,
            streamKey,
            event.data?.content || "",
            pending
              ? {
                  agent: pending.agent,
                  model: pending.model,
	                  mode: pending.agentMode,
	                  effort: pending.effort,
	                  fast_service: pending.fastService || "",
	                }
              : undefined,
          );
          updateDrawerIfShowingStream();
          break;
        case "thought_chunk":
          appendThoughtChunkForSession(
            activeRoot,
            streamKey,
            event.data?.content || "",
            event.data?.id || "",
          );
          updateDrawerIfShowingStream();
          break;
        case "tool_call":
          appendToolCallForSession(
            activeRoot,
            streamKey,
            event.data || {},
            false,
          );
          updateDrawerIfShowingStream();
          break;
        case "tool_call_update":
          appendToolCallForSession(
            activeRoot,
            streamKey,
            event.data || {},
            true,
          );
          updateDrawerIfShowingStream();
          break;
        case "todo_update":
          appendTodoUpdateForSession(
            activeRoot,
            streamKey,
            event.data || {},
          );
          updateDrawerIfShowingStream();
          break;
        case "plan_update":
          appendPlanUpdateForSession(
            activeRoot,
            streamKey,
            event.data || {},
          );
          updateDrawerIfShowingStream();
          break;
        case "compact_notice":
          appendCompactNoticeForSession(
            activeRoot,
            streamKey,
            event.data || {},
          );
          updateDrawerIfShowingStream();
          break;
        case "message_done":
          attachContextWindowToLatestAssistant(
            activeRoot,
            streamKey,
            event.data?.contextWindow,
          );
          tokenStationRefreshRef.current?.();
          setCodexRateLimitsRefreshToken((value) => value + 1);
          break;
        case "error":
          reportError(
            "session.resume_failed",
            event.data?.message || t("session.resumeFailed"),
            {
              details: {
                rootId: activeRoot,
                sessionKey: streamKey,
                eventType: event.type,
              },
            },
          );
          handleSessionStreamDone(activeRoot, streamKey);
          break;
      }
    };
    const handleSlashCommandStream = (payload: any) => {
      const sessionKey =
        typeof payload?.session_key === "string" ? payload.session_key : "";
      const rootID =
        typeof payload?.root_id === "string" && payload.root_id
          ? payload.root_id
          : resolveRootForSessionKey(sessionKey) || currentRootIdRef.current;
      const command =
        typeof payload?.command === "string" ? payload.command : "status";
      const requestId =
        typeof payload?.request_id === "string"
          ? payload.request_id
          : typeof payload?.id === "string"
            ? payload.id
            : "";
      const event = payload?.event;
      if (!rootID || !sessionKey || !event?.type) {
        return;
      }
      const resultKey = rootSessionKey(rootID, sessionKey);
      if (event.type === "message_chunk") {
        const chunk = typeof event.data?.content === "string" ? event.data.content : "";
        if (!chunk) {
          return;
        }
        setSlashCommandResults((prev) => {
          const current = prev[resultKey];
          if (!current && sessionKey.startsWith("transient-")) {
            return prev;
          }
          if (
            current?.requestId &&
            requestId &&
            current.requestId !== requestId
          ) {
            return prev;
          }
          return {
            ...prev,
            [resultKey]: {
              rootId: rootID,
              sessionKey,
              requestId: current?.requestId || requestId,
              command: current?.command || command,
              content: `${current?.content || ""}${chunk}`,
              status: "running",
            },
          };
        });
        return;
      }
      if (event.type === "login_notice") {
        const notice = event.data || {};
        const noticeStatus = typeof notice.status === "string" ? notice.status : "";
        const failed = noticeStatus === "error";
        const complete = noticeStatus === "success";
        setSlashCommandResults((prev) => {
          const current = prev[resultKey];
          if (!current && sessionKey.startsWith("transient-")) {
            return prev;
          }
          if (
            current?.requestId &&
            requestId &&
            current.requestId !== requestId
          ) {
            return prev;
          }
          return {
            ...prev,
            [resultKey]: {
              rootId: rootID,
              sessionKey,
              requestId: current?.requestId || requestId,
              command: current?.command || command || "login",
              content: current?.content || "",
              status: failed ? "failed" : complete ? "complete" : "running",
              error:
                failed && typeof notice.error === "string"
                  ? notice.error
                  : current?.error,
              createdAt: current?.createdAt || Date.now(),
              loginNotice: {
                ...current?.loginNotice,
                status: noticeStatus,
                loginId: typeof notice.loginId === "string" ? notice.loginId : current?.loginNotice?.loginId,
                verificationUrl:
                  typeof notice.verificationUrl === "string"
                    ? notice.verificationUrl
                    : current?.loginNotice?.verificationUrl,
                userCode:
                  typeof notice.userCode === "string"
                    ? notice.userCode
                    : current?.loginNotice?.userCode,
                error: typeof notice.error === "string" ? notice.error : current?.loginNotice?.error,
                authMode:
                  typeof notice.authMode === "string"
                    ? notice.authMode
                    : current?.loginNotice?.authMode,
                planType:
                  typeof notice.planType === "string"
                    ? notice.planType
                    : current?.loginNotice?.planType,
              },
            },
          };
        });
        if (failed) {
          reportError("session.slash_command_failed", notice.error || t("session.loginFailed"), {
            details: { rootId: rootID, sessionKey, command },
          });
        }
        return;
      }
      if (event.type === "error") {
        const message =
          typeof event.data?.message === "string"
            ? event.data.message
            : t("session.commandFailed");
        setSlashCommandResults((prev) => {
          const current = prev[resultKey];
          if (!current && sessionKey.startsWith("transient-")) {
            return prev;
          }
          if (
            current?.requestId &&
            requestId &&
            current.requestId !== requestId
          ) {
            return prev;
          }
          return {
            ...prev,
            [resultKey]: {
              rootId: rootID,
              sessionKey,
              requestId: current?.requestId || requestId,
              command: current?.command || command,
              content: current?.content || "",
              status: "failed",
              error: message,
            },
          };
        });
        reportError("session.slash_command_failed", message, {
          details: { rootId: rootID, sessionKey, command },
        });
      }
    };
    const handleSlashCommandDone = (payload: any) => {
      const sessionKey =
        typeof payload?.session_key === "string" ? payload.session_key : "";
      const rootID =
        typeof payload?.root_id === "string" && payload.root_id
          ? payload.root_id
          : resolveRootForSessionKey(sessionKey) || currentRootIdRef.current;
      if (!rootID || !sessionKey) {
        return;
      }
      const resultKey = rootSessionKey(rootID, sessionKey);
      setSlashCommandResults((prev) => {
        const current = prev[resultKey];
        if (!current || current.status === "failed") {
          return prev;
        }
        const requestId =
          typeof payload?.request_id === "string"
            ? payload.request_id
            : typeof payload?.id === "string"
              ? payload.id
              : "";
        if (
          current.requestId &&
          requestId &&
          current.requestId !== requestId
        ) {
          return prev;
        }
        return {
          ...prev,
          [resultKey]: {
            ...current,
            status: "complete",
          },
        };
      });
    };
    const dirname = (path: string): string => {
      const clean = (path || "").replace(/^\/+|\/+$/g, "");
      if (!clean || clean === ".") return ".";
      const idx = clean.lastIndexOf("/");
      return idx <= 0 ? "." : clean.slice(0, idx);
    };
    const currentDirAPI = (rootID: string): string => {
      const selected = selectedDirRef.current;
      if (!selected || selected === rootID) return ".";
      return selected;
    };
    const stringList = (value: unknown): string[] => {
      if (!Array.isArray(value)) return [];
      return Array.from(
        new Set(
          value.filter(
            (item): item is string => typeof item === "string" && item !== "",
          ),
        ),
      );
    };
    const handleFileChangedBatch = (payload: any) => {
      const rootID =
        typeof payload?.root_id === "string" ? payload.root_id : "";
      if (!rootID) return;

      const paths = stringList(payload?.paths);
      const events = Array.isArray(payload?.events) ? payload.events : [];
      const dirPathSet = new Set(stringList(payload?.dirs));
      for (const path of paths) {
        const parentDir = dirname(path);
        dirPathSet.add(parentDir);
        const event = events.find((item: any) => item?.path === path);
        const op = typeof event?.op === "string" ? event.op : "";
        if (
          event?.is_dir === true ||
          op.includes("REMOVE") ||
          op.includes("RENAME")
        ) {
          dirPathSet.add(path);
        }
      }
      const dirs = Array.from(dirPathSet);
      if (paths.length === 0 && dirs.length === 0) return;

      for (const path of paths) {
        invalidateFileCache(rootID, path);
      }
      if (
        [...paths, ...dirs].some((path) => {
          const normalized = String(path || "").replace(/\\/g, "/").replace(/^\/+/, "");
          return normalized === ".mindfs/plugins" || normalized.startsWith(".mindfs/plugins/");
        })
      ) {
        invalidatePluginsForRoot(rootID);
      }

      const currentFile = fileRef.current;
      const currentFileRoot =
        currentFile?.root || currentRootIdRef.current || "";
      if (
        currentFile &&
        currentFileRoot === rootID &&
        paths.includes(currentFile.path)
      ) {
        void refreshCurrentFileContent(rootID, currentFile.path);
      }

      void refreshGitStatus(rootID).then((next) => {
        if (!next?.available) {
          if (rootID === currentRootIdRef.current) {
            setGitDiff(null);
          }
          return;
        }
        const changedDiffPath = gitDiff?.path || "";
        if (
          rootID === currentRootIdRef.current &&
          changedDiffPath &&
          paths.includes(changedDiffPath)
        ) {
          const target = next.items.find(
            (item) => item.path === changedDiffPath,
          );
          if (!target) {
            setGitDiff(null);
            return;
          }
          void fetchGitDiff(rootID, changedDiffPath, {
            cacheSignature: buildGitDiffCacheSignature(target),
          })
            .then(setGitDiff)
            .catch((err) => {
              console.error("[git.diff.refresh] failed", {
                rootID,
                changedPath: changedDiffPath,
                err,
              });
            });
        }
      });

      const currentDir = currentDirAPI(rootID);
      for (const dir of dirs) {
        invalidTreeCacheKeysRef.current.add(treeCacheKey(rootID, dir));
        if (rootID === currentRootIdRef.current && dir === currentDir) {
          void refreshTreeDir(rootID, dir, true);
        }
      }
    };
    const handleFileChanged = (payload: any) => {
      const rootID =
        typeof payload?.root_id === "string" ? payload.root_id : "";
      const changedPath = typeof payload?.path === "string" ? payload.path : "";
      if (!rootID || !changedPath) return;
      const dirs = [dirname(changedPath)];
      if (payload?.is_dir === true) {
        dirs.push(changedPath);
      }
      handleFileChangedBatch({
        root_id: rootID,
        paths: [changedPath],
        dirs,
        events: [
          { path: changedPath, op: payload?.op, is_dir: payload?.is_dir },
        ],
      });
    };
    const unsubscribeEvents = sessionService.subscribeEvents((event) => {
      const payload = (event.payload || {}) as any;
      switch (event.type) {
        case "ws.connecting":
          setStatus("connecting");
          break;
        case "ws.connected":
          setStatus("connected");
          void refreshManagedRoots();
          if (currentRootIdRef.current) {
            const newest = sessionsRef.current[0]?.updated_at || "";
            void loadSessionsForRoot(
              currentRootIdRef.current,
              newest ? { afterTime: newest } : { replace: true },
            );
          }
          if (multiProjectSessionsEnabled) {
            void refreshMultiProjectReplyingSessions();
            void loadMultiProjectSessionGroups();
          }
          replayTargetsForAllRoots();
          break;
        case "ws.reconnecting":
          setStatus("reconnecting");
          break;
        case "ws.reconnected":
          setStatus("connected");
          void refreshManagedRoots();
          if (currentRootIdRef.current) {
            const newest = sessionsRef.current[0]?.updated_at || "";
            void loadSessionsForRoot(
              currentRootIdRef.current,
              newest ? { afterTime: newest } : { replace: true },
            );
          }
          if (multiProjectSessionsEnabled) {
            void refreshMultiProjectReplyingSessions();
            void loadMultiProjectSessionGroups();
          }
          replayTargetsForAllRoots();
          break;
        case "ws.closed":
          setStatus(currentRootIdRef.current ? "reconnecting" : "disconnected");
          void handleRelayWebSocketClosed();
          break;
        case "root.changed":
          if (
            payload?.action === "renamed" &&
            typeof payload?.old_root_id === "string" &&
            typeof payload?.root_id === "string"
          ) {
            const rootPayload =
              payload?.root && typeof payload.root === "object"
                ? ({ ...(payload.root as ManagedRootPayload), id: payload.root_id } as ManagedRootPayload)
                : null;
            if (!rootPayload) {
              break;
            }
            applyManagedRootRename(payload.old_root_id, rootPayload);
            if (currentRootIdRef.current === payload.old_root_id) {
              void actionHandlersRef.current.open_dir({
                path: payload.root_id,
                root: payload.root_id,
                isRoot: true,
                forceDirectory: true,
                preservePluginQuery: true,
              });
            }
            break;
          }
          void refreshManagedRoots();
          break;
        case "session.imported": {
          const rootID =
            typeof payload?.root_id === "string" ? payload.root_id : "";
          const agentName =
            typeof payload?.agent === "string" ? payload.agent : "";
          const agentSessionID =
            typeof payload?.agent_session_id === "string"
              ? payload.agent_session_id.trim()
              : "";
          if (!rootID) {
            break;
          }
          if (rootID === currentRootIdRef.current) {
            void loadSessionsForRoot(rootID, { replace: true });
            if (
              sessionListModeRef.current === "import" &&
              agentSessionID &&
              (!agentName || agentName === externalImportAgentRef.current)
            ) {
              setImportingExternalSessionKeys((current) => {
                if (!current.has(agentSessionID)) {
                  return current;
                }
                const next = new Set(current);
                next.delete(agentSessionID);
                return next;
              });
              setSelectedExternalImportKeys((current) => {
                if (!current.has(agentSessionID)) {
                  return current;
                }
                const next = new Set(current);
                next.delete(agentSessionID);
                return next;
              });
              setConfirmingExternalImport(false);
              if (externalImportAgentRef.current) {
                void loadExternalSessions(rootID, externalImportAgentRef.current, {
                  replace: true,
                });
              }
            }
          }
          if (multiProjectSessionsEnabled) {
            void loadMultiProjectSessionGroups();
          }
          break;
        }
        case "session.created": {
          const rootID =
            typeof payload?.root_id === "string" ? payload.root_id : "";
          if (rootID && rootID === currentRootIdRef.current) {
            void loadSessionsForRoot(rootID, { replace: true });
          }
          if (rootID && multiProjectSessionsEnabled) {
            void loadMultiProjectSessionGroups();
          }
          break;
        }
        case "session.stream":
          handleSessionStream(payload);
          break;
        case "session.slash_command.stream":
          handleSlashCommandStream(payload);
          break;
        case "session.slash_command.done":
          handleSlashCommandDone(payload);
          break;
        case "session.queue.updated": {
          const rootID =
            typeof payload?.root_id === "string" ? payload.root_id : "";
          const sessionKey =
            typeof payload?.session_key === "string" ? payload.session_key : "";
          if (!rootID || !sessionKey) {
            break;
          }
          const incomingQueue = Array.isArray(payload?.queue)
            ? (payload.queue.filter(
                (item: any) =>
                  item &&
                  typeof item.id === "string" &&
                  typeof item.content === "string",
              ) as SessionQueueItem[])
            : [];
          const cacheKey = rootSessionKey(rootID, sessionKey);
          const hidden = optimisticDequeuedIdsRef.current[cacheKey];
          const queue = hidden && hidden.size > 0
            ? incomingQueue.filter((item) => !hidden.has(item.id))
            : incomingQueue;
          queueFrozenBySessionRef.current[cacheKey] = payload?.queue_frozen === true;
          if (hidden) {
            for (const queueId of Array.from(hidden)) {
              if (!incomingQueue.some((item) => item.id === queueId)) {
                hidden.delete(queueId);
              }
            }
            if (hidden.size === 0) {
              delete optimisticDequeuedIdsRef.current[cacheKey];
            }
          }
          queuedMessagesBySessionRef.current[cacheKey] = queue;
          setQueueVersion((v) => v + 1);
          break;
        }
        case "session.accepted": {
          const requestId =
            typeof payload?.request_id === "string" ? payload.request_id : "";
          const pending = pendingRequestRef.current[requestId];
          if (!requestId || !pending) {
            console.warn("[session/ws] accepted_without_pending", { requestId, payloadSessionKey: typeof payload?.session_key === "string" ? payload.session_key : null });
            break;
          }
          console.info("[session/ws] accepted", { requestId, rootId: pending.rootId, sessionKey: pending.sessionKey || null, tempKey: pending.tempKey || null });
          delete pendingRequestRef.current[requestId];
          const acceptedTimestamp =
            typeof payload?.timestamp === "string" &&
            !Number.isNaN(Date.parse(payload.timestamp))
              ? payload.timestamp
              : pending.timestamp;
          const acceptedSessionKey =
            typeof payload?.session_key === "string" ? payload.session_key : "";
          if (!pending.sessionKey && pending.tempKey && acceptedSessionKey) {
            const cacheKey = rootSessionKey(pending.rootId, acceptedSessionKey);
            pendingBySessionRef.current[cacheKey] = {
              ...pending,
              timestamp: acceptedTimestamp,
              sessionKey: acceptedSessionKey,
            };
            setMultiProjectSessionPending(pending.rootId, pending.tempKey, false);
            setMultiProjectSessionPending(pending.rootId, acceptedSessionKey, true);
            if (pendingDraftRef.current?.requestId === pending.requestId) {
              pendingDraftRef.current = null;
            }
            promotePendingSessionForRoot(
              pending.rootId,
              pending.tempKey,
              acceptedSessionKey,
              sessionCacheRef.current[cacheKey] || null,
            );
          }
          const markAccepted = (
            sess: Session | SessionItem | null | undefined,
          ): Session | null => {
            if (!sess) return null;
            const exchanges = Array.isArray((sess as any).exchanges)
              ? ((sess as any).exchanges as Exchange[]).map((exchange) =>
                  exchange.pending_ack === true &&
                  exchange.content === pending.message &&
                  exchange.timestamp === pending.timestamp
                    ? {
                        ...exchange,
                        timestamp: acceptedTimestamp,
                        pending_ack: false,
                      }
                    : exchange,
                )
              : [];
            return {
              ...(sess as any),
              exchanges,
              updated_at: acceptedTimestamp,
            } as Session;
          };
          const acceptedTargetKey = pending.sessionKey || acceptedSessionKey;
          if (acceptedTargetKey) {
            const cacheKey = rootSessionKey(pending.rootId, acceptedTargetKey);
            const accepted = markAccepted(sessionCacheRef.current[cacheKey]);
            if (accepted) {
              sessionCacheRef.current[cacheKey] = accepted;
              bumpCacheVersion();
            }
          }
          const latestDrawer = drawerSessionByRootRef.current[pending.rootId];
          const drawerKey = latestDrawer?.key || "";
          if (
            drawerKey &&
            (drawerKey === pending.sessionKey ||
              drawerKey === pending.tempKey ||
              drawerKey === acceptedSessionKey)
          ) {
            const accepted = markAccepted(latestDrawer);
            if (accepted) {
              setDrawerSessionForRoot(pending.rootId, accepted);
            }
          }
          break;
        }
        case "session.error": {
          const requestId =
            typeof payload?.request_id === "string" ? payload.request_id : "";
          const pending = requestId
            ? pendingRequestRef.current[requestId]
            : null;
          if (!requestId || !pending) {
            console.warn("[session/ws] error_without_pending", { requestId, payloadSessionKey: typeof payload?.session_key === "string" ? payload.session_key : null });
            break;
          }
          console.warn("[session/ws] error", { requestId, rootId: pending.rootId, sessionKey: pending.sessionKey || null, tempKey: pending.tempKey || null });
          delete pendingRequestRef.current[requestId];
          const targetKey = pending.tempKey || "";
          const failedKey = pending.sessionKey || targetKey;
          const rootID = pending.rootId;
          if (failedKey) {
            setMultiProjectSessionPending(rootID, failedKey, false);
          }
          const latestDrawer = drawerSessionByRootRef.current[rootID];
          if (targetKey && latestDrawer?.key === targetKey) {
            const exchanges = Array.isArray((latestDrawer as any).exchanges)
              ? ((latestDrawer as any).exchanges as Exchange[]).map(
                  (exchange) =>
                    exchange.pending_ack === true &&
                    exchange.content === pending.message &&
                    exchange.timestamp === pending.timestamp
                      ? { ...exchange, pending_ack: false }
                      : exchange,
                )
              : [];
            setDrawerSessionForRoot(rootID, {
              ...(latestDrawer as any),
              pending: false,
              exchanges,
            } as Session);
          }
          break;
        }
        case "session.done": {
          const sessionKey =
            typeof payload?.session_key === "string" ? payload.session_key : "";
          const rootID =
            typeof payload?.root_id === "string" && payload.root_id
              ? payload.root_id
              : resolveRootForSessionKey(sessionKey) ||
                currentRootIdRef.current ||
                "";
          if (rootID && sessionKey) {
            if (payload?.replay !== true) {
              playCompletionSound();
            }
            setMultiProjectSessionPending(rootID, sessionKey, false);
            handleSessionStreamDone(rootID, sessionKey);
            const newest = sessionsRef.current[0]?.updated_at || "";
            void loadSessionsForRoot(
              rootID,
              newest ? { afterTime: newest } : { replace: true },
            );
            if (multiProjectSessionsEnabled) {
              void loadMultiProjectSessionGroups();
            }
          } else if (currentRootIdRef.current) {
            const newest = sessionsRef.current[0]?.updated_at || "";
            void loadSessionsForRoot(
              currentRootIdRef.current,
              newest ? { afterTime: newest } : { replace: true },
            );
            if (multiProjectSessionsEnabled) {
              void refreshMultiProjectReplyingSessions();
              void loadMultiProjectSessionGroups();
            }
          }
          break;
        }
        case "session.user_message":
          if (
            typeof payload?.session_key === "string" &&
            typeof payload?.root_id === "string"
          ) {
            const rootID = payload.root_id;
            const sessionKey = payload.session_key;
            setMultiProjectSessionPending(rootID, sessionKey, true);
            const exchange = payload.exchange;
            const sessionMeta = payload.session;
            const cacheKey = rootSessionKey(rootID, sessionKey);
            console.info("[session/ws] user_message", {
              rootID,
              sessionKey,
              sessionAgent: sessionMeta?.agent || "",
              exchangeAgent: exchange?.agent || "",
              cachedAgent: (sessionCacheRef.current[cacheKey] as any)?.agent || "",
              currentAgent:
                currentSessionRef.current?.key === sessionKey
                  ? ((currentSessionRef.current as any)?.agent || "")
                  : "",
              selectedAgent:
                (selectedSessionRef.current?.key || selectedSessionRef.current?.session_key) === sessionKey
                  ? ((selectedSessionRef.current as any)?.agent || "")
                  : "",
            });
            const cached =
              sessionCacheRef.current[cacheKey] ||
              ({
                key: sessionKey,
                type: sessionMeta?.type || "chat",
                agent: sessionMeta?.agent || exchange?.agent || "",
                model: sessionMeta?.model || exchange?.model || "",
                mode: sessionMeta?.mode || exchange?.mode || "",
                effort: sessionMeta?.effort || exchange?.effort || "",
                fast_service:
                  normalizeFastService(sessionMeta?.fast_service) ||
                  normalizeFastService(exchange?.fast_service),
	                plan_mode:
	                  typeof sessionMeta?.plan_mode === "boolean"
	                    ? sessionMeta.plan_mode
	                    : false,
                name: sessionMeta?.name || t("session.new"),
                created_at:
                  sessionMeta?.created_at ||
                  exchange?.timestamp ||
                  new Date().toISOString(),
                updated_at:
                  sessionMeta?.updated_at ||
                  exchange?.timestamp ||
                  new Date().toISOString(),
                exchanges: [],
              } as any);
            const prevExchanges = Array.isArray((cached as any).exchanges)
              ? ((cached as any).exchanges as Exchange[])
              : [];
            const duplicate = prevExchanges.some(
              (item) =>
                item.role === "user" &&
                item.content === exchange?.content &&
                item.timestamp === exchange?.timestamp,
            );
            sessionCacheRef.current[cacheKey] = {
              ...(cached as any),
              ...(sessionMeta || {}),
              key: sessionKey,
              agent:
                sessionMeta?.agent ||
                exchange?.agent ||
                (cached as any).agent ||
                "",
              model:
                sessionMeta?.model ||
                exchange?.model ||
                (cached as any).model ||
                "",
              mode:
                sessionMeta?.mode ||
                exchange?.mode ||
                (cached as any).mode ||
                "",
              effort:
                sessionMeta?.effort ||
                exchange?.effort ||
                (cached as any).effort ||
                "",
              fast_service:
                normalizeFastService(sessionMeta?.fast_service) ||
                normalizeFastService(exchange?.fast_service) ||
                normalizeFastService((cached as any).fast_service),
	              plan_mode:
	                typeof sessionMeta?.plan_mode === "boolean"
	                  ? sessionMeta.plan_mode
	                  : !!(cached as any).plan_mode,
              exchanges: duplicate
                ? prevExchanges
                : [
                    ...prevExchanges,
                    {
                      role: "user",
                      agent: exchange?.agent || "",
                      model: exchange?.model || "",
	                      mode: exchange?.mode || "",
	                      effort: exchange?.effort || "",
	                      fast_service: exchange?.fast_service || "",
	                      content: exchange?.content || "",
                      timestamp:
                        exchange?.timestamp || new Date().toISOString(),
                      pending_ack: false,
                    },
                  ],
              updated_at:
                sessionMeta?.updated_at ||
                exchange?.timestamp ||
                new Date().toISOString(),
            } as Session;
            const runtimeAgent = sessionMeta?.agent || exchange?.agent || "";
            if (runtimeAgent) {
              updateSessionAgentForKey(
                rootID,
                sessionKey,
                runtimeAgent,
                sessionMeta?.model || exchange?.model || "",
                sessionMeta?.mode || exchange?.mode || "",
                sessionMeta?.effort || exchange?.effort || "",
                normalizeFastService(sessionMeta?.fast_service) ||
                  normalizeFastService(exchange?.fast_service),
                typeof sessionMeta?.plan_mode === "boolean"
                  ? sessionMeta.plan_mode
                  : undefined,
              );
            }
            bumpCacheVersion();
            const newest = sessionsRef.current[0]?.updated_at || "";
            void loadSessionsForRoot(
              rootID,
              newest ? { afterTime: newest } : { replace: true },
            );
            if (multiProjectSessionsEnabled) {
              void loadMultiProjectSessionGroups();
            }
          }
          break;
        case "task.updated":
          if (
            typeof payload?.root_id === "string" &&
            payload.root_id === currentRootIdRef.current &&
            typeof payload?.task?.id === "string"
          ) {
            const nextTask = payload.task as KanbanTask;
            const detail = payload.detail as TaskDetail | undefined;
            if (detail?.task?.id) {
              applyTaskDetails(payload.root_id, [detail]);
            } else {
              const current = taskDetailsByIdRef.current[nextTask.id];
              applyTaskDetails(payload.root_id, [{
                task: nextTask,
                stage_runs: current?.stage_runs || [],
                events: current?.events || [],
              }]);
            }
            if (nextTask.worktree_path) {
              void refreshTaskWorktree(payload.root_id, nextTask.worktree_path, false);
            }
          }
          break;
        case "session.meta.updated":
          if (
            typeof payload?.root_id === "string" &&
            typeof payload?.session?.key === "string"
          ) {
            const rootID = payload.root_id;
            const sessionKey = payload.session.key;
            const cacheKey = rootSessionKey(rootID, sessionKey);
            const cached =
              sessionCacheRef.current[cacheKey] ||
              ({
                key: sessionKey,
                root_id: rootID,
                type: normalizeMode(payload.session.type),
                name:
                  typeof payload.session.name === "string"
                    ? payload.session.name
                    : "",
                created_at: payload.session.updated_at || new Date().toISOString(),
                updated_at: payload.session.updated_at || new Date().toISOString(),
                exchanges: [],
              } as Session);
            sessionCacheRef.current[cacheKey] = {
                ...cached,
                name:
                  typeof payload.session.name === "string"
                    ? payload.session.name
                    : cached.name,
                agent:
                  typeof payload.session.agent === "string"
                    ? payload.session.agent
                    : (cached as any).agent,
                model:
                  typeof payload.session.model === "string"
                    ? payload.session.model
                    : (cached as any).model,
                mode:
                  typeof payload.session.mode === "string"
                    ? payload.session.mode
                    : (cached as any).mode,
                effort:
                  typeof payload.session.effort === "string"
                    ? payload.session.effort
                    : (cached as any).effort,
                fast_service:
                  normalizeFastService(payload.session.fast_service) ||
                  normalizeFastService((cached as any).fast_service),
                plan_mode:
                  typeof payload.session.plan_mode === "boolean"
                    ? payload.session.plan_mode
                    : !!(cached as any).plan_mode,
                parent_session_key:
                  typeof payload.session.parent_session_key === "string"
                    ? payload.session.parent_session_key
                    : (cached as any).parent_session_key,
                parent_tool_call_id:
                  typeof payload.session.parent_tool_call_id === "string"
                    ? payload.session.parent_tool_call_id
                    : (cached as any).parent_tool_call_id,
                source:
                  typeof payload.session.source === "string"
                    ? payload.session.source
                    : (cached as any).source,
                task_id:
                  typeof payload.session.task_id === "string"
                    ? payload.session.task_id
                    : (cached as any).task_id,
                related_worktree:
                  payload.session.related_worktree !== undefined
                    ? payload.session.related_worktree
                    : (cached as any).related_worktree,
                pinned_at:
                  payload.session.pinned_at !== undefined
                    ? payload.session.pinned_at || undefined
                    : (cached as any).pinned_at,
                updated_at: payload.session.updated_at || cached.updated_at,
              } as Session;
            bumpCacheVersion();
            if (
              (selectedSessionRef.current?.key ||
                selectedSessionRef.current?.session_key) === sessionKey
            ) {
              setSelectedSession((prev) =>
                prev
                  ? ({
                      ...(prev as any),
                      name:
                        typeof payload.session.name === "string"
                          ? payload.session.name
                          : prev.name,
                      agent:
                        typeof payload.session.agent === "string"
                          ? payload.session.agent
                          : (prev as any).agent,
                      model:
                        typeof payload.session.model === "string"
                          ? payload.session.model
                          : (prev as any).model,
                      mode:
                        typeof payload.session.mode === "string"
                          ? payload.session.mode
                          : (prev as any).mode,
                      effort:
                        typeof payload.session.effort === "string"
                          ? payload.session.effort
                          : (prev as any).effort,
                      fast_service:
                        normalizeFastService(payload.session.fast_service) ||
                        normalizeFastService((prev as any).fast_service),
                      plan_mode:
                        typeof payload.session.plan_mode === "boolean"
                          ? payload.session.plan_mode
                          : !!(prev as any).plan_mode,
                      parent_session_key:
                        typeof payload.session.parent_session_key === "string"
                          ? payload.session.parent_session_key
                          : (prev as any).parent_session_key,
                      parent_tool_call_id:
                        typeof payload.session.parent_tool_call_id === "string"
                          ? payload.session.parent_tool_call_id
                          : (prev as any).parent_tool_call_id,
                      source:
                        typeof payload.session.source === "string"
                          ? payload.session.source
                          : (prev as any).source,
                      task_id:
                        typeof payload.session.task_id === "string"
                          ? payload.session.task_id
                          : (prev as any).task_id,
                      related_worktree:
                        payload.session.related_worktree !== undefined
                          ? payload.session.related_worktree
                          : (prev as any).related_worktree,
                      pinned_at:
                        payload.session.pinned_at !== undefined
                          ? payload.session.pinned_at || undefined
                          : (prev as any).pinned_at,
                      updated_at: payload.session.updated_at || prev.updated_at,
                    } as SessionItem)
                  : prev,
              );
            }
            if (boundSessionByRootRef.current[rootID] === sessionKey) {
              const latest = sessionCacheRef.current[cacheKey];
              if (latest) {
                setDrawerSessionForRoot(rootID, latest);
              }
            }
            const relatedWorktreePath =
              typeof payload.session.related_worktree?.path === "string"
                ? payload.session.related_worktree.path.trim()
                : "";
            if (relatedWorktreePath) {
              void refreshTaskWorktree(rootID, relatedWorktreePath, false);
            }
            const newest = sessionsRef.current[0]?.updated_at || "";
            void loadSessionsForRoot(
              rootID,
              newest ? { afterTime: newest } : { replace: true },
            );
            if (multiProjectSessionsEnabled) {
              void loadMultiProjectSessionGroups();
            }
          }
          break;
        case "session.related_files.updated": {
          const rootID =
            typeof payload?.root_id === "string" ? payload.root_id : "";
          const sessionKey =
            typeof payload?.session_key === "string" ? payload.session_key : "";
          if (rootID && sessionKey) {
            void refreshSessionRelatedFiles(rootID, sessionKey);
            refreshTasksForRelatedSession(rootID, sessionKey);
            const cachedSession =
              sessionCacheRef.current[rootSessionKey(rootID, sessionKey)];
            const parentSessionKey = String(
              cachedSession?.parent_session_key || "",
            ).trim();
            if (parentSessionKey) {
              void refreshSessionRelatedFiles(rootID, parentSessionKey);
              refreshTasksForRelatedSession(rootID, parentSessionKey);
            }
            if (payload?.related_worktree && typeof payload.related_worktree === "object") {
              updateSessionRelatedWorktreeForKey(
                rootID,
                sessionKey,
                payload.related_worktree as RelatedWorktree,
              );
            }
          }
          break;
        }
        case "file.changed.batch":
          handleFileChangedBatch(payload);
          break;
        case "file.changed":
          handleFileChanged(payload);
          break;
        case "agent.status.changed":
          setAgentsVersion((v) => v + 1);
          break;
        case "app.update":
          setUpdateState(normalizeUpdateState(payload?.state as UpdateState));
          break;
        case "github.import": {
          const status = (payload?.status || {}) as any;
          const taskID = typeof status?.task_id === "string" ? status.task_id : "";
          if (!taskID) {
            break;
          }
          setGitHubImportState((prev) => {
            if (prev.taskId && prev.taskId !== taskID) {
              return prev;
            }
            const nextStatus = String(status?.status || "");
            const done = nextStatus === "done";
            const failed = nextStatus === "failed";
            return {
              ...prev,
              taskId: taskID,
              status: nextStatus,
              message: String(status?.message || ""),
              running: !done && !failed,
              submitting: false,
              done,
              error: failed ? String(status?.message || t("root.githubImportFailed")) : "",
            };
          });
          if (String(status?.status || "") === "done") {
            setProjectAddMode(null);
            void refreshManagedRoots();
            const rootID = typeof status?.root_id === "string" ? status.root_id : "";
            if (rootID) {
              void actionHandlersRef.current.open_dir({
                path: rootID,
                root: rootID,
                isRoot: true,
              });
            }
          }
          break;
        }
      }
    });
    void loadSessionsForRoot(currentRootId, { replace: true });
    return () => {
      cancelled = true;
      unsubscribeEvents();
    };
  }, [
    currentRootId,
    loadExternalSessions,
    loadMultiProjectSessionGroups,
    loadSessionsForRoot,
    multiProjectSessionsEnabled,
    refreshMultiProjectReplyingSessions,
    rootSessionKey,
    resolveRootForSessionKey,
    promotePendingSessionForRoot,
    appendAgentChunkForSession,
    appendThoughtChunkForSession,
    appendToolCallForSession,
    appendTodoUpdateForSession,
    appendPlanUpdateForSession,
    appendCompactNoticeForSession,
    clearSessionStale,
    markSessionPending,
    markSessionStale,
    resolvePendingForSession,
    setSelectedPendingByKey,
    setBoundSessionForRoot,
    setDrawerSessionForRoot,
    setMultiProjectSessionPending,
    refreshManagedRoots,
    handleRelayWebSocketClosed,
    invalidatePluginsForRoot,
    refreshTreeDir,
    refreshCurrentFileContent,
    refreshGitStatus,
    refreshManagedRoots,
    updateSessionRelatedWorktreeForKey,
    updateSessionRelatedFilesForKey,
    refreshTasksForRelatedSession,
    updateSessionAgentForKey,
    treeCacheKey,
    t,
  ]);

  useEffect(() => {
    if (!currentRootId) return;
    if (pluginsLoadedByRootRef.current[currentRootId]) return;
    void ensurePluginsLoaded(currentRootId).catch(() => {});
  }, [currentRootId, ensurePluginsLoaded]);

  const handleLoadOlderSessions = useCallback(async () => {
    const rootID = currentRootIdRef.current;
    const oldest =
      sessionsRef.current[sessionsRef.current.length - 1]?.updated_at || "";
    if (!rootID || !oldest || loadingOlderSessions) {
      return;
    }
    setLoadingOlderSessions(true);
    try {
      const payload = await sessionService.fetchSessions(rootID, {
        beforeTime: oldest,
      });
      const next = [...payload.items, ...payload.pinnedItems]
        .map((item) => toSessionItem(rootID, item))
        .filter((item): item is SessionItem => !!item);
      setHasMoreSessions(payload.totalCount > payload.items.length);
      setSessions((prev) =>
        applyPinnedSnapshotToSessions(mergeSessionItems(prev, next), rootID, payload.pinnedKeys),
      );
    } finally {
      setLoadingOlderSessions(false);
    }
  }, [loadingOlderSessions]);

  useEffect(() => {
    if (didInitRef.current) {
      return;
    }
    didInitRef.current = true;
    let cancelled = false;
    let settled = false;
    if (isRelayPWAContext() && !isRelayNodePage()) {
      const lastNodeID = window.localStorage.getItem(
        RELAY_LAST_NODE_ID_STORAGE_KEY,
      );
      if (lastNodeID) {
        window.location.replace(`/n/${lastNodeID}/`);
        return;
      }
    }
    void (async () => {
      try {
        const bootstrap = await bootstrapService.start();
        if (bootstrap.phase !== "ready") {
          didInitRef.current = false;
          return;
        }
        const dirs = await loadManagedRootPayloads();
        if (!dirs) {
          return;
        }
        if (cancelled || !dirs.length) {
          return;
        }
        const nextDirs = dirs as ManagedRootPayload[];
        syncRelayNodesToNative(nextDirs);
        const ids = nextDirs.map((d) => d.id);
        managedRootByIdRef.current = Object.fromEntries(
          nextDirs.filter((dir) => !!dir.id).map((dir) => [dir.id, dir]),
        );
        managedRootIdsRef.current = new Set(ids);
        setManagedRootIds(ids);
        setRootEntries(mapManagedRootsToEntries(nextDirs));
        const urlState = readURLState();
        const lastRoot = loadLastRootId();
        const preferredRoot =
          urlState.root && ids.includes(urlState.root)
            ? urlState.root
            : lastRoot && ids.includes(lastRoot)
              ? lastRoot
              : ids[0];
        setCurrentRootId(preferredRoot);
        setPluginQuery(urlState.pluginQuery);
        if (urlState.session) {
          if (cancelled) return;
          await handleSelectSessionRef.current?.({
            key: urlState.session,
            session_key: urlState.session,
            root_id: preferredRoot,
          });
        } else if (urlState.file) {
          await ensurePluginsLoaded(preferredRoot);
          if (cancelled) return;
          actionHandlersRef.current.open({
            path: urlState.file,
            root: preferredRoot,
            cursor: urlState.cursor,
            preservePluginQuery: true,
          });
        } else {
          const restored = await tryShowBoundSessionForRoot(preferredRoot, {
            pluginQuery: urlState.pluginQuery,
          });
          if (!restored) {
            actionHandlersRef.current.open_dir({
              path: preferredRoot,
              root: preferredRoot,
              preservePluginQuery: true,
              isRoot: true,
            });
          } else {
            void loadSessionsForRoot(preferredRoot, {
              replace: true,
              force: true,
            });
            await refreshTreeDir(preferredRoot, ".", false);
          }
        }
      } catch (err) {
        if (cancelled) {
          return;
        }
        reportError(
          "app.init_failed",
          String((err as Error)?.message || err || t("app.initFailed")),
        );
      } finally {
        settled = true;
      }
    })();
    return () => {
      cancelled = true;
      if (!settled) {
        didInitRef.current = false;
      }
    };
  }, [
    ensurePluginsLoaded,
    handleRelayNavigationFailure,
    loadManagedRootPayloads,
    loadSessionsForRoot,
    refreshTreeDir,
    tryShowBoundSessionForRoot,
    bootstrapState.phase,
  ]);

  useEffect(() => {
    return bootstrapService.subscribe((state) => {
      setBootstrapState(state);
      setRelayStatus(state.relayStatus);
      setE2eeState(state.e2ee);
    });
  }, []);

  useEffect(() => {
    document.title = formatDocumentTitle(relayStatus);
  }, [relayStatus]);

  useEffect(() => {
    return e2eeService.subscribe((state) => {
      setE2eeState(state);
    });
  }, []);

  useEffect(() => {
    void syncNativeReplyPollerE2EE().catch((err) => {
      console.warn("[ReplyPoller] Failed to sync E2EE state:", err);
    });
  }, [e2eeState.nodeId, e2eeState.required, e2eeState.unlocked]);

  useEffect(() => {
    if (!e2eeState.required) {
      setE2eeSecretInput("");
      setE2eePromptError("");
    }
  }, [e2eeState.required, e2eeState.secretPresent]);

  useEffect(() => {
    if (bootstrapState.phase !== "ready") {
      return;
    }
    setAgentsVersion((v) => v + 1);
    void loadTaskTemplates();
    void loadKanbanTasks(currentRootIdRef.current);
    if (multiProjectSessionsEnabled) {
      void loadMultiProjectSessionGroups();
    }
  }, [
    bootstrapState.phase,
    loadKanbanTasks,
    loadMultiProjectSessionGroups,
    loadTaskTemplates,
    multiProjectSessionsEnabled,
  ]);

  const describeE2EEPromptError = useCallback((err: unknown) => {
    const code = err instanceof Error ? String(err.message || "").trim() : "";
    switch (code) {
      case "e2ee_proof_invalid":
        return t("e2ee.invalidProof");
      case "e2ee_secure_context_required":
      case "e2ee_webcrypto_unavailable":
        return t("e2ee.secureContextRequired");
      case "e2ee_secret_missing":
        return t("e2ee.secretMissing");
      case "e2ee_open_invalid_response":
        return t("e2ee.invalidResponse");
      default:
        if (code.startsWith("e2ee_open_failed_")) {
          return t("e2ee.openFailed");
        }
        return t("e2ee.failed");
    }
  }, [t]);

  const submitE2EESecret = useCallback(async () => {
    const trimmed = e2eeSecretInput.trim();
    if (!trimmed) {
      setE2eePromptError(t("e2ee.codeRequired"));
      return;
    }
    setE2eePromptBusy(true);
    setE2eePromptError("");
    try {
      await bootstrapService.submitPairingSecret(trimmed);
      didInitRef.current = false;
      setE2eeSecretInput("");
    } catch (err) {
      setE2eePromptError(describeE2EEPromptError(err));
    } finally {
      setE2eePromptBusy(false);
    }
  }, [describeE2EEPromptError, e2eeSecretInput, t]);

  useEffect(() => {
    if (!isRelayPWAContext()) {
      return;
    }
    const nodeID = relayNodeIdFromPathname(window.location.pathname);
    if (!nodeID) {
      return;
    }
    window.localStorage.setItem(RELAY_LAST_NODE_ID_STORAGE_KEY, nodeID);
  }, []);

  useEffect(() => {
    function handlePopState() {
      const state = readURLState();
      if (state.root) {
        setCurrentRootId(state.root);
      }
      setPluginQuery(state.pluginQuery);
      if (!state.root) {
        return;
      }
      if (state.session) {
        const currentSessionKey =
          selectedSessionRef.current?.key ||
          selectedSessionRef.current?.session_key ||
          "";
        const currentSessionRoot =
          (selectedSessionRef.current?.root_id as string | undefined) ||
          currentRootIdRef.current ||
          "";
        if (
          state.session !== currentSessionKey ||
          state.root !== currentSessionRoot
        ) {
          void handleSelectSessionRef.current?.({
            key: state.session,
            session_key: state.session,
            root_id: state.root,
          });
        }
        return;
      }
      if (state.file) {
        const currentPath = fileRef.current?.path || "";
        const currentRoot = currentRootIdRef.current || "";
        const currentCursor = fileCursorRef.current;
        if (
          state.file !== currentPath ||
          state.root !== currentRoot ||
          state.cursor !== currentCursor
        ) {
          actionHandlers.open({
            path: state.file,
            root: state.root,
            cursor: state.cursor,
            preservePluginQuery: true,
          });
        }
        return;
      }
      void (async () => {
        const restored = await tryShowBoundSessionForRoot(state.root, {
          pluginQuery: state.pluginQuery,
        });
        if (restored) {
          void loadSessionsForRoot(state.root, { replace: true, force: true });
          await refreshTreeDir(state.root, ".", false);
          return;
        }
        actionHandlers.open_dir({
          path: state.root,
          root: state.root,
          preservePluginQuery: true,
          isRoot: true,
        });
      })();
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [actionHandlers, loadSessionsForRoot, refreshTreeDir, tryShowBoundSessionForRoot]);

  const selectedRoot =
    (selectedSession?.root_id as string | undefined) || currentRootId || "";
  const selectedInCurrentRoot =
    !!selectedSession && !!currentRootId && selectedRoot === currentRootId;
  const selectedKey =
    selectedSession?.key || selectedSession?.session_key || "";
  const boundFromSelected =
    selectedInCurrentRoot && selectedKey === activeBoundSessionKey
      ? (selectedSession as any)
      : null;
  const boundFromCache =
    activeBoundSessionKey && currentRootId
      ? (sessionCacheRef.current[
          rootSessionKey(currentRootId, activeBoundSessionKey)
        ] as any)
      : null;
  const isDetachedMainSessionTarget =
    !!activeBoundSessionKey &&
    selectedInCurrentRoot &&
    !!selectedKey &&
    selectedKey !== activeBoundSessionKey &&
    interactionMode !== "drawer";
  const actionBarSession = activeBoundSessionKey
    ? isDetachedMainSessionTarget
      ? (selectedSession as any)
      : (currentSession as any) || boundFromCache || boundFromSelected
    : selectedInCurrentRoot
      ? (selectedSession as any)
      : null;
  const actionBarSessionKey =
    (actionBarSession as any)?.key ||
    (actionBarSession as any)?.session_key ||
    "";
  const actionBarInputHistory = sessionInputHistory(
    getSessionSnapshot(
      ((actionBarSession as any)?.root_id as string | undefined) || currentRootId,
      actionBarSession as any,
    ) || (actionBarSession as any),
  );
  const isBoundSessionInMain =
    !!activeBoundSessionKey &&
    selectedKey === activeBoundSessionKey &&
    interactionMode !== "drawer";
  const canOpenSessionDrawer = !!activeBoundSessionKey && !isBoundSessionInMain;
  const detachedBoundSession =
    isDetachedMainSessionTarget && !isDrawerOpen;
  const actionBarQueuedMessages = useMemo(() => {
    void queueVersion;
    if (!currentRootId || !actionBarSessionKey) return [];
    return (
      queuedMessagesBySessionRef.current[
        rootSessionKey(currentRootId, actionBarSessionKey)
      ] || []
    );
  }, [actionBarSessionKey, currentRootId, queueVersion, rootSessionKey]);

  const matchedPlugin = useMemo(() => {
    if (!currentRootId || !file) return null;
    const input = toPluginInput(file, pluginQuery);
    return pluginManagerRef.current.match(currentRootId, input);
  }, [currentRootId, file, pluginVersion, pluginQuery]);

  useEffect(() => {
    if (!file || pluginBypass || !matchedPlugin) return;
    if (inferReadModeFromPlugin(matchedPlugin) !== "full") return;
    if (!file.truncated) return;
    const root = file.root || currentRootId;
    if (!root) return;
    const upgradeKey = `${root}:${file.path}:${matchedPlugin.name}:${JSON.stringify(pluginQuery)}`;
    if (fullUpgradeAttemptRef.current === upgradeKey) return;
    fullUpgradeAttemptRef.current = upgradeKey;
    void actionHandlers.open({
      path: file.path,
      root,
      cursor: fileCursorRef.current || 0,
      readMode: "full",
      preservePluginQuery: true,
    });
  }, [
    file,
    pluginBypass,
    matchedPlugin,
    currentRootId,
    pluginQuery,
    actionHandlers,
  ]);

  const pluginRender = useMemo(() => {
    if (!file || pluginBypass || !matchedPlugin) return null;
    const input = toPluginInput(file, pluginQuery);
    try {
      const output = pluginManagerRef.current.run(matchedPlugin, input);
      return { plugin: matchedPlugin, output, error: "" };
    } catch (err: any) {
      return {
        plugin: matchedPlugin,
        output: null,
        error: String(err?.message || err || "plugin process failed"),
      };
    }
  }, [file, pluginBypass, matchedPlugin, pluginQuery]);

  useEffect(() => {
    if (!file || pluginBypass || !pluginRender?.output) {
      return;
    }
    const handleSelectionChange = () => {
      const root = pluginContentRef.current;
      const selection = window.getSelection();
      if (!root || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
        handleViewerSelectionChange(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const commonAncestor = range.commonAncestorContainer;
      if (!root.contains(commonAncestor)) {
        handleViewerSelectionChange(null);
        return;
      }
      const text = selection.toString();
      if (!text.trim()) {
        handleViewerSelectionChange(null);
        return;
      }
      handleViewerSelectionChange({
        filePath: file.path,
        text,
      });
    };
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
      handleViewerSelectionChange(null);
    };
  }, [file, pluginBypass, pluginRender?.output, handleViewerSelectionChange]);

  useEffect(() => {
    if (!file || pluginBypass || !pluginRender?.output) {
      lastPluginChapterRef.current = "";
      return;
    }
    const chapterKey = `${file.path}:${pluginQuery.chapter || "1"}`;
    if (!lastPluginChapterRef.current) {
      lastPluginChapterRef.current = chapterKey;
      return;
    }
    if (lastPluginChapterRef.current === chapterKey) {
      return;
    }
    lastPluginChapterRef.current = chapterKey;
    requestAnimationFrame(() => {
      pluginContentRef.current?.scrollTo({ top: 0, behavior: "auto" });
    });
  }, [file, pluginBypass, pluginRender?.output, pluginQuery.chapter]);

  const pluginRendererKey = `${currentRootId || ""}:${file?.path || ""}:${fileCursorRef.current}:${JSON.stringify(pluginQuery)}`;
  const pluginThemeVars = useMemo(() => {
    const theme = pluginRender?.plugin?.theme;
    if (!theme) return null;
    return {
      "--vp-overlay-bg": theme.overlayBg,
      "--vp-surface-bg": theme.surfaceBg,
      "--vp-surface-bg-elevated": theme.surfaceBgElevated,
      "--vp-text": theme.text,
      "--vp-text-muted": theme.textMuted,
      "--vp-border": theme.border,
      "--vp-primary": theme.primary,
      "--vp-primary-text": theme.primaryText,
      "--vp-radius": theme.radius,
      "--vp-shadow": theme.shadow,
      "--vp-focus-ring": theme.focusRing,
      "--vp-danger": theme.danger,
      "--vp-warning": theme.warning,
      "--vp-success": theme.success,
    } as React.CSSProperties;
  }, [pluginRender]);

	  const selectedSessionSnapshot = useMemo(
	    () => {
	      if (!selectedSession) {
	        return null;
      }
      return getSessionSnapshot(
        selectedSession.root_id || currentRootId,
        selectedSession,
      );
	    },
	    [selectedSession, selectedSessionLoading, currentRootId, getSessionSnapshot],
	  );
	  const sessionByKey = useMemo(() => sessions.reduce<Record<string, SessionItem>>((acc, session) => {
	    const key = session.key || session.session_key || "";
	    if (key) acc[key] = session;
	    return acc;
	  }, {}), [sessions]);

	  const selectedKanbanTask = useMemo(
	    () => kanbanTasks.find((task) => task.id === selectedKanbanTaskId) || null,
	    [kanbanTasks, selectedKanbanTaskId],
	  );
	  const selectedKanbanTaskSessionKey = useMemo(() => {
	    if (!selectedKanbanTask) return "";
	    const keys = taskSessionKeysById[selectedKanbanTask.id] || [];
	    return keys[0] || selectedKanbanTask.main_session_key || "";
	  }, [selectedKanbanTask, taskSessionKeysById]);
	  const selectedKanbanTaskSessionSnapshot = useMemo(() => {
	    if (!selectedKanbanTask || !selectedKanbanTaskSessionKey) return null;
	    const root = selectedKanbanTask.root_id || currentRootId || "";
	    const session = sessionByKey[selectedKanbanTaskSessionKey] || {
	      key: selectedKanbanTaskSessionKey,
	      session_key: selectedKanbanTaskSessionKey,
	      root_id: root,
	      task_id: selectedKanbanTask.id,
	    };
	    return getSessionSnapshot(root, session as any);
	  }, [currentRootId, getSessionSnapshot, selectedKanbanTask, selectedKanbanTaskSessionKey, sessionByKey]);

	  useEffect(() => {
    if (selectedSessionSnapshot) {
      lastMainSessionSnapshotRef.current = selectedSessionSnapshot as Session;
    }
  }, [selectedSessionSnapshot]);

  useEffect(() => {
    const sessionKey =
      selectedSession?.key || selectedSession?.session_key || "";
    const rootID =
      (selectedSession?.root_id as string | undefined) || currentRootId || "";
    if (!rootID || !sessionKey || sessionKey.startsWith("pending-")) {
      return;
    }
    if (selectedSessionLoading) {
      return;
    }
    const cacheKey = rootSessionKey(rootID, sessionKey);
    const isStale = isSessionStale(rootID, sessionKey);
    const cached = sessionCacheRef.current[cacheKey];
    if (!isStale && loadedSessionRef.current[cacheKey]) {
      return;
    }
    if (!isStale && hasSessionExchanges(cached)) {
      return;
    }
    if (!isStale && hasSessionExchanges(selectedSessionSnapshot as Session | null)) {
      return;
    }
    if (loadingSessionRef.current[cacheKey]) {
      return;
    }
    void restoreActiveSession(rootID, sessionKey).then((restored) => {
      if (!restored) {
        return;
      }
      loadedSessionRef.current[cacheKey] = true;
      clearSessionStale(rootID, sessionKey);
      setSelectedSession((prev) => {
        const prevKey = prev?.key || prev?.session_key;
        const prevRoot =
          (prev?.root_id as string | undefined) || currentRootIdRef.current;
        if (!prev || prevKey !== sessionKey || prevRoot !== rootID) {
          return prev;
        }
        return toSessionItem(rootID, {
          ...(prev as any),
          ...(restored as any),
          key: sessionKey,
          session_key: sessionKey,
          root_id: rootID,
        });
      });
      if (boundSessionByRootRef.current[rootID] === sessionKey) {
        setDrawerSessionForRoot(rootID, restored);
      }
    });
  }, [
    selectedSession,
    selectedSessionLoading,
    selectedSessionSnapshot,
    currentRootId,
    rootSessionKey,
    bumpCacheVersion,
    clearSessionStale,
    isSessionStale,
    resolvePendingForSession,
    restoreActiveSession,
    setDrawerSessionForRoot,
  ]);

  const handleSelectedSessionFileClick = useCallback(
    (target: string | RelatedFileClickTarget) => {
      setProjectTreeTabRequest((prev) => ({
        tab: "related",
        nonce: (prev?.nonce || 0) + 1,
      }));
      const root =
        (selectedSessionRef.current?.root_id as string | undefined) ||
        currentRootIdRef.current;
      if (!root) return;
      setExpanded((prev) => Array.from(new Set([...prev, root])));
      const file =
        typeof target === "string" ? { path: target } : target;
      void openRelatedFileDiff(root, file);
    },
    [openRelatedFileDiff],
  );

  const drawerSessionSnapshot = useMemo(
    () =>
      currentSession ? getSessionSnapshot(currentRootId, currentSession) : null,
    [currentSession, currentRootId, getSessionSnapshot],
  );

  const rootSessionIndicators = useMemo(() => {
    const next: Record<string, { bound?: boolean; pending?: boolean }> = {};
    for (const root of managedRootIds) {
      const boundKey = String(boundSessionByRootRef.current[root] || "").trim();
      const hasBound = !!boundKey && !boundKey.startsWith("pending-");
      const pendingPrefix = rootSessionKey(root, "");
      const hasPendingSession = Object.entries(multiProjectPendingByKey).some(
        ([key, pending]) => pending && key.startsWith(pendingPrefix),
      );
      if (!hasBound && !hasPendingSession) {
        continue;
      }
      const drawer = drawerSessionByRootRef.current[root] as
        | (Session & { pending?: boolean })
        | null
        | undefined;
      const selected =
        ((selectedSession?.root_id as string | undefined) || currentRootId) ===
          root &&
        (selectedSession?.key || selectedSession?.session_key) === boundKey
          ? ((selectedSession as any) as { pending?: boolean })
          : null;
      const pending =
        hasPendingSession ||
        (drawer?.key === boundKey && !!drawer?.pending) ||
        !!selected?.pending;
      next[root] = { bound: hasBound || hasPendingSession, pending };
    }
    return next;
  }, [
    managedRootIds,
    selectedSession,
    currentSession,
    currentRootId,
    activeBoundSessionKey,
    cacheVersion,
    multiProjectPendingByKey,
    rootSessionKey,
  ]);

  const handleDrawerSessionFileClick = useCallback(
    (target: string | RelatedFileClickTarget) => {
      const root = currentRootIdRef.current;
      if (!root) return;
      const file =
        typeof target === "string" ? { path: target } : target;
      void openRelatedFileDiff(root, file);
    },
    [openRelatedFileDiff],
  );

  const handleRemoveSessionRelatedFile = useCallback(
    async (
      rootID: string | null | undefined,
      sessionKey: string | undefined,
      path: string,
      head = "",
      repoPath = "",
      repoKind = "",
    ) => {
      const resolvedRoot = rootID || currentRootIdRef.current;
      const resolvedKey = sessionKey || "";
      if (!resolvedRoot || !resolvedKey || !path) return;
      const removed = await sessionService.removeSessionRelatedFile(
        resolvedRoot,
        resolvedKey,
        path,
        head,
        repoPath,
        repoKind,
      );
      if (!removed) return;
      const relatedFiles = await sessionService.getSessionRelatedFiles(
        resolvedRoot,
        resolvedKey,
      );
      await setCachedSessionRelatedFiles(resolvedRoot, resolvedKey, relatedFiles);
      updateSessionRelatedFilesForKey(resolvedRoot, resolvedKey, relatedFiles);
      if (selectedKanbanTaskId) {
        const removedKey = [repoKind || "", repoPath || "", head || "", path || ""].join("\0");
        setTaskRelatedFilesById((prev) => {
          const current = prev[selectedKanbanTaskId] || [];
          return {
            ...prev,
            [selectedKanbanTaskId]: current.filter((file) =>
              [file.repo_kind || "", file.repo_path || "", file.head || "", file.path || ""].join("\0") !== removedKey,
            ),
          };
        });
      }
    },
    [selectedKanbanTaskId, updateSessionRelatedFilesForKey],
  );

  const handleAskUserAnswer = useCallback(
    async (input: {
      rootId: string;
      sessionKey: string;
      agent?: string;
      toolUseId: string;
      answers: Record<string, string>;
    }) => {
      await sessionService.answerQuestion(
        input.rootId,
        input.sessionKey,
        input.agent,
        input.toolUseId,
        input.answers,
      );
    },
    [],
  );

  const handleEditUserMessage = useCallback((content: string) => {
    setEditDraftRequest((prev) => ({
      id: (prev?.id || 0) + 1,
      content,
    }));
  }, []);

  const currentFileScrollKey = buildFileScrollKey(
    file?.root || currentRootId,
    file?.path,
  );
  const slashCommandResultForSession = (
    rootID: string | null | undefined,
    session: { key?: string; session_key?: string } | null | undefined,
  ) => {
    const sessionKey = session?.key || session?.session_key || "";
    const resolvedRoot = rootID || "";
    if (!resolvedRoot) {
      return null;
    }
    if (!sessionKey) {
      let best: SlashCommandResult | null = null;
      for (const value of Object.values(slashCommandResults)) {
        if (value.rootId !== resolvedRoot || !value.sessionKey.startsWith("transient-")) {
          continue;
        }
        if (!best || (value.createdAt || 0) > (best.createdAt || 0)) {
          best = value;
        }
      }
      return best;
    }
    return slashCommandResults[rootSessionKey(resolvedRoot, sessionKey)] || null;
  };
  const renderRootSlashCommandResult = (result: SlashCommandResult | null) => {
    if (!result || !result.sessionKey.startsWith("transient-")) {
      return null;
    }
    const commandLabel = `/${result.command || "status"}`;
    const loginNotice = result.loginNotice;
    const isLogin = (result.command || "") === "login";
    const fallback =
      result.status === "running"
        ? isLogin
          ? t("session.loginWaiting")
          : t("session.statusFetching")
        : "";
    const content = result.error || loginNotice?.error || result.content || fallback;
    const loginCodeCopyKey = loginNotice?.loginId
      ? `login-code:${loginNotice.loginId}`
      : `login-code:${result.sessionKey}`;
    const loginCodeCopied = !!copiedSlashCommandKeys[loginCodeCopyKey];
    return (
      <div
        style={{
          width: "100%",
          boxSizing: "border-box",
          border: "1px solid rgba(148,163,184,0.36)",
          background: "rgba(148,163,184,0.10)",
          borderRadius: "8px",
          padding: "10px 12px",
          color: "var(--text-primary)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "8px",
            marginBottom: content || loginNotice?.userCode ? "6px" : 0,
            fontSize: "11px",
            lineHeight: 1.4,
            color: "var(--text-secondary)",
          }}
        >
          <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" }}>
            {commandLabel}
          </span>
          <span>{result.status === "running" ? t("session.statusRunning") : result.status === "failed" ? t("session.statusFailed") : t("session.statusComplete")}</span>
        </div>
        {isLogin && loginNotice?.userCode ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", fontSize: "13px", lineHeight: 1.5 }}>
            {loginNotice.verificationUrl ? (
              <a
                href={loginNotice.verificationUrl}
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--accent)", overflowWrap: "anywhere" }}
              >
                {loginNotice.verificationUrl}
              </a>
            ) : null}
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <span
                style={{
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                  fontSize: "20px",
                  letterSpacing: "0",
                }}
              >
                {loginNotice.userCode}
              </span>
              <button
                type="button"
                onClick={() => {
                  const userCode = loginNotice.userCode || "";
                  if (!userCode) {
                    reportError("clipboard.write_failed", t("session.emptyCodeCannotCopy"));
                    return;
                  }
                  void copyText(userCode)
                    .then(() => {
                      setCopiedSlashCommandKeys((prev) => ({
                        ...prev,
                        [loginCodeCopyKey]: true,
                      }));
                      if (slashCopyResetTimersRef.current[loginCodeCopyKey]) {
                        window.clearTimeout(
                          slashCopyResetTimersRef.current[loginCodeCopyKey],
                        );
                      }
                      slashCopyResetTimersRef.current[loginCodeCopyKey] =
                        window.setTimeout(() => {
                          setCopiedSlashCommandKeys((prev) => {
                            const next = { ...prev };
                            delete next[loginCodeCopyKey];
                            return next;
                          });
                          delete slashCopyResetTimersRef.current[
                            loginCodeCopyKey
                          ];
                        }, 1000);
                    })
                    .catch((err) => {
                      reportError(
                        "clipboard.write_failed",
                        String((err as Error)?.message || t("session.copyFailed")),
                      );
                    });
                }}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "22px",
                  height: "22px",
                  border: "none",
                  background: "transparent",
                  color: "var(--text-secondary)",
                  borderRadius: "6px",
                  padding: 0,
                  cursor: "pointer",
                }}
                aria-label={loginCodeCopied ? t("session.codeCopied") : t("session.copyCode")}
                title={loginCodeCopied ? t("session.copied") : t("session.copyCode")}
              >
                {loginCodeCopied ? (
                  <span
                    aria-hidden="true"
                    style={{ fontSize: "13px", fontWeight: 800, lineHeight: 1 }}
                  >
                    ✓
                  </span>
                ) : (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      fill="currentColor"
                      d="M20 2H10c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2m0 12H10V4h10z"
                    />
                    <path
                      fill="currentColor"
                      d="M14 20H4V10h2V8H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2v-2h-2z"
                    />
                  </svg>
                )}
              </button>
            </div>
            {result.status === "complete" ? (
              <div style={{ color: "var(--text-secondary)" }}>
                {t("session.loginComplete")}{loginNotice.planType ? ` · ${loginNotice.planType}` : ""}
              </div>
            ) : null}
          </div>
        ) : content ? (
          <div
            style={{
              fontSize: "13px",
              lineHeight: "1.6",
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            {content}
          </div>
        ) : null}
      </div>
    );
  };
  const currentRootSlashCommandResult = slashCommandResultForSession(currentRootId, null);
  const sessionView = (
    <SessionViewer
      session={selectedSessionSnapshot}
      agents={availableAgents}
      slashCommandResult={slashCommandResultForSession(
        selectedSession?.root_id || currentRootId,
        selectedSessionSnapshot,
      )}
      targetSeq={selectedSession?.search_seq}
      targetSeqRequestKey={selectedSession?.search_target_id}
      loading={selectedSessionLoading}
      rootId={selectedSession?.root_id || currentRootId}
      rootPath={
        managedRootByIdRef.current[
          selectedSession?.root_id || currentRootId || ""
        ]?.root_path || null
      }
      gitFileStatsByPath={gitFileStatsByPath}
      onFileClick={handleSelectedSessionFileClick}
      onRootClick={(root) => {
        void actionHandlers.open_dir({
          path: root,
          root,
          isRoot: true,
          forceDirectory: true,
          suppressTreeExpand: true,
        });
      }}
      onRemoveRelatedFile={(path, head, repoPath, repoKind) =>
        void handleRemoveSessionRelatedFile(
          selectedSession?.root_id || currentRootId,
          selectedSessionSnapshot?.key || selectedSessionSnapshot?.session_key,
          path,
          head,
          repoPath,
          repoKind,
        )
      }
      onAskUserAnswer={handleAskUserAnswer}
      onEditUserMessage={handleEditUserMessage}
      onForkAgentMessage={(seq) =>
        void handleForkAgentMessage(
          selectedSession?.root_id || currentRootId,
          selectedSessionSnapshot?.key || selectedSessionSnapshot?.session_key,
          seq,
        )
      }
    />
  );

  const worktreeBranchSelector =
    creatingRootKind === "worktree" ? (
      <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
        <select
          value={worktreeBranchMode === "new" ? "__new__" : worktreeBranch}
          disabled={creatingRootBusy}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "__new__") {
              setWorktreeBranchMode("new");
              setWorktreeBranch("");
              return;
            }
            setWorktreeBranchMode("existing");
            setWorktreeBranch(value);
          }}
          style={{
            width: "100%",
            borderRadius: "7px",
            border: "1px solid var(--border-color)",
            background: "var(--menu-bg)",
            color: "var(--text-primary)",
            fontSize: "12px",
            padding: "6px 8px",
            outline: "none",
          }}
        >
          <option value="__new__">{t("worktree.createBranch")}</option>
          {worktreeBranches.branches.map((branch) => (
            <option key={branch.name} value={branch.name}>
              {branch.current ? `${branch.name} ${t("worktree.current")}` : branch.name}
            </option>
          ))}
        </select>
        {worktreeBranchesLoading ? (
          <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>{t("worktree.loadingBranches")}</span>
        ) : worktreeBranchError ? (
          <span style={{ fontSize: "11px", color: "#b45309" }}>{worktreeBranchError}</span>
        ) : null}
      </div>
    ) : null;

  const worktreeCreateOverlay =
    creatingRootKind === "worktree" && creatingRootName !== null ? (
      <div
        ref={worktreeCreatePopoverRef}
        style={{
          width: "248px",
          maxWidth: "calc(100vw - 32px)",
          padding: "10px",
          borderRadius: "12px",
          border: "1px solid var(--border-color)",
          background: "var(--menu-bg)",
          boxShadow: "0 12px 30px rgba(15, 23, 42, 0.14)",
          display: "flex",
          flexDirection: "column",
          gap: "10px",
        }}
      >
        <div style={{ fontSize: "12px", fontWeight: 600, color: "var(--text-primary)" }}>
          worktree
        </div>
        <input
          value={creatingRootName}
          disabled={creatingRootBusy}
          autoFocus
          onChange={(event) => setCreatingRootName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void handleCreateRootSubmit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              handleCreateRootCancel();
            }
          }}
          style={{
            width: "100%",
            borderRadius: "8px",
            border: "1px solid var(--border-color)",
            background: "transparent",
            color: "var(--text-primary)",
            fontSize: "12px",
            padding: "8px 10px",
            outline: "none",
            boxSizing: "border-box",
          }}
        />
        {worktreeBranchSelector}
        <div style={{ display: "flex" }}>
          <button
            type="button"
            disabled={creatingRootBusy || !String(creatingRootName || "").trim()}
            onClick={() => {
              void handleCreateRootSubmit();
            }}
            style={{
              width: "100%",
              border: "none",
              background: creatingRootBusy || !String(creatingRootName || "").trim()
                ? "rgba(59, 130, 246, 0.65)"
                : "var(--accent-color)",
              color: "#fff",
              borderRadius: "8px",
              padding: "8px 10px",
              fontSize: "12px",
              fontWeight: 600,
              cursor: creatingRootBusy || !String(creatingRootName || "").trim()
                ? "not-allowed"
                : "pointer",
            }}
          >
            {creatingRootBusy ? t("worktree.processing") : t("worktree.create")}
          </button>
        </div>
      </div>
    ) : null;

  const worktreeSwitchOverlay =
    worktreeSwitchOpen ? (
      <div
        ref={worktreeSwitchPopoverRef}
        style={{
          width: "248px",
          maxWidth: "calc(100vw - 32px)",
          maxHeight: "360px",
          padding: "8px",
          borderRadius: "12px",
          border: "1px solid var(--border-color)",
          background: "var(--menu-bg)",
          boxShadow: "0 12px 30px rgba(15, 23, 42, 0.14)",
          display: "flex",
          flexDirection: "column",
          gap: "6px",
          overflow: "auto",
        }}
      >
        <div style={{ padding: "4px 6px 6px", fontSize: "12px", fontWeight: 600, color: "var(--text-primary)" }}>
          {t("worktree.switchTitle")}
        </div>
        {worktreeSwitchLoading ? (
          <div style={{ padding: "8px 6px", fontSize: "12px", color: "var(--text-secondary)" }}>{t("common.loading")}</div>
        ) : worktreeSwitchError ? (
          <div style={{ padding: "8px 6px", fontSize: "12px", color: "#b45309" }}>{worktreeSwitchError}</div>
        ) : worktreeSwitchItems.length === 0 ? (
          <div style={{ padding: "8px 6px", fontSize: "12px", color: "var(--text-secondary)" }}>{t("worktree.noSwitchable")}</div>
        ) : worktreeSwitchItems.map((item) => {
          const managed = findManagedRootByPath(item.path);
          const active = item.current || managed?.id === currentRootId;
          const busy = switchingWorktreePath === item.path;
          const name = String(item.path || "").replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() || item.path;
          return (
            <button
              key={item.path}
              type="button"
              disabled={active || !!switchingWorktreePath}
              onClick={() => {
                void handleSwitchWorktree(item);
              }}
              style={{
                width: "100%",
                border: "none",
                background: active ? "var(--selection-bg)" : "transparent",
                color: active ? "var(--accent-color)" : "var(--text-primary)",
                borderRadius: "8px",
                padding: "8px 10px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "12px",
                textAlign: "left",
                cursor: active || switchingWorktreePath ? "default" : "pointer",
                opacity: switchingWorktreePath && !busy ? 0.56 : 1,
              }}
            >
              <span style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: "2px" }}>
                <span style={{ fontSize: "12px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {name}
                </span>
                <span style={{ fontSize: "11px", color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {item.branch || item.head?.slice(0, 8) || item.path}
                </span>
              </span>
              <span style={{ fontSize: "11px", color: active ? "var(--accent-color)" : "var(--text-secondary)", flexShrink: 0 }}>
                {busy ? "..." : active ? t("worktree.current") : managed ? t("worktree.switch") : t("worktree.join")}
              </span>
            </button>
          );
        })}
      </div>
    ) : null;

  let workspaceView: React.ReactNode;
  const gitStatusAvailable = gitStatus?.available === true;
  const gitHistoryAvailable = gitHistory?.available === true;
  const gitStatusExpanded = currentRootId ? gitStatusExpandedByRoot[currentRootId] !== false : true;
  const gitHistoryExpandedCommits = currentRootId ? gitHistoryExpandedByRoot[currentRootId] || {} : {};
  const shouldRenderGitPanel =
    gitStatusLoading || gitStatusAvailable;
  const shouldRenderGitHistoryPanel =
    gitHistoryLoading || (gitHistoryAvailable && (gitHistory?.items.length || 0) > 0);
  const activePendingPluginTrust =
    pendingPluginTrust && pendingPluginTrust.rootId === currentRootId ? pendingPluginTrust : null;
	  const relatedSessionSnapshot =
	    selectedKanbanTaskSessionSnapshot ||
	    selectedSessionSnapshot ||
	    drawerSessionSnapshot ||
	    lastMainSessionSnapshotRef.current;
	  const relatedSessionRootId =
	    (relatedSessionSnapshot?.root_id as string | undefined) ||
	    selectedKanbanTask?.root_id ||
	    (selectedSession?.root_id as string | undefined) ||
	    currentRootId;
	  const relatedSessionKey = relatedSessionSnapshot?.key || relatedSessionSnapshot?.session_key;
	  const relatedSelectedPath = gitDiff?.path || file?.path || "";
	  const relatedWorktree = selectedKanbanTask?.worktree_path
	    ? {
	        root_id: selectedKanbanTask.root_id,
	        path: selectedKanbanTask.worktree_path,
	      }
	    : relatedSessionSnapshot?.related_worktree || null;

  useEffect(() => {
    const rootID = String(relatedWorktree?.root_id || "");
    const worktreePath = String(relatedWorktree?.path || "");
    if (projectTreeTab !== "worktrees" || !rootID || !worktreePath) {
      return;
    }
	    setExpandedWorktreeByRoot((prev) => {
	      if (prev[rootID] === worktreePath) {
	        return prev;
	      }
	      return { ...prev, [rootID]: worktreePath };
    });
    void loadProjectTreeWorktreeStatus(worktreePath);
  }, [
    loadProjectTreeWorktreeStatus,
    projectTreeTab,
    relatedWorktree?.path,
    relatedWorktree?.root_id,
  ]);

  const renderRootWorktreeContent = (root: string): React.ReactNode => {
    const relatedPath =
      relatedWorktree?.root_id === root ? String(relatedWorktree?.path || "") : "";
    const items = [...(worktreeItemsByRoot[root] || [])].sort((left, right) => {
      if (!relatedPath) {
        return 0;
      }
      if (left.path === relatedPath) {
        return -1;
      }
      if (right.path === relatedPath) {
        return 1;
      }
      return 0;
    });
    const loading = worktreeLoadingByRoot[root] === true;
    const error = worktreeErrorByRoot[root] || "";
    const expandedPath = expandedWorktreeByRoot[root] || "";
    if (loading) {
      return (
        <div style={{ padding: "8px 4px", fontSize: "12px", color: "var(--text-secondary)" }}>
          {t("worktree.loading")}
        </div>
      );
    }
    if (error) {
      return (
        <div style={{ padding: "8px 4px", fontSize: "12px", color: "#b45309" }}>
          {error}
        </div>
      );
    }
    if (items.length === 0) {
      return (
        <div style={{ padding: "8px 4px", fontSize: "12px", color: "var(--text-secondary)" }}>
          {t("worktree.empty")}
        </div>
      );
    }
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "5px", minWidth: 0 }}>
        {items.map((item) => {
          const managed = findManagedRootByPath(item.path);
          const targetRootId = managed?.id || "";
          const selected = expandedPath === item.path;
          const status = worktreeStatusByPath[item.path] || null;
          const statusLoading = worktreeStatusLoadingByPath[item.path] === true;
          const dirtyCount = status?.items?.length || 0;
          const branchLabel = item.branch || item.head?.slice(0, 8) || item.path;
          const statusCountLabel = statusLoading ? "..." : status ? String(dirtyCount) : "";
          return (
            <div key={item.path} style={{ minWidth: 0 }}>
              <button
                type="button"
                onClick={async () => {
                  if (selected) {
                    setExpandedWorktreeByRoot((prev) => ({ ...prev, [root]: "" }));
                    return;
                  }
                  setExpandedWorktreeByRoot((prev) => ({ ...prev, [root]: item.path }));
                  await loadProjectTreeWorktreeStatus(item.path);
                }}
                style={{
                  width: "100%",
                  border: "none",
                  borderRadius: "7px",
                  background: selected ? "var(--selection-bg)" : "transparent",
                  color: selected ? "var(--accent-color)" : "var(--text-primary)",
                  padding: "6px 4px 6px 0",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "8px",
                  textAlign: "left",
                  cursor: "pointer",
                }}
              >
                <span style={{ minWidth: 0, display: "inline-flex", alignItems: "center", gap: "8px" }}>
                  <span
                    title={t("git.changes")}
                    aria-label={t("git.changes")}
                    style={{
                      width: "18px",
                      height: "18px",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: "var(--text-primary)",
                      flexShrink: 0,
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path
                        fill="currentColor"
                        d="M7 5a2 2 0 1 1 3.763.945h.58a4 4 0 0 1 4 4v1.28a2 2 0 0 1-1.02 3.72a2 2 0 0 1-.98-3.745V9.945a2 2 0 0 0-2-2H10v9.323A2 2 0 0 1 9 21a2 2 0 0 1-1-3.732V6.732A2 2 0 0 1 7 5"
                      />
                    </svg>
                  </span>
                  <span style={{ fontSize: "12px", fontWeight: selected ? 700 : 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {branchLabel}
                  </span>
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "11px", color: selected ? "var(--accent-color)" : "var(--text-secondary)", flexShrink: 0 }}>
                  <span>{statusCountLabel}</span>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    aria-hidden="true"
                    style={{
                      transform: selected ? "rotate(180deg)" : "rotate(0deg)",
                      transition: "transform 0.15s",
                    }}
                  >
                    <path
                      fillRule="evenodd"
                      d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.17l3.71-3.94a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06"
                      clipRule="evenodd"
                    />
                  </svg>
                </span>
              </button>
              {selected ? (
                <div style={{ padding: "4px 0 4px 0" }}>
                  {statusLoading || status ? (
                    <GitStatusPanel
                      rootId={targetRootId || currentRootId || undefined}
                      status={status}
                      loading={statusLoading}
                      compact
                      expanded
                      showHeader={false}
                      showHeaderActions={false}
                      showExpandedToggle={false}
                      enableBranchMenu={false}
                      onSelectItem={(statusItem) => {
                        const nextRoot = targetRootId || root;
                        if (!nextRoot) {
                          return;
                        }
                        void openGitDiff(nextRoot, statusItem, targetRootId ? undefined : { repoPath: item.path });
                      }}
                      onOpenItem={(statusItem) => {
                        const nextRoot = targetRootId;
                        if (!nextRoot || statusItem.is_dir === true) {
                          return;
                        }
                        actionHandlers.open({ path: statusItem.path, root: nextRoot });
                      }}
                    />
                  ) : (
                    <div style={{ padding: "6px 4px", fontSize: "12px", color: "var(--text-secondary)" }}>
                      {t("git.loadingStatusInline")}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  };
  const selectedSessionRelatedFiles = useMemo(() => {
    const rawRelated = selectedKanbanTask
      ? taskRelatedFilesById[selectedKanbanTask.id] || []
      : relatedSessionSnapshot?.related_files || (relatedSessionSnapshot as any)?.outputs || [];
    return (Array.isArray(rawRelated) ? rawRelated : [])
      .map((file: RelatedFile | string | { path?: unknown; name?: unknown; head?: unknown; repo_path?: unknown; repo_name?: unknown; repo_kind?: unknown; root_id?: unknown }) => {
        const path = typeof file === "string"
          ? file
          : typeof file?.path === "string"
            ? file.path
            : "";
        const rawName =
          typeof file !== "string" ? (file as { name?: unknown }).name : "";
        const name = typeof rawName === "string"
          ? rawName
          : path.split("/").pop() || path;
        const head = typeof file !== "string" && typeof file?.head === "string"
          ? file.head
          : "";
        const repoPath = typeof file !== "string" && typeof file?.repo_path === "string"
          ? file.repo_path
          : "";
        const repoName = typeof file !== "string" && typeof file?.repo_name === "string"
          ? file.repo_name
          : repoPath.split(/[\\/]/).filter(Boolean).pop() || "";
        const repoKind = typeof file !== "string" && typeof file?.repo_kind === "string"
          ? file.repo_kind
          : "";
        const rootID = typeof file !== "string" && typeof file?.root_id === "string"
          ? file.root_id
          : "";
        return { path, name, head, repo_path: repoPath, repo_name: repoName, repo_kind: repoKind, root_id: rootID };
      })
      .filter((file) => file.path);
  }, [relatedSessionSnapshot, selectedKanbanTask, taskRelatedFilesById]);
  const selectedSessionRelatedFileGroups = useMemo(
    () => {
      const currentRootPath = normalizePath(
        managedRootByIdRef.current[relatedSessionRootId || currentRootId || ""]?.root_path || "",
      );
      const repoGroups = selectedSessionRelatedFiles.reduce<
        Array<{
          key: string;
          repoPath: string;
          repoName: string;
          repoKind: string;
          headGroups: Array<{ key: string; head: string; files: typeof selectedSessionRelatedFiles }>;
        }>
      >((groups, file) => {
        const head = file.head || "";
        const rawRepoPath = file.repo_path || "";
        const isCurrentRepoRecord =
          !rawRepoPath ||
          file.repo_name === t("session.currentProject") ||
          (currentRootPath && normalizePath(rawRepoPath) === currentRootPath);
        const repoPath = isCurrentRepoRecord ? "" : rawRepoPath;
        const rawRepoKind = file.repo_kind || "";
        const repoKind = isCurrentRepoRecord && rawRepoKind !== "plain" ? "" : rawRepoKind;
        const repoKey = `${repoKind}\0${repoPath}`;
        let repoGroup = groups.find((group) => group.key === repoKey);
        if (!repoGroup) {
          repoGroup = {
            key: repoKey,
            repoPath,
            repoName: isCurrentRepoRecord
              ? t("session.currentProject")
              : file.repo_name || repoPath.split(/[\\/]/).filter(Boolean).pop() || t("session.currentProject"),
            repoKind,
            headGroups: [],
          };
          groups.push(repoGroup);
        }
        const headKey = `${repoKey}\0${head}`;
        const existing = repoGroup.headGroups.find((group) => group.key === headKey);
        if (existing) {
          existing.files.push(file);
        } else {
          repoGroup.headGroups.push({
            key: headKey,
            head,
            files: [file],
          });
        }
        return groups;
      }, []);
      return repoGroups.flatMap((repoGroup) =>
        repoGroup.headGroups.map((headGroup) => ({
          key: headGroup.key,
          head: headGroup.head,
          repoPath: repoGroup.repoPath,
          repoName: repoGroup.repoName,
          repoKind: repoGroup.repoKind,
          files: headGroup.files,
        })),
      );
    },
    [currentRootId, relatedSessionRootId, selectedSessionRelatedFiles],
  );
  const renderRootRelatedContent = (root: string): React.ReactNode => {
    if (!root || root !== currentRootId || root !== relatedSessionRootId) {
      return null;
    }
    if (!relatedSessionSnapshot && !selectedKanbanTask) {
      return (
        <div style={{ padding: "8px 4px", fontSize: "12px", color: "var(--text-secondary)" }}>
          {t("session.empty")}
        </div>
      );
    }
    if (selectedSessionRelatedFiles.length === 0) {
      return (
        <div style={{ padding: "8px 4px", fontSize: "12px", color: "var(--text-secondary)" }}>
          {t("session.relatedFiles", { count: 0 })}
        </div>
      );
    }
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 }}>
        {selectedSessionRelatedFileGroups.map((group) => {
          const isCurrentRepo =
            !group.repoPath ||
            normalizePath(group.repoPath) ===
              normalizePath(managedRootByIdRef.current[root]?.root_path || "");
          const showGroupHeader = group.repoKind === "plain" || group.head || !isCurrentRepo;
          return (
            <div key={group.key} style={{ display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 }}>
              {showGroupHeader ? (
                <div
                  title={[group.repoPath, group.head].filter(Boolean).join(" · ") || group.repoName || t("session.currentProject")}
                  style={{
                    padding: "3px 6px 0",
                    fontSize: "11px",
                    color: "var(--text-secondary)",
                    fontFamily: group.head ? "var(--mono-font, monospace)" : undefined,
                  }}
                >
                  {group.repoKind === "plain"
                    ? `${group.repoName || t("session.currentProject")} · ${t("session.nonGit")}`
                    : group.head
                      ? isCurrentRepo
                        ? `HEAD ${group.head.slice(0, 8)}`
                        : `${group.repoName || t("session.currentProject")} · HEAD ${group.head.slice(0, 8)}`
                      : group.repoName || t("session.currentProject")}
                </div>
              ) : null}
              {group.files.map((file) => {
          const stats = gitFileStatsByPath[file.path];
          const fileSelectionKey = relatedFileSelectionKey(file);
          const isSelected = relatedSelectedFileKey
            ? fileSelectionKey === relatedSelectedFileKey
            : file.path === relatedSelectedPath;
          return (
            <div key={`${file.head || "legacy"}:${file.path}`} style={{ display: "flex", alignItems: "center", gap: "4px", minWidth: 0 }}>
              <button
                type="button"
                onClick={() => handleSelectedSessionFileClick(file)}
                title={file.path}
                style={{
                  flex: 1,
                  minWidth: 0,
                  border: "none",
                  background: isSelected ? "var(--selection-bg)" : "transparent",
                  color: isSelected ? "var(--accent-color)" : "var(--text-primary)",
                  borderRadius: "6px",
                  padding: "5px 6px",
                  display: "flex",
                  alignItems: "center",
                  gap: "7px",
                  textAlign: "left",
                  cursor: "pointer",
                  fontSize: "12px",
                  fontWeight: isSelected ? 700 : 400,
                }}
              >
                <span style={{ width: "16px", display: "inline-flex", justifyContent: "center", color: "#94a3b8", flexShrink: 0 }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="16" x2="8" y1="13" y2="13" />
                    <line x1="16" x2="8" y1="17" y2="17" />
                  </svg>
                </span>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {file.name}
                </span>
                {stats ? (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "11px", color: "var(--text-secondary)", flexShrink: 0 }}>
                    <span style={{ color: "#15803d", fontVariantNumeric: "tabular-nums" }}>+{stats.additions}</span>
                    <span style={{ color: "#b91c1c", fontVariantNumeric: "tabular-nums" }}>-{stats.deletions}</span>
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                aria-label={t("session.removeRelatedFile", { name: file.name || file.path })}
                title={t("session.removeRelatedFile", { name: file.name || file.path })}
                onClick={(event) => {
                  event.stopPropagation();
                  void handleRemoveSessionRelatedFile(
                    relatedSessionRootId,
                    relatedSessionKey,
                    file.path,
                    file.head,
                    file.repo_path,
                    file.repo_kind,
                  );
                }}
                style={{
                  width: "18px",
                  height: "18px",
                  border: "none",
                  borderRadius: "5px",
                  background: "transparent",
                  color: "#dc2626",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 0,
                  cursor: "pointer",
                  flexShrink: 0,
                  fontSize: "13px",
                }}
              >
                x
              </button>
            </div>
          );
              })}
            </div>
          );
        })}
      </div>
    );
  };
  const renderRootGitContent = (root: string): React.ReactNode => {
    const rootGitStatus = root === currentRootId ? gitStatus : gitStatusByRoot[root] || null;
    const rootGitHistory = root === currentRootId ? gitHistory : gitHistoryByRoot[root] || null;
    const rootGitStatusLoading =
      root === currentRootId ? gitStatusLoading : gitStatusLoadingByRoot[root] === true;
    const rootGitHistoryLoading =
      root === currentRootId ? gitHistoryLoading : gitHistoryLoadingByRoot[root] === true;
    const rootGitStatusAvailable = rootGitStatus?.available === true;
    const rootGitHistoryAvailable = rootGitHistory?.available === true;
    const rootGitStatusExpanded = gitStatusExpandedByRoot[root] !== false;
    const rootGitHistoryExpandedCommits = gitHistoryExpandedByRoot[root] || {};
    const rootShouldRenderGitPanel = rootGitStatusLoading || rootGitStatusAvailable;
    const rootShouldRenderGitHistoryPanel =
      rootGitHistoryLoading || (rootGitHistoryAvailable && (rootGitHistory?.items.length || 0) > 0);
    if (managedRootByIdRef.current[root]?.is_git_repo !== true) {
      return (
        <div style={{ padding: "8px 4px", fontSize: "12px", color: "var(--text-secondary)" }}>
          {t("git.notRepository")}
        </div>
      );
    }
    if (!rootGitStatus && !rootGitHistory && !rootGitStatusLoading && !rootGitHistoryLoading) {
      return (
        <button
          type="button"
          onClick={() => {
            void refreshGitStatus(root);
            void refreshGitHistory(root);
          }}
          style={{
            border: "none",
            background: "transparent",
            color: "var(--text-secondary)",
            borderRadius: "6px",
            padding: "8px 4px",
            fontSize: "12px",
            cursor: "pointer",
            textAlign: "left",
            width: "100%",
          }}
        >
          {t("git.loadingStatus")}
        </button>
      );
    }
    if (!rootGitStatusLoading && !rootGitHistoryLoading && !rootShouldRenderGitPanel && !rootShouldRenderGitHistoryPanel) {
      return (
        <div style={{ padding: "8px 4px", fontSize: "12px", color: "var(--text-secondary)" }}>
          {t("git.emptyChangesOrHistory")}
        </div>
      );
    }
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "14px", minWidth: 0 }}>
        {rootShouldRenderGitPanel ? (
          <GitStatusPanel
            rootId={root}
            status={rootGitStatus}
            loading={rootGitStatusLoading}
            compact
            expanded={rootGitStatusExpanded}
            onExpandedChange={(expanded) => {
              if (!root) {
                return;
              }
              setGitStatusExpandedByRoot((prev) => ({ ...prev, [root]: expanded }));
            }}
            onSelectItem={(item) => {
              if (!root) {
                return;
              }
              void openGitDiff(root, item);
            }}
            onOpenItem={(item) => {
              if (!root || item.is_dir === true) {
                return;
              }
              actionHandlers.open({ path: item.path, root });
            }}
            onDiscardItem={(item) => {
              if (!root) {
                return;
              }
              return handleGitDiscardItem(root, item);
            }}
            onStageItem={(item) => {
              if (!root) {
                return;
              }
              return item.staged === true
                ? handleGitUnstageItem(root, item)
                : handleGitStageItem(root, item);
            }}
            onPull={() => {
              if (!root) {
                return;
              }
              return handleGitPull(root);
            }}
            onPush={() => {
              if (!root) {
                return;
              }
              return handleGitPush(root);
            }}
            onCommit={(message) => {
              if (!root) {
                return;
              }
              return handleGitCommit(root, message);
            }}
            onSwitchBranch={(branch) => {
              if (!root) {
                return;
              }
              return switchGitBranch(root, branch);
            }}
          />
        ) : null}
        {rootShouldRenderGitHistoryPanel ? (
          <GitHistoryPanel
            rootId={root}
            items={rootGitHistory?.items || []}
            loading={rootGitHistoryLoading}
            loadingMore={gitHistoryLoadingMore}
            hasMore={rootGitHistory?.has_more === true}
            compact
            expandedCommits={rootGitHistoryExpandedCommits}
            onToggleCommit={(hash) => {
              if (!root) {
                return;
              }
              setGitHistoryExpandedByRoot((prev) => {
                const current = prev[root] || {};
                return {
                  ...prev,
                  [root]: {
                    ...current,
                    [hash]: current[hash] !== true,
                  },
                };
              });
            }}
            onLoadMore={() => {
              void loadMoreGitHistory(root);
            }}
            onSelectFile={(commit, item) => {
              if (!root) {
                return;
              }
              void openGitCommitDiff(root, commit, item);
            }}
          />
        ) : null}
      </div>
    );
  };
  const isAllTaskTemplateFilter = taskTemplateFilter === TASK_TEMPLATE_ALL_FILTER;
  const selectedTaskTemplateForFilter = isAllTaskTemplateFilter ? null : taskTemplates.find((template) => template.id === taskTemplateFilter) || null;
  const taskTemplateById = taskTemplates.reduce<Record<string, TaskTemplate>>((acc, template) => {
    if (template.id) acc[template.id] = template;
    return acc;
  }, {});
	  const unfinishedKanbanTasks = kanbanTaskCountItems.filter(isUnfinishedKanbanTask);
  const unfinishedKanbanTaskCountByTemplate = unfinishedKanbanTasks.reduce<Record<string, number>>((acc, task) => {
    const key = task.task_template_id || "";
    if (key) acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const selectedTaskTemplateUnfinishedCount = selectedTaskTemplateForFilter?.id ? unfinishedKanbanTaskCountByTemplate[selectedTaskTemplateForFilter.id] || 0 : 0;
  const isTaskAtLastKnownStage = (task: KanbanTask) => {
    const template = taskTemplateById[task.task_template_id || ""];
    if (!template || template.stages.length === 0) return false;
    return task.current_stage_index >= template.stages.length - 1;
  };
  const kanbanStageColumns = isAllTaskTemplateFilter
    ? [{
        index: 0,
        name: t("task.column.pending"),
        role: "user" as const,
        tasks: kanbanTasks.filter((task) => task.current_stage_index === 0 && !isTerminalKanbanTask(task)),
      }, {
        index: 1,
        name: t("task.column.running"),
        role: "agent" as const,
        tasks: kanbanTasks.filter((task) => task.current_stage_index !== 0 && !isTerminalKanbanTask(task)),
      }, {
        index: 2,
        name: t("task.column.done"),
        role: "user" as const,
        tasks: kanbanTasks.filter(isTerminalKanbanTask),
        groups: [{
          key: "success",
          name: t("task.group.completed"),
          tone: "success" as const,
          tasks: kanbanTasks.filter((task) => task.status === "success"),
        }, {
          key: "fail",
          name: t("task.group.failed"),
          tone: "danger" as const,
          tasks: kanbanTasks.filter((task) => task.status === "fail"),
        }, {
          key: "cancelled",
          name: t("task.group.cancelled"),
          tone: "muted" as const,
          tasks: kanbanTasks.filter((task) => task.status === "cancelled"),
        }].filter((group) => group.tasks.length > 0),
      }]
    : selectedTaskTemplateForFilter
      ? selectedTaskTemplateForFilter.stages.map((stage, index) => ({
        index,
        name: stage.snapshot.name || (stage.snapshot.role === "agent" ? t("task.stage.agent") : t("task.stage.user")),
        role: stage.snapshot.role,
        tasks: kanbanTasks.filter((task) => task.current_stage_index === index),
      }))
    : [];
  if (!isAllTaskTemplateFilter) {
    kanbanTasks.forEach((task) => {
      if (task.current_stage_index < 0 || task.current_stage_index >= kanbanStageColumns.length) {
        const existing = kanbanStageColumns.find((column) => column.index === task.current_stage_index);
        if (existing) {
          existing.tasks.push(task);
        } else {
          kanbanStageColumns.push({
            index: task.current_stage_index,
            name: task.current_stage_name || t("task.stageLabel", { index: task.current_stage_index + 1 }),
            role: "user",
            tasks: [task],
          });
        }
      }
    });
  }
  kanbanStageColumns.sort((a, b) => a.index - b.index);
	  const kanbanTaskPanel = currentRootId ? (
	    <div
	      data-onboarding="task-board"
	      style={{
	        maxHeight: "calc(100dvh - 92px)",
	        overflow: "visible",
	        display: "flex",
	        flexDirection: "column",
	        minWidth: 0,
	      }}
	    >
	      <div
	        style={{
	          display: "flex",
          alignItems: "center",
	          justifyContent: "space-between",
	          gap: "10px",
	          padding: "0 0 8px",
	          flexShrink: 0,
	        }}
	      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            minWidth: 0,
            flex: 1,
          }}
        >
          <div
            role="tablist"
            data-onboarding="task-templates"
            aria-label={t("task.templates")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "2px",
              overflowX: "auto",
              padding: "3px",
              borderRadius: "10px",
              border: "1px solid rgba(100, 116, 139, 0.36)",
              background: "rgba(148, 163, 184, 0.10)",
              minWidth: 0,
              scrollbarWidth: "none",
            }}
          >
            {(() => {
              const active = isAllTaskTemplateFilter;
              return (
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => {
                    setTaskTemplateFilter(TASK_TEMPLATE_ALL_FILTER);
                    setTaskTemplateActionMenuOpen(false);
                  }}
                  style={{
                    border: "none",
                    borderRadius: "6px",
                    background: active ? "var(--accent-color)" : "transparent",
                    color: active ? "#fff" : "var(--text-secondary)",
                    padding: "3px 7px",
                    fontSize: "11px",
                    fontWeight: 700,
                    lineHeight: "14px",
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    boxShadow: active ? "0 1px 3px rgba(37, 99, 235, 0.28)" : "none",
                  }}
                >
                  {t("task.all")}
                </button>
              );
            })()}
            {taskTemplates.length > 0 ? (
              <span
                aria-hidden="true"
                style={{
                  width: "1px",
                  height: "16px",
                  background: "rgba(100, 116, 139, 0.32)",
                  margin: "0 1px",
                  flexShrink: 0,
                }}
              />
            ) : null}
            {taskTemplates.map((template, index) => {
              const templateId = template.id || "";
              const active = selectedTaskTemplateForFilter?.id === templateId;
              return (
                <React.Fragment key={templateId || template.name}>
                  {index > 0 ? (
                    <span
                      aria-hidden="true"
                      style={{
                        width: "1px",
                        height: "16px",
                        background: "rgba(100, 116, 139, 0.32)",
                        margin: "0 1px",
                        flexShrink: 0,
                      }}
                    />
                  ) : null}
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => {
                      setTaskTemplateFilter(templateId);
                      setTaskTemplateActionMenuOpen(false);
                    }}
                    style={{
                      border: "none",
                      borderRadius: "6px",
                      background: active ? "var(--accent-color)" : "transparent",
                      color: active ? "#fff" : "var(--text-secondary)",
                      padding: "3px 7px",
                      fontSize: "11px",
                      fontWeight: 700,
                      lineHeight: "14px",
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                      boxShadow: active ? "0 1px 3px rgba(37, 99, 235, 0.28)" : "none",
                  }}
                >
                  <span>{template.name || t("task.unnamedTemplate")}</span>
                </button>
                </React.Fragment>
              );
            })}
          </div>
          <div ref={taskTemplateActionMenuRef} style={{ position: "relative", flexShrink: 0 }}>
            <button
              type="button"
              data-onboarding="task-template-menu"
              aria-label={t("task.templateMenu")}
              title={t("task.templateMenu")}
              onClick={() => setTaskTemplateActionMenuOpen((open) => !open)}
              style={{
                width: "28px",
                height: "28px",
                borderRadius: "8px",
                border: "none",
                background: taskTemplateActionMenuOpen ? "rgba(0, 0, 0, 0.06)" : "transparent",
                color: "var(--text-secondary)",
                opacity: 1,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                padding: 0,
              }}
            >
              <HorizontalDotsIcon />
            </button>
            {taskTemplateActionMenuOpen ? (
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 6px)",
                  left: "50%",
                  transform: "translateX(-50%)",
                  minWidth: "160px",
                  padding: "6px",
                  borderRadius: "10px",
                  border: "1px solid var(--border-color)",
                  background: "var(--menu-bg)",
                  boxShadow: "0 12px 30px rgba(15, 23, 42, 0.14)",
                  zIndex: 40,
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    setTaskTemplateActionMenuOpen(false);
                    openTaskTemplateEditor(null);
                  }}
                  style={taskTemplateMenuItemStyle()}
                >
                  <PlusSmallIcon />
                  <span>{t("task.createTemplate")}</span>
                </button>
                <button
                  type="button"
                  disabled={!selectedTaskTemplateForFilter}
                  onClick={() => {
                    if (!selectedTaskTemplateForFilter) return;
                    setTaskTemplateActionMenuOpen(false);
                    openTaskTemplateEditor(selectedTaskTemplateForFilter);
                  }}
                  style={taskTemplateMenuItemStyle(!selectedTaskTemplateForFilter)}
                >
                  <EditPencilIcon />
                  <span>{t("task.editTemplate")}</span>
                </button>
                <button
                  type="button"
                  disabled={!selectedTaskTemplateForFilter || selectedTaskTemplateUnfinishedCount > 0}
                  title={!selectedTaskTemplateForFilter ? t("task.selectTemplate") : selectedTaskTemplateUnfinishedCount > 0 ? t("task.deleteBlocked") : t("task.deleteTemplate")}
                  onClick={() => {
                    if (!selectedTaskTemplateForFilter || selectedTaskTemplateUnfinishedCount > 0) return;
                    setTaskTemplateActionMenuOpen(false);
                    void handleDeleteTaskTemplate(selectedTaskTemplateForFilter);
                  }}
                  style={taskTemplateMenuItemStyle(!selectedTaskTemplateForFilter || selectedTaskTemplateUnfinishedCount > 0)}
                >
                  <DeleteIcon />
                  <span>{t("task.deleteTemplate")}</span>
                </button>
                <div style={{ height: "1px", background: "var(--border-color)", margin: "6px 2px" }} />
                <button
                  type="button"
                  disabled={!selectedTaskTemplateForFilter}
                  onClick={() => setTaskTemplateConcurrencyOpen((open) => !open)}
                  style={taskTemplateMenuItemStyle(!selectedTaskTemplateForFilter)}
                >
                  <span style={{ flex: 1 }}>{t("task.concurrency")}</span>
                  <span style={{ fontSize: "12px", fontWeight: 800, color: "var(--text-primary)" }}>
                    {selectedTaskTemplateForFilter?.max_concurrency || 1}
                  </span>
                  <ChevronDownSmallIcon />
                </button>
                {taskTemplateConcurrencyOpen && selectedTaskTemplateForFilter ? (
                  <div style={{ borderTop: "1px solid var(--border-color)", borderBottom: "1px solid var(--border-color)", margin: "2px 2px 6px", padding: "4px 0" }}>
                    {Array.from({ length: 10 }, (_, index) => index + 1).map((value) => {
                      const active = (selectedTaskTemplateForFilter.max_concurrency || 1) === value;
                      return (
                        <button
                          key={value}
                          type="button"
                          onClick={() => {
                            void handleTaskTemplateConcurrencyChange(selectedTaskTemplateForFilter.id || "", value);
                          }}
                          style={{
                            width: "100%",
                            minHeight: "28px",
                            border: "none",
                            borderRadius: "6px",
                            background: active ? "rgba(37, 99, 235, 0.10)" : "transparent",
                            color: active ? "var(--accent-color)" : "var(--text-primary)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            padding: "5px 8px 5px 24px",
                            fontSize: "12px",
                            fontWeight: active ? 800 : 600,
                            cursor: "pointer",
                          }}
                        >
                          <span>{value}</span>
                          {active ? <CheckIconSmall /> : null}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          title={t("task.refresh")}
          aria-label={t("task.refresh")}
          onClick={() => void kanbanRefreshSpin.handleClick()}
          onMouseDown={() => kanbanRefreshSpin.setPressed(true)}
          onMouseUp={() => kanbanRefreshSpin.setPressed(false)}
          onMouseLeave={() => kanbanRefreshSpin.setPressed(false)}
          style={{
            width: "28px",
            height: "28px",
            borderRadius: "8px",
            border: "none",
            background: kanbanRefreshSpin.pressed || kanbanRefreshSpin.refreshing ? "rgba(0, 0, 0, 0.06)" : "transparent",
            color: "var(--text-color)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            flexShrink: 0,
            padding: 0,
          }}
        >
          <SyncIcon
            style={kanbanRefreshSpin.refreshing ? { animation: "mindfs-update-spin 0.8s linear infinite" } : undefined}
          />
        </button>
        <div ref={taskCreateTemplateMenuRef} style={{ position: "relative", flexShrink: 0 }}>
          <button
            type="button"
            data-onboarding="task-create"
            title={t("task.create")}
            aria-label={t("task.create")}
            disabled={!isAllTaskTemplateFilter && !selectedTaskTemplateForFilter}
            onClick={() => {
              if (isAllTaskTemplateFilter) {
                setTaskTemplateActionMenuOpen(false);
                setTaskCreateTemplateMenuOpen((open) => !open);
                return;
              }
              openTaskCreateDialog(selectedTaskTemplateForFilter);
            }}
            style={{
              width: "28px",
              height: "28px",
              borderRadius: "8px",
              border: "none",
              background: taskCreateTemplateMenuOpen ? "rgba(0, 0, 0, 0.06)" : "transparent",
              color: isAllTaskTemplateFilter || selectedTaskTemplateForFilter ? "var(--text-color)" : "var(--muted-text)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: isAllTaskTemplateFilter || selectedTaskTemplateForFilter ? "pointer" : "not-allowed",
              flexShrink: 0,
              padding: 0,
              opacity: isAllTaskTemplateFilter || selectedTaskTemplateForFilter ? 1 : 0.55,
            }}
          >
            <PlusSmallIcon />
          </button>
          {taskCreateTemplateMenuOpen ? (
            <div
              style={{
                position: "absolute",
                top: "calc(100% + 6px)",
                right: 0,
                minWidth: "136px",
                maxWidth: "220px",
                maxHeight: "260px",
                overflowY: "auto",
                padding: "5px",
                borderRadius: "10px",
                border: "1px solid var(--border-color)",
                background: "var(--menu-bg)",
                boxShadow: "0 12px 30px rgba(15, 23, 42, 0.14)",
                zIndex: 40,
              }}
            >
              {taskTemplates.length === 0 ? (
                <div style={{ padding: "8px", fontSize: "12px", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>{t("task.noTemplates")}</div>
              ) : taskTemplates.map((template) => (
                <button
                  key={template.id || template.name}
                  type="button"
                  onClick={() => {
                    setTaskCreateTemplateMenuOpen(false);
                    openTaskCreateDialog(template);
                  }}
                  style={{
                    width: "100%",
                    minHeight: "28px",
                    border: "none",
                    borderRadius: "7px",
                    background: "transparent",
                    color: "var(--text-primary)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "flex-start",
                    padding: "5px 8px",
                    fontSize: "12px",
                    fontWeight: 700,
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{template.name || t("task.unnamedTemplate")}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      {kanbanTasksLoading ? (
        <div style={{ padding: "12px", fontSize: "12px", color: "var(--text-secondary)" }}>{t("task.loading")}</div>
      ) : !isAllTaskTemplateFilter && !selectedTaskTemplateForFilter ? (
        <div style={{ padding: "12px", fontSize: "12px", color: "var(--text-secondary)" }}>{t("task.createTemplateFirst")}</div>
      ) : (
	        <div style={{ overflowX: "auto", overflowY: "hidden", padding: "0 0 12px 1px", minHeight: 0 }}>
	          <div
	            style={{
	              display: "grid",
	              gridAutoFlow: "column",
	              gridAutoColumns: isMobile ? "calc((100% - 6px) / 2)" : "minmax(220px, 1fr)",
	              gap: "6px",
	              minWidth: isMobile ? undefined : `${Math.max(kanbanStageColumns.length, 1) * 220}px`,
	              alignItems: "start",
	            }}
	          >
	            {kanbanStageColumns.map((column) => {
	              const taskSections = "groups" in column && Array.isArray(column.groups) && column.groups.length > 0
	                ? column.groups
	                : [{ key: "tasks", name: "", tone: "default" as const, tasks: column.tasks }];
	              return (
	              <section
	                key={column.index}
                style={{
		                  border: "1px solid var(--border-color)",
	                  borderRadius: "8px",
	                  background: "rgba(148, 163, 184, 0.06)",
	                  overflow: "hidden",
	                  display: "flex",
	                  flexDirection: "column",
	                  minHeight: 0,
	                  maxHeight: "calc(100dvh - 148px)",
	                }}
	              >
                <div
                  style={{
                    minHeight: "34px",
                    borderBottom: "1px solid var(--border-color)",
                    padding: "7px 9px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
	                    gap: "8px",
	                    flexShrink: 0,
	                  }}
	                >
                  <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: "6px" }}>
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "12px", fontWeight: 800, color: "var(--text-color)" }}>
                      {column.name}
                    </span>
                  </div>
                  <span style={{ fontSize: "11px", fontWeight: 800, color: "var(--text-secondary)" }}>{column.tasks.length}</span>
                </div>
	                <div style={{ padding: "8px", display: "flex", flexDirection: "column", gap: "8px", overflowY: "auto", minHeight: 0 }}>
	                  {column.tasks.length === 0 ? (
	                    <div style={{ padding: "10px 4px", fontSize: "12px", color: "var(--text-secondary)", textAlign: "center" }}>{t("task.empty")}</div>
	                      ) : taskSections.map((section) => {
                      const sectionCollapsed = Boolean(section.name && collapsedTaskCompletionGroups.has(section.key));
                      const sectionColor = section.tone === "danger" ? "#dc2626" : section.tone === "success" ? "#16a34a" : "var(--text-secondary)";
                      return (
	                    <React.Fragment key={section.key}>
	                      {section.name ? (
	                        <button
                            type="button"
                            onClick={() => {
                              setCollapsedTaskCompletionGroups((prev) => {
                                const next = new Set(prev);
                                if (next.has(section.key)) {
                                  next.delete(section.key);
                                } else {
                                  next.add(section.key);
                                }
                                return next;
                              });
                            }}
	                          style={{
	                            marginTop: "2px",
	                            padding: "2px 2px 0",
	                            display: "flex",
	                            alignItems: "center",
	                            justifyContent: "space-between",
	                            gap: "8px",
                              width: "100%",
                              border: "none",
                              background: "transparent",
	                            color: sectionColor,
	                            fontSize: "11px",
	                            fontWeight: 800,
                              cursor: "pointer",
	                          }}
	                        >
                            <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", minWidth: 0 }}>
                              <TaskGroupChevronIcon collapsed={sectionCollapsed} />
	                            <span>{section.name}</span>
                            </span>
	                          <span>{section.tasks.length}</span>
	                        </button>
	                      ) : null}
	                      {!sectionCollapsed ? section.tasks.map((task) => {
                    const firstInput = taskFirstInputById[task.id] || "";
                    const taskSessionKeys = taskSessionKeysById[task.id]?.length
                      ? taskSessionKeysById[task.id]
                      : task.main_session_key
                        ? [task.main_session_key]
                        : [];
                    const taskSessionPending = taskSessionKeys.some((key) => !!sessionByKey[key]?.pending);
                    const taskQueued = task.status === "queued";
                    const taskBlockedByConcurrency = taskQueued && !task.scheduler_admitted && !taskSessionKeys.length;
                    const auxFlags = task.aux_flags || {};
                    const taskSessionError = parseTaskSessionErrorMessage(auxFlags.session_error);
                    const taskSessionErrorDetails = parseTaskSessionErrorDetails(auxFlags.session_error);
                    const taskAuxBadges = [
                      auxFlags.ask_user_waiting ? { key: "ask_user", label: t("task.waitingUser"), icon: renderToolIcon("ask_user"), attention: true } : null,
                      auxFlags.has_plan ? { key: "plan", label: t("task.hasPlan"), icon: <TaskPlanAuxIcon />, attention: false } : null,
                      auxFlags.has_todos ? { key: "todos", label: t("task.hasTodos"), icon: renderToolIcon("todo"), attention: false } : null,
                      auxFlags.has_task ? { key: "task", label: t("task.hasTask"), icon: renderToolIcon("task"), attention: false } : null,
                    ].filter((item): item is { key: string; label: string; icon: React.ReactNode; attention: boolean } => Boolean(item));
                    const inputExpanded = expandedTaskInputIds.has(task.id);
                    const inputNeedsToggle = firstInput.length > 120 || firstInput.split(/\r?\n/).length > 3;
                    const taskTerminal = isTerminalKanbanTask(task);
                    const taskStageRunning = task.current_stage_status === "running";
                    const taskCanComplete = !taskTerminal && task.status === "waiting_user" && isTaskAtLastKnownStage(task);
                    const showTaskAdvanceButton = !taskTerminal && !taskStageRunning && !taskQueued;
                    const taskStatusText = taskStatusLabel(task.status || "", t);
                    const taskWorktreeEnabled = task.create_worktree === true;
	                    const taskNumberLabel = task.task_number ? `#${task.task_number}` : "";
	                    const taskStageName = task.current_stage_name || (task.current_stage_index >= 0 ? t("task.stageLabel", { index: task.current_stage_index + 1 }) : "");
	                    const showStageName = isAllTaskTemplateFilter ? column.name === t("task.column.running") : Boolean(taskStageName);
	                    const showTaskStatus = isAllTaskTemplateFilter && column.name === t("task.column.done");
	                    const taskSelected = selectedKanbanTaskId === task.id;
	                    return (
	                      <article
	                        key={task.id}
	                        onClick={() => handleSelectKanbanTask(task)}
	                        style={{
	                          position: "relative",
	                          border: taskSelected ? "1px solid rgba(14, 165, 233, 0.95)" : "1px solid rgba(96, 165, 250, 0.42)",
	                          borderRadius: "8px",
	                          background: "var(--menu-bg)",
	                          padding: "8px",
	                          boxShadow: taskSelected ? "0 0 0 2px rgba(14, 165, 233, 0.16)" : "0 1px 2px rgba(15, 23, 42, 0.06)",
	                          cursor: "pointer",
	                        }}
	                      >
                        {taskSessionPending ? (
                          <span
                            aria-label={t("task.replying")}
                            title={t("task.replying")}
                            style={taskReplyPulseStyle()}
                          />
                        ) : null}
                        {isAllTaskTemplateFilter ? (
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "5px",
                              minWidth: 0,
                              color: "var(--text-secondary)",
                              fontSize: "10px",
                              fontWeight: 700,
                              lineHeight: "14px",
                            }}
                          >
                            {taskNumberLabel ? (
                              <span style={{ flex: "0 0 auto", color: "#0ea5e9", fontWeight: 800 }}>{taskNumberLabel}</span>
                            ) : null}
                            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {task.task_template_name || selectedTaskTemplateForFilter?.name || t("task.unnamedTemplate")}
                            </span>
                            {showStageName ? (
                              <>
                                <span style={{ flex: "0 0 auto", opacity: 0.55 }}>·</span>
                                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                  {taskStageName}
                                </span>
                              </>
                            ) : null}
	                            {showTaskStatus ? (
	                              <>
	                                <span style={{ flex: "0 0 auto", opacity: 0.55 }}>·</span>
	                                <span style={{ flex: "0 0 auto" }}>{taskStatusText}</span>
	                                {task.status === "fail" && taskSessionError ? (
	                                  <button
	                                    type="button"
	                                    title={t("task.viewError")}
	                                    aria-label={t("task.viewTaskError")}
		                                    onClick={(event) => {
		                                      event.stopPropagation();
		                                      setTaskSessionErrorDialog({
		                                        title: task.task_template_name || selectedTaskTemplateForFilter?.name || t("task.defaultTitle"),
		                                        message: taskSessionError,
		                                        details: taskSessionErrorDetails,
		                                      });
		                                    }}
	                                    style={{ ...taskCardIconButtonStyle("warning"), width: "16px", height: "16px" }}
	                                  >
	                                    <TaskSessionErrorIcon />
	                                  </button>
	                                ) : null}
	                              </>
                            ) : null}
                            <span
                              title={taskWorktreeEnabled ? t("task.worktreeTitle") : t("task.noWorktreeTitle")}
                              aria-label={taskWorktreeEnabled ? t("task.worktreeTitle") : t("task.noWorktreeTitle")}
                              style={taskWorktreeTagStyle(taskWorktreeEnabled)}
                            >
                              {taskWorktreeEnabled ? null : <NoWorktreeIcon />}
                              worktree
                            </span>
                          </div>
                        ) : null}
                        <div
                          style={{
                            marginTop: isAllTaskTemplateFilter ? "5px" : 0,
                            color: firstInput ? "var(--text-color)" : "var(--text-secondary)",
                            fontSize: "12px",
                            lineHeight: "18px",
                            fontWeight: firstInput ? 700 : 500,
                            ...(!isAllTaskTemplateFilter
                              ? {
                                  display: "flex",
                                  alignItems: "flex-start",
                                  gap: "6px",
                                  minWidth: 0,
                                }
                              : {}),
                          }}
                        >
                          <div
                            style={{
                              ...(!isAllTaskTemplateFilter ? { flex: "1 1 auto", minWidth: 0 } : {}),
                              whiteSpace: "pre-wrap",
                              wordBreak: "break-word",
                              ...(!inputExpanded
                                ? {
                                    display: "-webkit-box",
                                    WebkitLineClamp: 3,
                                    WebkitBoxOrient: "vertical",
                                    overflow: "hidden",
                                  }
                                : {}),
                            }}
                          >
                            {!isAllTaskTemplateFilter && taskNumberLabel ? (
                              <span style={{ color: "#0ea5e9", fontWeight: 800, marginRight: "6px" }}>{taskNumberLabel}</span>
                            ) : null}
                            {firstInput ? <InlineTokenText content={firstInput} /> : <span>{t("task.noInput")}</span>}
                          </div>
                          {!isAllTaskTemplateFilter ? (
                            <span
                              title={taskWorktreeEnabled ? t("task.worktreeTitle") : t("task.noWorktreeTitle")}
                              aria-label={taskWorktreeEnabled ? t("task.worktreeTitle") : t("task.noWorktreeTitle")}
                              style={taskWorktreeTagStyle(taskWorktreeEnabled)}
                            >
                              {taskWorktreeEnabled ? null : <NoWorktreeIcon />}
                              worktree
                            </span>
                          ) : null}
                        </div>
                        <div style={{ marginTop: "8px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "4px" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                            {taskSessionKeys.length > 0 ? (
                              taskSessionKeys.map((sessionKey, sessionIndex) => {
                                const taskSession = sessionByKey[sessionKey] || null;
                                return (
                                  <button
                                    key={`${task.id}-${sessionKey}`}
                                    type="button"
                                    title={taskSession?.name || t("task.openSession", { index: sessionIndex + 1 })}
                                    aria-label={t("task.openSession", { index: sessionIndex + 1 })}
	                                    onClick={(event) => {
	                                      event.stopPropagation();
	                                      handleTaskSessionDrawerOpen(sessionKey, task.root_id || currentRootIdRef.current, task.id);
	                                    }}
                                    style={taskCardIconButtonStyle()}
                                  >
                                    <span
                                      style={{
                                        position: "relative",
                                        width: "18px",
                                        height: "18px",
                                        display: "inline-flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                      }}
                                    >
                                      <ModeIcon type="task" size={16} />
                                      <span
                                        style={{
                                          position: "absolute",
                                          right: "-2px",
                                          bottom: "-2px",
                                          width: "10px",
                                          height: "10px",
                                          borderRadius: "999px",
                                          background: "var(--content-bg, #fff)",
                                          border: "1px solid rgba(255,255,255,0.9)",
                                          display: "flex",
                                          alignItems: "center",
                                          justifyContent: "center",
                                          overflow: "hidden",
                                        }}
                                      >
                                        <AgentIcon
                                          agentName={taskSession?.agent || ""}
                                          style={{ width: "10px", height: "10px", display: "block" }}
                                        />
                                      </span>
                                    </span>
                                  </button>
                                );
                              })
                            ) : taskQueued ? (
                              <>
                                <span
                                  title={t("task.waitingSchedule")}
                                  aria-label={t("task.waitingSchedule")}
                                  style={{
                                    ...taskCardIconButtonStyle(),
                                    cursor: "default",
                                    color: "var(--accent-color)",
                                  }}
                                >
                                  <TaskQueuedSpinnerIcon />
                                </span>
                                {taskBlockedByConcurrency ? (
                                  <button
                                    type="button"
                                    title={t("task.runNow")}
                                    aria-label={t("task.runNow")}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void handleMoveKanbanTask(task, "run-now");
                                    }}
                                    style={{
                                      ...taskCardIconButtonStyle(),
                                      width: "17px",
                                      marginLeft: "-3px",
                                      color: "#2563eb",
                                    }}
                                  >
                                    <TaskRunNowIcon />
                                  </button>
                                ) : null}
                              </>
                            ) : null}
	                            {taskSessionError && !(showTaskStatus && task.status === "fail") ? (
                              <button
                                type="button"
                                title={t("task.viewError")}
                                aria-label={t("task.viewTaskSessionError")}
	                                onClick={(event) => {
	                                  event.stopPropagation();
	                                  setTaskSessionErrorDialog({
	                                    title: task.task_template_name || selectedTaskTemplateForFilter?.name || t("task.sessionTitle"),
	                                    message: taskSessionError,
	                                    details: taskSessionErrorDetails,
	                                  });
	                                }}
                                style={taskCardIconButtonStyle("warning")}
                              >
                                <TaskSessionErrorIcon />
                              </button>
                            ) : null}
                            {taskAuxBadges.length > 0 ? (
                              <div style={{ display: "inline-flex", alignItems: "center", gap: "2px" }}>
                                {taskAuxBadges.map((badge) => (
                                  <span
                                    key={badge.key}
                                    title={badge.label}
                                    aria-label={badge.label}
                                    style={taskAuxBadgeStyle(badge.attention)}
                                  >
                                    {badge.icon}
                                  </span>
                                ))}
                              </div>
                            ) : null}
                            {inputNeedsToggle ? (
                              <button
                                type="button"
                                title={inputExpanded ? t("common.collapse") : t("common.expand")}
                                aria-label={inputExpanded ? t("task.collapseContent") : t("task.expandContent")}
	                                onClick={(event) => {
	                                  event.stopPropagation();
	                                  setExpandedTaskInputIds((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(task.id)) {
                                      next.delete(task.id);
                                    } else {
                                      next.add(task.id);
                                    }
                                    return next;
                                  });
                                }}
                                style={taskCardIconButtonStyle()}
                              >
                                <TaskExpandIcon collapsed={!inputExpanded} />
                              </button>
                            ) : null}
                          </div>
                          {!taskTerminal ? (
                            <div style={{ display: "flex", justifyContent: "flex-end", gap: 0 }}>
                              {showTaskAdvanceButton ? (
                                <button
                                  type="button"
                                  title={taskCanComplete ? t("task.completeShort") : t("task.nextStage")}
                                  aria-label={taskCanComplete ? t("task.complete") : t("task.nextStage")}
	                                  onClick={(event) => {
	                                    event.stopPropagation();
	                                    void handleMoveKanbanTask(task, taskCanComplete ? "complete" : "next");
	                                  }}
                                  style={taskCardIconButtonStyle(taskCanComplete ? "success" : "accent")}
                                >
                                  {taskCanComplete ? <TaskCompleteIcon /> : <RunNowIcon />}
                                </button>
                              ) : null}
	                              <button type="button" title={t("common.edit")} aria-label={t("task.edit")} onClick={(event) => {
	                                event.stopPropagation();
	                                void openTaskEditDialog(task);
	                              }} style={taskCardIconButtonStyle()}>
                                {renderToolIcon("edit")}
                              </button>
	                              <button type="button" title={t("common.delete")} aria-label={t("task.delete")} onClick={(event) => {
	                                event.stopPropagation();
	                                void handleMoveKanbanTask(task, "cancel");
	                              }} style={taskCardIconButtonStyle("danger")}>
                                <DeleteIcon />
                              </button>
                            </div>
                          ) : null}
                        </div>
	                      </article>
	                    );
	                  }) : null}
	                    </React.Fragment>
                      );
	                  })}
	                </div>
	              </section>
	              );
	            })}
          </div>
        </div>
      )}
    </div>
  ) : null;
  if (activePendingPluginTrust) {
    workspaceView = (
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          background: "var(--mindfs-main-bg, transparent)",
        }}
      >
        <section
          style={{
            width: "min(720px, 100%)",
            border: "1px solid var(--border-color)",
            borderRadius: 8,
            background: "var(--mindfs-panel-bg, var(--bg-primary))",
            padding: 20,
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <ModeIcon type="plugin" size={18} />
            <strong style={{ fontSize: 15, color: "var(--text-primary)" }}>
              {t("plugin.trustTitle")}
            </strong>
          </div>
          <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.55 }}>
            {t("plugin.trustRisk")}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>
            <div>{t("plugin.trustRoot", { path: activePendingPluginTrust.bundle.rootPath })}</div>
            <div>{t("plugin.trustCount", { count: activePendingPluginTrust.bundle.plugins.length })}</div>
          </div>
          <div
            style={{
              border: "1px solid var(--border-color)",
              borderRadius: 6,
              overflow: "hidden",
            }}
          >
            {activePendingPluginTrust.bundle.plugins.map((plugin) => (
              <div
                key={plugin.path}
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1fr) auto",
                  gap: 12,
                  padding: "8px 10px",
                  borderBottom: "1px solid var(--border-color)",
                  fontSize: 12,
                }}
              >
                <span style={{ color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {plugin.path}
                </span>
                <span style={{ color: "var(--text-secondary)", fontFamily: "monospace" }}>
                  {plugin.sha256.slice(0, 12)}
                </span>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <button
              type="button"
              onClick={handleDisablePendingPlugins}
              style={{
                border: "1px solid var(--border-color)",
                background: "transparent",
                borderRadius: 6,
                padding: "6px 10px",
                cursor: "pointer",
                color: "var(--text-secondary)",
              }}
            >
              {t("plugin.trustDisable")}
            </button>
            <button
              type="button"
              onClick={() => {
                void handleTrustPendingPlugins();
              }}
              style={{
                border: "1px solid var(--accent-color)",
                background: "var(--accent-color)",
                borderRadius: 6,
                padding: "6px 10px",
                cursor: "pointer",
                color: "var(--accent-foreground, #fff)",
              }}
            >
              {pluginLoading ? t("plugin.loading") : t("plugin.trustAllow")}
            </button>
          </div>
        </section>
      </div>
    );
  } else if (gitDiff) {
    workspaceView = (
      <GitDiffViewer
        diff={gitDiff}
        root={currentRootId}
        sideBySide={gitDiffSideBySide}
        onPathClick={handleGitDiffPathClick}
        onSessionClick={(sessionKey) =>
          handleSessionChipClick(sessionKey, currentRootIdRef.current)
        }
        onSelectionChange={handleViewerSelectionChange}
      />
    );
  } else if (file) {
    if (pluginRender && pluginRender.output) {
      workspaceView = (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            minHeight: 0,
          }}
        >
          <div
            style={{
              height: "36px",
              borderBottom: "1px solid var(--border-color)",
              padding: "0 12px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              background: "var(--mindfs-topbar-bg, transparent)",
              fontSize: 12,
              color: "var(--text-secondary)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <ModeIcon type="plugin" size={16} />
              <span>{pluginRender.plugin.name}</span>
              {pluginLoading ? (
                <span style={{ opacity: 0.7 }}>{t("plugin.loading")}</span>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => {
                void switchToRawFileView();
              }}
              style={{
                border: "1px solid var(--border-color)",
                background: "transparent",
                borderRadius: 6,
                padding: "3px 8px",
                cursor: "pointer",
                fontSize: 12,
                color: "var(--text-secondary)",
              }}
            >
              {t("plugin.rawFile")}
            </button>
          </div>
          <div
            ref={pluginContentRef}
            className="plugin-shadcn-sandbox"
            style={{
              ...pluginThemeVars,
              flex: 1,
              minHeight: 0,
              overflow: "auto",
              padding: 12,
            }}
          >
            <Renderer
              key={pluginRendererKey}
              tree={pluginRender.output.tree as any}
              initialState={
                (pluginRender.output.data || {}) as Record<string, unknown>
              }
              handlers={pluginHandlers}
            />
          </div>
        </div>
      );
    } else {
      workspaceView = (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            minHeight: 0,
          }}
        >
          {pluginBypass && matchedPlugin ? (
            <div
              style={{
                borderBottom: "1px solid var(--border-color)",
                padding: "8px 12px",
                fontSize: 12,
                color: "var(--text-secondary)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span>{t("plugin.rawViewActive", { name: matchedPlugin.name })}</span>
              <button
                type="button"
                onClick={() => {
                  void switchToPluginView();
                }}
                style={{
                  border: "1px solid var(--border-color)",
                  background: "transparent",
                  borderRadius: 6,
                  padding: "3px 8px",
                  cursor: "pointer",
                  fontSize: 12,
                  color: "var(--text-secondary)",
                }}
              >
                {t("plugin.usePlugin")}
              </button>
            </div>
          ) : null}
          {pluginRender && pluginRender.error ? (
            <div
              style={{
                borderBottom: "1px solid var(--border-color)",
                padding: "8px 12px",
                fontSize: 12,
                color: "#d97706",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span>
                {t("plugin.renderFailedFallback", { name: pluginRender.plugin.name })}
              </span>
              <button
                type="button"
                onClick={() => setPluginBypass(true)}
                style={{
                  border: "1px solid var(--border-color)",
                  background: "transparent",
                  borderRadius: 6,
                  padding: "3px 8px",
                  cursor: "pointer",
                  fontSize: 12,
                  color: "var(--text-secondary)",
                }}
              >
                {t("plugin.ignorePlugin")}
              </button>
            </div>
          ) : null}
          <FileViewer
            file={file}
            isVisible={!selectedSession}
            onSelectionChange={handleViewerSelectionChange}
            initialScrollTop={
              fileScrollPositionsRef.current[currentFileScrollKey] || 0
            }
            onScrollTopChange={(scrollTop) => {
              if (!currentFileScrollKey) return;
              fileScrollPositionsRef.current[currentFileScrollKey] = scrollTop;
              persistFileScrollPositions(fileScrollPositionsRef.current);
            }}
            onSessionClick={(sessionKey) =>
              handleSessionChipClick(
                sessionKey,
                file?.root || currentRootIdRef.current,
              )
            }
            onPathClick={handleFileViewerPathClick}
            onFileClick={handleFileViewerFileClick}
          />
        </div>
      );
    }
  } else {
    workspaceView = (
      <DefaultListView
        root={currentRootId || undefined}
        path={selectedDir || ""}
        entries={currentMainContentView === "file-browser" ? visibleMainEntries : []}
        errorMessage={currentMainContentView === "file-browser" ? mainDirectoryError : ""}
        topContent={currentMainContentView === "task-kanban" ? kanbanTaskPanel : null}
        showHiddenFiles={showHiddenFiles}
        sortMode={currentDirectorySortMode}
        sortControlValue={currentDirectorySortOverride || "inherit"}
        currentViewMode={currentMainContentView}
        onViewModeChange={handleMainContentViewChange}
        uploadProgress={directoryUploadProgress}
        onCancelUpload={() => directoryUploadAbortRef.current?.abort()}
        onSortModeChange={(nextMode) => {
          const rootID = currentRootIdRef.current;
          const nextKey = getDirectorySortKey(rootID, selectedDirRef.current);
          if (!nextKey) {
            return;
          }
          setDirectorySortOverrides((prev) => {
            if (nextMode === "inherit") {
              if (!(nextKey in prev)) {
                return prev;
              }
              const next = { ...prev };
              delete next[nextKey];
              return next;
            }
            return { ...prev, [nextKey]: nextMode };
          });
        }}
        onUploadFiles={handleTreeUpload}
        onRenameRoot={handleRenameCurrentRoot}
        onRemoveRoot={handleRemoveCurrentRoot}
        isGitRepo={managedRootByIdRef.current[currentRootId || ""]?.is_git_repo === true}
        isGitWorktree={managedRootByIdRef.current[currentRootId || ""]?.is_git_worktree === true}
        enableGitHistoryToggle={false}
        onCreateWorktree={handleOpenWorktreeLocation}
        onSwitchWorktree={handleSwitchWorktreeStart}
        onRemoveWorktree={handleRemoveCurrentWorktree}
        onOpenScheduledAgentTasks={() => setScheduledAgentDialogOpen(true)}
        menuOverlay={
          projectAddMode === "worktree_location"
            ? projectAddOverlay
            : worktreeSwitchOpen
              ? worktreeSwitchOverlay
              : worktreeCreateOverlay
        }
        onItemClick={(e) =>
          e.is_dir
            ? actionHandlers.open_dir({ path: e.path })
            : actionHandlers.open({ path: e.path })
        }
        onPathClick={handleDirectoryPathClick}
      />
    );
  }

  useEffect(() => {
    const body = document.body;
    if (!pluginThemeVars || pluginBypass || !pluginRender?.output) {
      body.removeAttribute("data-plugin-theme");
      body.style.removeProperty("--vp-overlay-bg");
      body.style.removeProperty("--vp-surface-bg");
      body.style.removeProperty("--vp-surface-bg-elevated");
      body.style.removeProperty("--vp-text");
      body.style.removeProperty("--vp-text-muted");
      body.style.removeProperty("--vp-border");
      body.style.removeProperty("--vp-primary");
      body.style.removeProperty("--vp-primary-text");
      body.style.removeProperty("--vp-radius");
      body.style.removeProperty("--vp-shadow");
      body.style.removeProperty("--vp-focus-ring");
      body.style.removeProperty("--vp-danger");
      body.style.removeProperty("--vp-warning");
      body.style.removeProperty("--vp-success");
      return;
    }
    body.setAttribute("data-plugin-theme", "1");
    Object.entries(pluginThemeVars).forEach(([key, value]) => {
      body.style.setProperty(key, String(value));
    });
    return () => {
      body.removeAttribute("data-plugin-theme");
      body.style.removeProperty("--vp-overlay-bg");
      body.style.removeProperty("--vp-surface-bg");
      body.style.removeProperty("--vp-surface-bg-elevated");
      body.style.removeProperty("--vp-text");
      body.style.removeProperty("--vp-text-muted");
      body.style.removeProperty("--vp-border");
      body.style.removeProperty("--vp-primary");
      body.style.removeProperty("--vp-primary-text");
      body.style.removeProperty("--vp-radius");
      body.style.removeProperty("--vp-shadow");
      body.style.removeProperty("--vp-focus-ring");
      body.style.removeProperty("--vp-danger");
      body.style.removeProperty("--vp-warning");
      body.style.removeProperty("--vp-success");
    };
  }, [pluginThemeVars, pluginBypass, pluginRender]);

  const switchToRawFileView = useCallback(async () => {
    if (!file) return;
    const root = file.root || currentRootIdRef.current;
    if (!root) return;
    pluginBypassRef.current = true;
    setPluginBypass(true);
    await actionHandlers.open({
      path: file.path,
      root,
      cursor: fileCursorRef.current || 0,
      readMode: "incremental",
      preservePluginQuery: true,
    });
  }, [file, actionHandlers]);

  const switchToPluginView = useCallback(async () => {
    if (!file) return;
    const root = file.root || currentRootIdRef.current;
    if (!root) return;
    pluginBypassRef.current = false;
    setPluginBypass(false);
    await actionHandlers.open({
      path: file.path,
      root,
      cursor: fileCursorRef.current || 0,
      preservePluginQuery: true,
    });
  }, [file, actionHandlers]);

  const handleRelayAction = useCallback(async () => {
    if (!currentRootId) {
      return;
    }
    const pendingPopup = openPendingPopup();
    const latestStatus = await startRelayBinding();
    const nextStatus = latestStatus || relayStatus;
    if (!nextStatus) {
      pendingPopup?.close();
      return;
    }
    const nodeURL = String(nextStatus?.node_url || "");
    if (nextStatus?.relay_bound && nodeURL) {
      const target = new URL(nodeURL, window.location.origin);
      target.searchParams.set("root", currentRootId);
      navigatePopup(pendingPopup, target.toString());
      return;
    }
    const pendingCode = String(nextStatus?.pending_code || "");
    const nodeName = String(nextStatus?.node_name || "");
    const relayBaseURL = String(nextStatus?.relay_base_url || "");
    if (!pendingCode || !relayBaseURL) {
      pendingPopup?.close();
      return;
    }
    const target = new URL("/bind", relayBaseURL);
    target.searchParams.set("code", pendingCode);
    target.searchParams.set("root", currentRootId);
    if (nodeName) {
      target.searchParams.set("node_name", nodeName);
    }
    navigatePopup(pendingPopup, target.toString());
  }, [currentRootId, startRelayBinding, relayStatus]);

  const refreshTokenStationInfo = useCallback(async () => {
    setTokenStationLoading(true);
    setTokenStationErrorOpen(false);
    try {
      const info = await fetchTokenStationInfo();
      setTokenStationInfo(info);
    } catch (error) {
      setTokenStationInfo({
        success: false,
        message: error instanceof Error ? error.message : "token_station_failed",
      });
    } finally {
      setTokenStationLoading(false);
    }
  }, []);

  useEffect(() => {
    tokenStationRefreshRef.current = () => {
      void refreshTokenStationInfo();
    };
    return () => {
      tokenStationRefreshRef.current = null;
    };
  }, [refreshTokenStationInfo]);

  useEffect(() => {
    if (!bootstrapService.canUseProtectedAPI()) {
      return;
    }
    void refreshTokenStationInfo();
  }, [refreshTokenStationInfo, bootstrapState.phase]);

  useEffect(() => {
    if (!bootstrapService.canUseProtectedAPI() || !selectedSession?.updated_at) {
      return;
    }
    void refreshTokenStationInfo();
  }, [refreshTokenStationInfo, selectedSession?.updated_at]);

  const handleTokenStationAction = useCallback(async () => {
    setTokenStationErrorOpen(false);
    const topupURL = String(tokenStationInfo?.data?.topup_url || "http://localhost:3000");
    const walletURL = tokenStationWalletURL(topupURL);
    if (relayStatus?.relay_bound || relayStatus?.token_station_bound) {
      window.open(walletURL, "_blank", "noopener,noreferrer");
      return;
    }
    const pendingPopup = openPendingPopup();
    setTokenStationBusy(true);
    try {
      const status = await startTokenStationBinding();
      if (status.bound) {
        window.open(tokenStationWalletURL(String(status.topup_url || topupURL)), "_blank", "noopener,noreferrer");
        pendingPopup?.close();
        return;
      }
      const pendingCode = String(status.pending_code || "");
      const relayBaseURL = String(status.relay_base_url || relayStatus?.relay_base_url || "");
      if (!pendingCode || !relayBaseURL) {
        pendingPopup?.close();
        return;
      }
      const target = new URL("/bind", relayBaseURL);
      target.searchParams.set("code", pendingCode);
      target.searchParams.set("purpose", "token_station");
      navigatePopup(pendingPopup, target.toString());
    } finally {
      setTokenStationBusy(false);
    }
  }, [relayStatus, tokenStationInfo]);

  const handleTokenStationApply = useCallback(async () => {
    setTokenStationErrorOpen(false);
    setTokenStationApplyBusy(true);
    try {
      const info = await fetchTokenStationInfo("apply");
      setTokenStationInfo(info);
      if (!info.success) {
        setTokenStationInfo({
          ...info,
          message: info.message || t("tokenStation.loadFailed"),
        });
        setTokenStationErrorOpen(true);
        return;
      }
      const topupURL = String(info.data?.topup_url || tokenStationInfo?.data?.topup_url || "").trim();
      const byName = new Map<string, { name: string; baseUrl: string; apiKey: string }>();
      for (const item of info.data?.api_keys || []) {
        const name = String(item?.name || "").trim();
        const apiKey = normalizeTokenStationAPIKey(String(item?.api_key || ""));
        if (!name || !apiKey || !topupURL) {
          continue;
        }
        if (!byName.has(name)) {
          byName.set(name, { name, baseUrl: topupURL, apiKey });
        }
      }
      const providers = Array.from(byName.values());
      if (providers.length === 0) {
        setTokenStationInfo({
          ...info,
          success: false,
          message: t("tokenStation.noAPIKey"),
        });
        setTokenStationErrorOpen(true);
        return;
      }
      const result = await syncAgentAPIProviders(providers);
      setAgentConfigSwitchRequest({
        nonce: Date.now(),
        providerIDs: (result.providers || []).map((provider) => provider.id),
      });
    } catch (error) {
      setTokenStationInfo({
        success: false,
        message: error instanceof Error ? error.message : t("tokenStation.applyFailed"),
      });
      setTokenStationErrorOpen(true);
    } finally {
      setTokenStationApplyBusy(false);
    }
  }, [tokenStationInfo, t]);

  const relayActionLabel = useMemo(() => {
    if (isRelayNodePage()) {
      return null;
    }
    if (relayStatus?.no_relayer) {
      return null;
    }
    return t("relay.publicAccess");
  }, [relayStatus, t]);

  const relayActionDisabled =
    !currentRootId ||
    (!relayStatus?.relay_bound &&
      !relayStatus?.relay_base_url);
  const showUpdateButton = shouldShowUpdateButton(updateState);
  const updateBusy =
    updateSubmitting ||
    ["downloading", "installing", "restarting"].includes(
      (updateState.status || "").toLowerCase(),
    );
  const updateLabel = updateButtonLabel(updateState, t);
  const updateHelp = updateState.message || updateSummaryText(updateState, t);
  const updateSummary = updateSummaryText(updateState, t);
  const sessionImportMenu = (
    <div ref={importMenuRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setImportMenuOpen((open) => !open)}
        aria-label={t("externalImport.open")}
        style={{
          border: "none",
          background: "transparent",
          color:
            sessionListMode === "import" && externalImportAgent
              ? "var(--text-secondary)"
              : "#0f766e",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          height: "34px",
          minWidth: "34px",
          borderRadius: "8px",
          cursor: "pointer",
          padding:
            sessionListMode === "import" && externalImportAgent ? 0 : "0 2px",
        }}
      >
        {sessionListMode === "import" && externalImportAgent ? (
          <>
            <AgentIcon
              agentName={externalImportAgent}
              style={{ width: "14px", height: "14px", display: "block" }}
            />
            <ChevronDownSmallIcon />
          </>
        ) : (
          <ImportIcon />
        )}
      </button>
      {importMenuOpen ? (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            width: "260px",
            padding: "10px",
            borderRadius: "12px",
            border: "1px solid var(--border-color)",
            background: "var(--menu-bg)",
            boxShadow: "0 12px 30px rgba(15, 23, 42, 0.14)",
            zIndex: 40,
            display: "flex",
            flexDirection: "column",
            gap: "10px",
          }}
        >
          <div
            style={{
              fontSize: "12px",
              fontWeight: 700,
              color: "var(--text-primary)",
            }}
          >
            {t("externalImport.chooseAgent")}
          </div>
          <AgentMenuList
            agents={availableAgents}
            selectedAgent={externalImportAgent}
            maxHeight="180px"
            onSelect={(agentName) => {
              setImportMenuOpen(false);
              setExternalImportAgent(agentName);
              setExternalSelectedKey("");
              void enterImportMode(agentName);
            }}
          />
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              fontSize: "12px",
              color: "var(--text-primary)",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={externalFilterBound}
              onChange={(e) => setExternalFilterBound(e.target.checked)}
            />
            <span>{t("externalImport.hideImported")}</span>
          </label>
        </div>
      ) : null}
    </div>
  );
  const sessionSidebar =
    sessionListMode === "import" ? (
      <ExternalSessionList
        sessions={externalSessions}
        selectedKey={externalSelectedKey}
        selectedAgent={externalImportAgent}
        importingKeys={importingExternalSessionKeys}
        selectedImportKeys={selectedExternalImportKeys}
        filterBound={externalFilterBound}
        headerAction={sessionImportMenu}
        loading={loadingExternalSessions}
        error={externalSessionsError}
        loadingOlder={loadingOlderExternalSessions}
        confirmingImport={confirmingExternalImport}
        hasMore={hasMoreExternalSessions}
        onBack={exitImportMode}
        onSelect={(session) =>
          setExternalSelectedKey(
            String(session.key || session.session_key || ""),
          )
        }
        onToggleImport={toggleExternalImportSelection}
        onToggleSelectAllImport={toggleAllExternalImportSelection}
        onConfirmImport={() => {
          void handleConfirmExternalImport();
        }}
        onLoadOlder={() => {
          void handleLoadOlderExternalSessions();
        }}
      />
    ) : multiProjectSessionsEnabled && !sessionSearchOpen && !sessionSearchResultsMode ? (
      <MultiProjectSessionList
        groups={multiProjectSessionGroups}
        selectedKey={selectedSession?.key}
        selectedRootId={(selectedSession?.root_id as string | undefined) || currentRootId || ""}
        headerAction={sessionImportMenu}
        loading={multiProjectSessionsLoading}
        emptyText={t("externalImport.empty")}
        syncingSessionKeys={syncingSessionKeys}
        onSearchToggle={() => {
          setSessionSearchOpen(true);
          setSessionSearchResultsMode(false);
          setSessionSearchQuery("");
          setSessionSearchAppliedQuery("");
          setSessionSearchResults([]);
          setSessionSearchLoading(false);
        }}
        onSelect={(s) => {
          handleSelectSession(s);
          if (isMobile) setIsRightOpen(false);
        }}
        onSync={handleSyncSession}
        onPin={handlePinSession}
        onRename={handleRenameSession}
        onDelete={handleDeleteSession}
        onProjectClick={(rootId) => {
          actionHandlers.open_dir({
            path: rootId,
            root: rootId,
            isRoot: true,
            suppressTreeExpand: true,
          });
          if (isMobile) setIsRightOpen(false);
        }}
        onLoadMoreProject={loadMoreMultiProjectSessions}
        onLoadChildren={loadChildSessionsForParent}
      />
    ) : (
      <SessionList
        sessions={
          sessionSearchOpen && sessionSearchResultsMode
            ? sessionSearchResults
            : sessions
        }
        selectedKey={selectedSession?.key}
        headerAction={sessionImportMenu}
        searchOpen={sessionSearchOpen}
        searchResultsMode={sessionSearchResultsMode}
        searchQuery={sessionSearchQuery}
        searchLoading={sessionSearchLoading}
        syncingSessionKeys={syncingSessionKeys}
        emptyText={
          sessionSearchResultsMode
            ? t("externalImport.noSearchMatch")
            : sessionSearchOpen
              ? ""
            : (
              <span>
                {t("externalImport.emptyHintPrefix")}
                <strong style={{ color: "var(--text-primary)", fontWeight: 800 }}>
                  {t("externalImport.emptyHintAction")}
                </strong>
              </span>
            )
        }
        onSearchToggle={() => {
          setSessionSearchOpen((prev) => {
            const next = !prev;
            if (!next) {
              setSessionSearchResultsMode(false);
              setSessionSearchQuery("");
              setSessionSearchAppliedQuery("");
              setSessionSearchResults([]);
              setSessionSearchLoading(false);
            }
            return next;
          });
        }}
        onSearchQueryChange={(value) => {
          setSessionSearchQuery(value);
          if (!value.trim() && !sessionSearchResultsMode) {
            setSessionSearchAppliedQuery("");
            setSessionSearchResults([]);
            setSessionSearchLoading(false);
          }
        }}
        onSearchSubmit={executeSessionSearch}
        onSearchBlur={() => {
          setSessionSearchOpen(false);
          setSessionSearchResultsMode(false);
          setSessionSearchQuery("");
          setSessionSearchAppliedQuery("");
          setSessionSearchResults([]);
          setSessionSearchLoading(false);
        }}
        onSearchBack={() => {
          setSessionSearchResultsMode(false);
          setSessionSearchQuery("");
          setSessionSearchAppliedQuery("");
          setSessionSearchResults([]);
          setSessionSearchLoading(false);
          setSessionSearchOpen(false);
        }}
        onSelect={(s) => {
          handleSelectSession(s);
          if (isMobile) setIsRightOpen(false);
        }}
        onSync={handleSyncSession}
        onPin={handlePinSession}
        onRename={handleRenameSession}
        onDelete={handleDeleteSession}
        onLoadChildren={
          sessionSearchOpen && sessionSearchResultsMode
            ? undefined
            : loadChildSessionsForParent
        }
        onLoadOlder={
          sessionSearchOpen && sessionSearchResultsMode
            ? undefined
            : handleLoadOlderSessions
        }
        loadingOlder={
          sessionSearchOpen && sessionSearchResultsMode
            ? false
            : loadingOlderSessions
        }
        hasMore={
          sessionSearchOpen && sessionSearchResultsMode
            ? false
            : hasMoreSessions
        }
      />
    );
  const tokenStationBalanceText = tokenStationLoading
    ? t("tokenStation.reading")
    : formatTokenStationBalance(tokenStationInfo);
  const canApplyTokenStationConfig =
    tokenStationInfo?.success === true && parseTokenStationBalance(tokenStationInfo) > 0;
  const tokenStationCard = (
      <section
        aria-label={t("tokenStation.title")}
        style={{
          position: "relative",
          width: "100%",
          height: 36,
          display: "flex",
          alignItems: "center",
          gap: 6,
          border: "1px solid var(--panel-border)",
          background: "var(--panel-bg)",
          backdropFilter: "blur(14px)",
          boxShadow: "var(--panel-shadow)",
          borderRadius: 8,
          boxSizing: "border-box",
          padding: "0 5px 0 8px",
          color: "var(--text-primary)",
        }}
      >
        {tokenStationInfo?.success === false && tokenStationErrorOpen ? (
          <div
            role="status"
            style={{
              position: "absolute",
              left: 0,
              bottom: 42,
              width: "100%",
              border:
                "1px solid color-mix(in srgb, var(--mindfs-launcher-error-text) 24%, transparent)",
              background: "var(--mindfs-launcher-error-bg)",
              color: "var(--mindfs-launcher-error-text)",
              borderRadius: 8,
              boxShadow: "var(--panel-shadow)",
              padding: "7px 9px",
              fontSize: 11,
              lineHeight: "15px",
              wordBreak: "break-word",
            }}
          >
            {tokenStationInfo.message || t("tokenStation.unbound")}
          </div>
        ) : null}
        <div
          style={{
            width: "100%",
            height: 28,
            display: "flex",
            alignItems: "center",
            gap: 5,
            minWidth: 0,
          }}
        >
          <svg
            aria-hidden="true"
            width="1em"
            height="1em"
            viewBox="0 0 24 24"
            style={{
              flex: "0 0 auto",
              width: 21,
              height: 21,
              color: "#f97316",
            }}
          >
            <path d="M0 0h24v24H0z" fill="none" />
            <path
              fill="currentColor"
              d="M3 21a1 1 0 0 1 0-2V6a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v4a3 3 0 0 1 3 3v3a.5.5 0 1 0 1 0v-6a2 2 0 0 1-2-2v-.585l-.707-.708a1 1 0 0 1-.083-1.32l.083-.094a1 1 0 0 1 1.414 0l3.003 3.002l.095.112l.028.04l.044.073l.052.11l.031.09l.02.076l.012.078L21 9v7a2.5 2.5 0 1 1-5 0v-3a1 1 0 0 0-1-1v7a1 1 0 0 1 0 2zm9-16H6a1 1 0 0 0-1 1v4h8V6a1 1 0 0 0-1-1"
            />
          </svg>
          <span
            title={
              tokenStationInfo?.success
                ? tokenStationBalanceText
                : tokenStationInfo?.message || t("tokenStation.unbound")
            }
            style={{
              minWidth: "max-content",
              flex: "1 0 auto",
              overflow: "visible",
              whiteSpace: "nowrap",
              fontSize: tokenStationBalanceText.length > 9 ? 11 : 12,
              fontWeight: 700,
              lineHeight: "18px",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {tokenStationBalanceText}
          </span>
          {canApplyTokenStationConfig ? (
            <button
              type="button"
              onClick={() => void handleTokenStationApply()}
              disabled={tokenStationApplyBusy}
              style={{
                flex: "0 0 auto",
                height: 23,
                border: "1px solid var(--accent-color)",
                borderRadius: 6,
                background: "transparent",
                color: "var(--accent-color)",
                fontSize: 11,
                fontWeight: 650,
                cursor: tokenStationApplyBusy ? "default" : "pointer",
                opacity: tokenStationApplyBusy ? 0.65 : 1,
                padding: "0 4px",
                whiteSpace: "nowrap",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              {tokenStationApplyBusy ? (
                <svg
                  aria-hidden="true"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  style={{ animation: "mindfs-update-spin 0.9s linear infinite" }}
                >
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
              ) : null}
              <span style={{ fontSize: isTablet ? 10 : 11 }}>{t("tokenStation.apply")}</span>
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void handleTokenStationAction()}
            disabled={tokenStationBusy}
            style={{
              flex: "0 0 auto",
              height: 23,
              border: "none",
              borderRadius: 6,
              background: "var(--accent-color)",
              color: "#fff",
              fontSize: 11,
              fontWeight: 650,
              cursor: tokenStationBusy ? "default" : "pointer",
              opacity: tokenStationBusy ? 0.65 : 1,
              padding: "0 5px",
              whiteSpace: "nowrap",
            }}
          >
            {tokenStationBusy ? t("tokenStation.processing") : t("tokenStation.topUp")}
          </button>
        </div>
      </section>
  );

  return (
    <>
      <AppShell
        leftOpen={isLeftOpen}
        rightOpen={isRightOpen}
        sidebarsSwapped={sidebarsSwapped}
        onCloseLeft={() => setIsLeftOpen(false)}
        onCloseRight={() => setIsRightOpen(false)}
        onOpenLeft={() => setIsLeftOpen(true)}
        onOpenRight={() => setIsRightOpen(true)}
        sidebar={
          <FileTree
            entries={rootEntries}
            childrenByPath={entriesByPath}
            expanded={expanded}
            sortMode={treeSortMode}
            showHiddenFiles={showHiddenFiles}
            onSortModeChange={setTreeSortMode}
            onShowHiddenFilesChange={setShowHiddenFiles}
            onRefresh={() => {
              if (currentRootId) {
                const dir = selectedDirRef.current === currentRootId ? "." : (selectedDirRef.current || ".");
                void refreshTreeDir(currentRootId, dir, true);
              }
            }}
            selectedDirKey={selectedDirKey}
            selectedPath={file?.path}
            rootId={currentRootId}
            rootSessionIndicators={rootSessionIndicators}
            creatingRootName={
              creatingRootKind === "worktree" ? null : creatingRootName
            }
            creatingRootBusy={creatingRootBusy}
            onOpenProjectAdd={handleOpenProjectAdd}
            onStartOnboarding={isMobile ? undefined : () => setOnboardingOpen(true)}
            onCreateRootStart={handleCreateRootStart}
            onCreateRootNameChange={setCreatingRootName}
            onCreateRootSubmit={() => {
              void handleCreateRootSubmit();
            }}
            onCreateRootCancel={handleCreateRootCancel}
            projectAddOverlay={
              projectAddMode === "worktree_location" ? null : projectAddOverlay
            }
            onSelectFile={(e, r) => {
              actionHandlers.open({ path: e.path, root: r });
              if (isMobile) setIsLeftOpen(false);
            }}
            onSelectRoot={(e, r) =>
              actionHandlers.open_dir({
                path: e.path,
                root: r,
                isRoot: e.is_root === true,
                suppressTreeExpand: true,
              })
            }
            onToggleDir={(e, r) =>
              actionHandlers.open_dir({
                path: e.path,
                root: r,
                toggle: true,
                isRoot: e.is_root === true,
              })
            }
            renderRootExtraContent={renderRootGitContent}
            renderRootWorktreeContent={renderRootWorktreeContent}
            renderRootRelatedContent={renderRootRelatedContent}
            projectTreeTabRequest={projectTreeTabRequest}
            agentConfigSwitchRequest={agentConfigSwitchRequest}
            onAgentConfigSwitched={(agentName) => {
              if (agentName.trim().toLowerCase() === "codex") {
                setCodexRateLimitsRefreshToken((value) => value + 1);
              }
            }}
            onProjectTreeTabChange={setProjectTreeTab}
            relayActionLabel={relayActionLabel}
            relayActionDisabled={relayActionDisabled}
            relayActionHelp={null}
            onRelayAction={handleRelayAction}
            relayNodeId={relayStatus?.node_id || ""}
            relayBaseURL={relayStatus?.relay_base_url || ""}
            relayNoRelayer={relayStatus?.no_relayer === true}
            updateActionLabel={showUpdateButton ? updateLabel : null}
            updateActionDisabled={updateBusy}
            updateActionHelp={showUpdateButton ? updateHelp : ""}
            updateActionBusy={updateBusy}
            updateActionSummary={showUpdateButton ? updateSummary : ""}
            onUpdateAction={() => {
              void handleStartUpdate();
            }}
            footerTopContent={tokenStationCard}
            showEnterKeySendOption={isMobile}
            enterKeySends={mobileEnterKeySends}
            onEnterKeySendsChange={setMobileEnterKeySends}
            sidebarsSwapped={sidebarsSwapped}
            onSidebarsSwappedChange={setSidebarsSwapped}
            gitDiffSideBySide={gitDiffSideBySide}
            onGitDiffSideBySideChange={setGitDiffSideBySide}
            multiProjectSessionsEnabled={multiProjectSessionsEnabled}
            onMultiProjectSessionsChange={setMultiProjectSessionsEnabled}
            onRunAgentLifecycleCommand={handleRunAgentLifecycleCommand}
            onRestartAgent={handleRestartAgent}
            onGoHome={onGoHome}
          />
        }
        rightSidebar={sessionSidebar}
        main={
          <div
            data-onboarding="workspace"
            style={{
              width: "100%",
              flex: 1,
              minHeight: 0,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              position: "relative",
            }}
          >
            <div
              style={{
                flex: 1,
                minHeight: 0,
                minWidth: 0,
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <div
                style={{
                  display: selectedSession ? "flex" : "none",
                  flex: 1,
                  minHeight: 0,
                  minWidth: 0,
                }}
              >
                {sessionView}
              </div>
              <div
                style={{
                  display: selectedSession ? "none" : "flex",
                  flex: 1,
                  minHeight: 0,
                  minWidth: 0,
                  flexDirection: "column",
                }}
              >
                {workspaceView}
              </div>
            </div>
          </div>
        }
        footer={
          <div
            style={{
              width: "100%",
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "stretch",
              background: "var(--content-bg)",
            }}
          >
            {currentRootSlashCommandResult ? (
              <div
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: isMobile ? "0 0 6px" : "0 16px 8px",
                }}
              >
                {renderRootSlashCommandResult(currentRootSlashCommandResult)}
              </div>
            ) : null}
            <ActionBar
              status={status}
              agentsVersion={agentsVersion}
              codexRateLimitsRefreshToken={codexRateLimitsRefreshToken}
              currentRootId={currentRootId}
              currentRootIsGitRepo={managedRootByIdRef.current[currentRootId || ""]?.is_git_repo === true}
              currentSession={actionBarSession}
              pendingPlanMode={pendingPlanMode}
              attachedFileContext={attachedFileContext}
              canOpenSessionDrawer={canOpenSessionDrawer}
              sessionDrawerOpen={isDrawerOpen}
              detachedBoundSession={detachedBoundSession}
              editDraftRequest={editDraftRequest}
              queuedMessages={actionBarQueuedMessages}
              inputHistory={actionBarInputHistory}
              onSendMessage={handleSendMessage}
              onSetPlanMode={handleSetPlanMode}
              onCancelCurrentTurn={handleCancelCurrentTurn}
              onRemoveQueuedMessage={handleRemoveQueuedMessage}
              onUpdateQueuedMessage={handleUpdateQueuedMessage}
              onSendQueuedMessageNow={handleSendQueuedMessageNow}
              mobileEnterKeySends={mobileEnterKeySends}
              onNewSession={handleNewSession}
              onRequestFileContext={handleRequestFileContext}
              onClearFileContext={handleClearFileContext}
              onToggleLeftSidebar={() => setIsLeftOpen((v) => !v)}
              onToggleRightSidebar={() => setIsRightOpen((v) => !v)}
              sidebarsSwapped={sidebarsSwapped}
              onSessionClick={() => {
              const rootID = currentRootIdRef.current;
              if (!activeBoundSessionKey) return;
              const selectedKey =
                selectedSession?.key || selectedSession?.session_key;
              const isBoundSessionInMain =
                selectedKey === activeBoundSessionKey &&
                interactionMode !== "drawer";
              if (isBoundSessionInMain) return;
              const isDrawerCurrentlyOpen =
                !!drawerOpenByRootRef.current[rootID || ""];
              if (isDrawerCurrentlyOpen) {
                interactionModeRef.current = "main";
                setInteractionMode("main");
                setDrawerOpenForRoot(rootID, false);
                return;
              }
              setInteractionMode("drawer");
              setDrawerOpenForRoot(rootID, true);
              }}
            />
          </div>
        }
        drawer={
          <BottomSheet
            isOpen={isDrawerOpen}
            onClose={() => {
              interactionModeRef.current = "main";
              setInteractionMode("main");
              setDrawerOpenForRoot(currentRootIdRef.current, false);
            }}
            onExpand={() => {
              handleSelectSession(currentSession, {
                preserveTaskSelection:
                  !!currentSession?.task_id &&
                  currentSession.task_id === selectedKanbanTaskId,
              });
              setDrawerOpenForRoot(currentRootIdRef.current, false);
            }}
          >
            {drawerSessionSnapshot ? (
              <SessionViewer
                session={drawerSessionSnapshot}
                agents={availableAgents}
                slashCommandResult={slashCommandResultForSession(
                  currentRootId,
                  drawerSessionSnapshot,
                )}
                targetSeq={currentSession?.search_seq}
                targetSeqRequestKey={currentSession?.search_target_id}
                loading={
                  drawerLoadingSessionByRoot[currentRootId || ""] ===
                  (drawerSessionSnapshot.key || drawerSessionSnapshot.session_key)
                }
                rootId={currentRootId}
                rootPath={
                  managedRootByIdRef.current[currentRootId || ""]?.root_path ||
                  null
                }
                interactionMode="drawer"
                gitFileStatsByPath={gitFileStatsByPath}
                onFileClick={handleDrawerSessionFileClick}
                onRootClick={(root) => {
                  void actionHandlers.open_dir({
                    path: root,
                    root,
                    isRoot: true,
                    forceDirectory: true,
                    suppressTreeExpand: true,
                  });
                }}
                onRemoveRelatedFile={(path, head, repoPath, repoKind) =>
                  void handleRemoveSessionRelatedFile(
                    currentRootId,
                    drawerSessionSnapshot?.key || drawerSessionSnapshot?.session_key,
                    path,
                    head,
                    repoPath,
                    repoKind,
                  )
                }
                onAskUserAnswer={handleAskUserAnswer}
                onEditUserMessage={handleEditUserMessage}
                onForkAgentMessage={(seq) =>
                  void handleForkAgentMessage(
                    currentRootId,
                    drawerSessionSnapshot?.key || drawerSessionSnapshot?.session_key,
                    seq,
                  )
                }
              />
            ) : (
              <div style={{ padding: "40px", textAlign: "center" }}>
                {t("task.startHint")}
              </div>
            )}
          </BottomSheet>
        }
      />
      {!isMobile ? <OnboardingTour
        open={onboardingOpen}
        isMobile={isMobile}
        onStepChange={handleOnboardingStepChange}
        onComplete={() => {
          completeOnboarding();
          setOnboardingOpen(false);
          if (isMobile) {
            setIsLeftOpen(false);
            setIsRightOpen(false);
          }
        }}
        onDismiss={() => {
          dismissOnboarding();
          setOnboardingOpen(false);
          if (isMobile) {
            setIsLeftOpen(false);
            setIsRightOpen(false);
          }
        }}
      /> : null}
      {bootstrapState.phase === "needs_pairing" &&
        e2eeState.required &&
        !e2eeState.unlocked ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.46)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "24px",
            zIndex: 2000,
          }}
        >
          <div
            style={{
              width: "min(460px, 100%)",
              background: "#fff",
              borderRadius: "20px",
              padding: "24px",
              boxShadow: "0 28px 80px rgba(15, 23, 42, 0.22)",
              display: "flex",
              flexDirection: "column",
              gap: "14px",
            }}
	          >
	            <div style={{ fontSize: "20px", fontWeight: 700, color: "#0f172a" }}>
	              {t("e2ee.title")}
	            </div>
	            <input
	              type="text"
              value={e2eeSecretInput}
              onChange={(event) => {
                setE2eeSecretInput(event.target.value);
                if (e2eePromptError) {
                  setE2eePromptError("");
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !e2eePromptBusy) {
                  void submitE2EESecret();
                }
              }}
	              placeholder={t("e2ee.placeholder")}
              autoFocus
              spellCheck={false}
              style={{
                width: "100%",
                borderRadius: "14px",
                border: "1px solid rgba(148, 163, 184, 0.4)",
                padding: "14px 16px",
                fontSize: "14px",
                outline: "none",
              }}
            />
            {e2eePromptError ? (
              <div style={{ color: "#dc2626", fontSize: "13px" }}>
                {e2eePromptError}
              </div>
            ) : null}
            <div style={{ display: "flex", justifyContent: "space-between", gap: "12px" }}>
              <button
                type="button"
                onClick={() => {
                  setE2eeSecretInput("");
                  setE2eePromptError("");
                }}
                style={{
                  border: "none",
                  background: "transparent",
                  color: "#64748b",
                  padding: 0,
                  cursor: "pointer",
                }}
              >
                {t("e2ee.clear")}
              </button>
              <button
                type="button"
                onClick={() => void submitE2EESecret()}
                disabled={e2eePromptBusy}
                style={{
                  border: "none",
                  borderRadius: "999px",
                  background: e2eePromptBusy ? "#94a3b8" : "#0f172a",
                  color: "#fff",
                  padding: "10px 18px",
                  cursor: e2eePromptBusy ? "not-allowed" : "pointer",
                  fontWeight: 600,
                }}
              >
                {e2eePromptBusy ? t("e2ee.verifying") : t("e2ee.continue")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {taskInlineEdit ? (
	        (() => {
	          const taskInlineCanCreateWorktree = managedRootByIdRef.current[currentRootId || ""]?.is_git_repo === true;
	          const showTaskWorktreeControls = taskInlineCanCreateWorktree && (taskInlineEdit.canToggleWorktree || taskInlineEdit.taskId);
	          const taskWorktreeControlsEditable = taskInlineEdit.canToggleWorktree;
	          return (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 95,
            background: "rgba(15, 23, 42, 0.36)",
            display: "flex",
            alignItems: isMobile ? "flex-start" : "center",
            justifyContent: "center",
            padding: isMobile ? "38px 12px 12px" : "24px",
          }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !taskInlineSaving) {
              closeTaskEditDialog();
            }
          }}
        >
          <section
            style={{
              width: isMobile ? "100%" : "min(640px, 100%)",
              maxHeight: isMobile ? "70dvh" : "82vh",
              borderRadius: "10px",
              border: "1px solid var(--border-color)",
              background: "var(--menu-bg)",
              boxShadow: "0 24px 60px rgba(15, 23, 42, 0.24)",
              display: "flex",
              flexDirection: "column",
              overflow: "visible",
            }}
          >
            <div
              style={{
                minHeight: "42px",
                padding: "8px 12px",
                borderBottom: "1px solid var(--border-color)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "10px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "8px", minWidth: 0 }}>
                <div style={{ fontSize: "13px", fontWeight: 800, color: "var(--text-color)", whiteSpace: "nowrap" }}>
                  {t(taskInlineEdit.taskId ? "task.editDialogTitle" : "task.createDialogTitle", {
                    name: taskInlineEdit.templateName || t("task.defaultTitle"),
                  })}
                </div>
	                {showTaskWorktreeControls ? (
	                  <>
	                    <button
	                      type="button"
	                      onClick={() => {
	                        if (!taskWorktreeControlsEditable) return;
	                        setTaskInlineEdit((prev) => prev ? { ...prev, createWorktree: !prev.createWorktree } : prev);
	                      }}
	                      disabled={taskInlineSaving || !taskWorktreeControlsEditable}
                      aria-label={taskInlineEdit.createWorktree ? t("task.worktreeTitle") : t("task.noWorktreeTitle")}
                      title={taskInlineEdit.createWorktree ? t("task.worktreeTitle") : t("task.noWorktreeTitle")}
                      style={{
                        height: "26px",
                        borderRadius: "6px",
                        border: taskInlineEdit.createWorktree ? "1px solid rgba(22, 163, 74, 0.28)" : "1px solid var(--border-color)",
                        background: taskInlineEdit.createWorktree ? "rgba(22, 163, 74, 0.08)" : "rgba(100, 116, 139, 0.10)",
                        color: taskInlineEdit.createWorktree ? "#15803d" : "var(--text-secondary)",
                        padding: taskInlineEdit.createWorktree ? "0 8px" : "0 8px 0 5px",
                        fontSize: "12px",
                        fontWeight: 800,
	                        cursor: taskInlineSaving || !taskWorktreeControlsEditable ? "not-allowed" : "pointer",
	                        whiteSpace: "nowrap",
	                        opacity: taskInlineSaving || !taskWorktreeControlsEditable ? 0.72 : 1,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: "3px",
                      }}
                    >
                      {taskInlineEdit.createWorktree ? "worktree" : (
                        <>
                          <NoWorktreeIcon size={12} />
                          worktree
                        </>
                      )}
                    </button>
                    {taskInlineEdit.createWorktree ? (
                      <div style={{ display: "flex", alignItems: "center", gap: "6px", minWidth: 0 }}>
	                        <WorktreeBranchSelector
	                          branchMode={taskInlineEdit.worktreeBranchMode}
	                          branch={taskInlineEdit.worktreeBranch}
	                          branches={taskWorktreeBranches.branches}
                          disabled={taskInlineSaving || !taskWorktreeControlsEditable}
                          height={26}
                          maxWidth={isMobile ? 160 : 240}
                          menuAlign={isMobile ? "left" : "right"}
                          menuPlacement="bottom"
                          onChange={(nextMode, nextBranch) => {
                            setTaskInlineEdit((prev) => {
                              if (!prev) return prev;
                              return { ...prev, worktreeBranchMode: nextMode, worktreeBranch: nextBranch };
                            });
                          }}
                        />
                        {taskWorktreeBranchesLoading ? (
                          <span style={{ fontSize: "11px", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>{t("common.loading")}</span>
                        ) : taskWorktreeBranchError ? (
                          <span title={taskWorktreeBranchError} style={{ fontSize: "11px", color: "#b45309", whiteSpace: "nowrap" }}>{t("common.loadingFailed")}</span>
                        ) : null}
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            </div>
            <div style={{ padding: "12px", overflow: "visible", position: "relative", minHeight: 0, display: "flex", flexDirection: "column" }}>
              {taskInlineActiveToken && taskInlineCandidates.length > 0 ? (
                <div
                  style={{
                    position: "absolute",
                    left: "12px",
                    right: "12px",
                    bottom: "calc(100% + 6px)",
                    maxHeight: isMobile ? "min(42vh, 260px)" : "260px",
                    overflowY: "auto",
                    border: "1px solid var(--menu-border)",
                    borderRadius: "8px",
                    background: "var(--menu-bg)",
                    boxShadow: "0 12px 28px rgba(15, 23, 42, 0.14)",
                    zIndex: 2,
                  }}
                >
                  {taskInlineCandidates.map((candidate, index) => (
                    <button
                      key={`${candidate.type}:${candidate.name}`}
                      ref={(node) => {
                        taskInlineCandidateItemRefs.current[index] = node;
                      }}
                      type="button"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        applyTaskInlineCandidate(candidate);
                      }}
                      style={{
                        width: "100%",
                        border: "none",
                        borderTop: index === 0 ? "none" : "1px solid var(--menu-divider)",
                        background: index === taskInlineCandidateIndex ? "var(--menu-active-bg)" : "transparent",
                        color: "var(--text-primary)",
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "flex-start",
                        gap: "2px",
                        padding: "9px 10px",
                        textAlign: "left",
                        cursor: "pointer",
                      }}
                      onMouseEnter={() => setTaskInlineCandidateIndex(index)}
                    >
                      <span style={{ fontSize: "13px", fontWeight: 700 }}>
                        {candidate.type === "file" ? `@${candidate.name}` : candidate.type === "prompt" ? `#${candidate.name}` : candidate.type === "slash_command" ? `/${candidate.name}` : candidate.name}
                      </span>
                      {candidate.description ? (
                        <span style={{ fontSize: "11px", color: "var(--text-secondary)" }}>{candidate.description}</span>
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : null}
              {taskInlineEdit.previousInputs.length > 0 ? (
                <div
                  style={{
                    marginBottom: "10px",
                    display: "flex",
                    flexDirection: "column",
                    gap: "8px",
                    maxHeight: isMobile ? "18dvh" : "180px",
                    overflowY: "auto",
                  }}
                >
                  {taskInlineEdit.previousInputs.map((item) => (
                    <div
                      key={item.id}
                      style={{
                        border: "1px solid var(--border-color)",
                        borderRadius: "8px",
                        background: "rgba(100, 116, 139, 0.08)",
                        padding: "8px 9px",
                      }}
                    >
                      <div
                        style={{
                          marginBottom: "5px",
                          fontSize: "11px",
                          fontWeight: 800,
                          color: "var(--text-secondary)",
                        }}
                      >
                        {item.label}
                      </div>
                      <div
                        style={{
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          fontSize: "12px",
                          lineHeight: 1.45,
                          color: "var(--text-color)",
                        }}
                      >
                        <InlineTokenText content={item.input} />
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
              <div style={{ position: "relative" }}>
                <div
                  style={{
                    position: "relative",
                    height: "112px",
                    border: "1px solid var(--border-color)",
                    borderRadius: "8px",
                    background: "var(--input-bg)",
                    overflow: "auto",
                  }}
                >
                  <TokenEditor
                    ref={taskInlineEditorRef}
                    placeholder={t("task.editPlaceholder")}
                    disabled={taskInlineSaving}
                    isDark={false}
                    rightInset={42}
                    topInset={0}
                    bottomInset={12}
                    fillHeight
                    onChange={(payload) => {
                      setTaskInlineEdit((prev) => prev ? { ...prev, text: payload.serializedText } : prev);
                      setTaskInlineActiveToken(payload.activeToken);
                    }}
                    onFocusChange={(focused) => {
                      if (!focused) {
                        setTaskInlineActiveToken(null);
                        setTaskInlineCandidates([]);
                        setTaskInlineCandidateIndex(0);
                      }
                    }}
                    onPaste={handleTaskInlinePaste}
                    onKeyDown={handleTaskInlineEditorKeyDown}
                    onEnter={handleTaskInlineEditorEnter}
                  />
                </div>
                <button
                  type="button"
                  title={t("task.addAttachment")}
                  aria-label={t("task.addAttachment")}
	                  disabled={taskInlineSaving}
	                  onClick={() => {
	                    taskInlineAttachmentInputRef.current?.click();
	                  }}
                  style={{
                    position: "absolute",
                    right: "6px",
                    bottom: "6px",
                    zIndex: 3,
                    width: "28px",
                    height: "28px",
                    border: "none",
                    borderRadius: "8px",
                    background: "var(--button-bg)",
                    color: "var(--text-secondary)",
                    cursor: taskInlineSaving ? "not-allowed" : "pointer",
                    opacity: taskInlineSaving ? 0.55 : 1,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: 0,
                  }}
                >
                  <PlusSmallIcon />
                </button>
              </div>
              {taskInlineEdit.attachments.length > 0 || taskInlineUploadProgress ? (
                <div style={{ marginTop: "10px", display: "flex", flexWrap: "wrap", gap: "8px" }}>
                  {taskInlineEdit.attachments.map((attachment) => attachment.isImage && attachment.previewUrl ? (
                    <div
                      key={attachment.id}
                      style={{
                        width: "54px",
                        height: "54px",
                        borderRadius: "8px",
                        border: "1px solid var(--border-color)",
                        background: "rgba(100, 116, 139, 0.10)",
                        position: "relative",
                        overflow: "hidden",
                      }}
                    >
                      <img src={attachment.previewUrl} alt={attachment.file.name} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                      <button
                        type="button"
                        onClick={() => removeTaskInlineAttachment(attachment.id)}
                        disabled={taskInlineSaving}
                        aria-label={t("task.removeAttachment", { name: attachment.file.name })}
                        style={{
                          position: "absolute",
                          top: "2px",
                          right: "2px",
                          width: "18px",
                          height: "18px",
                          border: "none",
                          borderRadius: "999px",
                          background: "rgba(15, 23, 42, 0.72)",
                          color: "#fff",
                          cursor: taskInlineSaving ? "not-allowed" : "pointer",
                          padding: 0,
                          lineHeight: "18px",
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ) : (
                    <span
                      key={attachment.id}
                      style={{
                        maxWidth: "100%",
                        border: "1px solid var(--border-color)",
                        borderRadius: "999px",
                        background: "rgba(100, 116, 139, 0.10)",
                        color: "var(--text-color)",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px",
                        padding: "4px 7px",
                        fontSize: "12px",
                      }}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{attachment.file.name}</span>
                      <button
                        type="button"
                        onClick={() => removeTaskInlineAttachment(attachment.id)}
                        disabled={taskInlineSaving}
                        style={{
                          border: "none",
                          background: "transparent",
                          color: "var(--text-secondary)",
                          cursor: taskInlineSaving ? "not-allowed" : "pointer",
                          padding: 0,
                        }}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <CompactUploadProgress
                    progress={taskInlineUploadProgress}
                    label={t("upload.attachmentsProgress")}
                    statusLabel={t("upload.inProgress")}
                    cancelLabel={t("upload.cancel")}
                    onCancel={() => taskInlineUploadAbortRef.current?.abort()}
                  />
                </div>
              ) : null}
              <input
                ref={taskInlineAttachmentInputRef}
                type="file"
                multiple
                style={{ display: "none" }}
                onChange={handleTaskInlineAttachmentChange}
              />
            </div>
            <div
              style={{
                padding: "10px 12px",
                borderTop: "1px solid var(--border-color)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "8px",
              }}
            >
              <span />
              <div style={{ display: "flex", gap: "8px" }}>
                <button
                  type="button"
                  onClick={closeTaskEditDialog}
                  disabled={taskInlineSaving}
                  style={{ height: "30px", borderRadius: "6px", border: "1px solid var(--border-color)", background: "transparent", color: "var(--text-color)", padding: "0 12px", cursor: taskInlineSaving ? "not-allowed" : "pointer" }}
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  onClick={() => void saveTaskInlineEdit()}
                  disabled={taskInlineSaving}
                  style={{ height: "30px", borderRadius: "6px", border: "1px solid var(--accent-color)", background: "var(--accent-color)", color: "#fff", padding: "0 14px", fontWeight: 800, cursor: taskInlineSaving ? "not-allowed" : "pointer", opacity: taskInlineSaving ? 0.7 : 1 }}
                >
                  {taskInlineSaving ? t("common.saving") : t("common.save")}
                </button>
              </div>
            </div>
          </section>
        </div>
          );
        })()
      ) : null}
      {taskSessionErrorDialog ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 96,
            background: "rgba(15, 23, 42, 0.28)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "24px",
          }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setTaskSessionErrorDialog(null);
            }
          }}
        >
          <section
            style={{
              width: "min(460px, 100%)",
              borderRadius: "10px",
              border: "1px solid rgba(217, 119, 6, 0.22)",
              background: "var(--menu-bg)",
              boxShadow: "0 24px 60px rgba(15, 23, 42, 0.24)",
              overflow: "hidden",
            }}
          >
            <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border-color)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
              <div style={{ minWidth: 0, fontSize: "13px", fontWeight: 800, color: "var(--text-color)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {taskSessionErrorDialog.title}
              </div>
              <button type="button" aria-label={t("task.closeErrorInfo")} onClick={() => setTaskSessionErrorDialog(null)} style={taskCardIconButtonStyle()}>
                ×
              </button>
            </div>
            <div style={{ padding: "14px", display: "flex", flexDirection: "column", gap: "10px" }}>
              <div
                style={{
                  padding: "10px 12px",
                  borderRadius: "8px",
                  background: "rgba(217, 119, 6, 0.08)",
                  border: "1px solid rgba(217, 119, 6, 0.18)",
                  color: "var(--text-color)",
                  fontSize: "12px",
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                }}
              >
                {taskSessionErrorDialog.message}
              </div>
              {taskSessionErrorDialog.details.map((detail) => (
                <div
                  key={detail}
                  style={{
                    padding: "10px 12px",
                    borderRadius: "8px",
                    background: "rgba(100, 116, 139, 0.08)",
                    border: "1px solid var(--border-color)",
                    color: "var(--text-secondary)",
                    fontSize: "12px",
                    lineHeight: 1.5,
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                  }}
                >
                  {detail}
                </div>
              ))}
            </div>
          </section>
        </div>
      ) : null}
      <ScheduledAgentTaskDialog
        open={scheduledAgentDialogOpen}
        rootId={currentRootId}
        agents={availableAgents}
        onClose={() => setScheduledAgentDialogOpen(false)}
      />
      <TaskTemplateDialog
        open={taskTemplateDialogOpen}
        agents={availableAgents}
        template={taskTemplateDialogTemplate}
        onClose={() => setTaskTemplateDialogOpen(false)}
        onSaved={handleTaskTemplateSaved}
      />
      <ToastContainer />
    </>
  );
}

function ImportIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="m14 12l-4-4v3H2v2h8v3m10 2V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v3h2V6h12v12H6v-3H4v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2" />
    </svg>
  );
}

function EditPencilIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 20h4.2L18.7 9.5a2.1 2.1 0 0 0 0-3L17.5 5.3a2.1 2.1 0 0 0-3 0L4 15.8V20Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m13.5 6.3 4.2 4.2"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function HorizontalDotsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

function PlusSmallIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function CheckIconSmall() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m5 12 4 4L19 6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TaskCompleteIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M0 0h16v16H0z" fill="none" />
      <path fill="currentColor" fillRule="evenodd" d="M3 13.5a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5h9.25a.75.75 0 0 0 0-1.5H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9.75a.75.75 0 0 0-1.5 0V13a.5.5 0 0 1-.5.5zm12.78-8.82a.75.75 0 0 0-1.06-1.06L9.162 9.177 7.289 7.241a.75.75 0 1 0-1.078 1.043l2.403 2.484a.75.75 0 0 0 1.07.01z" clipRule="evenodd" />
    </svg>
  );
}

function TaskQueuedSpinnerIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      aria-hidden="true"
      style={{ animation: "mindfs-update-spin 0.9s linear infinite" }}
    >
      <path d="M21 12a9 9 0 1 1-6.2-8.56" />
    </svg>
  );
}

function TaskRunNowIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{ display: "block", transform: "translateX(-1px) scale(1.06)", transformOrigin: "center" }}
    >
      <path d="M0 0h24v24H0z" fill="none" />
      <path
        fill="currentColor"
        d="M14.5 4h.005M14.5 4L12 10l5 2.898L9.5 20l2.5-6l-5-2.9zm0-2a2.02 2.02 0 0 0-1.379.551L5.624 9.646a2 2 0 0 0-.61 1.686c.072.626.437 1.182.982 1.498l3.482 2.021l-1.826 4.381a2.003 2.003 0 0 0 1.847 2.77c.498 0 .993-.186 1.375-.548l7.5-7.103a2 2 0 0 0 .61-1.685a2 2 0 0 0-.982-1.498L14.52 9.15l1.789-4.293A2 2 0 0 0 14.5 2"
      />
    </svg>
  );
}

function TaskSessionErrorIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v6" />
      <path d="M12 17h.01" />
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

function taskTemplateMenuItemStyle(disabled = false): React.CSSProperties {
  return {
    width: "100%",
    minHeight: "30px",
    border: "none",
    borderRadius: "8px",
    background: "transparent",
    color: "var(--text-primary)",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 8px",
    textAlign: "left",
    fontSize: "12px",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.45 : 1,
    boxSizing: "border-box",
  };
}

function taskCardIconButtonStyle(tone: "default" | "accent" | "success" | "danger" | "warning" = "default"): React.CSSProperties {
  return {
    width: "22px",
    height: "22px",
    border: "none",
    borderRadius: "6px",
    background: "transparent",
    color: tone === "accent" ? "var(--accent-color)" : tone === "success" ? "#16a34a" : tone === "danger" ? "#dc2626" : tone === "warning" ? "#d97706" : "var(--text-secondary)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    padding: 0,
  };
}

function taskAuxBadgeStyle(attention = false): React.CSSProperties {
  return {
    width: "18px",
    height: "18px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "5px",
    background: attention ? "rgba(239, 68, 68, 0.10)" : "transparent",
    color: "var(--text-secondary)",
    animation: attention ? "mindfs-task-ask-user-pulse 2.2s ease-in-out infinite" : "none",
  };
}

function taskWorktreeTagStyle(enabled: boolean): React.CSSProperties {
  return {
    flex: "0 0 auto",
    marginLeft: "auto",
    display: "inline-flex",
    alignItems: "center",
    gap: "1px",
    border: enabled ? "1px solid rgba(22, 163, 74, 0.28)" : "1px solid rgba(217, 119, 6, 0.28)",
    borderRadius: "4px",
    background: enabled ? "rgba(22, 163, 74, 0.08)" : "rgba(217, 119, 6, 0.08)",
    color: enabled ? "#15803d" : "#b45309",
    fontSize: "9px",
    fontWeight: 800,
    lineHeight: "12px",
    padding: enabled ? "0 4px" : "0 3px 0 2px",
  };
}

function taskReplyPulseStyle(): React.CSSProperties {
  return {
    position: "absolute",
    top: "6px",
    right: "6px",
    width: "8px",
    height: "8px",
    borderRadius: "999px",
    boxSizing: "border-box",
    border: "1.5px solid #2563eb",
    background: "#2563eb",
    animation: "mindfs-bound-pulse 2.2s ease-in-out infinite",
    boxShadow: "0 0 0 1.5px rgba(37,99,235,0.14)",
    pointerEvents: "none",
  };
}

function TaskPlanAuxIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M7 6h10M7 12h10M7 18h6" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" />
      <path d="M4 6h.01M4 12h.01M4 18h.01" stroke="#2563eb" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function TaskExpandIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="13"
      height="13"
      viewBox="0 0 16 16"
      aria-hidden="true"
      style={{
        display: "block",
        transform: collapsed ? "none" : "rotate(180deg)",
      }}
    >
      <path d="M0 0h16v16H0z" fill="none" />
      <path fill="currentColor" d="M12.146 7.146a.5.5 0 0 1 .708.708l-4.5 4.5a.5.5 0 0 1-.708 0l-4.5-4.5a.5.5 0 1 1 .708-.708L8 11.293zm0-4a.5.5 0 0 1 .708.708l-4.5 4.5a.5.5 0 0 1-.708 0l-4.5-4.5a.5.5 0 1 1 .708-.708L8 7.293z" />
    </svg>
  );
}

function TaskGroupChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        flexShrink: 0,
        transform: collapsed ? "rotate(0deg)" : "rotate(90deg)",
        transition: "transform 0.2s",
        color: "currentColor",
        display: "inline-flex",
        alignItems: "center",
      }}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </span>
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

function SyncIcon({ style }: { style?: React.CSSProperties }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={style}
    >
      <path
        fill="currentColor"
        d="M19.91 15.51h-4.53a1 1 0 0 0 0 2h2.4A8 8 0 0 1 4 12a1 1 0 0 0-2 0a10 10 0 0 0 16.88 7.23V21a1 1 0 0 0 2 0v-4.5a1 1 0 0 0-.97-.99M12 2a10 10 0 0 0-6.88 2.77V3a1 1 0 0 0-2 0v4.5a1 1 0 0 0 1 1h4.5a1 1 0 0 0 0-2h-2.4A8 8 0 0 1 20 12a1 1 0 0 0 2 0A10 10 0 0 0 12 2"
      />
    </svg>
  );
}

function ChevronDownSmallIcon() {
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
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

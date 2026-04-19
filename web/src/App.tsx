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
  deleteCachedSession,
  getCachedSession,
  sessionService,
  setCachedSessionRelatedFiles,
  syncSession,
  type SyncSessionResult,
  type RelatedFile,
  type Session,
} from "./services/session";
import { buildClientContext } from "./services/context";
import { reportError } from "./services/error";
import {
  fetchFile,
  getCachedFile,
  invalidateFileCache,
  type FilePayload,
} from "./services/file";
import {
  buildGitDiffCacheSignature,
  fetchGitDiff,
  fetchGitStatus,
  type GitDiffPayload,
  type GitStatusItem,
  type GitStatusPayload,
} from "./services/git";
import {
  DEFAULT_DIRECTORY_SORT_MODE,
  type DirectorySortMode,
  type FileEntry,
} from "./services/directorySort";
import { uploadFiles } from "./services/upload";
import {
  PluginManager,
  loadAllPlugins,
  type PluginInput,
} from "./plugins/manager";
import { appPath, appURL, isRelayNodePage } from "./services/base";
import { triggerUpdate, type UpdateState } from "./services/update";

// 直接导入标准组件
import { AppShell } from "./layout/AppShell";
import { FileTree } from "./components/FileTree";
import { FileViewer } from "./components/FileViewer";
import { GitDiffViewer } from "./components/GitDiffViewer";
import { GitStatusPanel } from "./components/GitStatusPanel";
import { SessionViewer } from "./components/SessionViewer";
import { DefaultListView } from "./components/DefaultListView";
import { SessionList } from "./components/SessionList";
import { ExternalSessionList } from "./components/ExternalSessionList";
import { AgentIcon } from "./components/AgentIcon";
import { ActionBar } from "./components/ActionBar";
import { BottomSheet } from "./components/BottomSheet";
import {
  type GitHubImportState,
  type LocalDirBrowserState,
  ProjectAddPopover,
  type ProjectAddMode,
} from "./components/ProjectAddPopover";
import { fetchAgents, type AgentStatus } from "./services/agents";

// 类型定义
type SessionMode = "chat" | "plugin";
export type SessionItem = {
  key?: string;
  session_key?: string;
  root_id?: string;
  name?: string;
  type?: SessionMode;
  agent?: string;
  model?: string;
  mode?: string;
  effort?: string;
  scope?: string;
  purpose?: string;
  created_at?: string;
  updated_at?: string;
  closed_at?: string;
  search_seq?: number;
  search_snippet?: string;
  search_match_type?: "name" | "user" | "reply";
  related_files?: RelatedFile[];
  exchanges?: Array<{
    role?: string;
    content?: string;
    timestamp?: string;
    model?: string;
    mode?: string;
    effort?: string;
  }>;
  pending?: boolean;
};

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
    type:
      session?.type === "plugin" || session?.type === "chat"
        ? session.type
        : "chat",
    agent: typeof session?.agent === "string" ? session.agent : "",
    model: typeof session?.model === "string" ? session.model : "",
    mode: typeof session?.mode === "string" ? session.mode : "",
    effort: typeof session?.effort === "string" ? session.effort : "",
    scope: typeof session?.scope === "string" ? session.scope : "",
    purpose: typeof session?.purpose === "string" ? session.purpose : "",
    created_at:
      typeof session?.created_at === "string" ? session.created_at : undefined,
    updated_at:
      typeof session?.updated_at === "string" ? session.updated_at : undefined,
    closed_at:
      typeof session?.closed_at === "string" ? session.closed_at : undefined,
    search_seq:
      typeof session?.search_seq === "number" ? session.search_seq : undefined,
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
    pending: typeof session?.pending === "boolean" ? session.pending : undefined,
  };
}
type Exchange = {
  role: string;
  agent?: string;
  model?: string;
  mode?: string;
  effort?: string;
  content?: string;
  timestamp?: string;
  toolCall?: any;
  pending_ack?: boolean;
};
type PendingSend = {
  rootId: string;
  mode: SessionMode;
  agent: string;
  model?: string;
  agentMode?: string;
  effort?: string;
  message: string;
  timestamp: string;
  requestId?: string;
  sessionKey?: string;
  tempKey?: string;
};
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
  items?: LocalDirItemPayload[];
};
type RelayStatusPayload = {
  relay_bound?: boolean;
  no_relayer?: boolean;
  pending_code?: string;
  node_name?: string;
  node_id?: string;
  relay_base_url?: string;
  node_url?: string;
  last_error?: string;
};
const RELAY_LAST_NODE_ID_STORAGE_KEY = "mindfs.relay.last_node_id";
const PLUGIN_QUERY_STORAGE_PREFIX = "vp-progress:";
const TREE_SORT_STORAGE_KEY = "mindfs-tree-sort-mode";
const DIRECTORY_SORT_OVERRIDES_STORAGE_KEY = "mindfs-directory-sort-overrides";
const FILE_SCROLL_STORAGE_KEY = "mindfs-file-scroll-positions";
const LAST_ROOT_STORAGE_KEY = "mindfs-last-root-id";
const READ_FILE_TOKEN_PATTERN = /\[read file:\s*[^\]]+\]/i;

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

function updateButtonLabel(state: UpdateState): string {
  const status = (state.status || "idle").toLowerCase();
  switch (status) {
    case "available":
      if (state.current_version && state.latest_version) {
        return `更新 ${state.current_version} → ${state.latest_version}`;
      }
      return state.latest_version ? `更新到 ${state.latest_version}` : "新版本";
    case "downloading":
      return "下载中...";
    case "installing":
      return "安装中...";
    case "restarting":
      return "重启中...";
    case "failed":
      return "更新失败";
    default:
      return "已是最新";
  }
}

function updateSummaryText(state: UpdateState): string {
  const body = String(state.release_body || "").trim();
  if (body) {
    return body;
  }
  const name = String(state.release_name || "").trim();
  if (name) {
    return name;
  }
  if (state.latest_version) {
    return `发现 v${state.latest_version} 新版本`;
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

function trimGitPathPrefix(path: string, prefix: string): string {
  const normalizedPath = String(path || "").replace(/^\/+|\/+$/g, "");
  const normalizedPrefix = String(prefix || "").replace(/^\/+|\/+$/g, "");
  if (!normalizedPrefix) {
    return normalizedPath;
  }
  if (normalizedPath === normalizedPrefix) {
    return ".";
  }
  const matchPrefix = `${normalizedPrefix}/`;
  if (normalizedPath.startsWith(matchPrefix)) {
    return normalizedPath.slice(matchPrefix.length);
  }
  return normalizedPath;
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

function hasExplicitFileContext(message: string): boolean {
  return READ_FILE_TOKEN_PATTERN.test(message);
}

// Hook for responsive detection
function useResponsive() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const checkSize = () => {
      const width = window.innerWidth;
      setIsMobile(width < 768);
    };
    checkSize();
    window.addEventListener("resize", checkSize);
    return () => window.removeEventListener("resize", checkSize);
  }, []);
  return { isMobile };
}

export function App() {
  const pluginManagerRef = useRef<PluginManager>(new PluginManager());
  const completionAudioContextRef = useRef<AudioContext | null>(null);
  const completionAudioUnlockedRef = useRef(false);
  const managedRootIdsRef = useRef<Set<string>>(new Set());
  const expandedRef = useRef<string[]>([]);
  const selectedDirRef = useRef<string | null>(null);
  const fileRef = useRef<FilePayload | null>(null);
  const selectedSessionRef = useRef<SessionItem | null>(null);
  const currentSessionRef = useRef<SessionItem | null>(null);
  const interactionModeRef = useRef<"main" | "drawer">("main");
  const pendingDraftRef = useRef<PendingSend | null>(null);
  const pendingBySessionRef = useRef<Record<string, PendingSend>>({});
  const pendingRequestRef = useRef<Record<string, PendingSend>>({});
  const cancelRequestedBySessionRef = useRef<Record<string, boolean>>({});
  const sessionCacheRef = useRef<Record<string, Session>>({});
  const loadedSessionRef = useRef<Record<string, boolean>>({});
  const loadingSessionRef = useRef<Record<string, Promise<SyncSessionResult>>>({});
  const invalidTreeCacheKeysRef = useRef<Set<string>>(new Set());
  const boundSessionByRootRef = useRef<Record<string, string | null>>({});
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
  const viewerSelectionRef = useRef<ViewerSelection | null>(null);
  const lastViewerSelectionRef = useRef<ViewerSelection | null>(null);
  const dismissedSelectionFileRef = useRef<string | null>(null);
  const lastPluginResetFileKeyRef = useRef<string>("");
  const pluginBypassRef = useRef<boolean>(false);
  const fileOpenRequestRef = useRef(0);
  const fullUpgradeAttemptRef = useRef("");
  const pluginsLoadedByRootRef = useRef<Record<string, boolean>>({});
  const pluginsLoadingByRootRef = useRef<Record<string, Promise<void>>>({});
  const didInitRef = useRef(false);
  const handleSelectSessionRef = useRef<
    ((session: any) => Promise<void>) | null
  >(null);

  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const sessionsRef = useRef<SessionItem[]>([]);
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [sessionSearchResultsMode, setSessionSearchResultsMode] = useState(false);
  const [sessionSearchQuery, setSessionSearchQuery] = useState("");
  const [sessionSearchAppliedQuery, setSessionSearchAppliedQuery] = useState("");
  const [sessionSearchResults, setSessionSearchResults] = useState<SessionItem[]>([]);
  const [sessionSearchLoading, setSessionSearchLoading] = useState(false);
  const [hasMoreSessions, setHasMoreSessions] = useState(false);
  const [loadingOlderSessions, setLoadingOlderSessions] = useState(false);
  const [sessionListMode, setSessionListMode] = useState<"local" | "import">(
    "local",
  );
  const [externalSessions, setExternalSessions] = useState<SessionItem[]>([]);
  const externalSessionsRef = useRef<SessionItem[]>([]);
  const [hasMoreExternalSessions, setHasMoreExternalSessions] = useState(false);
  const [loadingOlderExternalSessions, setLoadingOlderExternalSessions] =
    useState(false);
  const [loadingExternalSessions, setLoadingExternalSessions] = useState(false);
  const [externalSelectedKey, setExternalSelectedKey] = useState("");
  const [externalImportAgent, setExternalImportAgent] = useState("");
  const [externalFilterBound, setExternalFilterBound] = useState(true);
  const [importingExternalSessionKey, setImportingExternalSessionKey] =
    useState("");
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const importMenuRef = useRef<HTMLDivElement | null>(null);
  const projectAddPopoverRef = useRef<HTMLDivElement | null>(null);
  const [availableAgents, setAvailableAgents] = useState<AgentStatus[]>([]);
  const [selectedSession, setSelectedSession] = useState<SessionItem | null>(
    null,
  );
  const [selectedSessionLoading, setSelectedSessionLoading] = useState(false);
  const [activeBoundSessionKey, setActiveBoundSessionKey] = useState<
    string | null
  >(null);
  const [currentSession, setCurrentSession] = useState<SessionItem | null>(null);
  const [cacheVersion, setCacheVersion] = useState(0);
  const [interactionMode, setInteractionMode] = useState<"main" | "drawer">(
    "main",
  );
  const [agentsVersion, setAgentsVersion] = useState(0);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const { isMobile } = useResponsive();
  const [isLeftOpen, setIsLeftOpen] = useState(() => window.innerWidth >= 768);
  const [isRightOpen, setIsRightOpen] = useState(
    () => window.innerWidth >= 768,
  );
  const [currentRootId, setCurrentRootId] = useState<string | null>(null);
  const currentRootIdRef = useRef<string | null>(null);
  const [managedRootIds, setManagedRootIds] = useState<string[]>([]);
  const managedRootByIdRef = useRef<Record<string, ManagedRootPayload>>({});
  const [rootEntries, setRootEntries] = useState<FileEntry[]>([]);
  const [creatingRootName, setCreatingRootName] = useState<string | null>(null);
  const [creatingRootParentPath, setCreatingRootParentPath] = useState<string | null>(null);
  const [creatingRootBusy, setCreatingRootBusy] = useState(false);
  const [projectAddMode, setProjectAddMode] = useState<ProjectAddMode | null>(
    null,
  );
  const [localDirState, setLocalDirState] = useState<LocalDirBrowserState>({
    path: "",
    parent: "",
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
  const [gitDiff, setGitDiff] = useState<GitDiffPayload | null>(null);
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
  const [status, setStatus] = useState("Disconnected");
  const [file, setFile] = useState<FilePayload | null>(null);
  const [viewerSelection, setViewerSelection] =
    useState<ViewerSelection | null>(null);
  const [attachedFileContext, setAttachedFileContext] =
    useState<AttachedFileContext | null>(null);
  const [pluginVersion, setPluginVersion] = useState(0);
  const [pluginLoading, setPluginLoading] = useState(false);
  const [pluginBypass, setPluginBypass] = useState(false);
  const [pluginQuery, setPluginQuery] = useState<Record<string, string>>(
    () => readURLState().pluginQuery,
  );
  const pluginQueryRef = useRef<Record<string, string>>(
    readURLState().pluginQuery,
  );
  const [showHiddenFiles, setShowHiddenFiles] = useState(false);
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
      setUpdateState(normalizeUpdateState(await triggerUpdate()));
    } catch (error) {
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
    fetchAgents(true)
      .then((items) => {
        if (cancelled) return;
        setAvailableAgents(items);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [agentsVersion]);
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
    sessionsRef.current = sessions;
  }, [sessions]);
  useEffect(() => {
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
    externalSessionsRef.current = externalSessions;
  }, [externalSessions]);
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
    window.localStorage.setItem(
      DIRECTORY_SORT_OVERRIDES_STORAGE_KEY,
      JSON.stringify(directorySortOverrides),
    );
  }, [directorySortOverrides]);
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
  const currentDirectorySortMode = currentDirectorySortOverride || treeSortMode;

  const replaceURLState = useCallback((next: URLState) => {
    const search = buildURLSearch(next);
    const target = `${window.location.pathname}${search}`;
    window.history.replaceState(null, "", target);
  }, []);

  const redirectToRelayLogin = useCallback(() => {
    const next = encodeURIComponent(
      `${window.location.pathname}${window.location.search}`,
    );
    window.location.replace(`/login?next=${next}`);
  }, []);

  const redirectToRelayNodes = useCallback(() => {
    window.location.replace("/nodes");
  }, []);

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
  const mergeSessionItems = useCallback(
    (current: SessionItem[], incoming: SessionItem[]) => {
      const byKey = new Map<string, SessionItem>();
      for (const item of current) {
        const key = item.key || item.session_key;
        if (key) {
          byKey.set(key, item);
        }
      }
      for (const item of incoming) {
        const key = item.key || item.session_key;
        if (!key) {
          continue;
        }
        byKey.set(key, { ...(byKey.get(key) || {}), ...item });
      }
      return Array.from(byKey.values()).sort((a, b) => {
        const left = Date.parse(a.updated_at || "") || 0;
        const right = Date.parse(b.updated_at || "") || 0;
        return right - left;
      });
    },
    [],
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

  const updateSessionAgentForKey = useCallback(
    (
      rootID: string,
      sessionKey: string,
      agent: string,
      model?: string,
      agentMode?: string,
      effort?: string,
    ) => {
      if (!rootID || !sessionKey || !agent) return;
      const cacheKey = rootSessionKey(rootID, sessionKey);
      const cached = sessionCacheRef.current[cacheKey];
      if (cached) {
        sessionCacheRef.current[cacheKey] = {
          ...(cached as any),
          agent,
          model: model || "",
          mode: agentMode || "",
          effort: effort || "",
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
        } as SessionItem;
      });
      const current = drawerSessionByRootRef.current[rootID];
      if (
        current &&
        current.key === sessionKey &&
        (current.agent !== agent ||
          (current as any).model !== (model || "") ||
          (current as any).mode !== (agentMode || "") ||
          (current as any).effort !== (effort || ""))
      ) {
        setDrawerSessionForRoot(rootID, {
          ...(current as any),
          agent,
          model: model || "",
          mode: agentMode || "",
          effort: effort || "",
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
        "新会话";
      const latestReal =
        realCached || pendingCached || fallback || drawer;
      let cacheChanged = false;

      if (pendingCached) {
        sessionCacheRef.current[realCacheKey] = {
          ...(pendingCached as any),
          ...(realCached as any),
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

  const resolveAgentForSession = useCallback(
    (rootID: string, sessionKey: string, fallbackAgent?: string): string => {
      if (fallbackAgent) return fallbackAgent;
      const cacheKey = rootSessionKey(rootID, sessionKey);
      const cached = sessionCacheRef.current[cacheKey] as any;
      if (cached?.agent) return cached.agent;
      const current = currentSessionRef.current as any;
      if (current?.key === sessionKey && current?.agent) return current.agent;
      const selected = selectedSessionRef.current as any;
      if (
        (selected?.key || selected?.session_key) === sessionKey &&
        selected?.agent
      )
        return selected.agent;
      return "";
    },
    [rootSessionKey],
  );

  const appendAgentChunkForSession = useCallback(
    (
      rootID: string,
      sessionKey: string,
      content: string,
      agentHint?: string,
    ) => {
      if (!content) return;
      const now = new Date().toISOString();
      const cacheKey = rootSessionKey(rootID, sessionKey);
      const resolvedAgent = resolveAgentForSession(
        rootID,
        sessionKey,
        agentHint,
      );
      const updateList = (prevList: Exchange[]) => {
        const list = [...(prevList || [])];
        const last = list.length > 0 ? list[list.length - 1] : null;
        if (last && (last.role === "agent" || last.role === "assistant")) {
          list[list.length - 1] = {
            ...last,
            agent: last.agent || resolvedAgent,
            content: `${last.content || ""}${content}`,
            timestamp: now,
          };
          return list;
        }
        list.push({
          role: "agent",
          agent: resolvedAgent,
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
          agent: resolvedAgent,
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
        agent: (base as any).agent || resolvedAgent,
        exchanges: nextList,
        updated_at: new Date().toISOString(),
      } as Session;
      bumpCacheVersion();
    },
    [rootSessionKey, resolveAgentForSession, bumpCacheVersion],
  );

  const appendThoughtChunkForSession = useCallback(
    (rootID: string, sessionKey: string, content: string) => {
      if (!content) return;
      const now = new Date().toISOString();
      const cacheKey = rootSessionKey(rootID, sessionKey);
      const updateList = (prevList: Exchange[]) => {
        const list = [...(prevList || [])];
        const last = list.length > 0 ? list[list.length - 1] : null;
        if (last && last.role === "thought") {
          list[list.length - 1] = {
            ...last,
            content: `${last.content || ""}${content}`,
            timestamp: now,
          };
          return list;
        }
        list.push({ role: "thought", content, timestamp: now });
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
        if (!incoming.kind && existing?.kind) merged.kind = existing.kind;
        if (!incoming.title && existing?.title) merged.title = existing.title;
        return merged;
      };
      const updateList = (prevList: Exchange[]) => {
        const list = [...(prevList || [])];
        const callId =
          toolCall.callId || toolCall.toolCallId || toolCall.tool_call_id || "";
        if (update && callId) {
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

  const normalizeTreeResponse = useCallback((payload: any) => {
    if (payload && payload.entries)
      return { entries: payload.entries as FileEntry[] };
    return { entries: [] };
  }, []);

  const formatDirectoryLoadError = useCallback((message?: string | null) => {
    const text = String(message || "").trim();
    if (!text) {
      return "无法读取这个目录。";
    }
    const lower = text.toLowerCase();
    if (
      lower.includes("access is denied") ||
      lower.includes("permission denied") ||
      lower.includes("operation not permitted") ||
      lower.includes("拒绝访问") ||
      lower.includes("权限")
    ) {
      return "当前进程没有权限读取这个目录或其中的部分系统项。";
    }
    return text;
  }, []);

  const treeCacheKey = useCallback(
    (rootID: string, dirPath: string) => `${rootID}:${dirPath || "."}`,
    [],
  );

  const refreshTreeDir = useCallback(
    async (rootID: string, dirPath: string, syncMain: boolean) => {
      try {
        const res = await fetch(
          appURL(
            "/api/tree",
            new URLSearchParams({ root: rootID, dir: dirPath }),
          ),
        );
        if (!res.ok) return;
        const payload = await res.json();
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
      setGitStatus(null);
      return null;
    }
    if (managedRootByIdRef.current[rootID]?.is_git_repo !== true) {
      const fallback = {
        available: false,
        dirty_count: 0,
        items: [],
      } as GitStatusPayload;
      setGitStatus(fallback);
      setGitStatusLoading(false);
      return fallback;
    }
    setGitStatusLoading(true);
    try {
      const next = await fetchGitStatus(rootID);
      setGitStatus(next);
      return next;
    } catch (err) {
      console.error("[git.status] failed", { rootID, err });
      const fallback = {
        available: false,
        dirty_count: 0,
        items: [],
      } as GitStatusPayload;
      setGitStatus(fallback);
      return fallback;
    } finally {
      setGitStatusLoading(false);
    }
  }, []);

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
        const next = (await sessionService.fetchSessions(rootID, {
          beforeTime: options?.beforeTime,
          afterTime: options?.afterTime,
        })) as SessionItem[];
        if (!options?.force && currentRootIdRef.current !== rootID) return;
        setHasMoreSessions(next.length >= 50);
        if (options?.replace || (!options?.beforeTime && !options?.afterTime)) {
          setSessions(next);
          return;
        }
        setSessions((prev) => mergeSessionItems(prev, next));
      } catch {}
    },
    [mergeSessionItems],
  );

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
    setSessionSearchLoading(true);
    void sessionService
      .searchSessions(currentRootId, sessionSearchAppliedQuery, 20)
      .then((hits) => {
        if (cancelled) return;
        const mapped = hits
          .map((hit) => {
            const item = toSessionItem(currentRootId, {
              ...hit,
              root_id: currentRootId,
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
  }, [currentRootId, sessionListMode, sessionSearchAppliedQuery, sessionSearchOpen]);

  const openGitDiff = useCallback(
    async (rootID: string, item: GitStatusItem) => {
      if (!rootID || !item?.path) {
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
        const next = await fetchGitDiff(rootID, item.path, {
          cacheSignature: buildGitDiffCacheSignature(item),
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

  const handleTreeUpload = useCallback(
    async (files: File[]) => {
      const rootID = currentRootIdRef.current;
      if (!rootID || files.length === 0) return;

      const selectedDirPath =
        selectedDirRef.current === rootID ? "." : selectedDirRef.current;
      const targetDir =
        selectedDirPath ||
        (fileRef.current?.path ? dirnameOfPath(fileRef.current.path) : ".");
      try {
        const uploaded = await uploadFiles({
          rootId: rootID,
          dir: targetDir,
          files,
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
        reportError(
          "file.write_failed",
          String((err as Error)?.message || "上传文件失败"),
        );
      }
    },
    [refreshTreeDir],
  );

  const handleSelectSession = useCallback(
    async (session: any) => {
      const key = session?.key || session?.session_key;
      const targetRoot =
        (session?.root_id as string | undefined) || currentRootIdRef.current;
      if (!targetRoot || !key) return;
      setMainViewPreferenceForRoot(targetRoot, "session");
      const currentDrawer = drawerSessionByRootRef.current[targetRoot];
      const preservePending =
        currentDrawer?.key === key
          ? !!(currentDrawer as any)?.pending
          : !!(session as any)?.pending;
      replaceURLState({
        root: targetRoot,
        file: "",
        session: key,
        cursor: 0,
        pluginQuery: {},
      });
      selectedSessionByRootRef.current[targetRoot] = key;
      setSelectedSessionLoading(true);
      setSelectedSession(
        toSessionItem(targetRoot, {
          ...(session as any),
          pending: preservePending,
        }),
      );
      setInteractionMode("main");
      setDrawerOpenForRoot(targetRoot, false);
      if (isMobile) setIsRightOpen(false);
      await waitForNextPaint();
      const cacheKey = rootSessionKey(targetRoot, key);
      const applySession = (fullSession: Session) => {
        const normalized = { ...(fullSession as any), key } as Session;
        sessionCacheRef.current[cacheKey] = normalized;
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
            pending:
              typeof (prev as any)?.pending === "boolean"
                ? !!(prev as any).pending
                : preservePending,
            key,
            session_key: key,
            root_id: targetRoot,
          });
        });
        if ((boundSessionByRootRef.current[targetRoot] || null) === key) {
          const activeDrawer = drawerSessionByRootRef.current[targetRoot];
          setDrawerSessionForRoot(targetRoot, {
            ...(normalized as any),
            pending:
              activeDrawer?.key === key
                ? !!(activeDrawer as any)?.pending
                : preservePending,
          } as Session);
        }
        setSelectedSessionLoading(false);
        bumpCacheVersion();
      };
      const cached = sessionCacheRef.current[cacheKey];
      if (cached) {
        applySession(cached);
        if (hasSessionExchanges(cached)) {
          if (loadedSessionRef.current[cacheKey]) {
            void sessionService.markSessionReady(targetRoot, key);
            return;
          }
        }
      } else {
        const persisted = await getCachedSession(targetRoot, key);
        if (persisted) {
          applySession(persisted);
        }
      }
      if (loadedSessionRef.current[cacheKey]) {
        void sessionService.markSessionReady(targetRoot, key);
        return;
      }
      try {
        const inflight = loadingSessionRef.current[cacheKey];
        if (inflight) {
          const syncResult = await inflight;
          const fullSession = syncResult?.session;
          if (fullSession) {
            applySession(fullSession);
          } else {
            setSelectedSessionLoading(false);
          }
          return;
        }
        const request = syncSession(targetRoot, key).finally(() => {
          delete loadingSessionRef.current[cacheKey];
        });
        loadingSessionRef.current[cacheKey] = request;
        const syncResult = await request;
        const fullSession = syncResult.session;
        if (fullSession) {
          applySession(fullSession as Session);
          loadedSessionRef.current[cacheKey] = true;
          void sessionService.markSessionReady(targetRoot, key);
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
      } else {
        const syncResult = await syncSession(resolvedRoot, preferredKey);
        if (syncResult.session) {
          initialSession = {
            ...(syncResult.session as any),
            key: preferredKey,
          } as Session;
          sessionCacheRef.current[cacheKey] = initialSession as Session;
          loadedSessionRef.current[cacheKey] = true;
          bumpCacheVersion();
        }
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
        reportError("session.delete_failed", "删除会话失败");
        return;
      }

      setSessions((prev) =>
        prev.filter((item) => (item.key || item.session_key) !== sessionKey),
      );

      const cacheKey = rootSessionKey(rootID, sessionKey);
      delete sessionCacheRef.current[cacheKey];
      delete loadedSessionRef.current[cacheKey];
      delete loadingSessionRef.current[cacheKey];
      delete pendingBySessionRef.current[cacheKey];
      delete cancelRequestedBySessionRef.current[cacheKey];
      void deleteCachedSession(rootID, sessionKey);

      if (boundSessionByRootRef.current[rootID] === sessionKey) {
        setBoundSessionForRoot(rootID, null);
      }
      if (selectedSessionByRootRef.current[rootID] === sessionKey) {
        selectedSessionByRootRef.current[rootID] = null;
      }
      if (drawerSessionByRootRef.current[rootID]?.key === sessionKey) {
        setDrawerSessionForRoot(rootID, null);
        setDrawerOpenForRoot(rootID, false);
      }

      const selectedKey =
        selectedSessionRef.current?.key ||
        selectedSessionRef.current?.session_key;
      const selectedRoot =
        (selectedSessionRef.current?.root_id as string | undefined) ||
        currentRootIdRef.current;
      if (selectedKey === sessionKey && selectedRoot === rootID) {
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
        reportError("session.rename_failed", "重命名会话失败");
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

      bumpCacheVersion();
      return true;
    },
    [bumpCacheVersion, rootSessionKey, setDrawerSessionForRoot],
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
        setHasMoreExternalSessions(next.length >= 50);
        if (options?.replace || (!options?.beforeTime && !options?.afterTime)) {
          setExternalSessions(next);
          return;
        }
        setExternalSessions((prev) => mergeSessionItems(prev, next));
      } finally {
        setLoadingExternalSessions(false);
      }
    },
    [externalFilterBound, mergeSessionItems],
  );

  const exitImportMode = useCallback(() => {
    setSessionListMode("local");
    setExternalSelectedKey("");
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

  const handleImportExternalSession = useCallback(
    async (session: SessionItem) => {
      const rootID = currentRootIdRef.current || "";
      const sessionKey = String(
        (session as any)?.agent_session_id || session?.key || "",
      ).trim();
      if (
        !rootID ||
        !externalImportAgent ||
        !sessionKey ||
        importingExternalSessionKey
      ) {
        return;
      }
      setImportingExternalSessionKey(sessionKey);
      try {
        const imported = await sessionService.importExternalSession(
          rootID,
          externalImportAgent,
          sessionKey,
        );
        if (!imported?.session_key) {
          reportError("session.import_failed", "导入会话失败");
          return;
        }
        exitImportMode();
        const next = (await sessionService.fetchSessions(
          rootID,
          {},
        )) as SessionItem[];
        setHasMoreSessions(next.length >= 50);
        setSessions(next);
        await handleSelectSession({
          key: imported.session_key,
          root_id: rootID,
          type: "chat",
          agent: externalImportAgent,
          name: session.name,
        } as SessionItem);
        if (isMobile) {
          setIsRightOpen(false);
        }
      } finally {
        setImportingExternalSessionKey("");
      }
    },
    [
      exitImportMode,
      externalImportAgent,
      handleSelectSession,
      importingExternalSessionKey,
      isMobile,
    ],
  );

  const handleSendMessage = useCallback(
    async (
      message: string,
      mode: SessionMode,
      agent: string,
      model?: string,
      agentMode?: string,
      effort?: string,
    ) => {
      const activeRoot = currentRootIdRef.current;
      if (!activeRoot) return;
      if (
        Object.values(pendingRequestRef.current).some(
          (pending) => pending.rootId === activeRoot,
        )
      ) {
        return;
      }
      const selected = selectedSessionRef.current;
      const selectedKey = selected?.key || selected?.session_key;
      const isMainSessionView =
        interactionModeRef.current !== "drawer" &&
        !!selectedKey &&
        (((selected as any)?.root_id as string | undefined) || activeRoot) ===
          activeRoot;
      let sendSessionKey =
        isMainSessionView && selectedKey && !selectedKey.startsWith("pending-")
          ? selectedKey
          : activeBoundSessionKey;
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
        if (selectedKey && !selectedKey.startsWith("pending-")) {
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
        effectiveEffort = effort || "";
      if (sendSessionKey && session) {
        const previousAgent = session.agent || "";
        effectiveMode = normalizeMode(session.type as any);
        effectiveAgent = agent || previousAgent || "";
        effectiveModel =
          model ||
          (effectiveAgent === previousAgent ? session.model || "" : "");
        effectiveAgentMode =
          agentMode ||
          (effectiveAgent === previousAgent ? (session as any).mode || "" : "");
        effectiveEffort =
          effort ||
          (effectiveAgent === previousAgent ? (session as any).effort || "" : "");
        updateSessionAgentForKey(
          activeRoot,
          sendSessionKey,
          effectiveAgent,
          effectiveModel,
          effectiveAgentMode,
          effectiveEffort,
        );
        session = {
          ...(session as any),
          agent: effectiveAgent,
          model: effectiveModel,
          mode: effectiveAgentMode,
          effort: effectiveEffort,
        } as Session;
        setBoundSessionForRoot(activeRoot, sendSessionKey);
        setSelectedPendingByKey(sendSessionKey, true);
        setDrawerSessionForRoot(activeRoot, {
          ...(session as any),
          pending: true,
        } as Session);
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
          name: "新会话",
          pending: true,
        } as any;
        setBoundSessionForRoot(activeRoot, tempKey);
      }
      const now = new Date().toISOString();
      const requestId = sessionService.createRequestId("msg");
      const tempKey = sendSessionKey ? "" : session?.key || "";
      const userEx: Exchange = {
        role: "user",
        agent: effectiveAgent,
        model: effectiveModel,
        mode: effectiveAgentMode,
        effort: effectiveEffort,
        content: message,
        timestamp: now,
        pending_ack: true,
      };
      pendingRequestRef.current[requestId] = {
        rootId: activeRoot,
        mode: effectiveMode,
        agent: effectiveAgent,
        model: effectiveModel,
        agentMode: effectiveAgentMode,
        effort: effectiveEffort,
        message,
        timestamp: now,
        requestId,
        sessionKey: sendSessionKey,
        tempKey,
      };
      if (sendSessionKey) {
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
            updated_at: now,
          } as Session;
        session = sessionCacheRef.current[ck];
        bumpCacheVersion();
      } else {
        const tempSessionKey = session?.key || "";
        pendingDraftRef.current = {
          rootId: activeRoot,
          mode: effectiveMode,
          agent: effectiveAgent,
          model: effectiveModel,
          agentMode: effectiveAgentMode,
          effort: effectiveEffort,
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
          sessionCacheRef.current[rootSessionKey(activeRoot, tempSessionKey)] =
            draftSession;
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
      setDrawerSessionForRoot(activeRoot, {
        ...(session as any),
        pending: true,
      } as Session);
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
      const sent = await sessionService.sendMessage(
        activeRoot,
        sendSessionKey,
        message,
        effectiveMode,
        effectiveAgent,
        effectiveModel || undefined,
        effectiveAgentMode || undefined,
        effectiveEffort || undefined,
        context,
        requestId,
      );
      if (!sent) {
        delete pendingRequestRef.current[requestId];
      }
      if (!sent && sendSessionKey) {
        setSelectedPendingByKey(sendSessionKey, false);
        const latest = drawerSessionByRootRef.current[activeRoot];
        if (latest && latest.key === sendSessionKey) {
          setDrawerSessionForRoot(activeRoot, {
            ...(latest as any),
            pending: false,
          } as Session);
        }
      }
    },
    [
      activeBoundSessionKey,
      attachedFileContext,
      rootSessionKey,
      setSelectedPendingByKey,
      bumpCacheVersion,
      setBoundSessionForRoot,
      setDrawerOpenForRoot,
      setDrawerSessionForRoot,
      updateSessionAgentForKey,
    ],
  );

  const handleCancelCurrentTurn = useCallback(
    async (sessionKey: string) => {
      const activeRoot = currentRootIdRef.current;
      if (!activeRoot || !sessionKey) return;
      const cacheKey = rootSessionKey(activeRoot, sessionKey);
      cancelRequestedBySessionRef.current[cacheKey] = true;
      const sent = await sessionService.cancelMessage(activeRoot, sessionKey);
      if (!sent) {
        delete cancelRequestedBySessionRef.current[cacheKey];
      }
    },
    [rootSessionKey],
  );

  const handleNewSession = useCallback(() => {
    const rootID = currentRootIdRef.current;
    setMainViewPreferenceForRoot(rootID, "session");
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
              const res = await fetch(
                appURL(
                  "/api/tree",
                  new URLSearchParams({ root: String(root), dir }),
                ),
              );
              if (!res.ok) continue;
              const payload = await res.json();
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
          isToggle = !!params.toggle;
        if (!path || !rootParam) return;
        setGitDiff(null);
        const isActuallyRoot = params.isRoot === true;
        const root = isActuallyRoot ? path : rootParam;
        const expandedKey = isActuallyRoot ? path : `${root}:${path}`;
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
            if (isMobile) setIsLeftOpen(false);
            return;
          }
          try {
            const res = await fetch(
              appURL("/api/tree", new URLSearchParams({ root, dir: apiDir })),
            );
            if (!res.ok) {
              const payload = await res.json().catch(() => ({}));
              if (
                await handleRelayNavigationFailure(
                  res.status,
                  typeof payload?.error === "string" ? payload.error : "",
                )
              ) {
                return;
              }
              const message = formatDirectoryLoadError(
                typeof payload?.error === "string" ? payload.error : "",
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
            const payload = await res.json();
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
            if (isMobile) setIsLeftOpen(false);
          } catch {
            const message = "目录加载失败，请稍后重试。";
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
          setExpanded((prev) => Array.from(new Set([...prev, path])));
          const restored = await tryShowBoundSessionForRoot(path, {
            pluginQuery: nextPluginQuery,
            closeLeftSidebar: true,
          });
          if (restored) {
            void loadSessionsForRoot(path, { replace: true, force: true });
            await refreshTreeDir(path, ".", false);
            return;
          }
        } else {
          setExpanded((prev) => Array.from(new Set([...prev, expandedKey])));
        }
        await loadDirectoryView(path, isActuallyRoot);
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

  const refreshManagedRoots = useCallback(async () => {
    const response = await fetch(appPath("/api/dirs"));
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      if (
        await handleRelayNavigationFailure(
          response.status,
          typeof payload?.error === "string" ? payload.error : "",
        )
      ) {
        return;
      }
      return;
    }
    const dirs = (await response.json()) as ManagedRootPayload[];
    const nextDirs = Array.isArray(dirs) ? dirs : [];
    const nextRootIds = nextDirs.map((dir) => dir.id).filter(Boolean);
    managedRootByIdRef.current = Object.fromEntries(
      nextDirs.filter((dir) => !!dir.id).map((dir) => [dir.id, dir]),
    );

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
  }, [handleRelayNavigationFailure, replaceURLState]);

  const refreshRelayStatus = useCallback(async () => {
    if (typeof window !== "undefined" && isRelayNodePage()) {
      return;
    }
    try {
      const response = await fetch("/api/relay/status");
      if (!response.ok) {
        return;
      }
      const payload = (await response.json()) as RelayStatusPayload;
      setRelayStatus(payload);
      return payload;
    } catch {
      return;
    }
  }, []);

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
    setCreatingRootName(nextName);
  }, [creatingRootBusy]);

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
    if (!trimmed) {
      setLocalDirState((prev) => ({
        ...prev,
        loading: false,
        error: "目录路径为空",
      }));
      return;
    }
    setLocalDirState((prev) => ({
      ...prev,
      loading: true,
      error: "",
      path: trimmed,
      selectedPath: "",
    }));
    try {
      const response = await fetch(
        appURL("/api/local_dirs", new URLSearchParams({ path: trimmed })),
      );
      const payload = (await response.json().catch(() => ({}))) as LocalDirsPayload;
      if (!response.ok) {
        throw new Error(String((payload as any)?.message || (payload as any)?.error || "加载目录失败"));
      }
      setLocalDirState({
        path: String(payload.path || trimmed),
        parent: String(payload.parent || ""),
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
        error: error instanceof Error ? error.message : "加载目录失败",
      }));
    }
  }, []);

  const openDirectoryPicker = useCallback((nextMode: ProjectAddMode) => {
    const rootID = currentRootIdRef.current;
    const rootPath = rootID
      ? String(managedRootByIdRef.current[rootID]?.root_path || "")
      : "";
    const initialPath = rootPath ? inferParentPath(rootPath) : "";
    setProjectAddMode(nextMode);
    if (!initialPath || initialPath === ".") {
      setLocalDirState((prev) => ({
        ...prev,
        path: rootPath,
        parent: "",
        items: [],
        loading: false,
        selectedPath: "",
        adding: false,
        error: "当前项目缺少可浏览的父目录",
      }));
      return;
    }
    void loadLocalDirs(initialPath);
  }, [inferParentPath, loadLocalDirs]);

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
  }, [creatingRootBusy]);

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
      const targetPath =
        creatingRootParentPath && creatingRootParentPath.trim()
          ? `${creatingRootParentPath.replace(/[\\/]+$/, "")}/${name}`
          : name;
      const response = await fetch(appPath("/api/dirs"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: targetPath, create: true }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          String(payload?.message || payload?.error || "新建项目失败"),
        );
      }
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
        String((err as Error)?.message || "新建项目失败"),
      );
    } finally {
      setCreatingRootBusy(false);
    }
  }, [creatingRootBusy, creatingRootName, creatingRootParentPath, refreshManagedRoots]);

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
    if (!path) {
      return;
    }
    setLocalDirState((prev) => ({ ...prev, adding: true, error: "" }));
    try {
      const response = await fetch(appPath("/api/dirs"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, create: false }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          String(payload?.message || payload?.error || "添加目录失败"),
        );
      }
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
        error: error instanceof Error ? error.message : "添加目录失败",
      }));
    }
  }, [handleCreateRootStart, loadLocalDirs, localDirState.adding, localDirState.path, localDirState.selectedPath, projectAddMode, refreshManagedRoots]);

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
      const response = await fetch(appPath("/api/imports/github"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, parent_path: parentPath }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          String(payload?.message || payload?.error || "GitHub 导入失败"),
        );
      }
      setGitHubImportState((prev) => ({
        ...prev,
        taskId: String(payload?.task_id || ""),
        status: "pending",
        message: "克隆中",
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
        error: error instanceof Error ? error.message : "GitHub 导入失败",
      }));
    }
  }, [githubImportState.parentPath, githubImportState.running, githubImportState.submitting, githubImportState.url]);

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
          projectAddMode === "local" ? "添加" : "放置于此目录"
        }
        localDisabledAddedRoot={projectAddMode === "local"}
        localBrowseOnly={
          projectAddMode === "blank_location" ||
          projectAddMode === "github_location"
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
      reportError("root.delete_failed", "当前项目缺少路径信息，无法移除");
      return;
    }
    if (!window.confirm(`确认移除项目“${rootID}”？`)) {
      return;
    }
    try {
      const response = await fetch(
        appURL("/api/dirs", new URLSearchParams({ path: rootPath })),
        {
          method: "DELETE",
        },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          String(payload?.message || payload?.error || "移除项目失败"),
        );
      }
      await refreshManagedRoots();
    } catch (err) {
      reportError(
        "root.delete_failed",
        String((err as Error)?.message || "移除项目失败"),
      );
    }
  }, [refreshManagedRoots]);

  const ensurePluginsLoaded = useCallback(async (rootId: string) => {
    if (!rootId || pluginsLoadedByRootRef.current[rootId]) {
      return;
    }
    const inflight = pluginsLoadingByRootRef.current[rootId];
    if (inflight) {
      await inflight;
      return;
    }
    setPluginLoading(true);
    const request = loadAllPlugins(rootId)
      .then((plugins) => {
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

  const handleFileViewerPathClick = useCallback(
    (path: string) => {
      if (!file) return;
      const root = file.root || currentRootIdRef.current;
      if (!root) return;
      actionHandlers.open_dir({
        path: path === "." ? root : path,
        root,
        isRoot: path === ".",
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

  const filteredGitStatus = useMemo<GitStatusPayload | null>(() => {
    if (!gitStatus) {
      return null;
    }
    const currentDir =
      selectedDir && selectedDir !== currentRootId ? selectedDir : ".";
    if (!currentDir || currentDir === ".") {
      return gitStatus;
    }
    const prefix = `${currentDir.replace(/^\/+|\/+$/g, "")}/`;
    const items = (gitStatus.items || [])
      .filter(
        (item) => item.path === currentDir || item.path.startsWith(prefix),
      )
      .map((item) => ({
        ...item,
        display_path: trimGitPathPrefix(item.path, currentDir),
      }));
    return {
      ...gitStatus,
      dirty_count: items.length,
      items,
    };
  }, [currentRootId, gitStatus, selectedDir]);

  useEffect(() => {
    if (!currentRootId) return;
    sessionService.connect(currentRootId);
    setStatus("Connected");
  }, [currentRootId]);

  useEffect(() => {
    if (sessionListMode !== "import") return;
    const rootID = currentRootIdRef.current || "";
    if (!rootID || !externalImportAgent) return;
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
      setStatus("Disconnected");
    },
    [],
  );

  useEffect(() => {
    if (!currentRootId) {
      setGitStatus(null);
      setGitDiff(null);
      setSessionListMode("local");
      setExternalSessions([]);
      setExternalSelectedKey("");
      return;
    }
    void refreshGitStatus(currentRootId);
    setGitDiff(null);
  }, [currentRootId, refreshGitStatus]);

  useEffect(() => {
    if (!currentRootId) return;
    let cancelled = false;
    const reloadSessionForReplay = async (
      rootID: string,
      sessionKey: string,
    ) => {
      if (!rootID || !sessionKey) return;
      const cacheKey = rootSessionKey(rootID, sessionKey);
      const inflight = loadingSessionRef.current[cacheKey];
      const request =
        inflight ||
        syncSession(rootID, sessionKey).finally(() => {
          delete loadingSessionRef.current[cacheKey];
        });
      if (!inflight) {
        loadingSessionRef.current[cacheKey] = request;
      }
      const syncResult = await request;
      if (cancelled) return;
      if (syncResult?.session) {
        const normalized = {
          ...(syncResult.session as any),
          key: sessionKey,
        } as Session;
        sessionCacheRef.current[cacheKey] = normalized;
        loadedSessionRef.current[cacheKey] = true;
        bumpCacheVersion();
        if (
          (selectedSessionRef.current?.key ||
            selectedSessionRef.current?.session_key) === sessionKey
        ) {
          setSelectedSession((prev) =>
            prev
              ? toSessionItem(rootID, {
                  ...(prev as any),
                  ...(normalized as any),
                })
              : prev,
          );
        }
        if (boundSessionByRootRef.current[rootID] === sessionKey) {
          setDrawerSessionForRoot(rootID, normalized);
        }
      }
      await sessionService.markSessionReady(rootID, sessionKey);
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
      for (const rootID of managedRootIdsRef.current) {
        if (!rootID) continue;
        const replayTargets = getReplayTargetsForRoot(rootID);
        for (const sessionKey of replayTargets) {
          void reloadSessionForReplay(rootID, sessionKey);
        }
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
      const cached = sessionCacheRef.current[cacheKey];
      if (cached && cached.key === sessionKey) {
        sessionCacheRef.current[cacheKey] = {
          ...(cached as any),
          pending: false,
        } as Session;
      }
      setSelectedPendingByKey(sessionKey, false);
      setSelectedSession((prev) => {
        const prevRoot =
          (prev?.root_id as string | undefined) || currentRootIdRef.current;
        if (!prev || prevRoot !== rootID || !(prev as any).pending) {
          return prev;
        }
        return {
          ...(prev as any),
          pending: false,
        } as SessionItem;
      });
      const latest = wasCanceled
        ? sessionCacheRef.current[cacheKey]
        : drawerSessionByRootRef.current[rootID];
      if (latest && latest.key === sessionKey) {
        setDrawerSessionForRoot(rootID, {
          ...(latest as any),
          pending: false,
        } as Session);
      } else if (drawerSessionByRootRef.current[rootID] && (drawerSessionByRootRef.current[rootID] as any)?.pending) {
        setDrawerSessionForRoot(rootID, {
          ...(drawerSessionByRootRef.current[rootID] as any),
          pending: false,
        } as Session);
      }
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
        if (draft && draft.rootId === activeRoot) {
          pending = draft;
          pendingBySessionRef.current[ck] = draft;
          pendingDraftRef.current = null;
        }
      }
      const boundKey = boundSessionByRootRef.current[activeRoot] || null;
      if (
        !boundKey ||
        (typeof boundKey === "string" && boundKey.startsWith("pending-"))
      ) {
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
            "新会话";
          const userEx = {
            role: "user",
            content: pending.message,
            timestamp: pending.timestamp,
            model: pending.model,
            mode: pending.agentMode,
            effort: pending.effort,
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
        promotePendingSessionForRoot(
          activeRoot,
          pending.tempKey,
          streamKey,
          sessionCacheRef.current[ck] || null,
        );
      }
      const event = payload.event;
      if (!event?.type) return;
      switch (event.type) {
        case "message_chunk":
          appendAgentChunkForSession(
            activeRoot,
            streamKey,
            event.data?.content || "",
            pending?.agent,
          );
          {
            const latest = sessionCacheRef.current[ck];
            if (latest) {
              setDrawerSessionForRoot(activeRoot, {
                ...(latest as any),
                pending: true,
              } as Session);
            }
          }
          break;
        case "thought_chunk":
          appendThoughtChunkForSession(
            activeRoot,
            streamKey,
            event.data?.content || "",
          );
          {
            const latest = sessionCacheRef.current[ck];
            if (latest) {
              setDrawerSessionForRoot(activeRoot, {
                ...(latest as any),
                pending: true,
              } as Session);
            }
          }
          break;
        case "tool_call":
          appendToolCallForSession(
            activeRoot,
            streamKey,
            event.data || {},
            false,
          );
          {
            const latest = sessionCacheRef.current[ck];
            if (latest) {
              setDrawerSessionForRoot(activeRoot, {
                ...(latest as any),
                pending: true,
              } as Session);
            }
          }
          break;
        case "tool_call_update":
          appendToolCallForSession(
            activeRoot,
            streamKey,
            event.data || {},
            true,
          );
          {
            const latest = sessionCacheRef.current[ck];
            if (latest) {
              setDrawerSessionForRoot(activeRoot, {
                ...(latest as any),
                pending: true,
              } as Session);
            }
          }
          break;
        case "message_done":
          playCompletionSound();
          handleSessionStreamDone(activeRoot, streamKey);
          break;
        case "error":
          handleSessionStreamDone(activeRoot, streamKey);
          break;
      }
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
        case "ws.connected":
          void refreshManagedRoots();
          if (currentRootIdRef.current) {
            const newest = sessionsRef.current[0]?.updated_at || "";
            void loadSessionsForRoot(
              currentRootIdRef.current,
              newest ? { afterTime: newest } : { replace: true },
            );
          }
          replayTargetsForAllRoots();
          break;
        case "ws.reconnected":
          void refreshManagedRoots();
          if (currentRootIdRef.current) {
            const newest = sessionsRef.current[0]?.updated_at || "";
            void loadSessionsForRoot(
              currentRootIdRef.current,
              newest ? { afterTime: newest } : { replace: true },
            );
          }
          replayTargetsForAllRoots();
          break;
        case "root.changed":
          void refreshManagedRoots();
          break;
        case "session.imported": {
          const rootID =
            typeof payload?.root_id === "string" ? payload.root_id : "";
          if (!rootID) {
            break;
          }
          if (rootID === currentRootIdRef.current) {
            void loadSessionsForRoot(rootID, { replace: true });
          }
          break;
        }
        case "session.stream":
          handleSessionStream(payload);
          break;
        case "session.accepted": {
          const requestId =
            typeof payload?.request_id === "string" ? payload.request_id : "";
          const pending = pendingRequestRef.current[requestId];
          if (!requestId || !pending) {
            break;
          }
          delete pendingRequestRef.current[requestId];
          const markAccepted = (
            sess: Session | null | undefined,
          ): Session | null => {
            if (!sess) return null;
            const exchanges = Array.isArray((sess as any).exchanges)
              ? ((sess as any).exchanges as Exchange[]).map((exchange) =>
                  exchange.pending_ack === true &&
                  exchange.content === pending.message &&
                  exchange.timestamp === pending.timestamp
                    ? { ...exchange, pending_ack: false }
                    : exchange,
                )
              : [];
            return { ...(sess as any), exchanges } as Session;
          };
          if (pending.sessionKey) {
            const cacheKey = rootSessionKey(pending.rootId, pending.sessionKey);
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
            (drawerKey === pending.sessionKey || drawerKey === pending.tempKey)
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
            break;
          }
          delete pendingRequestRef.current[requestId];
          const targetKey = pending.tempKey || "";
          const rootID = pending.rootId;
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
            handleSessionStreamDone(rootID, sessionKey);
            const newest = sessionsRef.current[0]?.updated_at || "";
            void loadSessionsForRoot(
              rootID,
              newest ? { afterTime: newest } : { replace: true },
            );
          } else if (currentRootIdRef.current) {
            const newest = sessionsRef.current[0]?.updated_at || "";
            void loadSessionsForRoot(
              currentRootIdRef.current,
              newest ? { afterTime: newest } : { replace: true },
            );
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
            const exchange = payload.exchange;
            const sessionMeta = payload.session;
            const cacheKey = rootSessionKey(rootID, sessionKey);
            const cached =
              sessionCacheRef.current[cacheKey] ||
              ({
                key: sessionKey,
                type: sessionMeta?.type || "chat",
                agent: sessionMeta?.agent || exchange?.agent || "",
                model: sessionMeta?.model || exchange?.model || "",
                mode: sessionMeta?.mode || exchange?.mode || "",
                effort: sessionMeta?.effort || exchange?.effort || "",
                name: sessionMeta?.name || "新会话",
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
            bumpCacheVersion();
            const newest = sessionsRef.current[0]?.updated_at || "";
            void loadSessionsForRoot(
              rootID,
              newest ? { afterTime: newest } : { replace: true },
            );
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
            const cached = sessionCacheRef.current[cacheKey];
            if (cached) {
              sessionCacheRef.current[cacheKey] = {
                ...cached,
                name:
                  typeof payload.session.name === "string"
                    ? payload.session.name
                    : cached.name,
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
                updated_at: payload.session.updated_at || cached.updated_at,
              } as Session;
              bumpCacheVersion();
            }
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
            const newest = sessionsRef.current[0]?.updated_at || "";
            void loadSessionsForRoot(
              rootID,
              newest ? { afterTime: newest } : { replace: true },
            );
          }
          break;
        case "session.related_files.updated": {
          const rootID =
            typeof payload?.root_id === "string" ? payload.root_id : "";
          const sessionKey =
            typeof payload?.session_key === "string" ? payload.session_key : "";
          if (rootID && sessionKey) {
            void refreshSessionRelatedFiles(rootID, sessionKey);
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
              error: failed ? String(status?.message || "GitHub 导入失败") : "",
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
    gitDiff?.path,
    loadSessionsForRoot,
    rootSessionKey,
    resolveRootForSessionKey,
    promotePendingSessionForRoot,
    appendAgentChunkForSession,
    appendThoughtChunkForSession,
    appendToolCallForSession,
    setSelectedPendingByKey,
    setBoundSessionForRoot,
    setDrawerSessionForRoot,
    refreshManagedRoots,
    refreshTreeDir,
    refreshCurrentFileContent,
    refreshGitStatus,
    refreshManagedRoots,
    updateSessionRelatedFilesForKey,
    treeCacheKey,
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
      const next = (await sessionService.fetchSessions(rootID, {
        beforeTime: oldest,
      })) as SessionItem[];
      setHasMoreSessions(next.length >= 50);
      setSessions((prev) => mergeSessionItems(prev, next));
    } finally {
      setLoadingOlderSessions(false);
    }
  }, [loadingOlderSessions, mergeSessionItems]);

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
    fetch(appPath("/api/dirs"))
      .then(async (r) => {
        if (!r.ok) {
          const payload = await r.json().catch(() => ({}));
          if (
            await handleRelayNavigationFailure(
              r.status,
              typeof payload?.error === "string" ? payload.error : "",
            )
          ) {
            return null;
          }
          return null;
        }
        return r.json();
      })
      .then(async (dirs) => {
        if (!dirs) {
          return;
        }
        void refreshRelayStatus();
        if (cancelled || !dirs.length) {
          return;
        }
        const nextDirs = dirs as ManagedRootPayload[];
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
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        reportError(
          "app.init_failed",
          String((err as Error)?.message || err || "初始化失败"),
        );
      })
      .finally(() => {
        settled = true;
      })
    ;
    return () => {
      cancelled = true;
      if (!settled) {
        didInitRef.current = false;
      }
    };
  }, [
    ensurePluginsLoaded,
    handleRelayNavigationFailure,
    loadSessionsForRoot,
    refreshRelayStatus,
    refreshTreeDir,
    tryShowBoundSessionForRoot,
  ]);

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
  const actionBarSession = activeBoundSessionKey
    ? (currentSession as any) || boundFromCache || boundFromSelected
    : selectedInCurrentRoot
      ? (selectedSession as any)
      : null;
  const isBoundSessionInMain =
    !!activeBoundSessionKey &&
    selectedKey === activeBoundSessionKey &&
    interactionMode !== "drawer";
  const canOpenSessionDrawer = !!activeBoundSessionKey && !isBoundSessionInMain;
  const detachedBoundSession =
    !!activeBoundSessionKey &&
    selectedInCurrentRoot &&
    !!selectedKey &&
    selectedKey !== activeBoundSessionKey &&
    !isDrawerOpen;

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
      if (selectedSessionLoading) {
        return {
          ...(selectedSession as any),
          exchanges: Array.isArray((selectedSession as any).exchanges)
            ? ([...(selectedSession as any).exchanges] as any)
            : [],
        } as SessionItem;
      }
      return getSessionSnapshot(
        selectedSession.root_id || currentRootId,
        selectedSession,
      );
    },
    [selectedSession, selectedSessionLoading, currentRootId, getSessionSnapshot],
  );

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
    const cached = sessionCacheRef.current[cacheKey];
    if (loadedSessionRef.current[cacheKey]) {
      return;
    }
    if (hasSessionExchanges(cached)) {
      return;
    }
    if (hasSessionExchanges(selectedSessionSnapshot as Session | null)) {
      return;
    }
    if (loadingSessionRef.current[cacheKey]) {
      return;
    }
    const request = syncSession(rootID, sessionKey)
      .then((syncResult) => {
        const fullSession = syncResult?.session;
        if (!fullSession) {
          return;
        }
        const normalized = {
          ...(fullSession as any),
          key: sessionKey,
        } as Session;
        sessionCacheRef.current[cacheKey] = normalized;
        loadedSessionRef.current[cacheKey] = true;
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
        if (boundSessionByRootRef.current[rootID] === sessionKey) {
          setDrawerSessionForRoot(rootID, normalized);
        }
        bumpCacheVersion();
        void sessionService.markSessionReady(rootID, sessionKey);
      })
      .finally(() => {
        delete loadingSessionRef.current[cacheKey];
      });
    loadingSessionRef.current[cacheKey] = request;
  }, [
    selectedSession,
    selectedSessionLoading,
    selectedSessionSnapshot,
    currentRootId,
    rootSessionKey,
    bumpCacheVersion,
    setDrawerSessionForRoot,
  ]);

  const handleSelectedSessionFileClick = useCallback(
    (path: string) => {
      const root =
        (selectedSessionRef.current?.root_id as string | undefined) ||
        currentRootIdRef.current;
      if (!root) return;
      const gitItem = (gitStatus?.items || []).find(
        (item) => item.path === path,
      );
      if (gitItem) {
        void openGitDiff(root, gitItem);
        return;
      }
      actionHandlers.open({ path, root });
    },
    [actionHandlers, gitStatus, openGitDiff],
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
      if (!hasBound) {
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
        (drawer?.key === boundKey && !!drawer?.pending) ||
        !!selected?.pending;
      next[root] = { bound: true, pending };
    }
    return next;
  }, [
    managedRootIds,
    selectedSession,
    currentSession,
    currentRootId,
    activeBoundSessionKey,
    cacheVersion,
    rootSessionKey,
  ]);

  const handleDrawerSessionFileClick = useCallback(
    (path: string) => {
      const root = currentRootIdRef.current;
      if (!root) return;
      const gitItem = (gitStatus?.items || []).find(
        (item) => item.path === path,
      );
      if (gitItem) {
        void openGitDiff(root, gitItem);
        return;
      }
      actionHandlers.open({ path, root });
    },
    [actionHandlers, gitStatus, openGitDiff],
  );

  const handleRemoveSessionRelatedFile = useCallback(
    async (
      rootID: string | null | undefined,
      sessionKey: string | undefined,
      path: string,
    ) => {
      const resolvedRoot = rootID || currentRootIdRef.current;
      const resolvedKey = sessionKey || "";
      if (!resolvedRoot || !resolvedKey || !path) return;
      const removed = await sessionService.removeSessionRelatedFile(
        resolvedRoot,
        resolvedKey,
        path,
      );
      if (!removed) return;
      const relatedFiles = await sessionService.getSessionRelatedFiles(
        resolvedRoot,
        resolvedKey,
      );
      await setCachedSessionRelatedFiles(resolvedRoot, resolvedKey, relatedFiles);
      updateSessionRelatedFilesForKey(resolvedRoot, resolvedKey, relatedFiles);
    },
    [updateSessionRelatedFilesForKey],
  );

  const currentFileScrollKey = buildFileScrollKey(
    file?.root || currentRootId,
    file?.path,
  );
  const sessionView = (
    <SessionViewer
      session={selectedSessionSnapshot}
      targetSeq={selectedSession?.search_seq}
      loading={selectedSessionLoading}
      rootId={selectedSession?.root_id || currentRootId}
      rootPath={
        managedRootByIdRef.current[
          selectedSession?.root_id || currentRootId || ""
        ]?.root_path || null
      }
      gitFileStatsByPath={gitFileStatsByPath}
      onFileClick={handleSelectedSessionFileClick}
      onRemoveRelatedFile={(path) =>
        void handleRemoveSessionRelatedFile(
          selectedSession?.root_id || currentRootId,
          selectedSessionSnapshot?.key || selectedSessionSnapshot?.session_key,
          path,
        )
      }
    />
  );

  let workspaceView: React.ReactNode;
  const showGitStatusPanel = !gitDiff && !file && !!currentRootId;
  const gitStatusAvailable = filteredGitStatus?.available === true;
  const shouldRenderGitPanel =
    showGitStatusPanel &&
    gitStatusAvailable &&
    (gitStatusLoading || (filteredGitStatus?.items.length || 0) > 0);
  if (gitDiff) {
    workspaceView = (
      <GitDiffViewer
        diff={gitDiff}
        root={currentRootId}
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
              fontSize: 12,
              color: "var(--text-secondary)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span>🧩</span>
              <span>{pluginRender.plugin.name}</span>
              {pluginLoading ? (
                <span style={{ opacity: 0.7 }}>加载中...</span>
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
              原始文件
            </button>
          </div>
          <div
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
              <span>已切换为原始文件视图（插件：{matchedPlugin.name}）</span>
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
                使用插件
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
                插件 {pluginRender.plugin.name} 执行失败，已回退原始视图
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
                忽略插件
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
        entries={visibleMainEntries}
        errorMessage={mainDirectoryError}
        topContent={
          shouldRenderGitPanel ? (
            <GitStatusPanel
              status={filteredGitStatus}
              loading={gitStatusLoading}
              isFiltered={!!selectedDir && selectedDir !== currentRootId}
              onSelectItem={(item) => {
                const root = currentRootIdRef.current;
                if (!root) {
                  return;
                }
                void openGitDiff(root, item);
              }}
            />
          ) : null
        }
        showHiddenFiles={showHiddenFiles}
        sortMode={currentDirectorySortMode}
        sortControlValue={currentDirectorySortOverride || "inherit"}
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
        onRemoveRoot={handleRemoveCurrentRoot}
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
    const latestStatus = await refreshRelayStatus();
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
  }, [currentRootId, refreshRelayStatus, relayStatus]);

  const relayActionLabel = useMemo(() => {
    if (isRelayNodePage()) {
      return null;
    }
    if (relayStatus?.no_relayer) {
      return null;
    }
    return "从公网访问";
  }, [relayStatus]);

  const relayActionDisabled =
    !currentRootId ||
    (!relayStatus?.relay_bound &&
      (!relayStatus?.pending_code || !relayStatus?.relay_base_url));
  const showUpdateButton = shouldShowUpdateButton(updateState);
  const updateBusy =
    updateSubmitting ||
    ["downloading", "installing", "restarting"].includes(
      (updateState.status || "").toLowerCase(),
    );
  const updateLabel = updateButtonLabel(updateState);
  const updateHelp = updateState.message || updateSummaryText(updateState);
  const updateSummary = updateSummaryText(updateState);
  const sessionImportMenu = (
    <div ref={importMenuRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setImportMenuOpen((open) => !open)}
        aria-label="导入外部会话"
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
              display: "flex",
              flexDirection: "column",
              gap: "4px",
              maxHeight: "180px",
              overflow: "auto",
            }}
          >
            {availableAgents.map((item) => {
              const selected = item.name === externalImportAgent;
              return (
                <button
                  key={item.name}
                  type="button"
                  onClick={() => {
                    setImportMenuOpen(false);
                    setExternalImportAgent(item.name);
                    setExternalSelectedKey("");
                    void enterImportMode(item.name);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    width: "100%",
                    border: "1px solid transparent",
                    background: selected
                      ? "rgba(59, 130, 246, 0.1)"
                      : "transparent",
                    color: selected
                      ? "var(--accent-color)"
                      : "var(--text-primary)",
                    borderRadius: "8px",
                    padding: "8px 10px",
                    cursor: "pointer",
                    textAlign: "left",
                    opacity: 1,
                  }}
                >
                  <AgentIcon
                    agentName={item.name}
                    style={{
                      width: "14px",
                      height: "14px",
                      display: "block",
                    }}
                  />
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: "12px",
                      fontWeight: 500,
                    }}
                  >
                    {item.name}
                  </span>
                  {!item.available ? (
                    <span
                      aria-label="当前未就绪"
                      title="当前未就绪"
                      style={{
                        minWidth: "11px",
                        height: "11px",
                        padding: "0 2px",
                        borderRadius: "50%",
                        background: "#d97706",
                        color: "#fff",
                        fontSize: "9px",
                        lineHeight: "11px",
                        textAlign: "center",
                        flexShrink: 0,
                        fontWeight: 700,
                      }}
                    >
                      !
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
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
            <span>隐藏已导入会话</span>
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
        importingKey={importingExternalSessionKey}
        filterBound={externalFilterBound}
        headerAction={sessionImportMenu}
        loading={loadingExternalSessions}
        loadingOlder={loadingOlderExternalSessions}
        hasMore={hasMoreExternalSessions}
        onBack={exitImportMode}
        onSelect={(session) =>
          setExternalSelectedKey(
            String(session.key || session.session_key || ""),
          )
        }
        onImport={(session) => {
          void handleImportExternalSession(session);
        }}
        onLoadOlder={() => {
          void handleLoadOlderExternalSessions();
        }}
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
        emptyText={
          sessionSearchResultsMode
            ? "未找到匹配会话"
            : sessionSearchOpen
              ? ""
            : "暂无会话记录"
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
        onRename={handleRenameSession}
        onDelete={handleDeleteSession}
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

  return (
    <>
      <AppShell
        leftOpen={isLeftOpen}
        rightOpen={isRightOpen}
        onCloseLeft={() => setIsLeftOpen(false)}
        onCloseRight={() => setIsRightOpen(false)}
        sidebar={
          <FileTree
            entries={rootEntries}
            childrenByPath={entriesByPath}
            expanded={expanded}
            sortMode={treeSortMode}
            showHiddenFiles={showHiddenFiles}
            onSortModeChange={setTreeSortMode}
            onShowHiddenFilesChange={setShowHiddenFiles}
            selectedDirKey={selectedDirKey}
            selectedPath={file?.path}
            rootId={currentRootId}
            rootSessionIndicators={rootSessionIndicators}
            creatingRootName={creatingRootName}
            creatingRootBusy={creatingRootBusy}
            onOpenProjectAdd={handleOpenProjectAdd}
            onCreateRootStart={handleCreateRootStart}
            onCreateRootNameChange={setCreatingRootName}
            onCreateRootSubmit={() => {
              void handleCreateRootSubmit();
            }}
            onCreateRootCancel={handleCreateRootCancel}
            projectAddOverlay={projectAddOverlay}
            onSelectFile={(e, r) => {
              actionHandlers.open({ path: e.path, root: r });
              if (isMobile) setIsLeftOpen(false);
            }}
            onToggleDir={(e, r) =>
              actionHandlers.open_dir({
                path: e.path,
                root: r,
                toggle: true,
                isRoot: e.is_root === true,
              })
            }
            relayActionLabel={relayActionLabel}
            relayActionDisabled={relayActionDisabled}
            relayActionHelp={null}
            onRelayAction={handleRelayAction}
            updateActionLabel={showUpdateButton ? updateLabel : null}
            updateActionDisabled={updateBusy}
            updateActionHelp={showUpdateButton ? updateHelp : ""}
            updateActionBusy={updateBusy}
            updateActionSummary={showUpdateButton ? updateSummary : ""}
            onUpdateAction={() => {
              void handleStartUpdate();
            }}
          />
        }
        rightSidebar={sessionSidebar}
        main={
          <div
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
            {!isMobile && (
              <div
                style={{
                  position: "absolute",
                  top: "10px",
                  left: isMobile ? "10px" : isLeftOpen ? "-40px" : "10px",
                  right: isMobile ? "10px" : isRightOpen ? "-40px" : "10px",
                  display: "flex",
                  justifyContent: "space-between",
                  pointerEvents: "none",
                  zIndex: 100,
                }}
              >
                <button
                  onClick={() => setIsLeftOpen(!isLeftOpen)}
                  style={{
                    pointerEvents: "auto",
                    background: "var(--content-bg)",
                    border: "1px solid var(--border-color)",
                    borderRadius: "8px",
                    width: "32px",
                    height: "32px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    opacity: isLeftOpen && !isMobile ? 0 : 1,
                  }}
                >
                  📁
                </button>
                <button
                  onClick={() => setIsRightOpen(!isRightOpen)}
                  style={{
                    pointerEvents: "auto",
                    background: "var(--content-bg)",
                    border: "1px solid var(--border-color)",
                    borderRadius: "8px",
                    width: "32px",
                    height: "32px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    opacity: isRightOpen && !isMobile ? 0 : 1,
                  }}
                >
                  🕒
                </button>
              </div>
            )}
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
          <ActionBar
            status={status}
            agentsVersion={agentsVersion}
            currentRootId={currentRootId}
            currentSession={actionBarSession}
            attachedFileContext={attachedFileContext}
            canOpenSessionDrawer={canOpenSessionDrawer}
            detachedBoundSession={detachedBoundSession}
            onSendMessage={handleSendMessage}
            onCancelCurrentTurn={handleCancelCurrentTurn}
            onNewSession={handleNewSession}
            onRequestFileContext={handleRequestFileContext}
            onClearFileContext={handleClearFileContext}
            onToggleLeftSidebar={() => setIsLeftOpen((v) => !v)}
            onToggleRightSidebar={() => setIsRightOpen((v) => !v)}
            onSessionClick={() => {
              const rootID = currentRootIdRef.current;
              if (!activeBoundSessionKey) return;
              const selectedKey =
                selectedSession?.key || selectedSession?.session_key;
              const isBoundSessionInMain =
                selectedKey === activeBoundSessionKey &&
                interactionMode !== "drawer";
              if (isBoundSessionInMain) return;
              setInteractionMode("drawer");
              setDrawerOpenForRoot(
                rootID,
                !(drawerOpenByRootRef.current[rootID || ""] || false),
              );
            }}
          />
        }
        drawer={
          <BottomSheet
            isOpen={isDrawerOpen}
            onClose={() =>
              setDrawerOpenForRoot(currentRootIdRef.current, false)
            }
            onExpand={() => {
              handleSelectSession(currentSession);
              setDrawerOpenForRoot(currentRootIdRef.current, false);
            }}
          >
            {drawerSessionSnapshot ? (
              <SessionViewer
                session={drawerSessionSnapshot}
                targetSeq={currentSession?.search_seq}
                loading={false}
                rootId={currentRootId}
                rootPath={
                  managedRootByIdRef.current[currentRootId || ""]?.root_path ||
                  null
                }
                interactionMode="drawer"
                gitFileStatsByPath={gitFileStatsByPath}
                onFileClick={handleDrawerSessionFileClick}
                onRemoveRelatedFile={(path) =>
                  void handleRemoveSessionRelatedFile(
                    currentRootId,
                    drawerSessionSnapshot?.key || drawerSessionSnapshot?.session_key,
                    path,
                  )
                }
              />
            ) : (
              <div style={{ padding: "40px", textAlign: "center" }}>
                点击蓝点或发消息开始
              </div>
            )}
          </BottomSheet>
        }
      />
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

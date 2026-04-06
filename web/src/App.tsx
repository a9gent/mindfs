import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getViewModeSystemPrompt } from "./renderer/viewCatalog";
import { Renderer } from "./renderer/Renderer";
import { deleteCachedSession, getCachedSession, sessionService, setCachedSessionRelatedFiles, syncSession, type RelatedFile, type Session } from "./services/session";
import { buildClientContext } from "./services/context";
import { reportError } from "./services/error";
import { fetchFile, getCachedFile, invalidateFileCache, type FilePayload } from "./services/file";
import { fetchGitDiff, fetchGitStatus, type GitDiffPayload, type GitStatusItem, type GitStatusPayload } from "./services/git";
import {
  DEFAULT_DIRECTORY_SORT_MODE,
  type DirectorySortMode,
  type FileEntry,
} from "./services/directorySort";
import { uploadFiles } from "./services/upload";
import { PluginManager, loadAllPlugins, type PluginInput } from "./plugins/manager";
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
import { ActionBar } from "./components/ActionBar";
import { BottomSheet } from "./components/BottomSheet";

// 类型定义
type SessionMode = "chat" | "plugin";
export type SessionItem = { key?: string; session_key?: string; root_id?: string; name?: string; type?: SessionMode; agent?: string; model?: string; scope?: string; purpose?: string; created_at?: string; updated_at?: string; closed_at?: string; related_files?: RelatedFile[]; exchanges?: Array<{ role?: string; content?: string; timestamp?: string; model?: string }>; pending?: boolean; };
type Exchange = { role: string; agent?: string; model?: string; content?: string; timestamp?: string; toolCall?: any; };
type PendingSend = { rootId: string; mode: SessionMode; agent: string; model?: string; message: string; timestamp: string; };
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
type URLState = { root: string; file: string; session: string; cursor: number; pluginQuery: Record<string, string> };
type ManagedRootPayload = {
  id: string;
  display_name?: string;
  root_path?: string;
  size?: number;
  mtime?: string;
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
const READ_FILE_TOKEN_PATTERN = /\[read file:\s*[^\]]+\]/i;

function normalizeUpdateState(input: UpdateState | null | undefined): UpdateState {
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
  if (status === "downloading" || status === "installing" || status === "restarting" || status === "failed") {
    return true;
  }
  return state.auto_update_supported === true && state.has_update === true;
}

function buildFileScrollKey(rootId: string | null | undefined, path: string | null | undefined): string {
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
    popup.document.body.innerHTML = "<p style=\"font-family: system-ui, sans-serif; padding: 16px; color: #111827;\">Opening Relayer...</p>";
  } catch {
  }
  return popup;
}

function navigatePopup(popup: Window | null, url: string): void {
  if (!popup || popup.closed) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  try {
    popup.opener = null;
  } catch {
  }
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
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia?.("(display-mode: standalone)")?.matches === true || navigatorWithStandalone.standalone === true;
}

function isRelayPWAContext(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return isStandaloneDisplayMode() && (/^\/n\/[^/]+/.test(window.location.pathname) || window.location.pathname === "/nodes" || window.location.pathname === "/login");
}

function extractHTTPStatusFromErrorMessage(message: string): number | null {
  const match = /status=(\d{3})|(?:^|:\s)(\d{3})\s[A-Z]/.exec(String(message || ""));
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
    window.localStorage.setItem(FILE_SCROLL_STORAGE_KEY, JSON.stringify(positions));
  } catch {
  }
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

function isDirectorySortMode(value: string | null | undefined): value is DirectorySortMode {
  return value === "name-asc"
    || value === "name-desc"
    || value === "mtime-desc"
    || value === "mtime-asc"
    || value === "size-desc"
    || value === "size-asc";
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

function loadPersistedPluginQuery(root: string, file: string): Record<string, string> {
  if (!root || !file) return {};
  try {
    const raw = window.localStorage.getItem(pluginQueryStorageKey(root, file));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const next: Record<string, string> = {};
    Object.entries(parsed as Record<string, unknown>).forEach(([key, value]) => {
      if (!key) return;
      next[key] = String(value);
    });
    return next;
  } catch {
    return {};
  }
}

function persistPluginQuery(root: string, file: string, query: Record<string, string>): void {
  if (!root || !file) return;
  try {
    window.localStorage.setItem(pluginQueryStorageKey(root, file), JSON.stringify(query || {}));
  } catch {
  }
}

function toPluginInput(file: FilePayload, query: Record<string, string>): PluginInput {
  return {
    name: file.name,
    path: file.path,
    content: file.content,
    ext: file.ext || "",
    mime: file.mime || "",
    size: typeof file.size === "number" ? file.size : 0,
    truncated: !!file.truncated,
    next_cursor: typeof file.next_cursor === "number" ? file.next_cursor : undefined,
    query,
  };
}

function inferReadModeFromPlugin(plugin: any): "incremental" | "full" {
  if (!plugin) return "incremental";
  if (plugin?.fileLoadMode === "full") return "full";
  if (plugin?.fileLoadMode === "incremental") return "incremental";
  return "incremental";
}

function buildMatchInputFromPath(path: string, query: Record<string, string>): PluginInput {
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
  return String(value || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
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

function parseFileLocation(path: string): { path: string; targetLine?: number; targetColumn?: number } {
  const raw = String(path || "");
  const [base, fragment = ""] = raw.split("#", 2);
  if (!fragment) {
    return { path: base };
  }
  const match = /^L(\d+)(?:C(\d+))?$/i.exec(fragment.trim());
  if (!match) {
    return { path: base };
  }
  const targetLine = Number.parseInt(match[1], 10);
  const targetColumn = match[2] ? Number.parseInt(match[2], 10) : undefined;
  return {
    path: base,
    targetLine: Number.isFinite(targetLine) && targetLine > 0 ? targetLine : undefined,
    targetColumn: targetColumn && Number.isFinite(targetColumn) && targetColumn > 0 ? targetColumn : undefined,
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

function buildDirectorySelectionKey(root: string, path: string, isRoot: boolean): string {
  return isRoot ? root : `${root}:${path}`;
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
  const currentSessionRef = useRef<Session | null>(null);
  const interactionModeRef = useRef<"main" | "drawer">("main");
  const pendingDraftRef = useRef<PendingSend | null>(null);
  const pendingBySessionRef = useRef<Record<string, PendingSend>>({});
  const cancelRequestedBySessionRef = useRef<Record<string, boolean>>({});
  const sessionCacheRef = useRef<Record<string, Session>>({});
  const loadedSessionRef = useRef<Record<string, boolean>>({});
  const loadingSessionRef = useRef<Record<string, Promise<Session | null>>>({});
  const boundSessionByRootRef = useRef<Record<string, string | null>>({});
  const drawerSessionByRootRef = useRef<Record<string, Session | null>>({});
  const drawerOpenByRootRef = useRef<Record<string, boolean>>({});
  const fileCursorRef = useRef<number>(0);
  const fileScrollPositionsRef = useRef<Record<string, number>>(loadPersistedFileScrollPositions());
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
  const handleSelectSessionRef = useRef<((session: any) => Promise<void>) | null>(null);
  
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const sessionsRef = useRef<SessionItem[]>([]);
  const [hasMoreSessions, setHasMoreSessions] = useState(false);
  const [loadingOlderSessions, setLoadingOlderSessions] = useState(false);
  const [selectedSession, setSelectedSession] = useState<SessionItem | null>(null);
  const [activeBoundSessionKey, setActiveBoundSessionKey] = useState<string | null>(null);
  const [currentSession, setCurrentSession] = useState<Session | null>(null);
  const [cacheVersion, setCacheVersion] = useState(0);
  const [interactionMode, setInteractionMode] = useState<"main" | "drawer">("main");
  const [agentsVersion, setAgentsVersion] = useState(0);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const { isMobile } = useResponsive();
  const [isLeftOpen, setIsLeftOpen] = useState(() => window.innerWidth >= 768);
  const [isRightOpen, setIsRightOpen] = useState(() => window.innerWidth >= 768);
  const [currentRootId, setCurrentRootId] = useState<string | null>(null);
  const currentRootIdRef = useRef<string | null>(null);
  const [managedRootIds, setManagedRootIds] = useState<string[]>([]);
  const managedRootByIdRef = useRef<Record<string, ManagedRootPayload>>({});
  const [rootEntries, setRootEntries] = useState<FileEntry[]>([]);
  const [creatingRootName, setCreatingRootName] = useState<string | null>(null);
  const [creatingRootBusy, setCreatingRootBusy] = useState(false);
  const [relayStatus, setRelayStatus] = useState<RelayStatusPayload | null>(null);
  const [entriesByPath, setEntriesByPath] = useState<Record<string, FileEntry[]>>({});
  const entriesByPathRef = useRef<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<string[]>([]);
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  const [selectedDirKey, setSelectedDirKey] = useState<string | null>(null);
  const [mainEntries, setMainEntries] = useState<FileEntry[]>([]);
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
  const [directorySortOverrides, setDirectorySortOverrides] = useState<Record<string, DirectorySortMode>>(() => {
    if (typeof window === "undefined") {
      return {};
    }
    try {
      const saved = window.localStorage.getItem(DIRECTORY_SORT_OVERRIDES_STORAGE_KEY);
      if (!saved) {
        return {};
      }
      const parsed = JSON.parse(saved) as Record<string, string>;
      return Object.fromEntries(
        Object.entries(parsed).filter(([, value]) => isDirectorySortMode(value)),
      ) as Record<string, DirectorySortMode>;
    } catch {
      return {};
    }
  });
  const [status, setStatus] = useState("Disconnected");
  const [file, setFile] = useState<FilePayload | null>(null);
  const [viewerSelection, setViewerSelection] = useState<ViewerSelection | null>(null);
  const [attachedFileContext, setAttachedFileContext] = useState<AttachedFileContext | null>(null);
  const [pluginVersion, setPluginVersion] = useState(0);
  const [pluginLoading, setPluginLoading] = useState(false);
  const [pluginBypass, setPluginBypass] = useState(false);
  const [pluginQuery, setPluginQuery] = useState<Record<string, string>>(() => readURLState().pluginQuery);
  const pluginQueryRef = useRef<Record<string, string>>(readURLState().pluginQuery);
  const [showHiddenFiles, setShowHiddenFiles] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateState>(() => normalizeUpdateState(null));
  const [updateSubmitting, setUpdateSubmitting] = useState(false);

  const ensureCompletionAudioContext = useCallback((): AudioContext | null => {
    if (typeof window === "undefined") {
      return null;
    }
    const AudioContextCtor = window.AudioContext || (window as typeof window & {
      webkitAudioContext?: typeof AudioContext;
    }).webkitAudioContext;
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
      void audioContext.resume().then(() => {
        completionAudioUnlockedRef.current = audioContext.state === "running";
      }).catch(() => {
      });
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
    if (status === "downloading" || status === "installing" || status === "restarting") {
      return;
    }
    if (next.has_update && status === "available") {
      const target = next.latest_version ? `v${next.latest_version}` : "the latest version";
      if (!window.confirm(`Install ${target} now? MindFS will restart after the update finishes.`)) {
        return;
      }
    }
    setUpdateSubmitting(true);
    try {
      setUpdateState(normalizeUpdateState(await triggerUpdate()));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start update";
      setUpdateState((prev) => normalizeUpdateState({
        ...prev,
        status: "failed",
        message,
      }));
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

  useEffect(() => { currentRootIdRef.current = currentRootId; }, [currentRootId]);
  useEffect(() => { expandedRef.current = expanded; }, [expanded]);
  useEffect(() => { selectedDirRef.current = selectedDir; }, [selectedDir]);
  useEffect(() => { entriesByPathRef.current = entriesByPath; }, [entriesByPath]);
  useEffect(() => { fileRef.current = file; }, [file]);
  useEffect(() => { viewerSelectionRef.current = viewerSelection; }, [viewerSelection]);
  useEffect(() => { pluginQueryRef.current = pluginQuery; }, [pluginQuery]);
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
  useEffect(() => { selectedSessionRef.current = selectedSession; }, [selectedSession]);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  useEffect(() => { currentSessionRef.current = currentSession; }, [currentSession]);
  useEffect(() => { interactionModeRef.current = interactionMode; }, [interactionMode]);
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
    window.localStorage.setItem(DIRECTORY_SORT_OVERRIDES_STORAGE_KEY, JSON.stringify(directorySortOverrides));
  }, [directorySortOverrides]);
  useEffect(() => {
    const rootID = currentRootId;
    if (!rootID) return;
    setActiveBoundSessionKey(boundSessionByRootRef.current[rootID] || null);
    setCurrentSession(drawerSessionByRootRef.current[rootID] || null);
    setIsDrawerOpen(!!drawerOpenByRootRef.current[rootID]);
  }, [currentRootId]);

  const setBoundSessionForRoot = useCallback((rootID: string | null | undefined, key: string | null) => {
    if (!rootID) return;
    boundSessionByRootRef.current[rootID] = key;
    if (currentRootIdRef.current === rootID) {
      setActiveBoundSessionKey(key);
    }
  }, []);

  const setDrawerSessionForRoot = useCallback((rootID: string | null | undefined, session: Session | null) => {
    if (!rootID) return;
    drawerSessionByRootRef.current[rootID] = session;
    if (currentRootIdRef.current === rootID) {
      setCurrentSession(session);
    }
  }, []);

  const setDrawerOpenForRoot = useCallback((rootID: string | null | undefined, open: boolean) => {
    if (!rootID) return;
    drawerOpenByRootRef.current[rootID] = open;
    if (currentRootIdRef.current === rootID) {
      setIsDrawerOpen(open);
    }
  }, []);

  const getDirectorySortKey = useCallback((rootID: string | null | undefined, dirPath: string | null | undefined) => {
    if (!rootID) {
      return "";
    }
    const normalizedDir = !dirPath || dirPath === rootID ? "." : dirPath;
    return `${rootID}:${normalizedDir}`;
  }, []);

  const currentDirectorySortKey = getDirectorySortKey(currentRootId, selectedDir);
  const currentDirectorySortOverride = currentDirectorySortKey ? directorySortOverrides[currentDirectorySortKey] : undefined;
  const currentDirectorySortMode = currentDirectorySortOverride || treeSortMode;

  const replaceURLState = useCallback((next: URLState) => {
    const search = buildURLSearch(next);
    const target = `${window.location.pathname}${search}`;
    window.history.replaceState(null, "", target);
  }, []);

  const redirectToRelayLogin = useCallback(() => {
    const next = encodeURIComponent(`${window.location.pathname}${window.location.search}`);
    window.location.replace(`/login?next=${next}`);
  }, []);

  const redirectToRelayNodes = useCallback(() => {
    window.location.replace("/nodes");
  }, []);

  const handleRelayNavigationFailure = useCallback((status: number, errorCode?: string | null) => {
    if (!isRelayPWAContext()) {
      return false;
    }
    const code = String(errorCode || "").trim();
    if (status === 401 || code === "unauthorized") {
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
  }, [redirectToRelayLogin, redirectToRelayNodes]);

  const rootSessionKey = useCallback((rootId: string, sessionKey: string) => `${rootId}::${sessionKey}`, []);
  const bumpCacheVersion = useCallback(() => setCacheVersion((v) => v + 1), []);
  const mergeSessionItems = useCallback((current: SessionItem[], incoming: SessionItem[]) => {
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
  }, []);
  const resolveRootForSessionKey = useCallback((sessionKey: string): string | null => {
    if (!sessionKey) return null;
    const currentRoot = currentRootIdRef.current;
    if (currentRoot && sessionCacheRef.current[rootSessionKey(currentRoot, sessionKey)]) {
      return currentRoot;
    }
    for (const [rootID, key] of Object.entries(boundSessionByRootRef.current)) {
      if (key === sessionKey) {
        return rootID;
      }
    }
    for (const [rootID, session] of Object.entries(drawerSessionByRootRef.current)) {
      if (session?.key === sessionKey) {
        return rootID;
      }
    }
    const suffix = `::${sessionKey}`;
    const matched = Object.keys(sessionCacheRef.current).find((key) => key.endsWith(suffix));
    if (!matched) return null;
    return matched.slice(0, matched.length-suffix.length);
  }, [rootSessionKey]);
  const getSessionSnapshot = useCallback((rootId: string | null | undefined, session: Session | SessionItem | null | undefined) => {
    if (!rootId || !session) return null;
    const key = (session as any).key || (session as any).session_key;
    if (!key) return null;
    const ck = rootSessionKey(rootId, key);
    const cached = sessionCacheRef.current[ck];
    const drawerSession = drawerSessionByRootRef.current[rootId];
    const fallbackExchanges = Array.isArray((session as any).exchanges) ? ((session as any).exchanges as Exchange[]) : [];
    const exchanges = Array.isArray((cached as any)?.exchanges) ? (((cached as any).exchanges as Exchange[]) || []) : fallbackExchanges;
    const pending = drawerSession?.key === key
      ? !!(drawerSession as any)?.pending
      : typeof (session as any)?.pending === "boolean"
        ? !!(session as any).pending
        : typeof (cached as any)?.pending === "boolean"
          ? !!(cached as any).pending
          : undefined;
    return { ...(session as any), ...(cached as any), ...(drawerSession?.key === key ? (drawerSession as any) : null), key, exchanges, pending } as any;
  }, [rootSessionKey, cacheVersion]);

  const setSelectedPendingByKey = useCallback((sessionKey: string, pending: boolean) => {
    setSelectedSession((prev) => {
      const prevKey = prev?.key || prev?.session_key;
      if (!prev || prevKey !== sessionKey) return prev;
      return { ...(prev as any), pending } as SessionItem;
    });
  }, []);

  const updateSessionRelatedFilesForKey = useCallback((rootID: string, sessionKey: string, relatedFiles: RelatedFile[]) => {
    if (!rootID || !sessionKey) return;
    const cacheKey = rootSessionKey(rootID, sessionKey);
    const cached = sessionCacheRef.current[cacheKey];
    const nextRelatedFiles = Array.isArray(relatedFiles) ? [...relatedFiles] : [];
    if (cached) {
      sessionCacheRef.current[cacheKey] = {
        ...(cached as any),
        related_files: nextRelatedFiles,
      } as Session;
    }
    setSelectedSession((prev) => {
      const prevKey = prev?.key || prev?.session_key;
      const prevRoot = (prev?.root_id as string | undefined) || currentRootIdRef.current;
      if (!prev || prevKey !== sessionKey || prevRoot !== rootID) return prev;
      return { ...(prev as any), related_files: nextRelatedFiles } as SessionItem;
    });
    const current = drawerSessionByRootRef.current[rootID];
    if (current && current.key === sessionKey) {
      setDrawerSessionForRoot(rootID, { ...(current as any), related_files: nextRelatedFiles } as Session);
    }
    bumpCacheVersion();
  }, [rootSessionKey, setDrawerSessionForRoot, bumpCacheVersion]);

  const updateSessionAgentForKey = useCallback((rootID: string, sessionKey: string, agent: string, model?: string) => {
    if (!rootID || !sessionKey || !agent) return;
    const cacheKey = rootSessionKey(rootID, sessionKey);
    const cached = sessionCacheRef.current[cacheKey];
    if (cached) {
      sessionCacheRef.current[cacheKey] = {
        ...(cached as any),
        agent,
        model: model || "",
        updated_at: new Date().toISOString(),
      } as Session;
    }
    setSelectedSession((prev) => {
      const prevKey = prev?.key || prev?.session_key;
      const prevRoot = (prev?.root_id as string | undefined) || currentRootIdRef.current;
      if (!prev || prevKey !== sessionKey || prevRoot !== rootID) return prev;
      return { ...(prev as any), agent, model: model || "" } as SessionItem;
    });
    const current = drawerSessionByRootRef.current[rootID];
    if (current && current.key === sessionKey && (current.agent !== agent || (current as any).model !== (model || ""))) {
      setDrawerSessionForRoot(rootID, { ...(current as any), agent, model: model || "" } as Session);
    }
    bumpCacheVersion();
  }, [rootSessionKey, setDrawerSessionForRoot, bumpCacheVersion]);

  const resolveAgentForSession = useCallback((rootID: string, sessionKey: string, fallbackAgent?: string): string => {
    if (fallbackAgent) return fallbackAgent;
    const cacheKey = rootSessionKey(rootID, sessionKey);
    const cached = sessionCacheRef.current[cacheKey] as any;
    if (cached?.agent) return cached.agent;
    const current = currentSessionRef.current as any;
    if (current?.key === sessionKey && current?.agent) return current.agent;
    const selected = selectedSessionRef.current as any;
    if ((selected?.key || selected?.session_key) === sessionKey && selected?.agent) return selected.agent;
    return "";
  }, [rootSessionKey]);

  const appendAgentChunkForSession = useCallback((rootID: string, sessionKey: string, content: string, agentHint?: string) => {
    if (!content) return;
    const now = new Date().toISOString();
    const cacheKey = rootSessionKey(rootID, sessionKey);
    const resolvedAgent = resolveAgentForSession(rootID, sessionKey, agentHint);
    const updateList = (prevList: Exchange[]) => {
      const list = [...(prevList || [])];
      const last = list.length > 0 ? list[list.length - 1] : null;
      if (last && (last.role === "agent" || last.role === "assistant")) {
        list[list.length - 1] = { ...last, agent: last.agent || resolvedAgent, content: `${last.content || ""}${content}`, timestamp: now };
        return list;
      }
      list.push({ role: "agent", agent: resolvedAgent, content, timestamp: now });
      return list;
    };
    const cached = sessionCacheRef.current[cacheKey];
    const base = cached || ({
      key: sessionKey,
      type: "chat",
      agent: resolvedAgent,
      name: "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      exchanges: [],
    } as any);
    const nextList = updateList((((base as any).exchanges || []) as Exchange[]));
    sessionCacheRef.current[cacheKey] = {
      ...(base as any),
      agent: (base as any).agent || resolvedAgent,
      exchanges: nextList,
      updated_at: new Date().toISOString(),
    } as Session;
    bumpCacheVersion();
  }, [rootSessionKey, resolveAgentForSession, bumpCacheVersion]);

  const appendThoughtChunkForSession = useCallback((rootID: string, sessionKey: string, content: string) => {
    if (!content) return;
    const now = new Date().toISOString();
    const cacheKey = rootSessionKey(rootID, sessionKey);
    const updateList = (prevList: Exchange[]) => {
      const list = [...(prevList || [])];
      const last = list.length > 0 ? list[list.length - 1] : null;
      if (last && last.role === "thought") {
        list[list.length - 1] = { ...last, content: `${last.content || ""}${content}`, timestamp: now };
        return list;
      }
      list.push({ role: "thought", content, timestamp: now });
      return list;
    };
    const cached = sessionCacheRef.current[cacheKey];
    const base = cached || ({
      key: sessionKey,
      type: "chat",
      agent: "",
      name: "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      exchanges: [],
    } as any);
    const nextList = updateList((((base as any).exchanges || []) as Exchange[]));
    sessionCacheRef.current[cacheKey] = {
      ...(base as any),
      exchanges: nextList,
      updated_at: new Date().toISOString(),
    } as Session;
    bumpCacheVersion();
  }, [rootSessionKey, bumpCacheVersion]);

  const appendToolCallForSession = useCallback((rootID: string, sessionKey: string, toolCall: any, update: boolean) => {
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
      const callId = toolCall.callId || toolCall.toolCallId || toolCall.tool_call_id || "";
      if (update && callId) {
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i]?.role === "tool" && (list[i]?.toolCall?.callId === callId || list[i]?.toolCall?.toolCallId === callId || list[i]?.toolCall?.tool_call_id === callId)) {
            list[i] = { ...list[i], timestamp: now, toolCall: mergeToolCall(list[i].toolCall, toolCall) };
            return list;
          }
        }
      }
      list.push({ role: "tool", content: "", timestamp: now, toolCall });
      return list;
    };
    const cached = sessionCacheRef.current[cacheKey];
    const base = cached || ({
      key: sessionKey,
      type: "chat",
      agent: "",
      name: "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      exchanges: [],
    } as any);
    const nextList = updateList((((base as any).exchanges || []) as Exchange[]));
    sessionCacheRef.current[cacheKey] = {
      ...(base as any),
      exchanges: nextList,
      updated_at: new Date().toISOString(),
    } as Session;
    bumpCacheVersion();
  }, [rootSessionKey, bumpCacheVersion]);

  const normalizeTreeResponse = useCallback((payload: any) => {
    if (payload && payload.entries) return { entries: payload.entries as FileEntry[] };
    return { entries: [] };
  }, []);

  const refreshTreeDir = useCallback(async (rootID: string, dirPath: string, syncMain: boolean) => {
    try {
      const res = await fetch(appURL("/api/tree", new URLSearchParams({ root: rootID, dir: dirPath })));
      if (!res.ok) return;
      const payload = await res.json();
      const parsed = normalizeTreeResponse(payload);
      setEntriesByPath((prev) => ({ ...prev, [`${rootID}:${dirPath}`]: parsed.entries }));
      if (syncMain) {
        setMainEntries(parsed.entries);
      }
    } catch {
    }
  }, [normalizeTreeResponse]);

  const refreshCurrentFileContent = useCallback(async (rootID: string, changedPath: string) => {
    const currentFile = fileRef.current;
    if (!currentFile) return;
    const currentRoot = currentFile.root || currentRootIdRef.current || "";
    if (currentRoot !== rootID || currentFile.path !== changedPath) return;

    let readMode: "incremental" | "full" = "incremental";
    if (!pluginBypassRef.current) {
      try {
        const plugin = pluginManagerRef.current.match(rootID, buildMatchInputFromPath(changedPath, pluginQueryRef.current));
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
      if (!next || !latestFile || latestRoot !== rootID || latestFile.path !== changedPath) {
        return;
      }
      setFile({
        ...next,
        targetLine: latestFile.targetLine,
        targetColumn: latestFile.targetColumn,
      });
    } catch (err) {
      console.error("[file.refresh.changed] failed", { rootID, changedPath, err });
    }
  }, []);

  const refreshGitStatus = useCallback(async (rootID: string) => {
    if (!rootID) {
      setGitStatus(null);
      return null;
    }
    setGitStatusLoading(true);
    try {
      const next = await fetchGitStatus(rootID);
      setGitStatus(next);
      return next;
    } catch (err) {
      console.error("[git.status] failed", { rootID, err });
      const fallback = { available: false, dirty_count: 0, items: [] } as GitStatusPayload;
      setGitStatus(fallback);
      return fallback;
    } finally {
      setGitStatusLoading(false);
    }
  }, []);

  const openGitDiff = useCallback(async (rootID: string, item: GitStatusItem) => {
    if (!rootID || !item?.path) {
      return;
    }
    fileOpenRequestRef.current += 1;
    setSelectedSession(null);
    setFile(null);
    setGitDiff(null);
    replaceURLState({ root: rootID, file: "", session: "", cursor: 0, pluginQuery: {} });
    try {
      const next = await fetchGitDiff(rootID, item.path);
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
  }, [isMobile, replaceURLState]);

  const handleTreeUpload = useCallback(async (files: File[]) => {
    const rootID = currentRootIdRef.current;
    if (!rootID || files.length === 0) return;

    const selectedDirPath = selectedDirRef.current === rootID ? "." : selectedDirRef.current;
    const targetDir = selectedDirPath || (fileRef.current?.path ? dirnameOfPath(fileRef.current.path) : ".");
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
      const currentDir = (selectedDirRef.current === rootID ? "." : selectedDirRef.current) || ".";
      const syncMain = rootID === currentRootIdRef.current && currentDir === targetDir;
      await refreshTreeDir(rootID, targetDir, syncMain);
      setExpanded((prev) => Array.from(new Set([
        ...prev,
        rootID,
        targetDir === "." ? rootID : `${rootID}:${targetDir}`,
      ])));
    } catch (err) {
      reportError("file.write_failed", String((err as Error)?.message || "上传文件失败"));
    }
  }, [refreshTreeDir]);

  const handleSelectSession = useCallback(async (session: any) => {
    const key = session?.key || session?.session_key;
    const targetRoot = (session?.root_id as string | undefined) || currentRootIdRef.current;
    if (!targetRoot || !key) return;
    const currentDrawer = drawerSessionByRootRef.current[targetRoot];
    const preservePending = currentDrawer?.key === key
      ? !!(currentDrawer as any)?.pending
      : !!(session as any)?.pending;
    replaceURLState({ root: targetRoot, file: "", session: key, cursor: 0, pluginQuery: {} });
    setSelectedSession({ ...(session as any), pending: preservePending } as SessionItem);
    setInteractionMode("main");
    setDrawerOpenForRoot(targetRoot, false);
    if (isMobile) setIsRightOpen(false);
    const cacheKey = rootSessionKey(targetRoot, key);
    const applySession = (fullSession: Session) => {
      const normalized = { ...(fullSession as any), key } as Session;
      sessionCacheRef.current[cacheKey] = normalized;
      setSelectedSession((prev) => {
        const prevKey = prev?.key || prev?.session_key;
        const prevRoot = (prev?.root_id as string | undefined) || currentRootIdRef.current;
        if (prevKey !== key || prevRoot !== targetRoot) {
          return prev;
        }
        return {
          ...(prev as any),
          ...(normalized as any),
          pending: typeof (prev as any)?.pending === "boolean" ? !!(prev as any).pending : preservePending,
          key,
          session_key: key,
          root_id: targetRoot,
        } as SessionItem;
      });
      if ((boundSessionByRootRef.current[targetRoot] || null) === key) {
        const activeDrawer = drawerSessionByRootRef.current[targetRoot];
        setDrawerSessionForRoot(targetRoot, {
          ...(normalized as any),
          pending: activeDrawer?.key === key ? !!(activeDrawer as any)?.pending : preservePending,
        } as Session);
      }
      bumpCacheVersion();
    };
    const cached = sessionCacheRef.current[cacheKey];
    if (cached) {
      applySession(cached);
      if (hasSessionExchanges(cached)) {
        loadedSessionRef.current[cacheKey] = true;
        return;
      }
    } else {
      const persisted = await getCachedSession(targetRoot, key);
      if (persisted) {
        applySession(persisted);
      }
    }
    if (loadedSessionRef.current[cacheKey]) {
      return;
    }
    try {
      const inflight = loadingSessionRef.current[cacheKey];
      if (inflight) {
        const fullSession = await inflight;
        if (fullSession) applySession(fullSession);
        return;
      }
      const request = syncSession(targetRoot, key)
        .finally(() => {
          delete loadingSessionRef.current[cacheKey];
        });
      loadingSessionRef.current[cacheKey] = request;
      const syncResult = await request;
      const fullSession = syncResult.session;
      if (fullSession) {
        applySession(fullSession as Session);
        loadedSessionRef.current[cacheKey] = true;
        void sessionService.markSessionReady(targetRoot, key);
      }
    } catch (err) {}
  }, [isMobile, rootSessionKey, bumpCacheVersion, setDrawerOpenForRoot, setDrawerSessionForRoot, replaceURLState]);

  const handleDeleteSession = useCallback(async (session: SessionItem) => {
    const sessionKey = session?.key || session?.session_key;
    const rootID = (session?.root_id as string | undefined) || currentRootIdRef.current;
    if (!rootID || !sessionKey) return;

    const deleted = await sessionService.deleteSession(rootID, sessionKey);
    if (!deleted) {
      reportError("session.delete_failed", "删除会话失败");
      return;
    }

    setSessions((prev) => prev.filter((item) => (item.key || item.session_key) !== sessionKey));

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
    if (drawerSessionByRootRef.current[rootID]?.key === sessionKey) {
      setDrawerSessionForRoot(rootID, null);
      setDrawerOpenForRoot(rootID, false);
    }

    const selectedKey = selectedSessionRef.current?.key || selectedSessionRef.current?.session_key;
    const selectedRoot = (selectedSessionRef.current?.root_id as string | undefined) || currentRootIdRef.current;
    if (selectedKey === sessionKey && selectedRoot === rootID) {
      setSelectedSession(null);
      replaceURLState({
        root: rootID,
        file: fileRef.current?.root === rootID ? fileRef.current.path : "",
        session: "",
        cursor: fileCursorRef.current || 0,
        pluginQuery: fileRef.current?.root === rootID ? pluginQuery : {},
      });
    }

    bumpCacheVersion();
  }, [bumpCacheVersion, pluginQuery, replaceURLState, rootSessionKey, setBoundSessionForRoot, setDrawerOpenForRoot, setDrawerSessionForRoot]);

  useEffect(() => {
    handleSelectSessionRef.current = handleSelectSession;
  }, [handleSelectSession]);

  const handleSendMessage = useCallback(async (message: string, mode: SessionMode, agent: string, model?: string) => {
    const activeRoot = currentRootIdRef.current;
    if (!activeRoot) return;
    const selected = selectedSessionRef.current;
    const selectedKey = selected?.key || selected?.session_key;
    const isMainSessionView =
      interactionModeRef.current !== "drawer" &&
      !!selectedKey &&
      (((selected as any)?.root_id as string | undefined) || activeRoot) === activeRoot;
    let sendSessionKey = isMainSessionView && selectedKey && !selectedKey.startsWith("pending-")
      ? selectedKey
      : activeBoundSessionKey;
    let session: Session | null = null;
    if (sendSessionKey) {
      session = sessionCacheRef.current[rootSessionKey(activeRoot, sendSessionKey)];
      if (!session) {
        const current = currentSessionRef.current;
        if (current?.key === sendSessionKey) {
          session = current as Session;
        }
      }
      if (!session && selectedKey === sendSessionKey) {
        session = ({ ...(selected as any), key: sendSessionKey } as Session);
      }
    } else {
      if (selectedKey && !selectedKey.startsWith("pending-")) {
        sendSessionKey = selectedKey;
        session = sessionCacheRef.current[rootSessionKey(activeRoot, sendSessionKey)] || ({ ...selected, key: selectedKey } as Session);
      }
    }
    let effectiveMode = mode, effectiveAgent = agent, effectiveModel = model || "";
    if (sendSessionKey && session) {
      const previousAgent = session.agent || "";
      effectiveMode = normalizeMode(session.type as any);
      effectiveAgent = agent || previousAgent || "";
      effectiveModel = model || (effectiveAgent === previousAgent ? session.model || "" : "");
      updateSessionAgentForKey(activeRoot, sendSessionKey, effectiveAgent, effectiveModel);
      session = {
        ...(session as any),
        agent: effectiveAgent,
        model: effectiveModel,
      } as Session;
      setBoundSessionForRoot(activeRoot, sendSessionKey);
      setSelectedPendingByKey(sendSessionKey, true);
      setDrawerSessionForRoot(activeRoot, { ...(session as any), pending: true } as Session);
    } else {
      sendSessionKey = undefined;
      const tempKey = `pending-${Date.now()}`;
      session = { key: tempKey, type: mode, agent, model: effectiveModel, name: "新会话", pending: true } as any;
    }
    const now = new Date().toISOString();
    const userEx: Exchange = { role: "user", content: message, timestamp: now };
    if (sendSessionKey) {
      const ck = rootSessionKey(activeRoot, sendSessionKey);
      const cached = sessionCacheRef.current[ck] || ({ ...(session as any) } as Session);
      const prevExchanges = Array.isArray((cached as any).exchanges) ? ((cached as any).exchanges as Exchange[]) : [];
      sessionCacheRef.current[ck] = {
        ...(cached as any),
        exchanges: [...prevExchanges, userEx],
        updated_at: now,
      } as Session;
      bumpCacheVersion();
    } else {
      pendingDraftRef.current = { rootId: activeRoot, mode: effectiveMode, agent: effectiveAgent, model: effectiveModel, message, timestamp: now };
      session = {
        ...(session as any),
        exchanges: [userEx],
        updated_at: now,
      } as Session;
    }
    const isBoundInMain = !!selectedSessionRef.current && selectedSessionRef.current.key === sendSessionKey && interactionModeRef.current !== "drawer";
    if (!isBoundInMain) { setInteractionMode("drawer"); setDrawerOpenForRoot(activeRoot, true); }
    setDrawerSessionForRoot(activeRoot, { ...(session as any), pending: true } as Session);
    const explicitFileContext = hasExplicitFileContext(message);
    const selection = explicitFileContext || !attachedFileContext?.filePath
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
      pluginCatalog: effectiveMode === "plugin" ? getViewModeSystemPrompt() : undefined,
    });
    const sent = await sessionService.sendMessage(activeRoot, sendSessionKey, message, effectiveMode, effectiveAgent, effectiveModel || undefined, context);
    if (!sent && sendSessionKey) {
      setSelectedPendingByKey(sendSessionKey, false);
      const latest = drawerSessionByRootRef.current[activeRoot];
      if (latest && latest.key === sendSessionKey) {
        setDrawerSessionForRoot(activeRoot, { ...(latest as any), pending: false } as Session);
      }
    }
  }, [activeBoundSessionKey, attachedFileContext, rootSessionKey, setSelectedPendingByKey, bumpCacheVersion, setBoundSessionForRoot, setDrawerOpenForRoot, setDrawerSessionForRoot, updateSessionAgentForKey]);

  const handleCancelCurrentTurn = useCallback(async (sessionKey: string) => {
    const activeRoot = currentRootIdRef.current;
    if (!activeRoot || !sessionKey) return;
    const cacheKey = rootSessionKey(activeRoot, sessionKey);
    cancelRequestedBySessionRef.current[cacheKey] = true;
    const sent = await sessionService.cancelMessage(activeRoot, sessionKey);
    if (!sent) {
      delete cancelRequestedBySessionRef.current[cacheKey];
    }
  }, [rootSessionKey]);

  const handleNewSession = useCallback(() => {
    const rootID = currentRootIdRef.current;
    setSelectedSession(null);
    setBoundSessionForRoot(rootID, null);
    setDrawerSessionForRoot(rootID, null);
    setInteractionMode("main"); setDrawerOpenForRoot(rootID, false);
  }, [setBoundSessionForRoot, setDrawerOpenForRoot, setDrawerSessionForRoot]);

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

  const buildAttachedFileContext = useCallback((currentSource: { path: string; name: string } | null, selection: ViewerSelection | null): AttachedFileContext | null => {
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
  }, []);

  const handleRequestFileContext = useCallback(() => {
    const currentSource = currentSelectionSource;
    if (dismissedSelectionFileRef.current && dismissedSelectionFileRef.current === currentSource?.path) {
      return;
    }
    const liveSelection = viewerSelectionRef.current;
    const fallbackSelection = lastViewerSelectionRef.current;
    const nextSelection = liveSelection?.filePath === currentSource?.path
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

  const handleViewerSelectionChange = useCallback((next: ViewerSelection | null) => {
    setViewerSelection(next);
    if (next?.filePath) {
      dismissedSelectionFileRef.current = null;
      lastViewerSelectionRef.current = next;
    }
  }, []);

  useEffect(() => {
    const currentPath = currentSelectionSource?.path;
    if (!currentPath) {
      dismissedSelectionFileRef.current = null;
      lastViewerSelectionRef.current = null;
      setViewerSelection(null);
      setAttachedFileContext(null);
      return;
    }
    if (dismissedSelectionFileRef.current && dismissedSelectionFileRef.current !== currentPath) {
      dismissedSelectionFileRef.current = null;
    }
    if (lastViewerSelectionRef.current?.filePath !== currentPath) {
      lastViewerSelectionRef.current = null;
    }
    setViewerSelection((prev) => (prev?.filePath === currentPath ? prev : null));
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
    const key = buildFileScrollKey(currentFile?.root || currentRootIdRef.current, currentFile?.path);
    if (!key) return;
    if (!(key in fileScrollPositionsRef.current)) {
      fileScrollPositionsRef.current[key] = 0;
      persistFileScrollPositions(fileScrollPositionsRef.current);
    }
  }, []);

  const actionHandlers = useMemo(() => ({
    open: async (params: any) => {
      const requestId = ++fileOpenRequestRef.current;
      const isStale = () => fileOpenRequestRef.current !== requestId;
      const parsedLocation = parseFileLocation(String(params.path || ""));
      const root = params.root || currentRootIdRef.current;
      const rootInfo = root ? managedRootByIdRef.current[String(root)] : undefined;
      const path = normalizePathForRoot(parsedLocation.path, rootInfo?.root_path);
      if (!path || !root) return;
      rememberCurrentFileScroll();
      setGitDiff(null);
      const currentFilePath = fileRef.current?.path || "";
      const currentFileRoot = fileRef.current?.root || currentRootIdRef.current || "";
      const isFileSwitch = currentFilePath !== String(path) || currentFileRoot !== String(root);
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
      const persistedQuery = loadPersistedPluginQuery(String(root), String(path));
      const urlQuery = preserveQuery ? parsePluginQuery(window.location.search) : {};
      // Priority: URL query > localStorage persisted query.
      const nextPluginQuery = preserveQuery ? { ...persistedQuery, ...urlQuery } : persistedQuery;
      setPluginQuery(nextPluginQuery);
      replaceURLState({ root, file: path, session: "", cursor, pluginQuery: nextPluginQuery });
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
          if (entriesByPathRef.current[`${root}:${dir}`]) {
            continue;
          }
          try {
            const res = await fetch(appURL("/api/tree", new URLSearchParams({ root: String(root), dir })));
            if (!res.ok) continue;
            const payload = await res.json();
            const parsed = normalizeTreeResponse(payload);
            setEntriesByPath((prev) => ({ ...prev, [`${root}:${dir}`]: parsed.entries }));
          } catch {
          }
        }
      };

      void expandAndLoadTreeForFile();
      try {
        const fetchFileWithMode = async (mode: "full" | "incremental", timeoutMs?: number) =>
          fetchFile({
            rootId: String(root),
            path: String(path),
            readMode: mode,
            cursor,
            timeoutMs,
          });

        let readMode: "incremental" | "full" = params.readMode === "full" ? "full" : "incremental";
        let requiresFull = params.readMode === "full";
        if (params.readMode !== "full" && params.readMode !== "incremental") {
          const currentFilePath = fileRef.current?.path || "";
          const currentFileRoot = (fileRef.current?.root || currentRootIdRef.current || "");
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
            const plugin = pluginManagerRef.current.match(root, buildMatchInputFromPath(path, nextPluginQuery));
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
          next = await fetchFileWithMode(readMode, requiresFull ? undefined : (readMode === "full" ? 1500 : undefined));
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
        setDrawerOpenForRoot(root, false);
        if (isMobile) setIsLeftOpen(false);
      } catch (err) {
        const status = extractHTTPStatusFromErrorMessage((err as Error)?.message || "");
        if (status && handleRelayNavigationFailure(status, "")) {
          return;
        }
        console.error("[file.open] failed", { root, path, cursor, err });
      }
    },
    open_dir: async (params: any) => {
      fileOpenRequestRef.current += 1;
      const path = params.path, rootParam = params.root || currentRootIdRef.current, isToggle = !!params.toggle;
      if (!path || !rootParam) return;
      setGitDiff(null);
      const isActuallyRoot = params.isRoot === true;
      const root = isActuallyRoot ? path : rootParam;
      const expandedKey = isActuallyRoot ? path : `${root}:${path}`;
      const preserveQuery = !!params.preservePluginQuery;
      const nextPluginQuery = preserveQuery ? parsePluginQuery(window.location.search) : {};
      const loadDirectoryView = async (targetPath: string, targetIsRoot: boolean) => {
        const apiDir = targetIsRoot ? "." : targetPath;
        if (currentRootIdRef.current !== root) {
          setCurrentRootId(root);
        }
        setFile(null);
        setSelectedSession(null);
        setMainEntries([]);
        setPluginQuery(nextPluginQuery);
        replaceURLState({ root, file: "", session: "", cursor: 0, pluginQuery: nextPluginQuery });
        try {
          const res = await fetch(appURL("/api/tree", new URLSearchParams({ root, dir: apiDir })));
          if (!res.ok) {
            const payload = await res.json().catch(() => ({}));
            if (handleRelayNavigationFailure(res.status, typeof payload?.error === "string" ? payload.error : "")) {
              return;
            }
            return;
          }
          const payload = await res.json();
          const parsed = normalizeTreeResponse(payload);
          setEntriesByPath((prev) => ({ ...prev, [`${root}:${apiDir}`]: parsed.entries }));
          setMainEntries(parsed.entries);
          setSelectedDir(targetPath);
          setSelectedDirKey(buildDirectorySelectionKey(root, targetPath, targetIsRoot));
          setFile(null);
          setSelectedSession(null);
          fileCursorRef.current = 0;
          setDrawerOpenForRoot(root, false);
          if (isMobile) setIsLeftOpen(false);
        } catch {}
      };
      if (isToggle && expandedRef.current.includes(expandedKey)) {
        setExpanded((prev) => prev.filter(k => k !== expandedKey));
        if (!isActuallyRoot) {
          const parentDir = dirnameOfPath(path);
          const parentPath = parentDir === "." ? root : parentDir;
          await loadDirectoryView(parentPath, parentDir === ".");
        }
        return;
      }
      if (isActuallyRoot) { setCurrentRootId(path); setExpanded((prev) => Array.from(new Set([...prev, path]))); } else { setExpanded((prev) => Array.from(new Set([...prev, expandedKey]))); }
      await loadDirectoryView(path, isActuallyRoot);
    }
  }), [handleRelayNavigationFailure, isMobile, normalizeTreeResponse, setDrawerOpenForRoot, replaceURLState, rememberCurrentFileScroll]);
  const actionHandlersRef = useRef(actionHandlers);
  useEffect(() => {
    actionHandlersRef.current = actionHandlers;
  }, [actionHandlers]);

  const refreshManagedRoots = useCallback(async () => {
    const response = await fetch(appPath("/api/dirs"));
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      if (handleRelayNavigationFailure(response.status, typeof payload?.error === "string" ? payload.error : "")) {
        return;
      }
      return;
    }
    const dirs = await response.json() as ManagedRootPayload[];
    const nextDirs = Array.isArray(dirs) ? dirs : [];
    const nextRootIds = nextDirs.map((dir) => dir.id).filter(Boolean);
    managedRootByIdRef.current = Object.fromEntries(nextDirs.filter((dir) => !!dir.id).map((dir) => [dir.id, dir]));

    managedRootIdsRef.current = new Set(nextRootIds);
    setManagedRootIds(nextRootIds);
    setRootEntries(mapManagedRootsToEntries(nextDirs));

    if (nextRootIds.length === 0) {
      setCurrentRootId(null);
      setSelectedDir(null);
      setSelectedDirKey(null);
      setMainEntries([]);
      setFile(null);
      setSelectedSession(null);
      setSessions([]);
      setCurrentSession(null);
      setActiveBoundSessionKey(null);
      setInteractionMode("main");
      setIsDrawerOpen(false);
      replaceURLState({ root: "", file: "", session: "", cursor: 0, pluginQuery: {} });
      return;
    }

    const currentRoot = currentRootIdRef.current;
    if (currentRoot && nextRootIds.includes(currentRoot)) {
      return;
    }

    const nextRoot = nextRootIds[0];
    await actionHandlersRef.current.open_dir({ path: nextRoot, root: nextRoot, preservePluginQuery: true, isRoot: true });
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
      const payload = await response.json() as RelayStatusPayload;
      setRelayStatus(payload);
      return payload;
    } catch {
      return;
    }
  }, []);

  const handleCreateRootStart = useCallback(() => {
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
    setCreatingRootName(nextName);
  }, [creatingRootBusy]);

  const handleCreateRootCancel = useCallback(() => {
    if (creatingRootBusy) {
      return;
    }
    setCreatingRootName(null);
  }, [creatingRootBusy]);

  const handleCreateRootSubmit = useCallback(async () => {
    const name = String(creatingRootName || "").trim();
    if (!name) {
      setCreatingRootName(null);
      return;
    }
    if (creatingRootBusy) {
      return;
    }
    setCreatingRootBusy(true);
    try {
      const response = await fetch(appPath("/api/dirs"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: name, create: true }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String(payload?.message || payload?.error || "新建项目失败"));
      }
      const created = payload as ManagedRootPayload;
      setCreatingRootName(null);
      await refreshManagedRoots();
      if (created?.id) {
        await actionHandlersRef.current.open_dir({ path: created.id, root: created.id, isRoot: true });
      }
    } catch (err) {
      reportError("root.create_failed", String((err as Error)?.message || "新建项目失败"));
    } finally {
      setCreatingRootBusy(false);
    }
  }, [creatingRootBusy, creatingRootName, refreshManagedRoots]);

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
      const response = await fetch(appURL("/api/dirs", new URLSearchParams({ path: rootPath })), {
        method: "DELETE",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String(payload?.message || payload?.error || "移除项目失败"));
      }
      await refreshManagedRoots();
    } catch (err) {
      reportError("root.delete_failed", String((err as Error)?.message || "移除项目失败"));
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
        const matched = sessions.find((item) => (item.key || item.session_key) === key);
        if (matched) {
          await handleSelectSession(matched);
          return;
        }
        await handleSelectSession({ key, session_key: key, root_id: root });
      },
      navigate: async (params: Record<string, unknown>) => {
        const current = readURLState();
        const nextRoot = current.root || currentRootIdRef.current || "";
        const nextPath = typeof params?.path === "string" ? params.path : current.file;
        const explicitCursor = normalizeCursor(params?.cursor);
        const rawQuery =
          params?.query && typeof params.query === "object" && !Array.isArray(params.query)
            ? (params.query as Record<string, unknown>)
            : null;

        const nextPluginQuery: Record<string, string> = { ...current.pluginQuery };
        if (rawQuery) {
          Object.entries(rawQuery).forEach(([key, value]) => {
            if (!key) return;
            nextPluginQuery[key] = String(value);
          });
        }

        let nextCursor = current.cursor;
        if (explicitCursor !== null) {
          nextCursor = explicitCursor;
        } else if (typeof params?.path === "string" && params.path !== current.file) {
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
          persistPluginQuery(nextState.root, nextState.file, nextState.pluginQuery);
        }

        const rootChanged = (nextState.root || "") !== (currentRootIdRef.current || "");
        const fileChanged = (nextState.file || "") !== (fileRef.current?.path || "");
        const pluginChanged = JSON.stringify(nextState.pluginQuery) !== JSON.stringify(current.pluginQuery);

        if (pluginChanged) {
          setPluginQuery(nextState.pluginQuery);
        }

        if (!nextState.file) {
          if (nextState.root) {
            await actionHandlers.open_dir({ path: nextState.root, root: nextState.root, preservePluginQuery: true, isRoot: true });
          }
          return;
        }

        const cursorChanged = nextState.cursor !== fileCursorRef.current;
        if (rootChanged || fileChanged || cursorChanged) {
          await actionHandlers.open({ path: nextState.file, root: nextState.root, cursor: nextState.cursor, preservePluginQuery: true });
        }
      },
    }),
    [actionHandlers, sessions, handleSelectSession, replaceURLState],
  );

  const handleSessionChipClick = useCallback((sessionKey: string, rootOverride?: string | null) => {
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
  }, [file, sessions, handleSelectSession]);

  const handleFileViewerPathClick = useCallback((path: string) => {
    if (!file) return;
    const root = file.root || currentRootIdRef.current;
    if (!root) return;
    actionHandlers.open_dir({ path: path === "." ? root : path, root, isRoot: path === "." });
  }, [file, actionHandlers]);

  const handleFileViewerFileClick = useCallback((path: string) => {
    if (!file) return;
    const root = file.root || currentRootIdRef.current;
    if (!root) return;
    actionHandlers.open({ path, root });
  }, [file, actionHandlers]);

  const handleGitDiffPathClick = useCallback((path: string) => {
    const root = currentRootIdRef.current;
    if (!root) return;
    setGitDiff(null);
    actionHandlers.open_dir({ path: path === "." ? root : path, root, isRoot: path === "." });
  }, [actionHandlers]);

  const handleDirectoryPathClick = useCallback((path: string) => {
    const root = currentRootIdRef.current;
    if (!root) return;
    actionHandlers.open_dir({ path: path === "." ? root : path, root, isRoot: path === "." });
  }, [actionHandlers]);

  const visibleMainEntries = useMemo(
    () => (showHiddenFiles ? mainEntries : mainEntries.filter((entry) => !entry.name.startsWith("."))),
    [mainEntries, showHiddenFiles],
  );

  const gitFileStatsByPath = useMemo<Record<string, GitFileStat>>(() => {
    const items = gitStatus?.items || [];
    return Object.fromEntries(items.map((item) => [
      item.path,
      { status: item.status, additions: item.additions, deletions: item.deletions },
    ]));
  }, [gitStatus]);

  const filteredGitStatus = useMemo<GitStatusPayload | null>(() => {
    if (!gitStatus) {
      return null;
    }
    const currentDir = selectedDir && selectedDir !== currentRootId ? selectedDir : ".";
    if (!currentDir || currentDir === ".") {
      return gitStatus;
    }
    const prefix = `${currentDir.replace(/^\/+|\/+$/g, "")}/`;
    const items = (gitStatus.items || [])
      .filter((item) => item.path === currentDir || item.path.startsWith(prefix))
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
    return () => {
      sessionService.disconnect();
      setStatus("Disconnected");
    };
  }, [currentRootId]);

  useEffect(() => {
    if (!currentRootId) {
      setGitStatus(null);
      setGitDiff(null);
      return;
    }
    void refreshGitStatus(currentRootId);
    setGitDiff(null);
  }, [currentRootId, refreshGitStatus]);

  useEffect(() => {
    if (!currentRootId) return;
    let cancelled = false;
    const loadSessions = async (rootID: string, options?: { beforeTime?: string; afterTime?: string; replace?: boolean }) => {
      try {
        const next = await sessionService.fetchSessions(rootID, {
          beforeTime: options?.beforeTime,
          afterTime: options?.afterTime,
        }) as SessionItem[];
        if (cancelled) return;
        setHasMoreSessions(next.length >= 50);
        if (options?.replace || (!options?.beforeTime && !options?.afterTime)) {
          setSessions(next);
          return;
        }
        setSessions((prev) => mergeSessionItems(prev, next));
      } catch {}
    };
    const reloadSessionForReplay = async (rootID: string, sessionKey: string) => {
      if (!rootID || !sessionKey) return;
      const cacheKey = rootSessionKey(rootID, sessionKey);
      const currentInMemory = sessionCacheRef.current[cacheKey];
      const inflight = loadingSessionRef.current[cacheKey];
      const request = inflight || syncSession(rootID, sessionKey).finally(() => {
        delete loadingSessionRef.current[cacheKey];
      });
      if (!inflight) {
        loadingSessionRef.current[cacheKey] = request;
      }
      const syncResult = await request;
      if (cancelled) return;
      const shouldApply = !!syncResult.session && (syncResult.hasDelta || !currentInMemory);
      if (shouldApply && syncResult.session) {
        const normalized = { ...(syncResult.session as any), key: sessionKey } as Session;
        sessionCacheRef.current[cacheKey] = normalized;
        loadedSessionRef.current[cacheKey] = true;
        bumpCacheVersion();
        if ((selectedSessionRef.current?.key || selectedSessionRef.current?.session_key) === sessionKey) {
          setSelectedSession((prev) => prev ? ({ ...(prev as any), ...(normalized as any) } as SessionItem) : prev);
        }
        if (boundSessionByRootRef.current[rootID] === sessionKey) {
          setDrawerSessionForRoot(rootID, normalized);
        }
      }
      await sessionService.markSessionReady(rootID, sessionKey);
    };
    const refreshSessionRelatedFiles = async (rootID: string, sessionKey: string) => {
      if (!rootID || !sessionKey) return;
      const relatedFiles = await sessionService.getSessionRelatedFiles(rootID, sessionKey);
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
      setSelectedPendingByKey(sessionKey, false);
      const latest = wasCanceled
        ? sessionCacheRef.current[cacheKey]
        : drawerSessionByRootRef.current[rootID];
      if (latest && latest.key === sessionKey) {
        setDrawerSessionForRoot(rootID, { ...(latest as any), pending: false } as Session);
      }
    };

    const handleSessionStream = (payload: any) => {
      const streamKey = payload.session_key, activeRoot = currentRootIdRef.current;
      if (!streamKey || !activeRoot) return;
      const ck = rootSessionKey(activeRoot, streamKey);
      let pending = pendingBySessionRef.current[ck];
      if (!pending) { const draft = pendingDraftRef.current; if (draft && draft.rootId === activeRoot) { pending = draft; pendingBySessionRef.current[ck] = draft; pendingDraftRef.current = null; } }
      const boundKey = boundSessionByRootRef.current[activeRoot] || null;
      if (!boundKey || (typeof boundKey === "string" && boundKey.startsWith("pending-"))) {
        setBoundSessionForRoot(activeRoot, streamKey);
        if (pending) {
          const userEx = { role: "user", content: pending.message, timestamp: pending.timestamp, model: pending.model };
          const cached = sessionCacheRef.current[ck] || ({
            key: streamKey,
            type: pending.mode,
            agent: pending.agent,
            model: pending.model,
            name: "",
            created_at: pending.timestamp,
            updated_at: pending.timestamp,
            exchanges: [],
          } as any);
          const prevExchanges = Array.isArray((cached as any).exchanges) ? ((cached as any).exchanges as Exchange[]) : [];
          sessionCacheRef.current[ck] = {
            ...(cached as any),
            exchanges: prevExchanges.length > 0 ? prevExchanges : [userEx],
            updated_at: new Date().toISOString(),
          } as Session;
          bumpCacheVersion();
        }
        const seeded = sessionCacheRef.current[ck];
        if (seeded) {
          setDrawerSessionForRoot(activeRoot, { ...(seeded as any), pending: true } as Session);
        }
      }
      const event = payload.event;
      if (!event?.type) return;
      switch (event.type) {
        case "message_chunk":
          appendAgentChunkForSession(activeRoot, streamKey, event.data?.content || "", pending?.agent);
          {
            const latest = sessionCacheRef.current[ck];
            if (latest) {
              setDrawerSessionForRoot(activeRoot, { ...(latest as any), pending: true } as Session);
            }
          }
          break;
        case "thought_chunk":
          appendThoughtChunkForSession(activeRoot, streamKey, event.data?.content || "");
          {
            const latest = sessionCacheRef.current[ck];
            if (latest) {
              setDrawerSessionForRoot(activeRoot, { ...(latest as any), pending: true } as Session);
            }
          }
          break;
        case "tool_call":
          appendToolCallForSession(activeRoot, streamKey, event.data || {}, false);
          {
            const latest = sessionCacheRef.current[ck];
            if (latest) {
              setDrawerSessionForRoot(activeRoot, { ...(latest as any), pending: true } as Session);
            }
          }
          break;
        case "tool_call_update":
          appendToolCallForSession(activeRoot, streamKey, event.data || {}, true);
          {
            const latest = sessionCacheRef.current[ck];
            if (latest) {
              setDrawerSessionForRoot(activeRoot, { ...(latest as any), pending: true } as Session);
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
    const handleFileChanged = (payload: any) => {
      const rootID = typeof payload?.root_id === "string" ? payload.root_id : "";
      const changedPath = typeof payload?.path === "string" ? payload.path : "";
      if (!rootID || !changedPath) return;
      invalidateFileCache(rootID, changedPath);
      void refreshCurrentFileContent(rootID, changedPath);
      void refreshGitStatus(rootID).then((next) => {
        if (!next?.available) {
          if (rootID === currentRootIdRef.current) {
            setGitDiff(null);
          }
          return;
        }
        const hasChangedDiff = (gitDiff?.path || "") === changedPath;
        if (rootID === currentRootIdRef.current && hasChangedDiff) {
          const target = next.items.find((item) => item.path === changedPath);
          if (!target) {
            setGitDiff(null);
            return;
          }
          void fetchGitDiff(rootID, changedPath).then(setGitDiff).catch((err) => {
            console.error("[git.diff.refresh] failed", { rootID, changedPath, err });
          });
        }
      });
      const parentDir = dirname(changedPath);
      const currentDir = currentDirAPI(rootID);
      const syncMain = rootID === currentRootIdRef.current && parentDir === currentDir;
      void refreshTreeDir(rootID, parentDir, syncMain);
    };
    const unsubscribeEvents = sessionService.subscribeEvents((event) => {
      const payload = (event.payload || {}) as any;
      switch (event.type) {
        case "ws.connected":
          void refreshManagedRoots();
          if (currentRootIdRef.current) {
            const newest = sessionsRef.current[0]?.updated_at || "";
            void loadSessions(currentRootIdRef.current, newest ? { afterTime: newest } : { replace: true });
          }
          break;
        case "ws.reconnected":
          void refreshManagedRoots();
          if (currentRootIdRef.current) {
            const newest = sessionsRef.current[0]?.updated_at || "";
            void loadSessions(currentRootIdRef.current, newest ? { afterTime: newest } : { replace: true });
            const boundKey = boundSessionByRootRef.current[currentRootIdRef.current] || "";
            if (boundKey) {
              void reloadSessionForReplay(currentRootIdRef.current, boundKey);
            }
          }
          break;
        case "root.changed":
          void refreshManagedRoots();
          break;
        case "session.stream": handleSessionStream(payload); break;
        case "session.done": {
          const sessionKey = typeof payload?.session_key === "string" ? payload.session_key : "";
          const rootID = resolveRootForSessionKey(sessionKey) || currentRootIdRef.current || "";
          if (rootID && sessionKey) {
            handleSessionStreamDone(rootID, sessionKey);
            const newest = sessionsRef.current[0]?.updated_at || "";
            void loadSessions(rootID, newest ? { afterTime: newest } : { replace: true });
          } else if (currentRootIdRef.current) {
            const newest = sessionsRef.current[0]?.updated_at || "";
            void loadSessions(currentRootIdRef.current, newest ? { afterTime: newest } : { replace: true });
          }
          break;
        }
        case "session.user_message":
          if (typeof payload?.session_key === "string" && typeof payload?.root_id === "string") {
            const rootID = payload.root_id;
            const sessionKey = payload.session_key;
            const exchange = payload.exchange;
            const sessionMeta = payload.session;
            const cacheKey = rootSessionKey(rootID, sessionKey);
            const cached = sessionCacheRef.current[cacheKey] || ({
              key: sessionKey,
              type: sessionMeta?.type || "chat",
              agent: sessionMeta?.agent || exchange?.agent || "",
              model: sessionMeta?.model || exchange?.model || "",
              name: sessionMeta?.name || "新会话",
              created_at: sessionMeta?.created_at || exchange?.timestamp || new Date().toISOString(),
              updated_at: sessionMeta?.updated_at || exchange?.timestamp || new Date().toISOString(),
              exchanges: [],
            } as any);
            const prevExchanges = Array.isArray((cached as any).exchanges) ? ((cached as any).exchanges as Exchange[]) : [];
            const duplicate = prevExchanges.some((item) =>
              item.role === "user" &&
              item.content === exchange?.content &&
              item.timestamp === exchange?.timestamp
            );
            sessionCacheRef.current[cacheKey] = {
              ...(cached as any),
              ...(sessionMeta || {}),
              key: sessionKey,
              agent: sessionMeta?.agent || exchange?.agent || (cached as any).agent || "",
              model: sessionMeta?.model || exchange?.model || (cached as any).model || "",
              exchanges: duplicate ? prevExchanges : [...prevExchanges, {
                role: "user",
                agent: exchange?.agent || "",
                model: exchange?.model || "",
                content: exchange?.content || "",
                timestamp: exchange?.timestamp || new Date().toISOString(),
              }],
              updated_at: sessionMeta?.updated_at || exchange?.timestamp || new Date().toISOString(),
            } as Session;
            bumpCacheVersion();
            const newest = sessionsRef.current[0]?.updated_at || "";
            void loadSessions(rootID, newest ? { afterTime: newest } : { replace: true });
          }
          break;
        case "session.meta.updated":
          if (typeof payload?.root_id === "string" && typeof payload?.session?.key === "string") {
            const rootID = payload.root_id;
            const sessionKey = payload.session.key;
            const cacheKey = rootSessionKey(rootID, sessionKey);
            const cached = sessionCacheRef.current[cacheKey];
            if (cached) {
              sessionCacheRef.current[cacheKey] = {
                ...cached,
                name: typeof payload.session.name === "string" ? payload.session.name : cached.name,
                model: typeof payload.session.model === "string" ? payload.session.model : (cached as any).model,
                updated_at: payload.session.updated_at || cached.updated_at,
              } as Session;
              bumpCacheVersion();
            }
            if ((selectedSessionRef.current?.key || selectedSessionRef.current?.session_key) === sessionKey) {
              setSelectedSession((prev) => prev ? ({
                ...(prev as any),
                name: typeof payload.session.name === "string" ? payload.session.name : prev.name,
                model: typeof payload.session.model === "string" ? payload.session.model : (prev as any).model,
                updated_at: payload.session.updated_at || prev.updated_at,
              } as SessionItem) : prev);
            }
            if (boundSessionByRootRef.current[rootID] === sessionKey) {
              const latest = sessionCacheRef.current[cacheKey];
              if (latest) {
                setDrawerSessionForRoot(rootID, latest);
              }
            }
            const newest = sessionsRef.current[0]?.updated_at || "";
            void loadSessions(rootID, newest ? { afterTime: newest } : { replace: true });
          }
          break;
        case "session.related_files.updated": {
          const rootID = typeof payload?.root_id === "string" ? payload.root_id : "";
          const sessionKey = typeof payload?.session_key === "string" ? payload.session_key : "";
          if (rootID && sessionKey) {
            void refreshSessionRelatedFiles(rootID, sessionKey);
          }
          break;
        }
        case "file.changed": handleFileChanged(payload); break;
        case "agent.status.changed": setAgentsVersion(v => v + 1); break;
        case "app.update":
          setUpdateState(normalizeUpdateState(payload?.state as UpdateState));
          break;
      }
    });
    void loadSessions(currentRootId, { replace: true });
    return () => {
      cancelled = true;
      unsubscribeEvents();
    };
  }, [currentRootId, gitDiff?.path, mergeSessionItems, rootSessionKey, resolveRootForSessionKey, appendAgentChunkForSession, appendThoughtChunkForSession, appendToolCallForSession, setSelectedPendingByKey, setBoundSessionForRoot, setDrawerSessionForRoot, refreshTreeDir, refreshCurrentFileContent, refreshGitStatus, refreshManagedRoots, updateSessionRelatedFilesForKey]);

  useEffect(() => {
    if (!currentRootId) return;
    if (pluginsLoadedByRootRef.current[currentRootId]) return;
    void ensurePluginsLoaded(currentRootId).catch(() => {
    });
  }, [currentRootId, ensurePluginsLoaded]);

  const handleLoadOlderSessions = useCallback(async () => {
    const rootID = currentRootIdRef.current;
    const oldest = sessionsRef.current[sessionsRef.current.length - 1]?.updated_at || "";
    if (!rootID || !oldest || loadingOlderSessions) {
      return;
    }
    setLoadingOlderSessions(true);
    try {
      const next = await sessionService.fetchSessions(rootID, { beforeTime: oldest }) as SessionItem[];
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
    if (isRelayPWAContext() && !isRelayNodePage()) {
      const lastNodeID = window.localStorage.getItem(RELAY_LAST_NODE_ID_STORAGE_KEY);
      if (lastNodeID) {
        window.location.replace(`/n/${lastNodeID}/`);
        return;
      }
    }
    fetch(appPath("/api/dirs")).then(async (r) => {
      if (!r.ok) {
        const payload = await r.json().catch(() => ({}));
        if (handleRelayNavigationFailure(r.status, typeof payload?.error === "string" ? payload.error : "")) {
          return null;
        }
        return null;
      }
      return r.json();
    }).then(async dirs => {
      if (!dirs) {
        return;
      }
      void refreshRelayStatus();
      if (cancelled || !dirs.length) return;
      const nextDirs = dirs as ManagedRootPayload[];
      const ids = nextDirs.map((d) => d.id);
      managedRootByIdRef.current = Object.fromEntries(nextDirs.filter((dir) => !!dir.id).map((dir) => [dir.id, dir]));
      managedRootIdsRef.current = new Set(ids); setManagedRootIds(ids);
      setRootEntries(mapManagedRootsToEntries(nextDirs));
      const urlState = readURLState();
      const preferredRoot = urlState.root && ids.includes(urlState.root) ? urlState.root : ids[0];
      setCurrentRootId(preferredRoot);
      setPluginQuery(urlState.pluginQuery);
      if (urlState.session) {
        if (cancelled) return;
        await handleSelectSessionRef.current?.({ key: urlState.session, session_key: urlState.session, root_id: preferredRoot });
      } else if (urlState.file) {
        await ensurePluginsLoaded(preferredRoot);
        if (cancelled) return;
        actionHandlersRef.current.open({ path: urlState.file, root: preferredRoot, cursor: urlState.cursor, preservePluginQuery: true });
      } else {
        actionHandlersRef.current.open_dir({ path: preferredRoot, root: preferredRoot, preservePluginQuery: true, isRoot: true });
      }
    });
    return () => { cancelled = true; };
  }, [ensurePluginsLoaded, handleRelayNavigationFailure, refreshRelayStatus]);

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
        const currentSessionKey = selectedSessionRef.current?.key || selectedSessionRef.current?.session_key || "";
        const currentSessionRoot = (selectedSessionRef.current?.root_id as string | undefined) || currentRootIdRef.current || "";
        if (state.session !== currentSessionKey || state.root !== currentSessionRoot) {
          void handleSelectSessionRef.current?.({ key: state.session, session_key: state.session, root_id: state.root });
        }
        return;
      }
      if (state.file) {
        const currentPath = fileRef.current?.path || "";
        const currentRoot = currentRootIdRef.current || "";
        const currentCursor = fileCursorRef.current;
        if (state.file !== currentPath || state.root !== currentRoot || state.cursor !== currentCursor) {
          actionHandlers.open({ path: state.file, root: state.root, cursor: state.cursor, preservePluginQuery: true });
        }
        return;
      }
      if (fileRef.current) {
        actionHandlers.open_dir({ path: state.root, root: state.root, preservePluginQuery: true, isRoot: true });
      }
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [actionHandlers]);

  const selectedRoot = (selectedSession?.root_id as string | undefined) || currentRootId || "";
  const selectedInCurrentRoot = !!selectedSession && !!currentRootId && selectedRoot === currentRootId;
  const selectedKey = selectedSession?.key || selectedSession?.session_key || "";
  const boundFromSelected = selectedInCurrentRoot && selectedKey === activeBoundSessionKey
    ? (selectedSession as any)
    : null;
  const boundFromCache = activeBoundSessionKey && currentRootId
    ? (sessionCacheRef.current[rootSessionKey(currentRootId, activeBoundSessionKey)] as any)
    : null;
  const actionBarSession = activeBoundSessionKey
    ? ((currentSession as any) || boundFromCache || boundFromSelected)
    : (selectedInCurrentRoot ? (selectedSession as any) : null);
  const isBoundSessionInMain = !!activeBoundSessionKey
    && selectedKey === activeBoundSessionKey
    && interactionMode !== "drawer";
  const canOpenSessionDrawer = !!activeBoundSessionKey && !isBoundSessionInMain;
  const detachedBoundSession = !!activeBoundSessionKey
    && selectedInCurrentRoot
    && !!selectedKey
    && selectedKey !== activeBoundSessionKey
    && !isDrawerOpen;

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
  }, [file, pluginBypass, matchedPlugin, currentRootId, pluginQuery, actionHandlers]);

  const pluginRender = useMemo(() => {
    if (!file || pluginBypass || !matchedPlugin) return null;
    const input = toPluginInput(file, pluginQuery);
    try {
      const output = pluginManagerRef.current.run(matchedPlugin, input);
      return { plugin: matchedPlugin, output, error: "" };
    } catch (err: any) {
      return { plugin: matchedPlugin, output: null, error: String(err?.message || err || "plugin process failed") };
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
    () => (selectedSession ? getSessionSnapshot(selectedSession.root_id || currentRootId, selectedSession) : null),
    [selectedSession, currentRootId, getSessionSnapshot]
  );

  const handleSelectedSessionFileClick = useCallback((path: string) => {
    const root = (selectedSessionRef.current?.root_id as string | undefined) || currentRootIdRef.current;
    if (!root) return;
    const gitItem = (gitStatus?.items || []).find((item) => item.path === path);
    if (gitItem) {
      void openGitDiff(root, gitItem);
      return;
    }
    actionHandlers.open({ path, root });
  }, [actionHandlers, gitStatus, openGitDiff]);

  const drawerSessionSnapshot = useMemo(
    () => (currentSession ? getSessionSnapshot(currentRootId, currentSession) : null),
    [currentSession, currentRootId, getSessionSnapshot]
  );

  const handleDrawerSessionFileClick = useCallback((path: string) => {
    const root = currentRootIdRef.current;
    if (!root) return;
    const gitItem = (gitStatus?.items || []).find((item) => item.path === path);
    if (gitItem) {
      void openGitDiff(root, gitItem);
      return;
    }
    actionHandlers.open({ path, root });
  }, [actionHandlers, gitStatus, openGitDiff]);

  const currentFileScrollKey = buildFileScrollKey(file?.root || currentRootId, file?.path);
  const sessionView = (
    <SessionViewer
      session={selectedSessionSnapshot}
      rootId={selectedSession?.root_id || currentRootId}
      rootPath={managedRootByIdRef.current[selectedSession?.root_id || currentRootId || ""]?.root_path || null}
      gitFileStatsByPath={gitFileStatsByPath}
      onFileClick={handleSelectedSessionFileClick}
    />
  );

  let workspaceView: React.ReactNode;
  const showGitStatusPanel = !gitDiff && !file && !!currentRootId;
  const shouldRenderGitPanel = showGitStatusPanel && (gitStatusLoading || ((filteredGitStatus?.items.length || 0) > 0));
  if (gitDiff) {
    workspaceView = (
      <GitDiffViewer
        diff={gitDiff}
        root={currentRootId}
        onPathClick={handleGitDiffPathClick}
        onSessionClick={(sessionKey) => handleSessionChipClick(sessionKey, currentRootIdRef.current)}
        onSelectionChange={handleViewerSelectionChange}
      />
    );
  } else if (file) {
    if (pluginRender && pluginRender.output) {
      workspaceView = (
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          <div style={{ height: "36px", borderBottom: "1px solid var(--border-color)", padding: "0 12px", display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12, color: "var(--text-secondary)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span>🧩</span>
              <span>{pluginRender.plugin.name}</span>
              {pluginLoading ? <span style={{ opacity: 0.7 }}>加载中...</span> : null}
            </div>
            <button
              type="button"
              onClick={() => { void switchToRawFileView(); }}
              style={{ border: "1px solid var(--border-color)", background: "transparent", borderRadius: 6, padding: "3px 8px", cursor: "pointer", fontSize: 12, color: "var(--text-secondary)" }}
            >
              原始文件
            </button>
          </div>
          <div className="plugin-shadcn-sandbox" style={{ ...pluginThemeVars, flex: 1, minHeight: 0, overflow: "auto", padding: 12 }}>
            <Renderer
              key={pluginRendererKey}
              tree={pluginRender.output.tree as any}
              initialState={(pluginRender.output.data || {}) as Record<string, unknown>}
              handlers={pluginHandlers}
            />
          </div>
        </div>
      );
    } else {
      workspaceView = (
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          {pluginBypass && matchedPlugin ? (
            <div style={{ borderBottom: "1px solid var(--border-color)", padding: "8px 12px", fontSize: 12, color: "var(--text-secondary)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>已切换为原始文件视图（插件：{matchedPlugin.name}）</span>
              <button
                type="button"
                onClick={() => { void switchToPluginView(); }}
                style={{ border: "1px solid var(--border-color)", background: "transparent", borderRadius: 6, padding: "3px 8px", cursor: "pointer", fontSize: 12, color: "var(--text-secondary)" }}
              >
                使用插件
              </button>
            </div>
          ) : null}
          {pluginRender && pluginRender.error ? (
            <div style={{ borderBottom: "1px solid var(--border-color)", padding: "8px 12px", fontSize: 12, color: "#d97706", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>插件 {pluginRender.plugin.name} 执行失败，已回退原始视图</span>
              <button
                type="button"
                onClick={() => setPluginBypass(true)}
                style={{ border: "1px solid var(--border-color)", background: "transparent", borderRadius: 6, padding: "3px 8px", cursor: "pointer", fontSize: 12, color: "var(--text-secondary)" }}
              >
                忽略插件
              </button>
            </div>
          ) : null}
          <FileViewer
            file={file}
            isVisible={!selectedSession}
            onSelectionChange={handleViewerSelectionChange}
            initialScrollTop={fileScrollPositionsRef.current[currentFileScrollKey] || 0}
            onScrollTopChange={(scrollTop) => {
              if (!currentFileScrollKey) return;
              fileScrollPositionsRef.current[currentFileScrollKey] = scrollTop;
              persistFileScrollPositions(fileScrollPositionsRef.current);
            }}
            onSessionClick={(sessionKey) => handleSessionChipClick(sessionKey, file?.root || currentRootIdRef.current)}
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
          topContent={shouldRenderGitPanel ? (
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
          ) : null}
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
          onItemClick={(e) => e.is_dir ? actionHandlers.open_dir({ path: e.path }) : actionHandlers.open({ path: e.path })}
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
    if (relayStatus?.relay_bound) {
      return "打开 Relayer";
    }
    return "绑定 Relayer";
  }, [relayStatus]);

  const relayActionDisabled = !currentRootId || (!relayStatus?.relay_bound && (!relayStatus?.pending_code || !relayStatus?.relay_base_url));
  const showUpdateButton = shouldShowUpdateButton(updateState);
  const updateBusy = updateSubmitting || ["downloading", "installing", "restarting"].includes((updateState.status || "").toLowerCase());
  const updateLabel = updateButtonLabel(updateState);
  const updateHelp = updateState.message || updateSummaryText(updateState);
  const updateSummary = updateSummaryText(updateState);

  return (
    <>
    <AppShell
      leftOpen={isLeftOpen} rightOpen={isRightOpen}
      onCloseLeft={() => setIsLeftOpen(false)} onCloseRight={() => setIsRightOpen(false)}
      sidebar={<FileTree entries={rootEntries} childrenByPath={entriesByPath} expanded={expanded} sortMode={treeSortMode} showHiddenFiles={showHiddenFiles} onSortModeChange={setTreeSortMode} onShowHiddenFilesChange={setShowHiddenFiles} selectedDirKey={selectedDirKey} selectedPath={file?.path} rootId={currentRootId} creatingRootName={creatingRootName} creatingRootBusy={creatingRootBusy} onCreateRootStart={handleCreateRootStart} onCreateRootNameChange={setCreatingRootName} onCreateRootSubmit={() => { void handleCreateRootSubmit(); }} onCreateRootCancel={handleCreateRootCancel} onSelectFile={(e, r) => { actionHandlers.open({path: e.path, root: r}); if (isMobile) setIsLeftOpen(false); }} onToggleDir={(e, r) => actionHandlers.open_dir({path: e.path, root: r, toggle: true, isRoot: e.is_root === true})} relayActionLabel={relayActionLabel} relayActionDisabled={relayActionDisabled} relayActionHelp={null} onRelayAction={handleRelayAction} updateActionLabel={showUpdateButton ? updateLabel : null} updateActionDisabled={updateBusy} updateActionHelp={showUpdateButton ? updateHelp : ""} updateActionBusy={updateBusy} updateActionSummary={showUpdateButton ? updateSummary : ""} onUpdateAction={() => { void handleStartUpdate(); }} />}
      rightSidebar={<SessionList sessions={sessions} selectedKey={selectedSession?.key} onSelect={(s) => { handleSelectSession(s); if (isMobile) setIsRightOpen(false); }} onDelete={handleDeleteSession} onLoadOlder={handleLoadOlderSessions} loadingOlder={loadingOlderSessions} hasMore={hasMoreSessions} />}
      main={
        <div style={{ width: "100%", flex: 1, minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column", position: "relative" }}>
          {!isMobile && <div style={{ position: "absolute", top: "10px", left: isMobile ? "10px" : (isLeftOpen ? "-40px" : "10px"), right: isMobile ? "10px" : (isRightOpen ? "-40px" : "10px"), display: "flex", justifyContent: "space-between", pointerEvents: "none", zIndex: 100 }}>
            <button onClick={() => setIsLeftOpen(!isLeftOpen)} style={{ pointerEvents: "auto", background: "var(--content-bg)", border: "1px solid var(--border-color)", borderRadius: "8px", width: "32px", height: "32px", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", opacity: isLeftOpen && !isMobile ? 0 : 1 }}>📁</button>
            <button onClick={() => setIsRightOpen(!isRightOpen)} style={{ pointerEvents: "auto", background: "var(--content-bg)", border: "1px solid var(--border-color)", borderRadius: "8px", width: "32px", height: "32px", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", opacity: isRightOpen && !isMobile ? 0 : 1 }}>🕒</button>
          </div>}
          <div style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
            <div style={{ display: selectedSession ? "flex" : "none", flex: 1, minHeight: 0, minWidth: 0 }}>
              {sessionView}
            </div>
            <div style={{ display: selectedSession ? "none" : "flex", flex: 1, minHeight: 0, minWidth: 0, flexDirection: "column" }}>
              {workspaceView}
            </div>
          </div>
        </div>
      }
      footer={<ActionBar status={status} agentsVersion={agentsVersion} currentRootId={currentRootId} currentSession={actionBarSession} attachedFileContext={attachedFileContext} canOpenSessionDrawer={canOpenSessionDrawer} detachedBoundSession={detachedBoundSession} onSendMessage={handleSendMessage} onCancelCurrentTurn={handleCancelCurrentTurn} onNewSession={handleNewSession} onRequestFileContext={handleRequestFileContext} onClearFileContext={handleClearFileContext} onToggleLeftSidebar={() => setIsLeftOpen((v) => !v)} onToggleRightSidebar={() => setIsRightOpen((v) => !v)} onSessionClick={() => {
        const rootID = currentRootIdRef.current;
        if (!activeBoundSessionKey) return;
        const selectedKey = selectedSession?.key || selectedSession?.session_key;
        const isBoundSessionInMain = selectedKey === activeBoundSessionKey && interactionMode !== "drawer";
        if (isBoundSessionInMain) return;
        setInteractionMode("drawer");
        setDrawerOpenForRoot(rootID, !(drawerOpenByRootRef.current[rootID || ""] || false));
      }} />}
      drawer={<BottomSheet isOpen={isDrawerOpen} onClose={() => setDrawerOpenForRoot(currentRootIdRef.current, false)} onExpand={() => { handleSelectSession(currentSession); setDrawerOpenForRoot(currentRootIdRef.current, false); }}>{drawerSessionSnapshot ? <SessionViewer session={drawerSessionSnapshot} rootId={currentRootId} rootPath={managedRootByIdRef.current[currentRootId || ""]?.root_path || null} interactionMode="drawer" gitFileStatsByPath={gitFileStatsByPath} onFileClick={handleDrawerSessionFileClick} /> : <div style={{ padding: "40px", textAlign: "center" }}>点击蓝点或发消息开始</div>}</BottomSheet>}
    />
    </>
  );
}

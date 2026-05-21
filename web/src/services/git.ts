import { appURL } from "./base";
import { protectedJSON } from "./api";
import { getCachedGitDiff, setCachedGitDiff, type CachedGitDiffPayload } from "./file";

export type GitStatusCode = "M" | "A" | "D" | "R" | "??";

export type GitStatusItem = {
  path: string;
  display_path?: string;
  old_path?: string;
  status: GitStatusCode;
  additions: number;
  deletions: number;
  is_dir?: boolean;
};

export type GitStatusPayload = {
  available: boolean;
  branch?: string;
  dirty_count: number;
  items: GitStatusItem[];
};

export type GitDiffPayload = CachedGitDiffPayload & {
  path: string;
  old_path?: string;
  status: GitStatusCode | string;
  additions: number;
  deletions: number;
  content: string;
  commit?: string;
  source?: "worktree" | "commit";
};

export type GitHistoryItem = {
  hash: string;
  message: string;
  commit_time: string;
  remote?: boolean;
};

export type GitHistoryPayload = {
  available: boolean;
  items: GitHistoryItem[];
  has_more: boolean;
  commit_missing?: boolean;
  remote_head?: string;
};

export type GitCommitFilesPayload = {
  commit: string;
  items: GitStatusItem[];
};

export type GitBranchItem = {
  name: string;
  current: boolean;
};

export type GitBranchesPayload = {
  current?: string;
  branches: GitBranchItem[];
};

export type GitWorktreeItem = {
  path: string;
  branch?: string;
  head?: string;
  current: boolean;
};

export type GitWorktreesPayload = {
  items: GitWorktreeItem[];
};

export async function fetchGitStatus(rootId: string): Promise<GitStatusPayload> {
  const payload = await protectedJSON<any>(appURL("/api/git/status", new URLSearchParams({ root: rootId })));
  return {
    available: payload?.available === true,
    branch: typeof payload?.branch === "string" ? payload.branch : undefined,
    dirty_count: Number(payload?.dirty_count) || 0,
    items: Array.isArray(payload?.items) ? payload.items as GitStatusItem[] : [],
  };
}

const DEFAULT_HISTORY_LIMIT = 10;
const HISTORY_LIST_STORAGE_PREFIX = "mindfs.git.history.list:";
const COMMIT_FILES_STORAGE_PREFIX = "mindfs.git.history.files:";
const COMMIT_DIFF_STORAGE_PREFIX = "mindfs.git.history.diff:";

type GitHistoryCacheEntry = {
  items: GitHistoryItem[];
  hasMore: boolean;
  remoteHead?: string;
};

const gitHistoryListCache = new Map<string, GitHistoryCacheEntry>();
const gitHistoryInflight = new Map<string, Promise<GitHistoryPayload>>();
const gitCommitFilesCache = new Map<string, GitCommitFilesPayload>();
const gitCommitFilesInflight = new Map<string, Promise<GitCommitFilesPayload>>();
const gitCommitDiffCache = new Map<string, GitDiffPayload>();
const gitCommitDiffInflight = new Map<string, Promise<GitDiffPayload>>();

function canUseStorage(): boolean {
  return typeof window !== "undefined" && !!window.localStorage;
}

function readStorageJSON<T>(key: string): T | null {
  if (!canUseStorage()) return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

function writeStorageJSON(key: string, value: unknown): void {
  if (!canUseStorage()) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function removeStorageByPrefix(prefix: string): void {
  if (!canUseStorage()) return;
  for (const key of Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.key(index)).filter(Boolean) as string[]) {
    if (key.startsWith(prefix)) {
      window.localStorage.removeItem(key);
    }
  }
}

function historyListStorageKey(rootId: string): string {
  return `${HISTORY_LIST_STORAGE_PREFIX}${encodeURIComponent(rootId)}`;
}

function commitFilesStorageKey(rootId: string, commit: string): string {
  return `${COMMIT_FILES_STORAGE_PREFIX}${encodeURIComponent(rootId)}:${encodeURIComponent(commit)}`;
}

function commitDiffStorageKey(rootId: string, commit: string, oldPath: string, path: string): string {
  return `${COMMIT_DIFF_STORAGE_PREFIX}${encodeURIComponent(rootId)}:${encodeURIComponent(commit)}:${encodeURIComponent(oldPath)}:${encodeURIComponent(path)}`;
}

function getHistoryCacheEntry(rootId: string): GitHistoryCacheEntry | null {
  const cached = gitHistoryListCache.get(rootId);
  if (cached) {
    return cached;
  }
  const persisted = readStorageJSON<GitHistoryCacheEntry>(historyListStorageKey(rootId));
  if (persisted && Array.isArray(persisted.items)) {
    const normalized = {
      items: persisted.items.filter((item) => !!item?.hash),
      hasMore: persisted.hasMore === true,
      remoteHead: typeof persisted.remoteHead === "string" ? persisted.remoteHead : undefined,
    };
    normalized.items = applyRemoteHead(normalized.items, normalized.remoteHead);
    gitHistoryListCache.set(rootId, normalized);
    return normalized;
  }
  return null;
}

function setHistoryCacheEntry(rootId: string, entry: GitHistoryCacheEntry): void {
  gitHistoryListCache.set(rootId, entry);
  writeStorageJSON(historyListStorageKey(rootId), entry);
}

function normalizeGitHistoryPayload(payload: any): GitHistoryPayload {
  return {
    available: payload?.available === true,
    items: Array.isArray(payload?.items)
      ? payload.items
          .map((item: any) => ({
            hash: typeof item?.hash === "string" ? item.hash : "",
            message: typeof item?.message === "string" ? item.message : "",
            commit_time: typeof item?.commit_time === "string" ? item.commit_time : "",
            remote: item?.remote === true,
          }))
          .filter((item: GitHistoryItem) => !!item.hash)
      : [],
    has_more: payload?.has_more === true,
    commit_missing: payload?.commit_missing === true,
    remote_head: typeof payload?.remote_head === "string" ? payload.remote_head : undefined,
  };
}

function applyRemoteHead(items: GitHistoryItem[], remoteHead?: string): GitHistoryItem[] {
  if (!remoteHead) {
    return items;
  }
  const remoteHeadIndex = items.findIndex((item) => item.hash === remoteHead);
  if (remoteHeadIndex < 0) {
    return items;
  }
  return items.map((item, index) => (
    index >= remoteHeadIndex ? { ...item, remote: true } : item
  ));
}

function mergeHistoryItems(existing: GitHistoryItem[], next: GitHistoryItem[]): GitHistoryItem[] {
  const seen = new Set(existing.map((item) => item.hash));
  const merged = existing.slice();
  next.forEach((item) => {
    if (!seen.has(item.hash)) {
      seen.add(item.hash);
      merged.push(item);
    }
  });
  return merged;
}

export function getCachedGitHistory(rootId: string): GitHistoryPayload | null {
  const cached = getHistoryCacheEntry(rootId);
  if (!cached) {
    return null;
  }
  return {
    available: true,
    items: cached.items.slice(),
    has_more: cached.hasMore,
    remote_head: cached.remoteHead,
  };
}

export function getCachedGitHistoryHead(rootId: string, limit = DEFAULT_HISTORY_LIMIT): GitHistoryPayload | null {
  const cached = getHistoryCacheEntry(rootId);
  if (!cached) {
    return null;
  }
  return {
    available: true,
    items: cached.items.slice(0, limit),
    has_more: cached.items.length > limit || cached.hasMore,
    remote_head: cached.remoteHead,
  };
}

export function clearGitHistoryCache(rootId?: string): void {
  if (rootId) {
    gitHistoryListCache.delete(rootId);
    if (canUseStorage()) {
      window.localStorage.removeItem(historyListStorageKey(rootId));
    }
    removeStorageByPrefix(`${COMMIT_FILES_STORAGE_PREFIX}${encodeURIComponent(rootId)}:`);
    removeStorageByPrefix(`${COMMIT_DIFF_STORAGE_PREFIX}${encodeURIComponent(rootId)}:`);
  } else {
    gitHistoryListCache.clear();
    removeStorageByPrefix(HISTORY_LIST_STORAGE_PREFIX);
    removeStorageByPrefix(COMMIT_FILES_STORAGE_PREFIX);
    removeStorageByPrefix(COMMIT_DIFF_STORAGE_PREFIX);
  }
  const clearMap = (cache: Map<string, unknown>) => {
    for (const key of Array.from(cache.keys())) {
      if (!rootId || key.startsWith(`${rootId}:`)) {
        cache.delete(key);
      }
    }
  };
  clearMap(gitHistoryInflight as Map<string, unknown>);
  clearMap(gitCommitFilesCache as Map<string, unknown>);
  clearMap(gitCommitFilesInflight as Map<string, unknown>);
  clearMap(gitCommitDiffCache as Map<string, unknown>);
  clearMap(gitCommitDiffInflight as Map<string, unknown>);
}

export async function fetchGitHistory(
  rootId: string,
  options?: { beforeCommit?: string; afterCommit?: string; limit?: number; force?: boolean },
): Promise<GitHistoryPayload> {
  const limit = options?.limit || DEFAULT_HISTORY_LIMIT;
  const beforeCommit = options?.beforeCommit || "";
  const afterCommit = options?.afterCommit || "";
  const cached = getHistoryCacheEntry(rootId);
  if (!options?.force && !beforeCommit && !afterCommit && cached) {
    return {
      available: true,
      items: cached.items.slice(0, limit),
      has_more: cached.items.length > limit || cached.hasMore,
      remote_head: cached.remoteHead,
    };
  }
  if (!options?.force && beforeCommit && cached) {
    const index = cached.items.findIndex((item) => item.hash === beforeCommit);
    if (index >= 0) {
      const cachedPage = cached.items.slice(index + 1, index + 1 + limit);
      if (cachedPage.length > 0 || !cached.hasMore) {
        return { available: true, items: cachedPage, has_more: cached.hasMore, remote_head: cached.remoteHead };
      }
    }
  }

  const key = `${rootId}:${beforeCommit}:${afterCommit}:${limit}`;
  const inflight = gitHistoryInflight.get(key);
  if (inflight) {
    return inflight;
  }
  const promise = protectedJSON<any>(
    appURL(
      "/api/git/history",
      new URLSearchParams({
        root: rootId,
        limit: String(limit),
        ...(beforeCommit ? { before_commit: beforeCommit } : {}),
        ...(afterCommit ? { after_commit: afterCommit } : {}),
      }),
    ),
  ).then((payload) => {
    const normalized = normalizeGitHistoryPayload(payload);
    if (normalized.commit_missing) {
      clearGitHistoryCache(rootId);
      return normalized;
    }
    const existing = getHistoryCacheEntry(rootId);
    if (!beforeCommit && !afterCommit) {
      const remoteHead = normalized.remote_head;
      setHistoryCacheEntry(rootId, {
        items: applyRemoteHead(normalized.items.slice(), remoteHead),
        hasMore: normalized.has_more,
        remoteHead,
      });
    } else if (beforeCommit) {
      const remoteHead = normalized.remote_head || existing?.remoteHead;
      setHistoryCacheEntry(rootId, {
        items: applyRemoteHead(mergeHistoryItems(existing?.items || [], normalized.items), remoteHead),
        hasMore: normalized.has_more,
        remoteHead,
      });
    } else if (afterCommit) {
      const remoteHead = normalized.remote_head || existing?.remoteHead;
      setHistoryCacheEntry(rootId, {
        items: applyRemoteHead(mergeHistoryItems(normalized.items, existing?.items || []), remoteHead),
        hasMore: existing?.hasMore ?? normalized.has_more,
        remoteHead,
      });
    }
    return {
      ...normalized,
      items: applyRemoteHead(normalized.items, normalized.remote_head),
    };
  }).finally(() => {
    gitHistoryInflight.delete(key);
  });
  gitHistoryInflight.set(key, promise);
  return promise;
}

export async function fetchGitCommitFiles(rootId: string, commit: string): Promise<GitCommitFilesPayload> {
  const key = `${rootId}:${commit}`;
  const cached = gitCommitFilesCache.get(key);
  if (cached) {
    return cached;
  }
  const persisted = readStorageJSON<GitCommitFilesPayload>(commitFilesStorageKey(rootId, commit));
  if (persisted && Array.isArray(persisted.items)) {
    gitCommitFilesCache.set(key, persisted);
    return persisted;
  }
  const inflight = gitCommitFilesInflight.get(key);
  if (inflight) {
    return inflight;
  }
  const promise = protectedJSON<any>(
    appURL("/api/git/commit/files", new URLSearchParams({ root: rootId, commit })),
  ).then((payload) => {
    const normalized = {
      commit: typeof payload?.commit === "string" ? payload.commit : commit,
      items: Array.isArray(payload?.items) ? payload.items as GitStatusItem[] : [],
    };
    gitCommitFilesCache.set(key, normalized);
    writeStorageJSON(commitFilesStorageKey(rootId, commit), normalized);
    return normalized;
  }).finally(() => {
    gitCommitFilesInflight.delete(key);
  });
  gitCommitFilesInflight.set(key, promise);
  return promise;
}

export async function fetchGitBranches(rootId: string): Promise<GitBranchesPayload> {
  const payload = await protectedJSON<any>(appURL("/api/git/branches", new URLSearchParams({ root: rootId })));
  return {
    current: typeof payload?.current === "string" ? payload.current : undefined,
    branches: Array.isArray(payload?.branches)
      ? payload.branches
          .map((item: any) => ({
            name: typeof item?.name === "string" ? item.name : "",
            current: item?.current === true,
          }))
          .filter((item: GitBranchItem) => !!item.name)
      : [],
  };
}

export async function checkoutGitBranch(rootId: string, branch: string): Promise<GitStatusPayload> {
  const payload = await protectedJSON<any>(appURL("/api/git/checkout"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root: rootId, branch }),
  });
  const status = payload?.status || {};
  return {
    available: status?.available === true,
    branch: typeof status?.branch === "string" ? status.branch : undefined,
    dirty_count: Number(status?.dirty_count) || 0,
    items: Array.isArray(status?.items) ? status.items as GitStatusItem[] : [],
  };
}

export async function fetchGitWorktrees(rootId: string): Promise<GitWorktreesPayload> {
  const payload = await protectedJSON<any>(appURL("/api/git/worktrees", new URLSearchParams({ root: rootId })));
  return {
    items: Array.isArray(payload?.items)
      ? payload.items
          .map((item: any) => ({
            path: typeof item?.path === "string" ? item.path : "",
            branch: typeof item?.branch === "string" ? item.branch : undefined,
            head: typeof item?.head === "string" ? item.head : undefined,
            current: item?.current === true,
          }))
          .filter((item: GitWorktreeItem) => !!item.path)
      : [],
  };
}

export async function createGitWorktree(input: {
  rootId: string;
  parentPath: string;
  name: string;
  branchMode: "new" | "existing";
  branch?: string;
}): Promise<any> {
  return protectedJSON<any>(appURL("/api/git/worktrees"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      root: input.rootId,
      parent_path: input.parentPath,
      name: input.name,
      branch_mode: input.branchMode,
      branch: input.branch || "",
    }),
  });
}

export async function removeGitWorktree(rootId: string): Promise<any> {
  return protectedJSON<any>(appURL("/api/git/worktrees"), {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root: rootId }),
  });
}

export function buildGitDiffCacheSignature(item?: Partial<GitStatusItem> | null): string {
  if (!item) {
    return "";
  }
  return [
    item.status || "",
    item.old_path || "",
    Number(item.additions) || 0,
    Number(item.deletions) || 0,
  ].join(":");
}

export async function fetchGitDiff(
  rootId: string,
  path: string,
  options?: { cacheSignature?: string },
): Promise<GitDiffPayload> {
  const cacheSignature = options?.cacheSignature || "";
  const cached = await getCachedGitDiff(rootId, path, cacheSignature);
  if (cached) {
    return cached as GitDiffPayload;
  }

  const payload = await protectedJSON<any>(appURL("/api/git/diff", new URLSearchParams({ root: rootId, path })));
  const diff = {
    path: typeof payload?.path === "string" ? payload.path : path,
    old_path: typeof payload?.old_path === "string" ? payload.old_path : undefined,
    status: typeof payload?.status === "string" ? payload.status : "M",
    additions: Number(payload?.additions) || 0,
    deletions: Number(payload?.deletions) || 0,
    content: typeof payload?.content === "string" ? payload.content : "",
    file_meta: Array.isArray(payload?.file_meta) ? payload.file_meta : [],
    source: "worktree" as const,
  };
  await setCachedGitDiff(rootId, path, diff, cacheSignature);
  return diff;
}

export async function fetchGitCommitDiff(
  rootId: string,
  commit: string,
  item: Pick<GitStatusItem, "path" | "old_path" | "status" | "additions" | "deletions">,
): Promise<GitDiffPayload> {
  const path = item.path;
  const key = `${rootId}:${commit}:${item.old_path || ""}:${path}`;
  const cached = gitCommitDiffCache.get(key);
  if (cached) {
    return cached;
  }
  const persisted = readStorageJSON<GitDiffPayload>(commitDiffStorageKey(rootId, commit, item.old_path || "", path));
  if (persisted && typeof persisted.content === "string") {
    gitCommitDiffCache.set(key, persisted);
    return persisted;
  }
  const inflight = gitCommitDiffInflight.get(key);
  if (inflight) {
    return inflight;
  }
  const promise = protectedJSON<any>(
    appURL("/api/git/commit/diff", new URLSearchParams({ root: rootId, commit, path })),
  ).then((payload) => {
    const diff = {
      path: typeof payload?.path === "string" ? payload.path : path,
      old_path: typeof payload?.old_path === "string" ? payload.old_path : item.old_path,
      status: typeof payload?.status === "string" ? payload.status : item.status,
      additions: Number(payload?.additions) || Number(item.additions) || 0,
      deletions: Number(payload?.deletions) || Number(item.deletions) || 0,
      content: typeof payload?.content === "string" ? payload.content : "",
      file_meta: Array.isArray(payload?.file_meta) ? payload.file_meta : [],
      commit,
      source: "commit" as const,
    };
    gitCommitDiffCache.set(key, diff);
    writeStorageJSON(commitDiffStorageKey(rootId, commit, item.old_path || "", path), diff);
    return diff;
  }).finally(() => {
    gitCommitDiffInflight.delete(key);
  });
  gitCommitDiffInflight.set(key, promise);
  return promise;
}

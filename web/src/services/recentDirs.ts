import { appPath } from "./base";

export type RecentDirEntry = {
  rootId: string;
  path: string;
  /** Display name (directory basename) captured at click time. */
  name: string;
  at: number;
};

export const RECENT_DIRS_STORAGE_KEY = "mindfs-recent-dirs";
export const RECENT_DIRS_LIMIT = 8;

function recentDirsStorageKey(): string {
  // appPath includes the configured backend (native shells) and /n/<node>
  // relay prefix. Resolve it on each access so backend changes cannot reuse
  // another node's history. Never migrate the unscoped legacy key: its owner
  // is unknown, and root IDs can collide between nodes.
  return `${RECENT_DIRS_STORAGE_KEY}:v2:${encodeURIComponent(appPath("/"))}`;
}

function dirDisplayName(path: string): string {
  const trimmed = (path || "").replace(/\/+$/, "");
  if (!trimmed) return "/";
  const base = trimmed.split("/").pop() || trimmed;
  return base || trimmed;
}

export function listRecentDirs(): RecentDirEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = JSON.parse(window.localStorage.getItem(recentDirsStorageKey()) || "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((item): item is RecentDirEntry => {
        const entry = item as Partial<RecentDirEntry>;
        return typeof entry?.rootId === "string" && !!entry.rootId
          && typeof entry?.path === "string" && !!entry.path;
      })
      .map((item) => ({ ...item, name: item.name || dirDisplayName(item.path), at: item.at || 0 }));
  } catch {
    return [];
  }
}

export function recordRecentDir(entry: { rootId: string; path: string; name?: string }): void {
  if (typeof window === "undefined" || !entry.rootId || !entry.path) return;
  const next: RecentDirEntry = {
    rootId: entry.rootId,
    path: entry.path,
    name: entry.name || dirDisplayName(entry.path),
    at: Date.now(),
  };
  const rest = listRecentDirs().filter(
    (item) => !(item.rootId === next.rootId && item.path === next.path),
  );
  const updated = [next, ...rest].slice(0, RECENT_DIRS_LIMIT);
  try {
    window.localStorage.setItem(recentDirsStorageKey(), JSON.stringify(updated));
  } catch {
    // Storage may be unavailable; the list still works for this session.
  }
}

/**
 * Pick the next recent directory after the current one, cycling through the
 * list. Returns null when there is nothing to switch to.
 */
export function nextRecentDir(currentRootId: string | null, currentPath: string | null, allowedRootIds?: readonly string[]): RecentDirEntry | null {
  const allowed = allowedRootIds ? new Set(allowedRootIds) : null;
  const list = listRecentDirs().filter((item) => item.rootId && item.path && (!allowed || allowed.has(item.rootId)));
  if (list.length === 0) return null;
  const currentKey = currentRootId ? `${currentRootId}\u0000${currentPath || ""}` : null;
  const candidates = list.filter((item) => !currentKey || `${item.rootId}\u0000${item.path}` !== currentKey);
  if (candidates.length === 0) return null;
  if (currentKey) {
    const index = list.findIndex((item) => `${item.rootId}\u0000${item.path}` === currentKey);
    if (index >= 0) {
      const forward = list.slice(index + 1).find((item) => `${item.rootId}\u0000${item.path}` !== currentKey);
      if (forward) return forward;
    }
  }
  return candidates[0];
}

export function clearRecentDirs(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(recentDirsStorageKey());
  } catch {
    // Ignore storage failures.
  }
}

import { appURL } from "./base";
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
  status: GitStatusCode | string;
  additions: number;
  deletions: number;
  content: string;
};

export async function fetchGitStatus(rootId: string): Promise<GitStatusPayload> {
  const response = await fetch(appURL("/api/git/status", new URLSearchParams({ root: rootId })));
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(payload?.message || payload?.error || `Failed to fetch git status: status=${response.status}`));
  }
  return {
    available: payload?.available === true,
    branch: typeof payload?.branch === "string" ? payload.branch : undefined,
    dirty_count: Number(payload?.dirty_count) || 0,
    items: Array.isArray(payload?.items) ? payload.items as GitStatusItem[] : [],
  };
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

  const response = await fetch(appURL("/api/git/diff", new URLSearchParams({ root: rootId, path })));
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(payload?.message || payload?.error || `Failed to fetch git diff: status=${response.status}`));
  }
  const diff = {
    path: typeof payload?.path === "string" ? payload.path : path,
    status: typeof payload?.status === "string" ? payload.status : "M",
    additions: Number(payload?.additions) || 0,
    deletions: Number(payload?.deletions) || 0,
    content: typeof payload?.content === "string" ? payload.content : "",
    file_meta: Array.isArray(payload?.file_meta) ? payload.file_meta : [],
  };
  await setCachedGitDiff(rootId, path, diff, cacheSignature);
  return diff;
}

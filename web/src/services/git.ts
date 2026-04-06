import { appURL } from "./base";

export type GitStatusCode = "M" | "A" | "D" | "R" | "??";

export type GitStatusItem = {
  path: string;
  display_path?: string;
  old_path?: string;
  status: GitStatusCode;
  additions: number;
  deletions: number;
};

export type GitStatusPayload = {
  available: boolean;
  branch?: string;
  dirty_count: number;
  items: GitStatusItem[];
};

export type GitDiffPayload = {
  path: string;
  status: GitStatusCode | string;
  additions: number;
  deletions: number;
  content: string;
  file_meta?: Array<{
    source_session: string;
    session_name?: string;
    agent?: string;
    created_at?: string;
    updated_at?: string;
    created_by?: string;
  }>;
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

export async function fetchGitDiff(rootId: string, path: string): Promise<GitDiffPayload> {
  const response = await fetch(appURL("/api/git/diff", new URLSearchParams({ root: rootId, path })));
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(payload?.message || payload?.error || `Failed to fetch git diff: status=${response.status}`));
  }
  return {
    path: typeof payload?.path === "string" ? payload.path : path,
    status: typeof payload?.status === "string" ? payload.status : "M",
    additions: Number(payload?.additions) || 0,
    deletions: Number(payload?.deletions) || 0,
    content: typeof payload?.content === "string" ? payload.content : "",
    file_meta: Array.isArray(payload?.file_meta) ? payload.file_meta : [],
  };
}

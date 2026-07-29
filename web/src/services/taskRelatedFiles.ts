import type { RelatedFile } from "./session";

export function taskIdsForUpdatedSession(
  taskSessionKeysById: Record<string, string[]>,
  sessionKey: string,
): string[] {
  const target = String(sessionKey || "").trim();
  if (!target) return [];
  return Object.entries(taskSessionKeysById)
    .filter(([, keys]) => (keys || []).map((key) => String(key || "").trim()).includes(target))
    .map(([taskId]) => taskId);
}

export function mergeRelatedFileGroups(groups: RelatedFile[][]): RelatedFile[] {
  const seen = new Set<string>();
  const merged: RelatedFile[] = [];
  groups.flat().forEach((file) => {
    const key = [
      file.root_id || "",
      file.repo_kind || "",
      file.repo_path || "",
      file.head || "",
      file.path || "",
    ].join("\0");
    if (!file.path || seen.has(key)) return;
    seen.add(key);
    merged.push(file);
  });
  return merged;
}

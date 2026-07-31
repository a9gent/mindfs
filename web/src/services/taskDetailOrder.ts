import type { TaskDetail } from "./tasks";

function taskUpdatedAtNanoseconds(value: string | undefined): bigint | null {
  const match = String(value || "").match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (!match) return null;
  const seconds = Date.parse(`${match[1]}${match[3]}`);
  if (!Number.isFinite(seconds)) return null;
  const fraction = (match[2] || "").slice(0, 9).padEnd(9, "0");
  return BigInt(seconds) * 1_000_000n + BigInt(fraction);
}

export function shouldApplyTaskDetail(
  current: TaskDetail | undefined,
  incoming: TaskDetail,
): boolean {
  if (!current) return true;
  const currentUpdatedAt = taskUpdatedAtNanoseconds(current.task.updated_at);
  const incomingUpdatedAt = taskUpdatedAtNanoseconds(incoming.task.updated_at);
  if (incomingUpdatedAt === null) return currentUpdatedAt === null;
  if (currentUpdatedAt === null) return true;
  return incomingUpdatedAt >= currentUpdatedAt;
}

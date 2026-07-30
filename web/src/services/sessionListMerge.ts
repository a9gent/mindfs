export type PinAwareSessionItem = {
  key?: string;
  session_key?: string;
  root_id?: string;
  updated_at?: string;
  pinned_at?: string | null;
};

function sessionKey(item: PinAwareSessionItem): string {
  return String(item.key || item.session_key || "");
}

function timeValue(value: string | null | undefined): number {
  return Date.parse(String(value || "")) || 0;
}

export function mergeSessionItems<T extends PinAwareSessionItem>(
  current: T[],
  incoming: T[],
): T[] {
  const byKey = new Map<string, T>();
  for (const item of current) {
    const key = sessionKey(item);
    if (key) {
      byKey.set(key, item);
    }
  }
  for (const item of incoming) {
    const key = sessionKey(item);
    if (!key) {
      continue;
    }
    byKey.set(key, { ...(byKey.get(key) || ({} as T)), ...item });
  }
  return Array.from(byKey.values()).sort(compareSessionItems);
}

export function applyPinnedSnapshotToSessions<T extends PinAwareSessionItem>(
  items: T[],
  rootId: string,
  pinnedKeys: string[],
): T[] {
  const pinned = new Set(pinnedKeys.map((key) => String(key || "").trim()).filter(Boolean));
  const next = items.map((item) => {
    if (String(item.root_id || "") !== rootId) {
      return item;
    }
    const key = sessionKey(item);
    if (!key || pinned.has(key) || !item.pinned_at) {
      return item;
    }
    const copy = { ...item };
    delete copy.pinned_at;
    return copy;
  });
  return next.sort(compareSessionItems);
}

function compareSessionItems(left: PinAwareSessionItem, right: PinAwareSessionItem): number {
  const leftPinned = timeValue(left.pinned_at);
  const rightPinned = timeValue(right.pinned_at);
  if (leftPinned || rightPinned) {
    if (leftPinned !== rightPinned) {
      return rightPinned - leftPinned;
    }
  }
  const leftUpdated = timeValue(left.updated_at);
  const rightUpdated = timeValue(right.updated_at);
  if (leftUpdated !== rightUpdated) {
    return rightUpdated - leftUpdated;
  }
  return sessionKey(left).localeCompare(sessionKey(right));
}

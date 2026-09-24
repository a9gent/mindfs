import type { MultiRootSessionGroup } from "./session";

export function ringGesture(x: number, y: number): "new" | "switch" | null {
  if (x <= -40 && -x > Math.abs(y)) return "new";
  if (y <= -40 && -y > Math.abs(x)) return "switch";
  return null;
}

export function recentQuickSwitchGroups(groups: MultiRootSessionGroup[]) {
  const time = (value: string) => Date.parse(value) || 0;
  return [...groups]
    .sort((a, b) => time(b.latestSessionTime) - time(a.latestSessionTime))
    .slice(0, 3)
    .map((group) => {
      const sessions = new Map([...group.items, ...group.pinnedItems]
        .map((session) => [session.key || session.session_key, session]));
      return {
        ...group,
        items: [...sessions.values()]
          .filter((session) => !!(session.key || session.session_key))
          .sort((a, b) => time(b.updated_at || b.created_at) - time(a.updated_at || a.created_at))
          .slice(0, 3),
      };
    });
}

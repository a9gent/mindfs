export type SessionTimeWindow = "all" | "1h" | "3h" | "day";

export type SessionFilterState = {
  runningOnly: boolean;
  timeWindow: SessionTimeWindow;
  sortAsc: boolean;
};

export const SESSION_FILTER_STORAGE_KEY = "mindfs-session-filter";

export const DEFAULT_SESSION_FILTER: SessionFilterState = {
  runningOnly: false,
  timeWindow: "all",
  sortAsc: false,
};

export function normalizeSessionFilter(raw: unknown): SessionFilterState {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_SESSION_FILTER };
  }
  const value = raw as Record<string, unknown>;
  const timeWindow = value.timeWindow;
  return {
    runningOnly: value.runningOnly === true,
    timeWindow:
      timeWindow === "1h" || timeWindow === "3h" || timeWindow === "day" ? timeWindow : "all",
    sortAsc: value.sortAsc === true,
  };
}

export function loadSessionFilter(): SessionFilterState {
  if (typeof window === "undefined") {
    return { ...DEFAULT_SESSION_FILTER };
  }
  try {
    return normalizeSessionFilter(JSON.parse(window.localStorage.getItem(SESSION_FILTER_STORAGE_KEY) || "{}"));
  } catch {
    return { ...DEFAULT_SESSION_FILTER };
  }
}

export function persistSessionFilter(filter: SessionFilterState): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(SESSION_FILTER_STORAGE_KEY, JSON.stringify(filter));
  } catch {
    // storage unavailable (private mode / quota); filter stays session-local
  }
}

export function isSessionFilterActive(filter: SessionFilterState): boolean {
  return filter.runningOnly || filter.timeWindow !== "all" || filter.sortAsc;
}

const TIME_WINDOW_MS: Record<Exclude<SessionTimeWindow, "all">, number> = {
  "1h": 60 * 60 * 1000,
  "3h": 3 * 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
};

export function sessionWithinTimeWindow(updatedAt: string | undefined, timeWindow: SessionTimeWindow, now = Date.now()): boolean {
  if (timeWindow === "all") {
    return true;
  }
  if (!updatedAt) {
    return false;
  }
  const time = Date.parse(updatedAt);
  if (Number.isNaN(time)) {
    return false;
  }
  return now - time <= TIME_WINDOW_MS[timeWindow];
}

export type FilteredSessions<T extends { pending?: boolean; updated_at?: string }> = {
  running: T[];
  rest: T[];
};

/**
 * Project a session list through the filter state. The input list is assumed
 * to be ordered newest-first (as produced by the backend); ordering inside
 * each bucket is preserved, "sortAsc" reverses the non-running bucket.
 */
export function applySessionFilters<T extends { pending?: boolean; updated_at?: string }>(
  sessions: readonly T[],
  filter: SessionFilterState,
  now = Date.now(),
): FilteredSessions<T> {
  const running: T[] = [];
  const rest: T[] = [];
  for (const session of sessions) {
    if (filter.runningOnly && !session.pending) {
      continue;
    }
    // 运行中会话豁免时间窗：长时间无更新的运行中会话不应「消失」
    if (session.pending) {
      running.push(session);
      continue;
    }
    if (sessionWithinTimeWindow(session.updated_at, filter.timeWindow, now)) {
      rest.push(session);
    }
  }
  if (filter.sortAsc) {
    rest.reverse();
  }
  return { running, rest };
}

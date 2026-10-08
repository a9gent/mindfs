import type { MessageKey } from "../i18n";
import type { MultiRootSessionGroup } from "./session";

export function ringGesture(x: number, y: number): "new" | "switch" | null {
  if (x <= -40 && -x > Math.abs(y)) return "new";
  if (y <= -40 && -y > Math.abs(x)) return "switch";
  return null;
}

/** Gestures recognized on the blue ring next to the message input. */
export type BlueRingGesture = "left" | "right" | "up" | "upLeft" | "upRight";

/** Actions a blue ring gesture can trigger. */
export type BlueRingAction =
  | "none"
  | "newSession"
  | "quickSwitch"
  | "recentSession"
  | "toggleFileSidebar"
  | "toggleSessionSidebar"
  | "modelSelector";

export type BlueRingGestureConfig = {
  enabled: boolean;
  actions: Record<BlueRingGesture, BlueRingAction>;
};

// Keep the persisted key compatible with existing gesture preferences.
export const BLUE_RING_GESTURE_STORAGE_KEY = "mindfs-float-ball-gestures";

/** Mirrors the original behavior: left = new session, up = quick switch. */
export const DEFAULT_BLUE_RING_ACTIONS: Record<BlueRingGesture, BlueRingAction> = {
  left: "newSession",
  right: "none",
  up: "quickSwitch",
  upLeft: "none",
  upRight: "none",
};

export const BLUE_RING_GESTURES: readonly BlueRingGesture[] = ["left", "right", "up", "upLeft", "upRight"];

export const BLUE_RING_ACTION_OPTIONS: readonly BlueRingAction[] = [
  "none",
  "newSession",
  "quickSwitch",
  "recentSession",
  "toggleFileSidebar",
  "toggleSessionSidebar",
  "modelSelector",
];

export const BLUE_RING_GESTURE_LABEL_KEYS: Record<BlueRingGesture, MessageKey> = {
  left: "blueRing.gesture.left",
  right: "blueRing.gesture.right",
  up: "blueRing.gesture.up",
  upLeft: "blueRing.gesture.upLeft",
  upRight: "blueRing.gesture.upRight",
};

export const BLUE_RING_ACTION_LABEL_KEYS: Record<BlueRingAction, MessageKey> = {
  none: "blueRing.action.none",
  newSession: "blueRing.action.newSession",
  quickSwitch: "blueRing.action.quickSwitch",
  recentSession: "blueRing.action.recentSession",
  toggleFileSidebar: "blueRing.action.toggleFileSidebar",
  toggleSessionSidebar: "blueRing.action.toggleSessionSidebar",
  modelSelector: "blueRing.action.modelSelector",
};

const BLUE_RING_ACTION_SET = new Set<string>(BLUE_RING_ACTION_OPTIONS);

function normalizeBlueRingAction(value: unknown, fallback: BlueRingAction): BlueRingAction {
  return typeof value === "string" && BLUE_RING_ACTION_SET.has(value) ? value as BlueRingAction : fallback;
}

export function normalizeBlueRingGestureConfig(value: unknown): BlueRingGestureConfig {
  const input = value && typeof value === "object" ? value as Partial<BlueRingGestureConfig> : {};
  const actions = input.actions && typeof input.actions === "object"
    ? input.actions as Partial<Record<BlueRingGesture, unknown>>
    : {};
  return {
    enabled: input.enabled === true,
    actions: {
      left: normalizeBlueRingAction(actions.left, DEFAULT_BLUE_RING_ACTIONS.left),
      right: normalizeBlueRingAction(actions.right, DEFAULT_BLUE_RING_ACTIONS.right),
      up: normalizeBlueRingAction(actions.up, DEFAULT_BLUE_RING_ACTIONS.up),
      upLeft: normalizeBlueRingAction(actions.upLeft, DEFAULT_BLUE_RING_ACTIONS.upLeft),
      upRight: normalizeBlueRingAction(actions.upRight, DEFAULT_BLUE_RING_ACTIONS.upRight),
    },
  };
}

export function loadBlueRingGestureConfig(): BlueRingGestureConfig {
  let raw: string | null = null;
  try {
    raw = typeof window === "undefined" ? null : window.localStorage.getItem(BLUE_RING_GESTURE_STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (!raw) return { enabled: false, actions: { ...DEFAULT_BLUE_RING_ACTIONS } };
  try {
    return normalizeBlueRingGestureConfig(JSON.parse(raw));
  } catch {
    return { enabled: false, actions: { ...DEFAULT_BLUE_RING_ACTIONS } };
  }
}

export function persistBlueRingGestureConfig(config: BlueRingGestureConfig): void {
  try {
    window.localStorage.setItem(BLUE_RING_GESTURE_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Ignore storage failures; the setting can still apply for this session.
  }
}

/** Actions that actually run: while the feature is off the original mapping applies. */
export function effectiveBlueRingActions(config: BlueRingGestureConfig | null | undefined): Record<BlueRingGesture, BlueRingAction> {
  if (!config?.enabled) return { ...DEFAULT_BLUE_RING_ACTIONS };
  return { ...DEFAULT_BLUE_RING_ACTIONS, ...config.actions };
}

export type RingPathPoint = { x: number; y: number };

export type RingGestureMatch = { gesture: BlueRingGesture; ready: boolean };

const RING_SWIPE_THRESHOLD = 40;
const RING_SWIPE_HINT_THRESHOLD = 10;

/**
 * Classify the pointer path of a blue ring drag. Strict thresholds commit an
 * action on release; loose thresholds drive the live hint while dragging
 * (ready marks the point where the strict gesture would commit).
 */
export function ringPathGesture(points: RingPathPoint[], strict: boolean): RingGestureMatch | null {
  if (points.length < 2) return null;
  const start = points[0];
  const end = points[points.length - 1];
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  // The upper corners depend only on displacement, not on the route taken.
  const horizontal = Math.abs(dx);
  const upward = -dy;
  if (upward > 0 && horizontal >= upward / 2 && upward >= horizontal / 2) {
    const ready = horizontal >= RING_SWIPE_THRESHOLD && upward >= RING_SWIPE_THRESHOLD;
    if (strict ? !ready : Math.min(horizontal, upward) < RING_SWIPE_HINT_THRESHOLD) return null;
    return { gesture: dx < 0 ? "upLeft" : "upRight", ready };
  }
  if (Math.abs(dx) >= RING_SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
    return { gesture: dx < 0 ? "left" : "right", ready: true };
  }
  if (dy <= -RING_SWIPE_THRESHOLD && -dy > Math.abs(dx)) {
    return { gesture: "up", ready: true };
  }
  if (strict) return null;
  if (Math.abs(dx) >= RING_SWIPE_HINT_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
    return { gesture: dx < 0 ? "left" : "right", ready: false };
  }
  if (dy <= -RING_SWIPE_HINT_THRESHOLD && -dy > Math.abs(dx)) {
    return { gesture: "up", ready: false };
  }
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

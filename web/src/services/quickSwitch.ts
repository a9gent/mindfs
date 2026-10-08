import type { MessageKey } from "../i18n";
import type { MultiRootSessionGroup } from "./session";

export function ringGesture(x: number, y: number): "new" | "switch" | null {
  if (x <= -40 && -x > Math.abs(y)) return "new";
  if (y <= -40 && -y > Math.abs(x)) return "switch";
  return null;
}

/** Gestures recognized on the float ball (blue ring next to the message input). */
export type FloatBallGesture = "left" | "right" | "up" | "upLeft" | "upRight";

/** Actions a float ball gesture can trigger. */
export type FloatBallAction =
  | "none"
  | "newSession"
  | "quickSwitch"
  | "recentSession"
  | "toggleFileSidebar"
  | "toggleSessionSidebar"
  | "modelSelector";

export type FloatBallGestureConfig = {
  enabled: boolean;
  actions: Record<FloatBallGesture, FloatBallAction>;
};

export const FLOAT_BALL_GESTURE_STORAGE_KEY = "mindfs-float-ball-gestures";

/** Mirrors the original behavior: left = new session, up = quick switch. */
export const DEFAULT_FLOAT_BALL_ACTIONS: Record<FloatBallGesture, FloatBallAction> = {
  left: "newSession",
  right: "none",
  up: "quickSwitch",
  upLeft: "none",
  upRight: "none",
};

export const FLOAT_BALL_GESTURES: readonly FloatBallGesture[] = ["left", "right", "up", "upLeft", "upRight"];

export const FLOAT_BALL_ACTION_OPTIONS: readonly FloatBallAction[] = [
  "none",
  "newSession",
  "quickSwitch",
  "recentSession",
  "toggleFileSidebar",
  "toggleSessionSidebar",
  "modelSelector",
];

export const FLOAT_BALL_GESTURE_LABEL_KEYS: Record<FloatBallGesture, MessageKey> = {
  left: "floatBall.gesture.left",
  right: "floatBall.gesture.right",
  up: "floatBall.gesture.up",
  upLeft: "floatBall.gesture.upLeft",
  upRight: "floatBall.gesture.upRight",
};

export const FLOAT_BALL_ACTION_LABEL_KEYS: Record<FloatBallAction, MessageKey> = {
  none: "floatBall.action.none",
  newSession: "floatBall.action.newSession",
  quickSwitch: "floatBall.action.quickSwitch",
  recentSession: "floatBall.action.recentSession",
  toggleFileSidebar: "floatBall.action.toggleFileSidebar",
  toggleSessionSidebar: "floatBall.action.toggleSessionSidebar",
  modelSelector: "floatBall.action.modelSelector",
};

const FLOAT_BALL_ACTION_SET = new Set<string>(FLOAT_BALL_ACTION_OPTIONS);

function normalizeFloatBallAction(value: unknown, fallback: FloatBallAction): FloatBallAction {
  return typeof value === "string" && FLOAT_BALL_ACTION_SET.has(value) ? value as FloatBallAction : fallback;
}

export function normalizeFloatBallGestureConfig(value: unknown): FloatBallGestureConfig {
  const input = value && typeof value === "object" ? value as Partial<FloatBallGestureConfig> : {};
  const actions = input.actions && typeof input.actions === "object"
    ? input.actions as Partial<Record<FloatBallGesture, unknown>>
    : {};
  return {
    enabled: input.enabled === true,
    actions: {
      left: normalizeFloatBallAction(actions.left, DEFAULT_FLOAT_BALL_ACTIONS.left),
      right: normalizeFloatBallAction(actions.right, DEFAULT_FLOAT_BALL_ACTIONS.right),
      up: normalizeFloatBallAction(actions.up, DEFAULT_FLOAT_BALL_ACTIONS.up),
      upLeft: normalizeFloatBallAction(actions.upLeft, DEFAULT_FLOAT_BALL_ACTIONS.upLeft),
      upRight: normalizeFloatBallAction(actions.upRight, DEFAULT_FLOAT_BALL_ACTIONS.upRight),
    },
  };
}

export function loadFloatBallGestureConfig(): FloatBallGestureConfig {
  let raw: string | null = null;
  try {
    raw = typeof window === "undefined" ? null : window.localStorage.getItem(FLOAT_BALL_GESTURE_STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (!raw) return { enabled: false, actions: { ...DEFAULT_FLOAT_BALL_ACTIONS } };
  try {
    return normalizeFloatBallGestureConfig(JSON.parse(raw));
  } catch {
    return { enabled: false, actions: { ...DEFAULT_FLOAT_BALL_ACTIONS } };
  }
}

export function persistFloatBallGestureConfig(config: FloatBallGestureConfig): void {
  try {
    window.localStorage.setItem(FLOAT_BALL_GESTURE_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Ignore storage failures; the setting can still apply for this session.
  }
}

/** Actions that actually run: while the feature is off the original mapping applies. */
export function effectiveFloatBallActions(config: FloatBallGestureConfig | null | undefined): Record<FloatBallGesture, FloatBallAction> {
  if (!config?.enabled) return { ...DEFAULT_FLOAT_BALL_ACTIONS };
  return { ...DEFAULT_FLOAT_BALL_ACTIONS, ...config.actions };
}

export type RingPathPoint = { x: number; y: number };

export type RingGestureMatch = { gesture: FloatBallGesture; ready: boolean };

const RING_SWIPE_THRESHOLD = 40;
const RING_SWIPE_HINT_THRESHOLD = 10;
const RING_TURN_THRESHOLD = 36;
const RING_TURN_HINT_THRESHOLD = 14;
/** After reaching the top, the finger must stay near it while turning sideways. */
const RING_TURN_SAG_LIMIT = 24;
/** Two-phase gestures must end well above the starting point. */
const RING_TURN_MIN_HEIGHT = 30;

function ringApex(points: RingPathPoint[]): RingPathPoint {
  let apex = points[0];
  for (const point of points) {
    if (point.y < apex.y) apex = point;
  }
  return apex;
}

/**
 * Classify the pointer path of a float ball drag. Strict thresholds commit an
 * action on release; loose thresholds drive the live hint while dragging
 * (ready marks the point where the strict gesture would commit).
 */
export function ringPathGesture(points: RingPathPoint[], strict: boolean): RingGestureMatch | null {
  if (points.length < 2) return null;
  const start = points[0];
  const end = points[points.length - 1];
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  // Two-phase gestures: reach the top first, then turn left/right while keeping the finger high.
  const apex = ringApex(points);
  const turnX = end.x - apex.x;
  const turnY = end.y - apex.y;
  const turnLimit = strict ? RING_TURN_THRESHOLD : RING_TURN_HINT_THRESHOLD;
  if (apex.y - start.y <= -RING_SWIPE_THRESHOLD
    && Math.abs(turnX) >= turnLimit
    && Math.abs(turnX) > Math.abs(turnY)
    && turnY <= RING_TURN_SAG_LIMIT
    && end.y - start.y <= -RING_TURN_MIN_HEIGHT) {
    return { gesture: turnX < 0 ? "upLeft" : "upRight", ready: Math.abs(turnX) >= RING_TURN_THRESHOLD };
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

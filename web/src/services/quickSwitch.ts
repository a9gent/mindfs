import type { MessageKey } from "../i18n";
import type { AppearanceMode } from "./appearance";
import type { MultiRootSessionGroup } from "./session";

export function ringGesture(x: number, y: number): "new" | "switch" | null {
  if (x <= -40 && -x > Math.abs(y)) return "new";
  if (y <= -40 && -y > Math.abs(x)) return "switch";
  return null;
}

/**
 * Gestures recognized on the blue ring next to the message input.
 *
 * Two families:
 * - tap / doubleTap: click-scale gestures, no path needed.
 * - path gestures: single-stroke (left/right/up and the two corner diagonals
 *   upLeft/upRight, judged on displacement like the original ring) and
 *   two-stage trails that go up first and then turn (upDown, upThenLeft/right
 *   and the corner continuations upLeftThenRight / upRightThenLeft/down).
 */
export type BlueRingGesture =
  | "tap"
  | "doubleTap"
  | "left"
  | "right"
  | "up"
  | "upLeft"
  | "upRight"
  | "upDown"
  | "upThenLeft"
  | "upThenRight"
  | "upLeftThenRight"
  | "upRightThenLeft"
  | "upRightThenDown";

/** Actions a blue ring gesture can trigger. */
export type BlueRingAction =
  | "none"
  | "newSession"
  | "quickSwitch"
  | "recentSession"
  | "toggleFileSidebar"
  | "toggleSessionSidebar"
  | "modelSelector"
  | "agentToggle"
  | "agentPick"
  | "dirSwitch"
  | "recentDirSwitch"
  | "toggleMultiProjectList"
  | "toggleEnterSend"
  | "fontCycle"
  | "themeCycle"
  | "outlineToggle"
  | "toggleMainView"
  | "kanbanTemplateCycle"
  | "newTask"
  | "openScheduledTasks";

export type BlueRingGestureConfig = {
  enabled: boolean;
  actions: Record<BlueRingGesture, BlueRingAction>;
  /** Per-gesture agent name for the "agentPick" action, chosen in settings. */
  agentPicks?: Partial<Record<BlueRingGesture, string>>;
  /** Per-gesture task template id for the "newTask" action, chosen in settings. */
  taskPicks?: Partial<Record<BlueRingGesture, string>>;
};

// Keep the persisted key compatible with existing gesture preferences.
export const BLUE_RING_GESTURE_STORAGE_KEY = "mindfs-float-ball-gestures";

/** Mirrors the original behavior: left = new session, up = quick switch. Tap opens the panel. */
export const DEFAULT_BLUE_RING_ACTIONS: Record<BlueRingGesture, BlueRingAction> = {
  tap: "quickSwitch",
  doubleTap: "none",
  left: "newSession",
  right: "none",
  up: "quickSwitch",
  upLeft: "none",
  upRight: "none",
  upDown: "none",
  upThenLeft: "none",
  upThenRight: "none",
  upLeftThenRight: "none",
  upRightThenLeft: "none",
  upRightThenDown: "none",
};

/** Click-scale gestures are handled by the tap/double-tap logic, not path matching. */
export const BLUE_RING_PATH_GESTURES: readonly BlueRingGesture[] = [
  "left",
  "right",
  "up",
  "upLeft",
  "upRight",
  "upDown",
  "upThenLeft",
  "upThenRight",
  "upLeftThenRight",
  "upRightThenLeft",
  "upRightThenDown",
];

export const BLUE_RING_GESTURES: readonly BlueRingGesture[] = [
  "tap",
  "doubleTap",
  ...BLUE_RING_PATH_GESTURES,
];

export const BLUE_RING_ACTION_OPTIONS: readonly BlueRingAction[] = [
  "none",
  "newSession",
  "quickSwitch",
  "recentSession",
  "toggleFileSidebar",
  "toggleSessionSidebar",
  "modelSelector",
  "agentToggle",
  "agentPick",
  "dirSwitch",
  "recentDirSwitch",
  "toggleMultiProjectList",
  "toggleEnterSend",
  "fontCycle",
  "themeCycle",
  "outlineToggle",
  "toggleMainView",
  "kanbanTemplateCycle",
  "newTask",
  "openScheduledTasks",
];

export const BLUE_RING_GESTURE_LABEL_KEYS: Record<BlueRingGesture, MessageKey> = {
  tap: "blueRing.gesture.tap",
  doubleTap: "blueRing.gesture.doubleTap",
  left: "blueRing.gesture.left",
  right: "blueRing.gesture.right",
  up: "blueRing.gesture.up",
  upLeft: "blueRing.gesture.upLeft",
  upRight: "blueRing.gesture.upRight",
  upDown: "blueRing.gesture.upDown",
  upThenLeft: "blueRing.gesture.upThenLeft",
  upThenRight: "blueRing.gesture.upThenRight",
  upLeftThenRight: "blueRing.gesture.upLeftThenRight",
  upRightThenLeft: "blueRing.gesture.upRightThenLeft",
  upRightThenDown: "blueRing.gesture.upRightThenDown",
};

export const BLUE_RING_ACTION_LABEL_KEYS: Record<BlueRingAction, MessageKey> = {
  none: "blueRing.action.none",
  newSession: "blueRing.action.newSession",
  quickSwitch: "blueRing.action.quickSwitch",
  recentSession: "blueRing.action.recentSession",
  toggleFileSidebar: "blueRing.action.toggleFileSidebar",
  toggleSessionSidebar: "blueRing.action.toggleSessionSidebar",
  modelSelector: "blueRing.action.modelSelector",
  agentToggle: "blueRing.action.agentToggle",
  agentPick: "blueRing.action.agentPick",
  dirSwitch: "blueRing.action.dirSwitch",
  recentDirSwitch: "blueRing.action.recentDirSwitch",
  toggleMultiProjectList: "blueRing.action.toggleMultiProjectList",
  toggleEnterSend: "blueRing.action.toggleEnterSend",
  fontCycle: "blueRing.action.fontCycle",
  themeCycle: "blueRing.action.themeCycle",
  outlineToggle: "blueRing.action.outlineToggle",
  toggleMainView: "blueRing.action.toggleMainView",
  kanbanTemplateCycle: "blueRing.action.kanbanTemplateCycle",
  newTask: "blueRing.action.newTask",
  openScheduledTasks: "blueRing.action.openScheduledTasks",
};

const BLUE_RING_ACTION_SET = new Set<string>(BLUE_RING_ACTION_OPTIONS);
const BLUE_RING_GESTURE_SET = new Set<string>(BLUE_RING_GESTURES);

function normalizeBlueRingAction(value: unknown, fallback: BlueRingAction): BlueRingAction {
  return typeof value === "string" && BLUE_RING_ACTION_SET.has(value) ? value as BlueRingAction : fallback;
}

function normalizeBlueRingAgentPicks(value: unknown): Partial<Record<BlueRingGesture, string>> {
  return normalizeBlueRingGesturePicks(value);
}

function normalizeBlueRingGesturePicks(value: unknown): Partial<Record<BlueRingGesture, string>> {
  if (!value || typeof value !== "object") return {};
  const input = value as Record<string, unknown>;
  const picks: Partial<Record<BlueRingGesture, string>> = {};
  for (const [gesture, pick] of Object.entries(input)) {
    if (BLUE_RING_GESTURE_SET.has(gesture) && typeof pick === "string" && pick.trim()) {
      picks[gesture as BlueRingGesture] = pick.trim();
    }
  }
  return picks;
}

export function normalizeBlueRingGestureConfig(value: unknown): BlueRingGestureConfig {
  const input = value && typeof value === "object" ? value as Partial<BlueRingGestureConfig> : {};
  const actions = input.actions && typeof input.actions === "object"
    ? input.actions as Partial<Record<BlueRingGesture, unknown>>
    : {};
  return {
    enabled: input.enabled === true,
    actions: {
      tap: normalizeBlueRingAction(actions.tap, DEFAULT_BLUE_RING_ACTIONS.tap),
      doubleTap: normalizeBlueRingAction(actions.doubleTap, DEFAULT_BLUE_RING_ACTIONS.doubleTap),
      left: normalizeBlueRingAction(actions.left, DEFAULT_BLUE_RING_ACTIONS.left),
      right: normalizeBlueRingAction(actions.right, DEFAULT_BLUE_RING_ACTIONS.right),
      up: normalizeBlueRingAction(actions.up, DEFAULT_BLUE_RING_ACTIONS.up),
      upLeft: normalizeBlueRingAction(actions.upLeft, DEFAULT_BLUE_RING_ACTIONS.upLeft),
      upRight: normalizeBlueRingAction(actions.upRight, DEFAULT_BLUE_RING_ACTIONS.upRight),
      upDown: normalizeBlueRingAction(actions.upDown, DEFAULT_BLUE_RING_ACTIONS.upDown),
      upThenLeft: normalizeBlueRingAction(actions.upThenLeft, DEFAULT_BLUE_RING_ACTIONS.upThenLeft),
      upThenRight: normalizeBlueRingAction(actions.upThenRight, DEFAULT_BLUE_RING_ACTIONS.upThenRight),
      upLeftThenRight: normalizeBlueRingAction(actions.upLeftThenRight, DEFAULT_BLUE_RING_ACTIONS.upLeftThenRight),
      upRightThenLeft: normalizeBlueRingAction(actions.upRightThenLeft, DEFAULT_BLUE_RING_ACTIONS.upRightThenLeft),
      upRightThenDown: normalizeBlueRingAction(actions.upRightThenDown, DEFAULT_BLUE_RING_ACTIONS.upRightThenDown),
    },
    agentPicks: normalizeBlueRingAgentPicks(input.agentPicks),
    taskPicks: normalizeBlueRingGesturePicks(input.taskPicks),
  };
}

export function loadBlueRingGestureConfig(): BlueRingGestureConfig {
  let raw: string | null = null;
  try {
    raw = typeof window === "undefined" ? null : window.localStorage.getItem(BLUE_RING_GESTURE_STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (!raw) return normalizeBlueRingGestureConfig(null);
  try {
    return normalizeBlueRingGestureConfig(JSON.parse(raw));
  } catch {
    return normalizeBlueRingGestureConfig(null);
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
/** Apex noise band: the first point within 5px of the highest point counts as the turn. */
const RING_APEX_NOISE_PX = 5;

type UpSegment = "up" | "upLeft" | "upRight";
type TurnSegment = "left" | "right" | "down";

function classifyUpSegment(dx: number, dy: number, minUp: number): UpSegment | null {
  if (dy > -minUp) return null;
  const upward = -dy;
  const horizontal = Math.abs(dx);
  if (horizontal < upward / 2) return "up";
  // Same diagonal band as the original corner rule: horizontal within [up/2, up*2].
  if (horizontal <= upward * 2) return dx < 0 ? "upLeft" : "upRight";
  return null;
}

function classifyTurnSegment(dx: number, dy: number, minTurn: number): TurnSegment | null {
  // Apex is the highest point, so dy can only go down from there.
  if (Math.abs(dx) > dy) {
    if (dx >= minTurn) return "right";
    if (dx <= -minTurn) return "left";
    return null;
  }
  if (dy >= minTurn) return "down";
  return null;
}

/**
 * Map an upward first leg + turn leg to a two-stage gesture. Returns null for
 * undefined combinations (e.g. up-left then left) so classification falls
 * through to the legacy displacement rules instead of misfiring a new gesture.
 */
function mapTwoStageGesture(seg1: UpSegment, seg2: TurnSegment | null): BlueRingGesture | null {
  if (seg1 === "up") {
    if (seg2 === "down") return "upDown";
    if (seg2 === "right") return "upThenRight";
    if (seg2 === "left") return "upThenLeft";
    return null;
  }
  if (seg1 === "upLeft") {
    return seg2 === "right" ? "upLeftThenRight" : null;
  }
  if (seg1 === "upRight") {
    if (seg2 === "left") return "upRightThenLeft";
    if (seg2 === "down") return "upRightThenDown";
    return null;
  }
  return null;
}

function classifyRingPath(points: RingPathPoint[], minSwipe: number): BlueRingGesture | null {
  if (points.length < 2) return null;
  const start = points[0];
  const end = points[points.length - 1];

  // Two-stage trails: find the turn point (first contact with the highest band),
  // classify the upward leg and the leg after the turn.
  let minY = Infinity;
  for (const point of points) {
    if (point.y < minY) minY = point.y;
  }
  let apexIndex = -1;
  for (let index = 0; index < points.length; index += 1) {
    if (points[index].y <= minY + RING_APEX_NOISE_PX) {
      apexIndex = index;
      break;
    }
  }
  if (apexIndex > 0) {
    const apex = points[apexIndex];
    const seg1 = classifyUpSegment(apex.x - start.x, apex.y - start.y, minSwipe);
    if (seg1) {
      const seg2 = apexIndex < points.length - 1
        ? classifyTurnSegment(end.x - apex.x, end.y - apex.y, minSwipe)
        : null;
      const mapped = mapTwoStageGesture(seg1, seg2);
      if (mapped) return mapped;
    }
  }

  // Single-stroke fallback: displacement only, same as the original ring.
  // Deliberately judgment by start→end displacement, so three-leg trails
  // (e.g. ↑→↓) land on the two-stage guess from end-vs-apex and may degrade to
  // a plain gesture — acceptable, since no three-leg gesture exists and none
  // of the actions is destructive.
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const horizontal = Math.abs(dx);
  const upward = -dy;
  if (upward > 0 && horizontal >= upward / 2 && upward >= horizontal / 2
    && horizontal >= minSwipe && upward >= minSwipe) {
    return dx < 0 ? "upLeft" : "upRight";
  }
  if (horizontal >= minSwipe && horizontal > Math.abs(dy)) {
    return dx < 0 ? "left" : "right";
  }
  if (dy <= -minSwipe && upward > horizontal) {
    return "up";
  }
  return null;
}

/**
 * Classify the pointer path of a blue ring drag. Strict thresholds commit an
 * action on release; loose thresholds drive the live hint while dragging
 * (ready marks the point where the strict gesture would commit).
 */
export function ringPathGesture(points: RingPathPoint[], strict: boolean): RingGestureMatch | null {
  const strictGesture = classifyRingPath(points, RING_SWIPE_THRESHOLD);
  if (strict) return strictGesture ? { gesture: strictGesture, ready: true } : null;
  if (strictGesture) return { gesture: strictGesture, ready: true };
  const looseGesture = classifyRingPath(points, RING_SWIPE_HINT_THRESHOLD);
  return looseGesture ? { gesture: looseGesture, ready: false } : null;
}

/** Main session font cycle: 100% → 140% in 10% steps, then back down, looping. */
// Floor mirrors fontSize.FONT_SIZE_MIN; inlined because node-run tests import
// this module directly and cannot resolve extensionless value imports.
const FONT_SCALE_FLOOR = 0.8;
export const FONT_CYCLE_MIN = 1;
export const FONT_CYCLE_MAX = 1.4;
export const FONT_CYCLE_STEP = 0.1;

export type FontCycleDirection = "up" | "down";

function roundFontScale(value: number): number {
  return Number((Math.round(value / FONT_CYCLE_STEP) * FONT_CYCLE_STEP).toFixed(1));
}

export function nextFontCycleScale(
  current: number,
  direction: FontCycleDirection,
): { scale: number; direction: FontCycleDirection } {
  let nextDirection = direction;
  if (current <= FONT_CYCLE_MIN) nextDirection = "up";
  if (current >= FONT_CYCLE_MAX) nextDirection = "down";
  const scale = roundFontScale(current + (nextDirection === "up" ? FONT_CYCLE_STEP : -FONT_CYCLE_STEP));
  const clamped = Math.min(FONT_CYCLE_MAX, Math.max(FONT_SCALE_FLOOR, scale));
  return { scale: clamped, direction: nextDirection };
}

/** Appearance cycle order: the two common themes first, extras, system last. */
export const THEME_CYCLE_ORDER: readonly AppearanceMode[] = ["dark", "light", "meadow", "moss", "system"];

export function nextAppearanceMode(current: AppearanceMode): AppearanceMode {
  const index = THEME_CYCLE_ORDER.indexOf(current);
  return THEME_CYCLE_ORDER[(index + 1) % THEME_CYCLE_ORDER.length];
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

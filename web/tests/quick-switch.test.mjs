import assert from "node:assert/strict";
import {
  DEFAULT_BLUE_RING_ACTIONS,
  effectiveBlueRingActions,
  normalizeBlueRingGestureConfig,
  recentQuickSwitchGroups,
  ringGesture,
  ringPathGesture,
} from "../src/services/quickSwitch.ts";

assert.equal(ringGesture(-40, 0), "new");
assert.equal(ringGesture(0, -40), "switch");
assert.equal(ringGesture(-55, -42), "new");
assert.equal(ringGesture(-42, -55), "switch");
for (const [x, y] of [[0, 0], [-39, 0], [0, -39], [60, 0], [0, 60], [-50, -50], [-40, 70], [70, -40]]) {
  assert.equal(ringGesture(x, y), null, `Unexpected gesture for ${x}, ${y}`);
}

const path = (...points) => points.map(([x, y]) => ({ x, y }));

// Straight swipes keep working on the path classifier (release = strict).
assert.deepEqual(ringPathGesture(path([0, 0], [-40, 0]), true), { gesture: "left", ready: true });
assert.deepEqual(ringPathGesture(path([0, 0], [40, 0]), true), { gesture: "right", ready: true });
assert.deepEqual(ringPathGesture(path([0, 0], [0, -40]), true), { gesture: "up", ready: true });
assert.equal(ringPathGesture(path([0, 0], [-39, 0]), true), null);
assert.deepEqual(ringPathGesture(path([0, 0], [-50, -50]), true), { gesture: "upLeft", ready: true });
assert.equal(ringPathGesture(path([0, 0], [0, 40]), true), null, "downward swipes stay unrecognized");

// Upper corners work directly and are independent of the path taken.
assert.deepEqual(ringPathGesture(path([0, 0], [40, -40]), true), { gesture: "upRight", ready: true });
assert.deepEqual(ringPathGesture(path([100, 100], [60, 60]), true), { gesture: "upLeft", ready: true });
assert.equal(ringPathGesture(path([0, 0], [-39, -39]), true), null);
assert.deepEqual(ringPathGesture(path([0, 0], [-39, -39]), false), { gesture: "upLeft", ready: false });
assert.deepEqual(ringPathGesture(path([0, 0], [-90, 0], [-50, -50]), true), { gesture: "upLeft", ready: true });
assert.deepEqual(ringPathGesture(path([0, 0], [0, -90], [-50, -84]), true), { gesture: "upLeft", ready: true });
assert.deepEqual(ringPathGesture(path([0, 0], [0, -90], [50, -84]), true), { gesture: "upRight", ready: true });
assert.deepEqual(
  ringPathGesture(path([0, 0], [0, -90], [-20, -84]), true),
  { gesture: "up", ready: true },
  "a small sideways wiggle after the apex falls back to a plain swipe up",
);
assert.deepEqual(
  ringPathGesture(path([0, 0], [-40, -45], [-100, -25]), true),
  { gesture: "left", ready: true },
  "a mostly horizontal swipe stays left",
);
assert.deepEqual(
  ringPathGesture(path([0, 0], [-30, -50], [-90, -45]), true),
  { gesture: "upLeft", ready: true },
  "an arced swipe ending in the upper corner counts as upper left",
);

// Live hints use loose thresholds and mark when the strict gesture commits.
assert.deepEqual(ringPathGesture(path([0, 0], [-15, 0]), false), { gesture: "left", ready: false });
assert.deepEqual(ringPathGesture(path([0, 0], [15, 0]), false), { gesture: "right", ready: false });
assert.deepEqual(ringPathGesture(path([0, 0], [0, -15]), false), { gesture: "up", ready: false });
assert.deepEqual(ringPathGesture(path([0, 0], [0, -90], [-20, -84]), false), { gesture: "up", ready: true });
assert.deepEqual(ringPathGesture(path([0, 0], [0, -90], [-50, -84]), false), { gesture: "upLeft", ready: true });
assert.equal(ringPathGesture(path([0, 0], [5, -5]), false), null);

// Gesture config: unknown values fall back to the original behavior.
assert.deepEqual(normalizeBlueRingGestureConfig(null), { enabled: false, actions: { ...DEFAULT_BLUE_RING_ACTIONS } });
assert.deepEqual(
  normalizeBlueRingGestureConfig({ enabled: "yes", actions: { left: "toggleFileSidebar", up: 42 } }),
  { enabled: false, actions: { ...DEFAULT_BLUE_RING_ACTIONS, left: "toggleFileSidebar" } },
);
assert.deepEqual(effectiveBlueRingActions({ enabled: false, actions: { ...DEFAULT_BLUE_RING_ACTIONS, left: "modelSelector" } }), DEFAULT_BLUE_RING_ACTIONS, "disabled config keeps the original mapping");
assert.deepEqual(
  effectiveBlueRingActions(normalizeBlueRingGestureConfig({ enabled: true, actions: { upLeft: "toggleSessionSidebar" } })).upLeft,
  "toggleSessionSidebar",
);

const session = (key, day) => ({ key, name: key, updated_at: `2026-09-${day}T00:00:00Z` });
const group = (rootId, day, items = [], pinnedItems = []) => ({ rootId, latestSessionTime: `2026-09-${day}T00:00:00Z`, items, pinnedItems });
const input = [
  group("old", "10"),
  group("recent", "24", [session("a", "22"), session("b", "21"), session("c", "20")], [session("pinned-old", "11"), session("a", "22"), session("pinned-new", "24")]),
  group("third", "20"),
  group("second", "23"),
];
const before = structuredClone(input);
const result = recentQuickSwitchGroups(input);
assert.deepEqual(result.map((item) => item.rootId), ["recent", "second", "third"]);
assert.deepEqual(result[0].items.map((item) => item.key), ["pinned-new", "a", "b"]);
assert.deepEqual(input, before, "Quick switch must not reorder the shared session lists");
assert.deepEqual(recentQuickSwitchGroups([]), []);
assert.equal(recentQuickSwitchGroups([group("only", "22")]).length, 1);

// Feature wiring: settings entry (default off), persistence, and action plumbing.
import { readFileSync } from "node:fs";
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const fileTree = readFileSync(new URL("../src/components/FileTree.tsx", import.meta.url), "utf8");
const actionBar = readFileSync(new URL("../src/components/ActionBar.tsx", import.meta.url), "utf8");
const quickActions = readFileSync(new URL("../src/components/SessionQuickActions.tsx", import.meta.url), "utf8");
const service = readFileSync(new URL("../src/services/quickSwitch.ts", import.meta.url), "utf8");

assert.match(
  app,
  /useState<BlueRingGestureConfig>\(loadBlueRingGestureConfig\)[\s\S]*?persistBlueRingGestureConfig\(blueRingGestures\)/,
  "the gesture config should survive app reloads",
);
assert.match(
  fileTree,
  /blueRing\.title[\s\S]*?BLUE_RING_GESTURES\.map/,
  "the sidebar menu should offer per-gesture action binding",
);
assert.match(
  quickActions,
  /effectiveBlueRingActions\(gestureConfig\)[\s\S]*?ringPathGesture\(/,
  "the blue ring must resolve actions through the effective config",
);
assert.match(
  actionBar,
  /gestureConfig=\{blueRingGestures\}[\s\S]*?onToggleFileSidebar=\{onToggleLeftSidebar\}[\s\S]*?onToggleSessionSidebar=\{onToggleRightSidebar\}/,
  "sidebar toggles must be reachable from blue ring gestures",
);
assert.match(
  actionBar,
  /onOpenModelSelector=\{\(\) => setModelSelectorSignal/,
  "the model selector must be openable from a gesture",
);
assert.match(
  quickActions,
  /case "recentSession"/,
  "jump to the most recent other session must be a bindable action",
);
for (const action of ["toggleFileSidebar", "toggleSessionSidebar", "modelSelector", "recentSession"]) {
  assert.match(service, new RegExp(`"${action}"`), `${action} should stay part of the action registry`);
}

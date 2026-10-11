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

// Upper corners: a diagonal stroke (or a route that ends in the corner without
// a long second leg) still counts as the corner gesture.
assert.deepEqual(ringPathGesture(path([0, 0], [40, -40]), true), { gesture: "upRight", ready: true });
assert.deepEqual(ringPathGesture(path([100, 100], [60, 60]), true), { gesture: "upLeft", ready: true });
assert.equal(ringPathGesture(path([0, 0], [-39, -39]), true), null);
assert.deepEqual(ringPathGesture(path([0, 0], [-39, -39]), false), { gesture: "upLeft", ready: false });
assert.deepEqual(ringPathGesture(path([0, 0], [-90, 0], [-50, -50]), true), { gesture: "upLeft", ready: true });
// A vertical first leg followed by a long sideways leg is now its own gesture.
assert.deepEqual(ringPathGesture(path([0, 0], [0, -90], [-50, -84]), true), { gesture: "upThenLeft", ready: true });
assert.deepEqual(ringPathGesture(path([0, 0], [0, -90], [50, -84]), true), { gesture: "upThenRight", ready: true });
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
assert.deepEqual(ringPathGesture(path([0, 0], [0, -90], [-50, -84]), false), { gesture: "upThenLeft", ready: true });
assert.equal(ringPathGesture(path([0, 0], [5, -5]), false), null);

// Gesture config: unknown values fall back to the original behavior.
assert.deepEqual(normalizeBlueRingGestureConfig(null), { enabled: false, actions: { ...DEFAULT_BLUE_RING_ACTIONS }, agentPicks: {}, taskPicks: {} });
assert.deepEqual(
  normalizeBlueRingGestureConfig({ enabled: "yes", actions: { left: "toggleFileSidebar", up: 42 } }),
  { enabled: false, actions: { ...DEFAULT_BLUE_RING_ACTIONS, left: "toggleFileSidebar" }, agentPicks: {}, taskPicks: {} },
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

// Two-stage trail gestures: up first, then a committed turn (>= 40px).
assert.deepEqual(
  ringPathGesture(path([0, 0], [0, -90], [0, -10]), true),
  { gesture: "upDown", ready: true },
  "up then a long pull back down",
);
assert.deepEqual(ringPathGesture(path([0, 0], [0, -90], [80, -85]), true), { gesture: "upThenRight", ready: true });
assert.deepEqual(ringPathGesture(path([0, 0], [-60, -60], [40, -55]), true), { gesture: "upLeftThenRight", ready: true });
assert.deepEqual(ringPathGesture(path([0, 0], [60, -60], [-50, -55]), true), { gesture: "upRightThenLeft", ready: true });
assert.deepEqual(ringPathGesture(path([0, 0], [60, -60], [55, -10]), true), { gesture: "upRightThenDown", ready: true });
assert.deepEqual(
  ringPathGesture(path([0, 0], [60, -60], [55, -10]), false),
  { gesture: "upRightThenDown", ready: true },
  "two-stage gestures hint as ready once both legs commit",
);
// A short second leg does not form a two-stage gesture; classification falls
// back to the legacy displacement rules.
assert.deepEqual(
  ringPathGesture(path([0, 0], [0, -90], [-39, -85]), true),
  { gesture: "up", ready: true },
  "a 39px sideways leg is still a plain swipe up",
);
assert.deepEqual(
  ringPathGesture(path([0, 0], [-60, -60], [-55, -5]), true),
  { gesture: "left", ready: true },
  "up-left then down falls back to displacement (left)",
);
assert.equal(
  ringPathGesture(path([0, 0], [0, -50], [0, -20]), true),
  null,
  "up with a sub-threshold drop commits nothing on release (end displacement too short)",
);
assert.deepEqual(
  ringPathGesture(path([0, 0], [0, -50], [0, -20]), false),
  { gesture: "upDown", ready: false },
  "the loose hint previews up-down as soon as the drop leg shows",
);

// Tap and double tap are part of the gesture registry with sane defaults.
assert.equal(DEFAULT_BLUE_RING_ACTIONS.tap, "quickSwitch", "tap opens the quick switch panel by default");
assert.equal(DEFAULT_BLUE_RING_ACTIONS.doubleTap, "none");
assert.equal(effectiveBlueRingActions(null).tap, "quickSwitch", "tap works even when custom gestures are off");
assert.equal(
  effectiveBlueRingActions(normalizeBlueRingGestureConfig({ enabled: true, actions: { tap: "newSession" } })).tap,
  "newSession",
);
assert.deepEqual(
  normalizeBlueRingGestureConfig({ enabled: true, agentPicks: { upRight: "codex", bogus: "x", left: 42 } }).agentPicks,
  { upRight: "codex" },
  "agent picks are keyed by real gestures and drop invalid entries",
);

// New quick actions stay registered.
for (const action of ["agentToggle", "agentPick", "dirSwitch", "recentDirSwitch", "toggleMultiProjectList", "toggleEnterSend", "fontCycle", "themeCycle", "outlineToggle", "toggleMainView", "kanbanTemplateCycle", "newTask", "openScheduledTasks"]) {
  assert.match(service, new RegExp(`"${action}"`), `${action} should be a bindable blue ring action`);
}

// Main font cycle: 1.0 → 1.4 → 1.0 loop, always in 0.1 steps.
import { nextFontCycleScale, nextAppearanceMode, THEME_CYCLE_ORDER } from "../src/services/quickSwitch.ts";
assert.deepEqual(nextFontCycleScale(1, "up"), { scale: 1.1, direction: "up" });
assert.deepEqual(nextFontCycleScale(1.3, "up"), { scale: 1.4, direction: "up" });
assert.deepEqual(nextFontCycleScale(1.4, "up"), { scale: 1.3, direction: "down" }, "at the ceiling the walk turns around");
assert.deepEqual(nextFontCycleScale(1.4, "down"), { scale: 1.3, direction: "down" });
assert.deepEqual(nextFontCycleScale(1.1, "down"), { scale: 1, direction: "down" });
assert.deepEqual(nextFontCycleScale(1, "down"), { scale: 1.1, direction: "up" }, "at the floor the walk turns around");
assert.deepEqual(nextFontCycleScale(0.8, "down"), { scale: 0.9, direction: "up" }, "below 100% it always walks up");

// Appearance cycle covers every theme exactly once before wrapping.
assert.deepEqual(THEME_CYCLE_ORDER, ["dark", "light", "meadow", "moss", "system"]);
let mode = "dark";
for (let index = 0; index < THEME_CYCLE_ORDER.length; index += 1) {
  mode = nextAppearanceMode(mode);
}
assert.equal(mode, "dark", "the cycle wraps back to the start");

// Feature wiring for the new actions end to end.
assert.match(app, /onOpenRecentDirectory=\{\(target\)/, "recent-directory switching must be wired through App");
assert.match(app, /onToggleMultiProjectSessions=\{\(\) => setMultiProjectSessionsEnabled/, "multi-project toggle must be wired");
assert.match(app, /onToggleEnterKeySends=\{\(\) => setMobileEnterKeySends/, "enter-to-send toggle must be wired");
assert.match(app, /onCycleMainFontScale=\{cycleMainFontScale\}/, "font cycle must be wired");
assert.match(app, /recordRecentDir\(\{ rootId: root, path: targetPath \}\)/, "breadcrumb clicks must record recent directories");
assert.match(app, /recordRecentDir\(\{ rootId: r, path: e\.path \}\)/, "file-tree root clicks must record recent directories");
assert.doesNotMatch(app, /onOpenRecentDirectory=\{\(target\) => \{\s*recordRecentDir/, "cycling a recent dir must not re-record it (the list only holds manual clicks, else cycling degenerates to a two-dir ping-pong)");
assert.match(fileTree, /addEventListener\("mousedown", handlePointerDown\)/, "the gesture popover must close on mousedown: ProviderModelSelect portals only shield mousedown, pointerdown would kill dropdown selection");
assert.match(actionBar, /onToggleRecentAgent=\{toggleRecentAgent\}/, "agent ping-pong must be reachable from the ring");
assert.match(actionBar, /lastAgentRef/, "agent ping-pong must remember the previous agent");
assert.match(quickActions, /DOUBLE_TAP_MS/, "double-tap discrimination must live in the ring component");
// 双击窗口契约：cancelPendingTap 只能撤定时器，绝不能清 lastTapAt（否则第二次按下会抹掉双击窗口）；
// 双击命中后由 doubleTap 分支自己复位 lastTapAt。
{
  const cancelBody = quickActions.match(/const cancelPendingTap = \(\) => \{([\s\S]*?)\n  \};/)?.[1] || "";
  assert.doesNotMatch(cancelBody, /lastTapAt/, "cancelPendingTap must not reset lastTapAt or double-taps can never register");
  assert.match(quickActions, /lastTapAt = 0;\s*\n\s*runAction\(actions\.doubleTap/, "the double-tap branch resets the tap window itself");
  assert.match(quickActions, /if \(actions\.doubleTap === "none"\) return;/, "unbound double-tap swallows rapid repeats instead of double-firing the tap action");
}
assert.match(quickActions, /case "agentPick"/, "the ring must execute the bound agent pick");
assert.match(quickActions, /setMarkdownOutlineEnabled\(!isMarkdownOutlineEnabled\(\)\)/, "outline toggle must flip the shared preference");
const fileViewerSource = readFileSync(new URL("../src/components/FileViewer.tsx", import.meta.url), "utf8");
assert.match(fileViewerSource, /useSyncExternalStore\(subscribeMarkdownOutline/, "the preview must follow the outline preference");
const recentDirsSource = readFileSync(new URL("../src/services/recentDirs.ts", import.meta.url), "utf8");
assert.match(recentDirsSource, /RECENT_DIRS_LIMIT = 8/, "recent directories stay bounded");
assert.match(app, /onToggleMainContentView=\{toggleMainContentView\}/, "home view toggle must be wired");
assert.match(app, /onCycleKanbanTemplate=\{cycleKanbanTemplate\}/, "kanban template cycle must be wired");
assert.match(app, /onCreateTask=\{createTaskFromQuickAction\}/, "task creation must be wired");
assert.match(app, /onOpenScheduledTasks=\{openScheduledTasksFromQuickAction\}/, "scheduled tasks dialog must be wired");
assert.match(app, /taskTemplates=\{taskTemplates\.map\(\(template\) => \(\{ id: template\.id \|\| "", name: template\.name \|\| "" \}\)\)\}/, "settings need the template list for the tertiary picker");
assert.deepEqual(
  normalizeBlueRingGestureConfig({ enabled: true, taskPicks: { upLeft: "tpl-1", nope: "x" } }).taskPicks,
  { upLeft: "tpl-1" },
  "task picks are keyed by real gestures",
);

import assert from "node:assert/strict";
import { recentQuickSwitchGroups, ringGesture } from "../src/services/quickSwitch.ts";

assert.equal(ringGesture(-40, 0), "new");
assert.equal(ringGesture(0, -40), "switch");
assert.equal(ringGesture(-55, -42), "new");
assert.equal(ringGesture(-42, -55), "switch");
for (const [x, y] of [[0, 0], [-39, 0], [0, -39], [60, 0], [0, 60], [-50, -50], [-40, 70], [70, -40]]) {
  assert.equal(ringGesture(x, y), null, `Unexpected gesture for ${x}, ${y}`);
}

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

import test from "node:test";
import assert from "node:assert/strict";

import {
  classifySwipeIntent,
  swipeProgress,
  swipeRelease,
  clamp01,
} from "../src/services/edgeSwipe.ts";
import {
  normalizeSessionFilter,
  loadSessionFilter,
  persistSessionFilter,
  isSessionFilterActive,
  sessionWithinTimeWindow,
  applySessionFilters,
  SESSION_FILTER_STORAGE_KEY,
} from "../src/services/sessionFilter.ts";
import {
  DEFAULT_HANDOFF_TEMPLATE,
  loadHandoffTemplate,
  persistHandoffTemplate,
  renderHandoffPack,
  templateFromRenderedPack,
  HANDOFF_TEMPLATE_STORAGE_KEY,
} from "../src/services/handoff.ts";

// ---------- edgeSwipe ----------

test("classifySwipeIntent: dead zone keeps intent open", () => {
  assert.equal(classifySwipeIntent(4, 3), null);
  assert.equal(classifySwipeIntent(0, 0), null);
});

test("classifySwipeIntent: horizontal wins on wide drags", () => {
  assert.equal(classifySwipeIntent(30, 4), "horizontal");
  assert.equal(classifySwipeIntent(-30, 4), "horizontal");
});

test("classifySwipeIntent: vertical wins on tall drags", () => {
  assert.equal(classifySwipeIntent(4, 30), "vertical");
});

test("swipeProgress: left drawer open drag follows rightwards finger", () => {
  const width = 320;
  assert.ok(Math.abs(swipeProgress("left", "open", 160, width) - 0.5) < 1e-9);
  assert.equal(swipeProgress("left", "open", 400, width), 1);
  assert.equal(swipeProgress("left", "open", -50, width), 0);
});

test("swipeProgress: right drawer opens with leftwards (negative) dx", () => {
  const width = 320;
  assert.ok(Math.abs(swipeProgress("right", "open", -160, width) - 0.5) < 1e-9);
  assert.equal(swipeProgress("right", "open", -400, width), 1);
});

test("swipeProgress: close mode starts at 1 and shrinks", () => {
  const width = 320;
  assert.equal(swipeProgress("left", "close", 0, width), 1);
  assert.ok(Math.abs(swipeProgress("left", "close", -160, width) - 0.5) < 1e-9);
  assert.equal(swipeProgress("left", "close", -400, width), 0);
  // right drawer closes rightwards
  assert.ok(Math.abs(swipeProgress("right", "close", 160, width) - 0.5) < 1e-9);
});

test("swipeRelease: flicks win over position", () => {
  assert.equal(swipeRelease(0.1, 0.8, 320), "open");
  assert.equal(swipeRelease(0.9, -0.8, 320), "close");
});

test("swipeRelease: slow release uses projected threshold", () => {
  assert.equal(swipeRelease(0.6, 0, 320), "open");
  assert.equal(swipeRelease(0.4, 0, 320), "close");
  assert.equal(swipeRelease(0.48, 0.2, 320), "open");
  assert.equal(swipeRelease(0.52, -0.2, 320), "close");
});

test("clamp01 clamps bounds", () => {
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(0.5), 0.5);
  assert.equal(clamp01(2), 1);
});

// ---------- sessionFilter ----------

// Minimal window/localStorage shim: the services guard on `typeof window ===
// "undefined"`, so tests install a fake before exercising persistence paths.
const shimStore = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => (shimStore.has(key) ? shimStore.get(key) : null),
    setItem: (key, value) => shimStore.set(key, String(value)),
    removeItem: (key) => shimStore.delete(key),
  },
};

function withStorage(fn) {
  shimStore.clear();
  fn(shimStore);
}

test("normalizeSessionFilter rejects unknown values", () => {
  assert.deepEqual(normalizeSessionFilter(null), { runningOnly: false, timeWindow: "all", sortAsc: false });
  assert.deepEqual(normalizeSessionFilter({ timeWindow: "1h", runningOnly: true, sortAsc: true }), {
    runningOnly: true,
    timeWindow: "1h",
    sortAsc: true,
  });
  assert.deepEqual(normalizeSessionFilter({ timeWindow: "bogus" }).timeWindow, "all");
});

test("session filter load/persist round-trips through localStorage", () => {
  withStorage((store) => {
    assert.deepEqual(loadSessionFilter(), { runningOnly: false, timeWindow: "all", sortAsc: false });
    persistSessionFilter({ runningOnly: true, timeWindow: "3h", sortAsc: false });
    assert.equal(store.get(SESSION_FILTER_STORAGE_KEY), JSON.stringify({ runningOnly: true, timeWindow: "3h", sortAsc: false }));
    assert.deepEqual(loadSessionFilter(), { runningOnly: true, timeWindow: "3h", sortAsc: false });
    window.localStorage.setItem(SESSION_FILTER_STORAGE_KEY, "{broken");
    assert.deepEqual(loadSessionFilter(), { runningOnly: false, timeWindow: "all", sortAsc: false });
  });
});

test("isSessionFilterActive detects any active dimension", () => {
  assert.equal(isSessionFilterActive({ runningOnly: false, timeWindow: "all", sortAsc: false }), false);
  assert.equal(isSessionFilterActive({ runningOnly: true, timeWindow: "all", sortAsc: false }), true);
  assert.equal(isSessionFilterActive({ runningOnly: false, timeWindow: "day", sortAsc: false }), true);
  assert.equal(isSessionFilterActive({ runningOnly: false, timeWindow: "all", sortAsc: true }), true);
});

test("sessionWithinTimeWindow buckets by updated_at", () => {
  const now = Date.now();
  assert.equal(sessionWithinTimeWindow(new Date(now - 30 * 60000).toISOString(), "1h", now), true);
  assert.equal(sessionWithinTimeWindow(new Date(now - 2 * 3600000).toISOString(), "1h", now), false);
  assert.equal(sessionWithinTimeWindow(new Date(now - 2 * 3600000).toISOString(), "3h", now), true);
  assert.equal(sessionWithinTimeWindow(undefined, "day", now), false);
  assert.equal(sessionWithinTimeWindow(new Date(now - 90000000).toISOString(), "day", now), false);
  assert.equal(sessionWithinTimeWindow(undefined, "all", now), true);
});

test("applySessionFilters splits running to top and honors time window + sortAsc", () => {
  const now = Date.now();
  const sessions = [
    { key: "a", pending: true, updated_at: new Date(now - 60000).toISOString() },
    { key: "b", pending: false, updated_at: new Date(now - 7200000).toISOString() },
    { key: "c", pending: false, updated_at: new Date(now - 60000).toISOString() },
    { key: "d", pending: false, updated_at: new Date(now - 90000000).toISOString() },
  ];
  const all = applySessionFilters(sessions, { runningOnly: false, timeWindow: "all", sortAsc: false }, now);
  assert.deepEqual(all.running.map((s) => s.key), ["a"]);
  assert.deepEqual(all.rest.map((s) => s.key), ["b", "c", "d"]);

  const hour = applySessionFilters(sessions, { runningOnly: false, timeWindow: "1h", sortAsc: false }, now);
  assert.deepEqual(hour.running.map((s) => s.key), ["a"]);
  assert.deepEqual(hour.rest.map((s) => s.key), ["c"]);

  const runningOnly = applySessionFilters(sessions, { runningOnly: true, timeWindow: "all", sortAsc: false }, now);
  assert.deepEqual(runningOnly.running.map((s) => s.key), ["a"]);
  assert.deepEqual(runningOnly.rest, []);

  const asc = applySessionFilters(sessions, { runningOnly: false, timeWindow: "all", sortAsc: true }, now);
  assert.deepEqual(asc.rest.map((s) => s.key), ["d", "c", "b"]);
});

// ---------- handoff ----------

test("default handoff template carries all placeholders", () => {
  assert.ok(DEFAULT_HANDOFF_TEMPLATE.includes("{jsonl_path}"));
  assert.ok(DEFAULT_HANDOFF_TEMPLATE.includes("{session_key}"));
  assert.ok(DEFAULT_HANDOFF_TEMPLATE.includes("{agent_session_id}"));
});

test("handoff template load falls back on missing/broken marker", () => {
  withStorage(() => {
    assert.equal(loadHandoffTemplate(), DEFAULT_HANDOFF_TEMPLATE);
    persistHandoffTemplate("T {jsonl_path} {session_key} {agent_session_id}");
    assert.equal(loadHandoffTemplate(), "T {jsonl_path} {session_key} {agent_session_id}");
    window.localStorage.setItem(HANDOFF_TEMPLATE_STORAGE_KEY, "no placeholders here");
    assert.equal(loadHandoffTemplate(), DEFAULT_HANDOFF_TEMPLATE);
  });
});

test("renderHandoffPack substitutes values and tolerates empty agent id", () => {
  const rendered = renderHandoffPack(DEFAULT_HANDOFF_TEMPLATE, {
    sessionKey: "1728350000-a1b2c3d4e5f6",
    jsonlPath: "/mnt/Projects/x/.mindfs/sessions/1728350000-a1b2c3d4e5f6.jsonl",
    agentSessionId: "0197abcd-thread",
  });
  assert.ok(rendered.includes("/mnt/Projects/x/.mindfs/sessions/1728350000-a1b2c3d4e5f6.jsonl"));
  assert.ok(rendered.includes("1728350000-a1b2c3d4e5f6"));
  assert.ok(rendered.includes("0197abcd-thread"));
  const renderedNoAgent = renderHandoffPack(DEFAULT_HANDOFF_TEMPLATE, {
    sessionKey: "k1",
    jsonlPath: "/p.jsonl",
    agentSessionId: "",
  });
  assert.ok(renderedNoAgent.includes("（无）"));
});

test("templateFromRenderedPack restores placeholders from rendered pack", () => {
  const context = {
    sessionKey: "1728350000-a1b2c3d4e5f6",
    jsonlPath: "/mnt/x/.mindfs/sessions/1728350000-a1b2c3d4e5f6.jsonl",
    agentSessionId: "thread-1",
  };
  const rendered = renderHandoffPack(DEFAULT_HANDOFF_TEMPLATE, context);
  const restored = templateFromRenderedPack(rendered, context);
  assert.ok(restored.includes("{jsonl_path}"));
  assert.ok(restored.includes("{session_key}"));
  assert.ok(restored.includes("{agent_session_id}"));
  assert.equal(renderHandoffPack(restored, context), rendered);
});

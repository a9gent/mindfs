import assert from "node:assert/strict";
import { resolveInputSession } from "../src/services/inputSession.ts";

const main = { key: "main", root_id: "project" };
const drawer = { key: "drawer", root_id: "project" };
assert.equal(resolveInputSession("project", false, main, drawer), main);
assert.equal(resolveInputSession("project", true, main, drawer), drawer);
// A remembered session in a closed drawer must not receive a new message.
assert.equal(resolveInputSession("project", false, null, drawer), null);
// An empty, open drawer starts a new session even if the main view has one.
assert.equal(resolveInputSession("project", true, main, null), null);
assert.equal(resolveInputSession("project", false, null, null), null);
assert.equal(resolveInputSession("other", false, main, drawer), null);
assert.equal(resolveInputSession("other", true, main, drawer), null);
assert.equal(resolveInputSession(null, true, main, drawer), null);
const legacy = { session_key: "legacy" };
assert.equal(resolveInputSession("project", false, legacy, null), legacy);
const pending = { key: "pending-1", root_id: "project" };
assert.equal(resolveInputSession("project", true, main, pending), pending);

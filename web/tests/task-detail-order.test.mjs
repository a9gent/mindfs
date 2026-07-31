import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import vm from "node:vm";

const sourcePath = path.resolve("src/services/taskDetailOrder.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;

const sandbox = {
  exports: {},
  module: { exports: {} },
};
vm.runInNewContext(compiled, sandbox, { filename: sourcePath });

const { shouldApplyTaskDetail } = sandbox.exports;

function detail(status, updatedAt, sessionKey = "") {
  return {
    task: {
      id: "task-1",
      status,
      updated_at: updatedAt,
    },
    stage_runs: sessionKey ? [{ session_key: sessionKey }] : [],
    events: [],
  };
}

const running = detail("running", "2026-07-31T10:00:00.123456789Z", "session-1");
const staleQueued = detail("queued", "2026-07-31T10:00:00.123000000Z");

assert.equal(
  shouldApplyTaskDetail(running, staleQueued),
  false,
  "a stale create response must not replace a running task",
);
assert.equal(
  shouldApplyTaskDetail(staleQueued, running),
  true,
  "a newer scheduler update must replace the queued task",
);
assert.equal(
  shouldApplyTaskDetail(running, {
    ...running,
    stage_runs: [{ session_key: "session-1" }, { session_key: "session-2" }],
  }),
  true,
  "an equal-version full detail may enrich the current snapshot",
);

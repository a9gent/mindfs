import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import vm from "node:vm";

const sourcePath = path.resolve("src/services/sessionListMerge.ts");
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

const { applyPinnedSnapshotToSessions, mergeSessionItems } = sandbox.exports;

const merged = mergeSessionItems(
  [
    {
      key: "old",
      session_key: "old",
      root_id: "root",
      updated_at: "2026-07-30T10:00:00.000Z",
    },
    {
      key: "new",
      session_key: "new",
      root_id: "root",
      updated_at: "2026-07-30T12:00:00.000Z",
    },
  ],
  [
    {
      key: "pin-a",
      session_key: "pin-a",
      root_id: "root",
      updated_at: "2026-07-30T09:00:00.000Z",
      pinned_at: "2026-07-30T12:30:00.000Z",
    },
    {
      key: "pin-b",
      session_key: "pin-b",
      root_id: "root",
      updated_at: "2026-07-30T11:00:00.000Z",
      pinned_at: "2026-07-30T12:45:00.000Z",
    },
  ],
);

assert.equal(JSON.stringify(merged.map((item) => item.key)), JSON.stringify(["pin-b", "pin-a", "new", "old"]));

const unpinned = applyPinnedSnapshotToSessions(merged, "root", ["pin-a"]);

assert.equal(unpinned.find((item) => item.key === "pin-b")?.pinned_at, undefined);
assert.equal(JSON.stringify(unpinned.map((item) => item.key)), JSON.stringify(["pin-a", "new", "pin-b", "old"]));

import assert from "node:assert/strict";
import {
  mergeRelatedFileGroups,
  taskIdsForUpdatedSession,
} from "../src/services/taskRelatedFiles.ts";

const taskSessionKeysById = {
  "task-1": ["session-a", "session-b"],
  "task-2": ["session-c"],
};

assert.deepEqual(taskIdsForUpdatedSession(taskSessionKeysById, "session-a"), ["task-1"]);
assert.deepEqual(taskIdsForUpdatedSession(taskSessionKeysById, "session-c"), ["task-2"]);
assert.deepEqual(taskIdsForUpdatedSession(taskSessionKeysById, "session-x"), []);

const merged = mergeRelatedFileGroups([
  [
    {
      path: "src/App.tsx",
      name: "App.tsx",
      root_id: "root-1",
      repo_kind: "main",
      repo_path: "",
      head: "abc",
    },
  ],
  [
    {
      path: "src/App.tsx",
      name: "duplicate",
      root_id: "root-1",
      repo_kind: "main",
      repo_path: "",
      head: "abc",
    },
    {
      path: "README.md",
      name: "README.md",
      root_id: "root-1",
      repo_kind: "main",
      repo_path: "",
      head: "abc",
    },
  ],
]);

assert.deepEqual(
  merged.map((file) => file.path),
  ["src/App.tsx", "README.md"],
);

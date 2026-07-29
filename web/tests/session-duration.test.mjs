import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import vm from "node:vm";

const sourcePath = path.resolve("src/services/sessionDuration.ts");
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

const { formatSessionDuration } = sandbox.exports;

assert.equal(
  formatSessionDuration("2026-07-29T10:00:00.000Z", "2026-07-29T10:00:33.000Z"),
  "(33s)",
);
assert.equal(
  formatSessionDuration("2026-07-29T10:00:00.000Z", "2026-07-29T10:01:39.000Z"),
  "(99s)",
);
assert.equal(
  formatSessionDuration("2026-07-29T10:00:00.000Z", "2026-07-29T10:01:40.000Z"),
  "(100s)",
);
assert.equal(
  formatSessionDuration("2026-07-29T10:00:00.000Z", "2026-07-29T10:01:41.000Z"),
  "(1m)",
);
assert.equal(
  formatSessionDuration("2026-07-29T10:00:00.000Z", "2026-07-29T10:11:59.000Z"),
  "(11m)",
);
assert.equal(formatSessionDuration("", "2026-07-29T10:00:33.000Z"), "");
assert.equal(formatSessionDuration("bad", "2026-07-29T10:00:33.000Z"), "");
assert.equal(
  formatSessionDuration("2026-07-29T10:00:33.000Z", "2026-07-29T10:00:00.000Z"),
  "",
);
assert.equal(
  formatSessionDuration("2026-07-29T10:00:00.000Z", "2026-07-29T10:00:00.999Z"),
  "",
);

assert.equal(
  formatSessionDuration("2026-07-29T10:02:00.000Z", "2026-07-29T10:02:45.000Z"),
  "(45s)",
);

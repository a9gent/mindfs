import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import vm from "node:vm";

const source = fs.readFileSync("src/services/agentVisibility.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;
const sandbox = {
  require: () => ({}),
  exports: {},
  module: { exports: {} },
};
vm.runInNewContext(compiled, sandbox);
const { foldInstanceGroups, filterEntryAgents } = sandbox.exports;

// base 存在：同名实例折叠为 base
assert.deepEqual(foldInstanceGroups(["zcode", "zcode-1", "zcode-2", "codex"]), ["zcode", "codex"]);
// base 不存在：实例原样保留
assert.deepEqual(foldInstanceGroups(["zcode-1", "zcode-2"]), ["zcode-1", "zcode-2"]);
// 非数字后缀不算实例
assert.deepEqual(foldInstanceGroups(["zcode-dev", "zcode"]), ["zcode-dev", "zcode"]);
// 顺序保持
assert.deepEqual(foldInstanceGroups(["codex", "zcode-2", "zcode"]), ["codex", "zcode"]);

const mk = (name) => ({ name });
const all = ["zcode", "zcode-1", "zcode-2", "codex"].map(mk);

// 未加载到显隐偏好（null）：不过滤
assert.equal(filterEntryAgents(all, null).length, 4);
// 默认（从未设置）：实例组折叠，只显示 base
assert.deepEqual(
  filterEntryAgents(all, { hidden: [], customized: false }).map((item) => item.name),
  ["zcode", "codex"],
);
// 用户自定义后：完全按 hidden 名单
assert.deepEqual(
  filterEntryAgents(all, { hidden: ["codex"], customized: true }).map((item) => item.name),
  ["zcode", "zcode-1", "zcode-2"],
);
// 自定义后清空隐藏 = 全部显示
assert.equal(filterEntryAgents(all, { hidden: [], customized: true }).length, 4);

console.log("agent visibility rules passed");

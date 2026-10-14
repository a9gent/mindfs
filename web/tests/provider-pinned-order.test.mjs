import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import vm from "node:vm";

const source = fs.readFileSync("src/components/FileTree.tsx", "utf8");
const ast = ts.createSourceFile("FileTree.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = ast.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "orderModelsPinnedFirst",
);
assert.ok(declaration, "orderModelsPinnedFirst not found in FileTree.tsx");
const compiled = ts.transpileModule(declaration.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText;
const sandbox = {};
vm.runInNewContext(compiled, sandbox);
const order = sandbox.orderModelsPinnedFirst;

// vm 沙箱里的数组来自另一个 realm，先拷贝回宿主 realm 再比较
const orderHost = (...args) => [...order(...args)];

const models = ["glm-4.6", "glm-5.3-flash", "deepseek-v3", "kimi-k2"];

// 无精选：保持原顺序
assert.deepEqual(orderHost(models), models);
assert.deepEqual(orderHost(models, []), models);
// 精选置顶（按精选顺序），其余保持原顺序
assert.deepEqual(orderHost(models, ["kimi-k2", "glm-4.6"]), ["kimi-k2", "glm-4.6", "glm-5.3-flash", "deepseek-v3"]);
// 精选中已不在模型列表里的（重新同步后被移除）自动忽略
assert.deepEqual(orderHost(models, ["gone-model", "deepseek-v3"]), ["deepseek-v3", "glm-4.6", "glm-5.3-flash", "kimi-k2"]);

console.log("provider pinned order passed");

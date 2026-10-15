import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import vm from "node:vm";

const source = fs.readFileSync("src/services/recentDirs.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;
const baseCompiled = ts.transpileModule(fs.readFileSync("src/services/base.ts", "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;

// 近期目录是纯 localStorage 逻辑：用一个内存 stub 顶上 window.localStorage。
const makeSandbox = () => {
  const store = new Map();
  const endpoint = { base: "https://mindfs.test", prefix: "" };
  const storageKey = () => `mindfs-recent-dirs:v2:${encodeURIComponent(`${endpoint.base}${endpoint.prefix}/`)}`;
  const localStorage = {
    __failWrite: false,
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      if (localStorage.__failWrite) throw new Error("quota exceeded");
      store.set(key, String(value));
    },
    removeItem: (key) => store.delete(key),
  };
  const window = { localStorage, location: { get pathname() { return `${endpoint.prefix}/`; } } };
  const baseSandbox = {
    exports: {}, window,
    require: () => ({ getApiBaseURL: () => endpoint.base, getWsBaseURL: () => "", isBrowserRuntime: () => true }),
  };
  vm.runInNewContext(baseCompiled, baseSandbox);
  const sandbox = {
    require: (name) => name === "./base" ? baseSandbox.exports : {},
    exports: {},
    module: { exports: {} },
    window,
  };
  return { sandbox, store, localStorage, endpoint, storageKey };
};

const load = () => {
  const { sandbox, store, endpoint, storageKey } = makeSandbox();
  vm.runInNewContext(compiled, sandbox);
  return { ...sandbox.exports, store, endpoint, storageKey, localStorage: sandbox.window.localStorage };
};

const { recordRecentDir, listRecentDirs, nextRecentDir, clearRecentDirs, RECENT_DIRS_LIMIT } = load();

// VM 沙箱的数组/对象原型与宿主 realm 不同，deepEqual 会判不等，深拷贝回宿主 realm
const host = (value) => JSON.parse(JSON.stringify(value));

// 记录 + 展示名回退（basename）
recordRecentDir({ rootId: "mnt", path: "/mnt/Projects/MindFS" });
assert.deepEqual(host(listRecentDirs()), [
  { rootId: "mnt", path: "/mnt/Projects/MindFS", name: "MindFS", at: listRecentDirs()[0].at },
]);

// 去重：同 root+path 重新记录会挪到最前，不产生重复项
recordRecentDir({ rootId: "root", path: "/root/docs" });
recordRecentDir({ rootId: "mnt", path: "/mnt/Projects/MindFS", name: "MindFS" });
assert.equal(listRecentDirs().length, 2);
assert.equal(listRecentDirs()[0].path, "/mnt/Projects/MindFS");

// 同路径不同 root 是两个条目
recordRecentDir({ rootId: "d-project", path: "/mnt/Projects/MindFS" });
assert.equal(listRecentDirs().length, 3);

// 上限截断
const many = load();
for (let i = 0; i < RECENT_DIRS_LIMIT + 4; i++) {
  many.recordRecentDir({ rootId: "root", path: `/root/dir-${i}` });
}
assert.equal(many.listRecentDirs().length, RECENT_DIRS_LIMIT);
assert.equal(many.listRecentDirs()[0].path, `/root/dir-${RECENT_DIRS_LIMIT + 3}`);
assert.equal(many.listRecentDirs().at(-1).path, `/root/dir-4`);

// 空列表 / 只有当前项 → null
const fresh = load();
assert.equal(fresh.nextRecentDir("root", "/root/docs"), null);
fresh.recordRecentDir({ rootId: "root", path: "/root/docs" });
assert.equal(fresh.nextRecentDir("root", "/root/docs"), null);

// 顺序轮转：列表按最近使用倒序 [c, b, a]，next 沿列表向后走（更旧的），到尾部绕回最新
const rot = load();
rot.recordRecentDir({ rootId: "root", path: "/root/a" });
rot.recordRecentDir({ rootId: "root", path: "/root/b" });
rot.recordRecentDir({ rootId: "root", path: "/root/c" });
assert.equal(rot.nextRecentDir("root", "/root/c").path, "/root/b");
assert.equal(rot.nextRecentDir("root", "/root/b").path, "/root/a");
assert.equal(rot.nextRecentDir("root", "/root/a").path, "/root/c");

// 基准不在列表里（被删/换 root）：回退到最近一条
assert.equal(rot.nextRecentDir("root", "/root/gone").path, "/root/c");
// currentRootId 为 null 也能轮转
assert.equal(rot.nextRecentDir(null, null).path, "/root/c");

// 跨 root 混合轮转：路径同、root 不同不算同一项
const cross = load();
cross.recordRecentDir({ rootId: "root", path: "/mnt/Projects/MindFS" });
cross.recordRecentDir({ rootId: "d-project", path: "/mnt/Projects/MindFS" });
assert.equal(cross.nextRecentDir("root", "/mnt/Projects/MindFS").rootId, "d-project");
assert.equal(cross.nextRecentDir("d-project", "/mnt/Projects/MindFS").rootId, "root");

// 存储坏 JSON / 非数组：静默回空列表，后续记录可恢复
const broken = load();
broken.localStorage.setItem(broken.storageKey(), "{not json");
assert.deepEqual(host(broken.listRecentDirs()), []);
assert.equal(broken.nextRecentDir("root", null), null);
broken.recordRecentDir({ rootId: "root", path: "/root/back" });
assert.equal(broken.listRecentDirs().length, 1);

// 缺字段的条目被过滤，不抛异常
const dirty = load();
dirty.localStorage.setItem(
  dirty.storageKey(),
  JSON.stringify([{ rootId: "", path: "/x" }, { rootId: "root" }, { rootId: "root", path: "/root/ok" }]),
);
assert.deepEqual([...dirty.listRecentDirs().map((item) => item.path)], ["/root/ok"]);

// 配额失败：静默吞掉，旧数据不受影响
const quota = load();
quota.recordRecentDir({ rootId: "root", path: "/root/first" });
quota.localStorage.__failWrite = true;
quota.recordRecentDir({ rootId: "root", path: "/root/second" });
assert.deepEqual([...quota.listRecentDirs().map((item) => item.path)], ["/root/first"]);

// clearRecentDirs
const wipe = load();
wipe.recordRecentDir({ rootId: "root", path: "/root/x" });
wipe.clearRecentDirs();
assert.deepEqual(host(wipe.listRecentDirs()), []);

// Relay nodes on the same origin can have identical root IDs. Never share paths.
const nodes = load();
nodes.endpoint.prefix = "/n/node-a";
nodes.recordRecentDir({ rootId: "001", path: "/machine-a/private-project" });
nodes.endpoint.prefix = "/n/node-b";
assert.deepEqual(host(nodes.listRecentDirs()), []);
assert.equal(nodes.nextRecentDir("001", "/machine-b/work", ["001"]), null);
nodes.recordRecentDir({ rootId: "001", path: "/machine-b/work" });
nodes.recordRecentDir({ rootId: "002", path: "/machine-b/other-project" });
assert.equal(nodes.nextRecentDir("001", "/machine-b/work", ["001", "002"]).path, "/machine-b/other-project");
nodes.clearRecentDirs();
nodes.endpoint.prefix = "/n/node-a";
assert.equal(nodes.listRecentDirs()[0].path, "/machine-a/private-project", "clearing one node must preserve the others");
nodes.endpoint.prefix = "";
assert.deepEqual(host(nodes.listRecentDirs()), [], "direct access must be isolated from relay nodes");

// Native shells can switch backends without changing the local WebView origin.
nodes.recordRecentDir({ rootId: "001", path: "/backend-one" });
nodes.endpoint.base = "https://other-backend.test";
assert.deepEqual(host(nodes.listRecentDirs()), []);
nodes.recordRecentDir({ rootId: "001", path: "/backend-two" });
nodes.endpoint.base = "https://mindfs.test";
assert.equal(nodes.listRecentDirs()[0].path, "/backend-one");

// Legacy history has no node identity and must not be attributed to a new node.
const legacy = load();
legacy.localStorage.setItem("mindfs-recent-dirs", JSON.stringify([{ rootId: "001", path: "/unknown-node/private" }]));
assert.deepEqual(host(legacy.listRecentDirs()), []);
legacy.recordRecentDir({ rootId: "001", path: "/current-node" });
assert.equal(legacy.listRecentDirs().length, 1);
assert.equal(legacy.listRecentDirs()[0].path, "/current-node");

// Removed workspaces are skipped without preventing rotation to valid ones.
const removed = load();
removed.recordRecentDir({ rootId: "valid", path: "/valid" });
removed.recordRecentDir({ rootId: "deleted", path: "/deleted" });
assert.equal(removed.nextRecentDir(null, null, ["valid"]).rootId, "valid");
assert.equal(removed.nextRecentDir(null, null, []), null);
assert.equal(removed.nextRecentDir("valid", "/valid", ["valid"]), null);

console.log("ok: tests/recent-dirs.test.mjs");

import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import vm from "node:vm";

const source = fs.readFileSync("src/services/recentDirs.ts", "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;

// 近期目录是纯 localStorage 逻辑：用一个内存 stub 顶上 window.localStorage。
const makeSandbox = () => {
  const store = new Map();
  const localStorage = {
    __failWrite: false,
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      if (localStorage.__failWrite) throw new Error("quota exceeded");
      store.set(key, String(value));
    },
    removeItem: (key) => store.delete(key),
  };
  const sandbox = {
    require: () => ({}),
    exports: {},
    module: { exports: {} },
    window: { localStorage },
  };
  return { sandbox, store, localStorage };
};

const load = () => {
  const { sandbox, store } = makeSandbox();
  vm.runInNewContext(compiled, sandbox);
  return { ...sandbox.exports, store, localStorage: sandbox.window.localStorage };
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
broken.localStorage.setItem("mindfs-recent-dirs", "{not json");
assert.deepEqual(host(broken.listRecentDirs()), []);
assert.equal(broken.nextRecentDir("root", null), null);
broken.recordRecentDir({ rootId: "root", path: "/root/back" });
assert.equal(broken.listRecentDirs().length, 1);

// 缺字段的条目被过滤，不抛异常
const dirty = load();
dirty.localStorage.setItem(
  "mindfs-recent-dirs",
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

console.log("ok: tests/recent-dirs.test.mjs");

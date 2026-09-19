import assert from "node:assert/strict";
import { FileEditStore, fileEditKey, editableText, serializeEditedText } from "../src/services/fileEditing.ts";

const key = fileEditKey("r", "a.txt");
const fixture = (content = "\ufeff中文\r\n", revision = "v1") => ({ name: "a.txt", path: "a.txt", root: "r", content, revision, encoding: "utf-8", size: new TextEncoder().encode(content).length, truncated: false });
let finishSave;
let fail = false;
const writes = [];
const store = new FileEditStore({
  load: async () => fixture(),
  save: async (...args) => {
    writes.push(args);
    if (fail) throw new Error("file_edit_conflict");
    await new Promise(resolve => { finishSave = resolve; });
    return fixture(args[2], "v2");
  },
});
await store.open("r", "a.txt");
assert.equal(store.get(key).text, "中文\n");
store.patch(key, { text: "修改\n" });
Object.assign(store.get(key).view, { start: 1, end: 2, top: 100, left: 20 });
await store.open("r", "other.txt");
await store.open("r", "a.txt");
assert.equal(store.get(key).text, "修改\n");
assert.equal(store.get(key).view.top, 100);
assert.equal(store.get(key).view.start, 1);
const saving = store.save(key);
assert.equal(await store.save(key), null, "duplicate saves blocked");
store.patch(key, { text: "保存期间继续输入\n" });
finishSave();
await saving;
assert.equal(writes[0][2], "\ufeff修改\r\n");
assert.equal(store.get(key).savedText, "修改\n");
assert.equal(store.get(key).text, "保存期间继续输入\n");
assert.equal(store.get(key).revision, "v2");
fail = true;
await store.save(key);
assert.equal(store.get(key).error, "file_edit_conflict");
assert.equal(store.get(key).text, "保存期间继续输入\n");
assert.equal(store.get(key).savedText, "修改\n");
store.close(key);
assert.equal(store.get(key), undefined);
assert.ok(store.has("r", "other.txt"));
assert.equal(new FileEditStore({ load: async () => fixture(), save: async () => fixture() }).get(key), undefined, "no persistence");
assert.equal(serializeEditedText("a\r\nb\r\n", "a\nb\n"), "a\r\nb\r\n");
assert.equal(serializeEditedText("a\r\nb", "x\ny"), "x\r\ny");
assert.equal(serializeEditedText("", ""), "");
assert.equal(editableText("a\rb"), "a\nb");

// Old asynchronous loads cannot resurrect an exited/reopened editing session.
let finishLoad;
let loads = 0;
const delayed = new FileEditStore({ load: async () => {
  if (++loads === 1) await new Promise(resolve => { finishLoad = resolve; });
  return fixture(loads === 1 ? "old" : "new");
}, save: async () => fixture() });
const opening = delayed.open("r", "a.txt");
delayed.close(key);
await delayed.open("r", "a.txt");
delayed.patch(key, { text: "new draft" });
finishLoad();
await opening;
assert.equal(delayed.get(key).text, "new draft");
console.log("file editing state tests passed");

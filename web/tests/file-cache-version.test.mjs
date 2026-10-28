import assert from "node:assert/strict";
import { build } from "esbuild";

// Exercise the real cache/read flow with an unchanged file and an old chunk.
const bundle = await build({
  entryPoints: [new URL("../src/services/file.ts", import.meta.url).pathname],
  bundle: true, write: false, format: "esm", platform: "node",
  plugins: [{ name: "transport", setup(builder) {
    builder.onResolve({ filter: /^\.\/(base|e2ee)$/ }, args => ({ path: args.path, namespace: "transport" }));
    builder.onLoad({ filter: /.*/, namespace: "transport" }, args => ({ contents: args.path === "./base"
      ? 'export const appURL = (path, params) => `${path}?${params}`;'
      : 'export const e2eeService = { isRequired: () => false, parseProtectedJSONResponse: response => response.json() };' }));
  } }],
});
const records = new Map();
globalThis.window = { localStorage: {
  get length() { return records.size; },
  key: index => [...records.keys()][index] ?? null,
  getItem: key => records.get(key) ?? null,
  setItem: (key, value) => records.set(key, value),
  removeItem: key => records.delete(key),
} };
const oldKey = "r::long.md::incremental::0";
const oldFile = { root: "r", path: "long.md", name: "long.md", content: "old chunk", size: 200000, encoding: "utf-8", truncated: true, mtime: "2026-10-28T00:00:00Z" };
records.set(`mindfs-file-cache-record:${oldKey}`, JSON.stringify({
  key: oldKey, rootId: "r", path: "long.md", readMode: "incremental", cursor: 0, touchedAt: 1, file: oldFile,
}));
const { fetchFile, getCachedFile, invalidateFileCache } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const params = { rootId: "r", path: "long.md" };
assert.equal(await getCachedFile(params), null, "128 KiB cache must not be reused");
const fullFile = { ...oldFile, content: "new complete content", truncated: false };
let requests = 0;
globalThis.fetch = async url => {
  const query = new URL(url, "http://localhost").searchParams;
  if (++requests === 1) {
    assert.equal(query.has("mtime"), false, "old chunk must not cause a 304");
    return Response.json({ file: fullFile });
  }
  assert.equal(query.get("mtime"), fullFile.mtime, "new cache still supports validation");
  return new Response(null, { status: 304 });
};
assert.deepEqual(await fetchFile(params), fullFile);
assert.deepEqual(await fetchFile(params), fullFile);
invalidateFileCache("r", "long.md");
assert.equal(await getCachedFile(params), null, "versioned cache remains invalidatable");

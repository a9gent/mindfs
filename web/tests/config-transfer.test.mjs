import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/services/configTransferData.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
const sandbox = { exports: {}, TextEncoder, URL };
vm.runInNewContext(compiled, sandbox);
const { parseConfigArchive, availableConfigCategories, importableConfigCategories, CONFIG_BROWSER_KEYS, CONFIG_CATEGORIES } = sandbox.exports;
const host = value => JSON.parse(JSON.stringify(value));
const archive = {
  format: "mindfs-user-config", version: 1, created_at: "2026-10-26T00:00:00Z", platform: "darwin",
  sections: { providers: [{ id: "p", name: "Example", baseUrl: "https://api.example" }] },
  browser: { appearance: { "mindfs-appearance-mode": "moss", "mindfs-sidebars-swapped": "1" } },
};
assert.deepEqual(host(availableConfigCategories(parseConfigArchive(JSON.stringify(archive)))), ["appearance", "providers"]);
for (const id of ["api_keys", "agent_backups", "custom_agents", "token_station", "projects", "recent"]) {
  assert.equal(CONFIG_CATEGORIES.find(c => c.id === id).defaultSelected, false);
}
for (const key of ["mindfs_token", "mindfs_api_base_url", "mindfs_ws_base_url", "mindfs.nodePageURL", "mindfs-onboarding-state", "mindfs-e2ee-secret"]) {
  assert.equal(Object.values(CONFIG_BROWSER_KEYS).flat().includes(key), false, `${key} must not migrate`);
}
for (const mutate of [
  a => { a.format = "other"; }, a => { a.version = 2; }, a => { a.sections = null; },
  a => { a.sections.device = {}; }, a => { a.sections.appearance = {}; },
  a => { a.browser.appearance.mindfs_token = "secret"; },
  a => { a.browser.nodes = { mindfs_launcher_nodes: JSON.stringify([{ id: "n", name: "N", createdAt: "now", url: "javascript:alert(1)" }]) }; },
  a => { a.browser.appearance["mindfs-sidebars-swapped"] = "yes"; },
  a => { a.browser.appearance["mindfs-appearance-mode"] = {}; },
  a => { a.browser.appearance["mindfs-font-size-preferences"] = JSON.stringify({ fileSidebar: 10, main: 1, sessionSidebar: 1 }); },
  a => { a.browser.interaction = { "mindfs-send-shortcut": JSON.stringify({ key: "Enter", ctrl: false, meta: false, alt: false, shift: false }) }; },
]) {
  const invalid = structuredClone(archive); mutate(invalid);
  assert.throws(() => parseConfigArchive(JSON.stringify(invalid)));
}
assert.throws(() => parseConfigArchive(JSON.stringify({ ...archive, sections: {}, browser: {} })));
assert.throws(() => parseConfigArchive("not JSON"));
const paths = { ...archive, sections: { projects: { dirs: [{ id: "repo", name: "Repo", root_path: "/old/repo" }], order: ["repo"] } } };
assert.deepEqual(host(importableConfigCategories(paths)), ["appearance"], "old project registrations are excluded from import");
assert.equal(availableConfigCategories(paths).includes("projects"), true, "project backups remain compatible with the archive format");
console.log("configuration archive validation checks passed");

// Exercise the actual transfer service with isolated storage and network/native
// adapters, including node scoping and failures after a server commit.
const serviceSource = readFileSync(new URL("../src/services/configTransfer.ts", import.meta.url), "utf8");
const serviceCompiled = ts.transpileModule(serviceSource, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
const storage = new Map([["mindfs_token", "never-export"], ["mindfs-appearance-mode", "meadow"], ["mindfs-pinned-session-projects", '{"new-project":1}']]);
let request, saved, failServer = false, failNative = false;
const node = (id, url) => ({ id, name: id, url, createdAt: "2026-10-26" });
const serverNode = node("server", "https://server.example");
const browserNode = node("browser", "https://browser.example");
const nativeNode = node("native", "https://native.example");
const modules = {
  "./api": { protectedJSON: async (url, init) => {
    request = JSON.parse(init.body);
    if (failServer) throw new Error("server rejected import");
    return url.endsWith("/export") ? { ...baseArchive(), sections: request.categories.includes("nodes") ? { nodes: { launcher_nodes: [serverNode] } } : {} } : { restart_required: false };
  } },
  "./base": { appPath: path => `/n/destination${path}` },
  "./download": { downloadBlob: async blob => { saved = JSON.parse(await blob.text()); } },
  "./launcherNodeSync": { getNativeLauncherNodes: async () => [nativeNode], setNativeLauncherNodes: async () => { if (failNative) throw new Error("native unavailable"); } },
  "./storage": { getStoredLauncherNodes: () => [browserNode] },
  "./configTransferData": sandbox.exports,
};
function baseArchive() { return { format: "mindfs-user-config", version: 1, created_at: "2026-10-26", platform: "darwin", sections: {} }; }
const serviceSandbox = { exports: {}, require: name => modules[name], Blob, window: { localStorage: {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: key => storage.delete(key),
} } };
vm.runInNewContext(serviceCompiled, serviceSandbox);
const { exportUserConfig, importUserConfig } = serviceSandbox.exports;
await exportUserConfig(["nodes", "appearance"]);
assert.deepEqual(saved.sections.nodes.launcher_nodes.map(n => n.id), ["server", "browser", "native"]);
assert.equal(JSON.stringify(saved).includes("never-export"), false);
assert.equal(JSON.parse(saved.browser.nodes.mindfs_launcher_nodes).length, 3);
const incoming = { ...baseArchive(), sections: { behavior: {}, api_keys: { p: "unselected-secret" }, projects: paths.sections.projects }, browser: { appearance: { "mindfs-appearance-mode": "moss" }, recent: { "mindfs-recent-dirs": "[]" }, projects: { "mindfs-pinned-session-projects": '{"old-project":2}' } } };
failServer = true;
await assert.rejects(importUserConfig(incoming, ["appearance", "behavior", "projects"]));
assert.equal(storage.get("mindfs-appearance-mode"), "meadow");
assert.equal(request.archive.sections.api_keys, undefined);
assert.equal(request.archive.sections.projects, undefined);
failServer = false;
await importUserConfig(incoming, ["appearance", "recent", "projects"]);
assert.equal(storage.get("mindfs-appearance-mode"), "moss");
assert.equal(storage.get("mindfs-recent-dirs:v2:%2Fn%2Fdestination%2F"), "[]");
assert.equal(storage.get("mindfs-pinned-session-projects"), '{"new-project":1}', "project preferences are not restored");
failNative = true;
const result = await importUserConfig(saved, ["nodes"]);
assert.equal(result.native_sync_failed, true, "native copy failure must be visible after server settings were saved");
assert.equal(storage.get("mindfs_token"), "never-export");
console.log("configuration transfer service checks passed");

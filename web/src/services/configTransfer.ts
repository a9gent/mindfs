import { protectedJSON } from "./api";
import { appPath } from "./base";
import { downloadBlob } from "./download";
import { getNativeLauncherNodes, setNativeLauncherNodes } from "./launcherNodeSync";
import { getStoredLauncherNodes, type LauncherNode } from "./storage";
import {
  CONFIG_ARCHIVE_MAX_BYTES, CONFIG_BROWSER_KEYS, CONFIG_CATEGORIES,
  importableConfigCategories, parseConfigArchive, validateBrowserValue, type ConfigArchive, type ConfigCategory,
} from "./configTransferData";

function browserStorageKey(key: string): string {
  return key === "mindfs-recent-dirs" ? `${key}:v2:${encodeURIComponent(appPath("/"))}` : key;
}

export async function exportUserConfig(categories: ConfigCategory[]): Promise<void> {
  const server = categories.filter(id => CONFIG_CATEGORIES.find(c => c.id === id)?.server);
  const archive = await protectedJSON<ConfigArchive>(appPath("/api/config/export"), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ categories: server }),
  });
  archive.browser = {};
  for (const id of categories) {
    const keys = CONFIG_BROWSER_KEYS[id];
    if (!keys) continue;
    const section: Record<string, string | null> = {};
    for (const key of keys) {
      const value = window.localStorage.getItem(browserStorageKey(key));
      validateBrowserValue(key, value);
      section[key] = value;
    }
    archive.browser[id] = section;
  }
  if (categories.includes("nodes")) {
    const serverNodes = (archive.sections.nodes as { launcher_nodes?: LauncherNode[] } | undefined)?.launcher_nodes || [];
    const nodes = [...serverNodes, ...getStoredLauncherNodes(), ...await getNativeLauncherNodes()];
    const unique = nodes.filter((n, i) => nodes.findIndex(other => other.url === n.url || other.id === n.id) === i);
    archive.browser.nodes = { mindfs_launcher_nodes: JSON.stringify(unique) };
    // One portable list can be restored from either a server-backed node page
    // or the native launcher, whose persistence mechanisms differ.
    archive.sections.nodes = { launcher_nodes: unique.map(({ id, name, url, createdAt }) => ({ id, name, url, createdAt })) };
  }
  const text = JSON.stringify(archive, null, 2);
  // Enforce the same format and limits that the destination device accepts.
  parseConfigArchive(text);
  const blob = new Blob([text], { type: "application/json" });
  if (blob.size > CONFIG_ARCHIVE_MAX_BYTES) throw new Error("configTransfer.tooLarge");
  await downloadBlob(blob, `mindfs-config-${new Date().toISOString().slice(0, 10)}.json`);
}

export async function importUserConfig(archive: ConfigArchive, categories: ConfigCategory[]): Promise<{ restart_required: boolean; native_sync_failed?: boolean }> {
  const available = new Set(importableConfigCategories(archive));
  const selected = categories.filter(id => available.has(id));
  const server = selected.filter(id => Object.hasOwnProperty.call(archive.sections, id));
  const changes = new Map<string, string | null>();
  for (const id of selected) {
    const section = archive.browser?.[id];
    if (!section) continue;
    for (const key of CONFIG_BROWSER_KEYS[id] || []) {
      if (!Object.hasOwnProperty.call(section, key)) continue;
      validateBrowserValue(key, section[key]);
      changes.set(browserStorageKey(key), section[key]);
    }
  }
  const previous = new Map([...changes.keys()].map(key => [key, window.localStorage.getItem(key)]));
  const setValue = (key: string, value: string | null) => value === null ? window.localStorage.removeItem(key) : window.localStorage.setItem(key, value);
  let result: { restart_required: boolean; native_sync_failed?: boolean } = { restart_required: false };
  try {
    // Check quota/storage access before mutating server settings. If validation
    // or server import fails, restore the destination browser's previous values.
    for (const [key, value] of changes) setValue(key, value);
    if (server.length) {
      result = await protectedJSON<{ restart_required: boolean }>(appPath("/api/config/import"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archive: { ...archive, sections: Object.fromEntries(server.map(id => [id, archive.sections[id]])), browser: undefined }, categories: server }),
      });
    }
  } catch (error) {
    for (const [key, value] of previous) { try { setValue(key, value); } catch { /* Preserve the original error. */ } }
    throw error;
  }
  if (selected.includes("nodes") && archive.browser?.nodes) {
    const raw = archive.browser.nodes.mindfs_launcher_nodes;
    const nodes = raw ? JSON.parse(raw) as LauncherNode[] : [];
    try { await setNativeLauncherNodes(nodes, true); }
    catch { result.native_sync_failed = true; }
  }
  return result;
}

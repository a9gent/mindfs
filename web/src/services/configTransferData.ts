import type { MessageKey } from "../i18n";

export const CONFIG_ARCHIVE_FORMAT = "mindfs-user-config";
export const CONFIG_ARCHIVE_MAX_BYTES = (32 << 20) - (64 << 10);

export const CONFIG_CATEGORIES = [
  { id: "appearance", defaultSelected: true, server: false },
  { id: "interaction", defaultSelected: true, server: false },
  { id: "agent_preferences", defaultSelected: true, server: true },
  { id: "behavior", defaultSelected: true, server: true },
  { id: "prompts", defaultSelected: true, server: true },
  { id: "templates", defaultSelected: true, server: true },
  { id: "nodes", defaultSelected: true, server: true },
  { id: "providers", defaultSelected: false, server: true },
  { id: "api_keys", defaultSelected: false, server: true, sensitive: true },
  { id: "agent_backups", defaultSelected: false, server: true, sensitive: true, device: true },
  { id: "custom_agents", defaultSelected: false, server: true, sensitive: true, device: true },
  { id: "projects", defaultSelected: false, server: true, device: true },
  { id: "recent", defaultSelected: false, server: false, device: true },
  { id: "relay_services", defaultSelected: false, server: true, device: true },
  { id: "token_station", defaultSelected: false, server: true, sensitive: true },
] as const;

export type ConfigCategory = typeof CONFIG_CATEGORIES[number]["id"];
export type ConfigArchive = {
  format: typeof CONFIG_ARCHIVE_FORMAT;
  version: 1;
  created_at: string;
  platform: string;
  sections: Partial<Record<ConfigCategory, unknown>>;
  browser?: Partial<Record<ConfigCategory, Record<string, string | null>>>;
};

export function categoryLabel(id: ConfigCategory): MessageKey { return `configTransfer.category.${id}`; }
export function categoryDescription(id: ConfigCategory): MessageKey { return `configTransfer.description.${id}`; }

// Only explicit preference keys may cross devices. Never copy arbitrary storage
// prefixes: they also contain pairing secrets, access tokens and plugin grants.
export const CONFIG_BROWSER_KEYS: Partial<Record<ConfigCategory, readonly string[]>> = {
  appearance: ["mindfs-locale", "mindfs-appearance-mode", "mindfs-font-size-preferences", "mindfs-sidebars-swapped", "mindfs-default-main-content-view", "mindfs-tree-sort-mode", "mindfs-git-diff-side-by-side", "mindfs-markdown-outline-enabled", "mindfs-project-tree-tab"],
  interaction: ["mindfs-send-shortcut", "mindfs-mobile-enter-key-sends", "mindfs-float-ball-gestures", "mindfs-multi-project-session-list", "mindfs-mobile-reply-info"],
  prompts: ["mindfs-handoff-template"],
  nodes: ["mindfs_launcher_nodes"],
  projects: ["mindfs-pinned-session-projects", "mindfs-directory-sort-overrides", "mindfs-main-content-view", "mindfs-task-template-selection", "mindfs-task-create-worktree-pref"],
  // The recent-directory key is portable inside the archive, then scoped to the
  // destination node on import; unrelated nodes' history is never enumerated.
  recent: ["mindfs-recent-dirs", "mindfs-last-root-id", "mindfs-file-scroll-positions", "mindfs-git-status-expanded", "mindfs-git-history-expanded"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const enumKeys: Record<string, readonly string[]> = {
  "mindfs-locale": ["zh-CN", "en-US"],
  "mindfs-appearance-mode": ["dark", "light", "meadow", "moss", "system"],
  "mindfs-default-main-content-view": ["task-kanban", "file-browser"],
  "mindfs-tree-sort-mode": ["name-asc", "name-desc", "mtime-desc", "mtime-asc", "size-desc", "size-asc"],
  "mindfs-project-tree-tab": ["files", "git", "worktrees", "related"],
};
const booleanKeys = new Set(["mindfs-sidebars-swapped", "mindfs-git-diff-side-by-side", "mindfs-markdown-outline-enabled", "mindfs-mobile-enter-key-sends", "mindfs-multi-project-session-list"]);

export function validateBrowserValue(key: string, raw: unknown): asserts raw is string | null {
  if (raw === null) return;
  if (typeof raw !== "string" || raw.length > (1 << 20)) throw new Error(`Invalid preference: ${key}`);
  if (enumKeys[key]) {
    if (!enumKeys[key].includes(raw)) throw new Error(`Invalid preference: ${key}`);
    return;
  }
  if (booleanKeys.has(key)) {
    if (raw !== "0" && raw !== "1") throw new Error(`Invalid preference: ${key}`);
    return;
  }
  if (key === "mindfs-handoff-template" || key === "mindfs-last-root-id") return;
  const value: unknown = JSON.parse(raw);
  if (key === "mindfs_launcher_nodes" || key === "mindfs-recent-dirs") {
    if (!Array.isArray(value) || value.length > 1000) throw new Error(`Invalid preference: ${key}`);
    for (const item of value) {
      if (!isRecord(item)) throw new Error(`Invalid preference: ${key}`);
      if (key === "mindfs_launcher_nodes") {
        if (![item.id, item.name, item.createdAt].every(v => typeof v === "string" && v.length > 0) || typeof item.url !== "string") throw new Error("Invalid launcher node");
        const url = new URL(item.url);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid launcher node URL");
      } else if (typeof item.rootId !== "string" || typeof item.path !== "string") throw new Error("Invalid recent directory");
    }
    return;
  }
  if (!isRecord(value)) throw new Error(`Invalid preference: ${key}`);
  if (key === "mindfs-font-size-preferences") {
    for (const region of ["fileSidebar", "main", "sessionSidebar"]) {
      const scale = value[region];
      if (typeof scale !== "number" || scale < 0.8 || scale > 1.4) throw new Error("Invalid font size");
    }
  }
  if (key === "mindfs-send-shortcut" && (typeof value.key !== "string" || !["alt", "ctrl", "meta", "shift"].every(k => typeof value[k] === "boolean") || !(value.alt || value.ctrl || value.meta))) throw new Error("Invalid send shortcut");
}

export function parseConfigArchive(text: string): ConfigArchive {
  if (new TextEncoder().encode(text).length > CONFIG_ARCHIVE_MAX_BYTES) throw new Error("configTransfer.tooLarge");
  const data: unknown = JSON.parse(text);
  if (!isRecord(data) || data.format !== CONFIG_ARCHIVE_FORMAT || data.version !== 1 || typeof data.created_at !== "string" || typeof data.platform !== "string" || !isRecord(data.sections) || (data.browser !== undefined && !isRecord(data.browser))) throw new Error("configTransfer.invalidFile");
  const known = new Map<string, typeof CONFIG_CATEGORIES[number]>(CONFIG_CATEGORIES.map(c => [c.id, c]));
  for (const id of Object.keys(data.sections)) {
    if (!known.get(id)?.server || data.sections[id] === null) throw new Error("configTransfer.invalidFile");
  }
  for (const [id, section] of Object.entries(data.browser || {})) {
    const keys = CONFIG_BROWSER_KEYS[id as ConfigCategory];
    if (!keys || !isRecord(section)) throw new Error("configTransfer.invalidFile");
    for (const [key, value] of Object.entries(section)) {
      if (!keys.includes(key)) throw new Error("configTransfer.invalidFile");
      validateBrowserValue(key, value);
    }
  }
  const archive = data as ConfigArchive;
  if (!availableConfigCategories(archive).length) throw new Error("configTransfer.emptyFile");
  return archive;
}

export function availableConfigCategories(archive: ConfigArchive): ConfigCategory[] {
  return CONFIG_CATEGORIES.filter(c => Object.hasOwnProperty.call(archive.sections, c.id) || Object.hasOwnProperty.call(archive.browser || {}, c.id)).map(c => c.id);
}

export function importableConfigCategories(archive: ConfigArchive): ConfigCategory[] {
  // Project registrations and their local preferences stay on the destination.
  // Keep accepting older archives that include them without restoring old paths.
  return availableConfigCategories(archive).filter(id => id !== "projects");
}

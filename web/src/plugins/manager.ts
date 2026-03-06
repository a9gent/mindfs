export type MatchRule = {
  ext?: string;
  path?: string;
  mime?: string;
  name?: string;
  any?: MatchRule[];
  all?: MatchRule[];
};

export type PluginInput = {
  name: string;
  path: string;
  content: string;
  ext: string;
  mime: string;
  size: number;
  truncated: boolean;
  next_cursor?: number;
  query?: Record<string, string>;
};

export type UITree = {
  root: string;
  elements: Record<string, unknown>;
};

export type PluginOutput = {
  data?: Record<string, unknown>;
  tree: UITree;
};

export type ViewPlugin = {
  name: string;
  match: MatchRule;
  fileLoadMode: "incremental" | "full";
  theme: {
    overlayBg: string;
    surfaceBg: string;
    surfaceBgElevated: string;
    text: string;
    textMuted: string;
    border: string;
    primary: string;
    primaryText: string;
    radius: string;
    shadow: string;
    focusRing: string;
    danger: string;
    warning: string;
    success: string;
  };
  process: (file: PluginInput) => PluginOutput;
};

function splitCSV(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function escapeRegex(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, "/");
  let pattern = escapeRegex(normalized);
  pattern = pattern.replace(/\\\*\\\*/g, ".*");
  pattern = pattern.replace(/\\\*/g, "[^/]*");
  pattern = pattern.replace(/\\\?/g, ".");
  return new RegExp("^" + pattern + "$", "i");
}

function normalizePath(value: string | undefined): string {
  if (!value) return "";
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function matchExt(path: string, extRule: string): boolean {
  if (!extRule) return true;
  const lowerPath = path.toLowerCase();
  const rules = splitCSV(extRule).map((item) => item.toLowerCase());
  return rules.some((item) => lowerPath.endsWith(item));
}

function matchMime(mime: string, mimeRule: string): boolean {
  if (!mimeRule) return true;
  const target = (mime || "").toLowerCase();
  const rule = mimeRule.toLowerCase();
  if (rule.endsWith("/*")) {
    return target.startsWith(rule.slice(0, -1));
  }
  return target === rule;
}

function matchGlob(path: string, pattern: string): boolean {
  if (!pattern) return true;
  try {
    return globToRegExp(pattern).test(path);
  } catch {
    return false;
  }
}

function matchesRule(file: PluginInput, rule: MatchRule): boolean {
  if (!rule) return true;
  const filePath = normalizePath(file.path);
  const fileName = file.name || filePath.split("/").pop() || "";
  const fileMime = file.mime || "";

  if (rule.any && rule.any.length > 0) {
    return rule.any.some((child) => matchesRule(file, child));
  }
  if (rule.all && rule.all.length > 0) {
    return rule.all.every((child) => matchesRule(file, child));
  }

  if (rule.ext && !matchExt(filePath, rule.ext)) return false;
  if (rule.path && !matchGlob(filePath, rule.path)) return false;
  if (rule.mime && !matchMime(fileMime, rule.mime)) return false;
  if (rule.name && !matchGlob(fileName, rule.name)) return false;
  return true;
}

function isValidPlugin(value: unknown): value is ViewPlugin {
  if (!value || typeof value !== "object") return false;
  const plugin = value as Record<string, unknown>;
  const theme = plugin.theme as Record<string, unknown> | undefined;
  const requiredThemeKeys = [
    "overlayBg",
    "surfaceBg",
    "surfaceBgElevated",
    "text",
    "textMuted",
    "border",
    "primary",
    "primaryText",
    "radius",
    "shadow",
    "focusRing",
    "danger",
    "warning",
    "success",
  ];
  const hasValidTheme =
    !!theme &&
    requiredThemeKeys.every((key) => typeof theme[key] === "string" && String(theme[key]).trim().length > 0);
  return (
    typeof plugin.name === "string" &&
    !!plugin.match &&
    (plugin.fileLoadMode === "incremental" || plugin.fileLoadMode === "full") &&
    hasValidTheme &&
    typeof plugin.process === "function"
  );
}

export class PluginManager {
  private pluginsByRoot = new Map<string, ViewPlugin[]>();

  list(rootId: string): ViewPlugin[] {
    return this.pluginsByRoot.get(rootId) || [];
  }

  set(rootId: string, plugins: ViewPlugin[]): void {
    this.pluginsByRoot.set(rootId, plugins);
  }

  clear(rootId: string): void {
    this.pluginsByRoot.delete(rootId);
  }

  match(rootId: string, file: PluginInput): ViewPlugin | null {
    const plugins = this.list(rootId);
    for (const plugin of plugins) {
      if (matchesRule(file, plugin.match)) {
        return plugin;
      }
    }
    return null;
  }

  run(plugin: ViewPlugin, file: PluginInput): PluginOutput {
    return plugin.process(file);
  }
}

export async function loadPlugin(code: string): Promise<ViewPlugin> {
  const module = { exports: {} as any };
  const fn = new Function("module", "exports", code);
  fn(module, module.exports);
  const loaded = module.exports?.default ?? module.exports;
  if (!isValidPlugin(loaded)) {
    throw new Error("invalid plugin module");
  }
  return loaded;
}

export async function loadAllPlugins(rootId: string): Promise<ViewPlugin[]> {
  let treeResp: Response;
  try {
    treeResp = await fetch(
      `/api/tree?root=${encodeURIComponent(rootId)}&dir=${encodeURIComponent(".mindfs/plugins")}`,
    );
  } catch {
    return [];
  }
  if (!treeResp.ok) {
    return [];
  }
  const treePayload = await treeResp.json();
  const entries = Array.isArray(treePayload?.entries) ? treePayload.entries : [];
  const pluginFiles = entries.filter(
    (entry: any) =>
      entry &&
      entry.is_dir === false &&
      typeof entry.name === "string" &&
      entry.name.toLowerCase().endsWith(".js") &&
      typeof entry.path === "string",
  );

  const plugins: ViewPlugin[] = [];
  for (const file of pluginFiles) {
    try {
      const fileResp = await fetch(
        `/api/file?root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(file.path)}`,
      );
      if (!fileResp.ok) continue;
      const payload = await fileResp.json();
      const content = payload?.file?.content;
      if (typeof content !== "string") continue;
      const loaded = await loadPlugin(content);
      plugins.push(loaded);
    } catch {
      // ignore invalid plugin files
    }
  }
  return plugins;
}

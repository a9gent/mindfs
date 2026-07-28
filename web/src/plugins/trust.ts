export type PluginSourceRecord = {
  path: string;
  sha256: string;
  size: number;
};

export type PluginSourceSnapshot = {
  rootPath: string;
  plugins: PluginSourceRecord[];
};

export type TrustedPluginSet = PluginSourceSnapshot & {
  trustedAt: string;
};

const TRUST_STORAGE_PREFIX = "mindfs-plugin-trust:";

export function pluginTrustStorageKey(rootId: string): string {
  return `${TRUST_STORAGE_PREFIX}${rootId}`;
}

export function normalizePluginSnapshot(snapshot: PluginSourceSnapshot): PluginSourceSnapshot {
  return {
    rootPath: String(snapshot.rootPath || ""),
    plugins: [...snapshot.plugins]
      .map((plugin) => ({
        path: String(plugin.path || ""),
        sha256: String(plugin.sha256 || ""),
        size: Number(plugin.size) || 0,
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export function buildPluginTrustRecord(
  snapshot: PluginSourceSnapshot,
  trustedAt = new Date().toISOString(),
): TrustedPluginSet {
  return {
    ...normalizePluginSnapshot(snapshot),
    trustedAt,
  };
}

export function isPluginSnapshotTrusted(
  snapshot: PluginSourceSnapshot,
  trusted: TrustedPluginSet | null | undefined,
): boolean {
  if (!trusted) return false;
  const current = normalizePluginSnapshot(snapshot);
  const saved = normalizePluginSnapshot(trusted);
  if (current.rootPath !== saved.rootPath) return false;
  if (current.plugins.length !== saved.plugins.length) return false;
  return current.plugins.every((plugin, index) => {
    const other = saved.plugins[index];
    return plugin.path === other.path && plugin.sha256 === other.sha256 && plugin.size === other.size;
  });
}

export function readTrustedPluginSet(rootId: string): TrustedPluginSet | null {
  if (typeof window === "undefined" || !rootId) return null;
  try {
    const raw = window.localStorage.getItem(pluginTrustStorageKey(rootId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TrustedPluginSet | null;
    if (!parsed || typeof parsed !== "object" || typeof parsed.rootPath !== "string" || !Array.isArray(parsed.plugins)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveTrustedPluginSet(rootId: string, snapshot: PluginSourceSnapshot): void {
  if (typeof window === "undefined" || !rootId) return;
  try {
    window.localStorage.setItem(pluginTrustStorageKey(rootId), JSON.stringify(buildPluginTrustRecord(snapshot)));
  } catch {
  }
}

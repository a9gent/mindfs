import { getNativeBridge, parseNativeJSON } from "./nativeBridge";
import { getNativePlatform, isAndroidRuntime, isHarmonyRuntime, isNativeShellRuntime, type NativePlatform } from "./runtime";

const DEFAULT_ANDROID_VERSION_URL = "https://relay.a9gent.com/api/versions/android";
const DEFAULT_HARMONY_VERSION_URL = "https://relay.a9gent.com/api/versions/harmony";

export type AppUpdateState = {
  platform: NativePlatform;
  current_version: string;
  current_build: string;
  latest_version: string;
  has_update: boolean;
  status: "idle" | "available" | "downloading" | "downloaded" | "failed";
  message: string;
  notes: string;
  download_url: string;
  filename: string;
};

type RelayVersionResponse = {
  version?: string;
  notes?: string;
  downloads?: Array<{
    os?: string;
    arch?: string;
    filename?: string;
    url?: string;
  }>;
};

type WindowWithAppInfoBridge = Window & {
  MindFSAppInfo?: {
    getInfo?: () => string;
  };
};

export function normalizeAppUpdateState(
  input: Partial<AppUpdateState> | null | undefined,
): AppUpdateState {
  return {
    platform: input?.platform || getNativePlatform(),
    current_version: input?.current_version || "",
    current_build: input?.current_build || "",
    latest_version: input?.latest_version || "",
    has_update: input?.has_update === true,
    status: input?.status || "idle",
    message: input?.message || "",
    notes: input?.notes || "",
    download_url: input?.download_url || "",
    filename: input?.filename || "",
  };
}

export function isUpdatableNativeRuntime(): boolean {
  return isAndroidRuntime() || isHarmonyRuntime();
}

export async function fetchAppUpdateState(): Promise<AppUpdateState> {
  if (!isUpdatableNativeRuntime()) {
    return normalizeAppUpdateState(null);
  }

  const platform = getNativePlatform();
  const appInfo = await getAppInfo();
  const endpoint = buildVersionEndpoint(platform);
  const response = await fetch(endpoint, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`${platform}_version_check_failed_${response.status}`);
  }

  const payload = (await response.json()) as RelayVersionResponse;
  const download = pickNativeDownload(payload, platform);
  const latestVersion = normalizeVersionLabel(payload.version || "");
  const currentVersion = normalizeVersionLabel(appInfo.version || "");
  const hasUpdate =
    !!latestVersion &&
    !!download.url &&
    isNewerVersion(latestVersion, currentVersion);

  return normalizeAppUpdateState({
    platform,
    current_version: appInfo.version || "",
    current_build: appInfo.build || "",
    latest_version: latestVersion,
    has_update: hasUpdate,
    status: hasUpdate ? "available" : "idle",
    notes: payload.notes || "",
    download_url: download.url || "",
    filename: download.filename || filenameFromURL(download.url || "") || defaultPackageFilename(platform),
  });
}

function buildVersionEndpoint(platform: NativePlatform): string {
  if (platform === "harmony") {
    const configured = String(import.meta.env.VITE_HARMONY_VERSION_URL || "").trim();
    return configured || DEFAULT_HARMONY_VERSION_URL;
  }
  const configured = String(import.meta.env.VITE_ANDROID_VERSION_URL || "").trim();
  return configured || DEFAULT_ANDROID_VERSION_URL;
}

async function getAppInfo(): Promise<{ version?: string; build?: string }> {
  const native = getNativeBridge();
  if (typeof native?.getAppInfo === "function") {
    return parseNativeJSON(await native.getAppInfo(), {});
  }
  if (isAndroidRuntime()) {
    const nativeBridge = (window as WindowWithAppInfoBridge).MindFSAppInfo;
    if (nativeBridge && typeof nativeBridge.getInfo === "function") {
      return parseNativeJSON(nativeBridge.getInfo(), {});
    }
    const { App } = await import("@capacitor/app");
    return App.getInfo();
  }
  return {};
}

function pickNativeDownload(payload: RelayVersionResponse, platform: NativePlatform): {
  filename?: string;
  url?: string;
} {
  const downloads = Array.isArray(payload.downloads) ? payload.downloads : [];
  const platformDownloads = downloads.filter((item) => {
    const os = String(item.os || "").toLowerCase();
    return !os || os === platform || (platform === "harmony" && os === "openharmony");
  });
  const candidates = platformDownloads.length ? platformDownloads : downloads;
  const packagePattern = platform === "harmony"
    ? /\.(hap|app)(?:$|\?)/i
    : /\.apk(?:$|\?)/i;
  return (
    candidates.find((item) => packagePattern.test(item.url || item.filename || "")) ||
    candidates[0] ||
    {}
  );
}

function defaultPackageFilename(platform: NativePlatform): string {
  return platform === "harmony" ? "mindfs-harmony.hap" : "mindfs-android.apk";
}

export function appPackageLabel(platform = getNativePlatform()): string {
  return platform === "harmony" ? "HarmonyOS" : "Android";
}

export function normalizeVersionLabel(value: string): string {
  return String(value || "").trim().replace(/^v/i, "");
}

function isNewerVersion(latest: string, current: string): boolean {
  const latestParts = parseVersionParts(latest);
  const currentParts = parseVersionParts(current);
  if (!latestParts || !currentParts) {
    return latest !== current;
  }
  const length = Math.max(latestParts.length, currentParts.length);
  for (let i = 0; i < length; i += 1) {
    const left = latestParts[i] || 0;
    const right = currentParts[i] || 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return false;
}

function parseVersionParts(value: string): number[] | null {
  const match = normalizeVersionLabel(value).match(/^(\d+(?:\.\d+){0,3})/);
  if (!match) {
    return null;
  }
  return match[1].split(".").map((part) => Number.parseInt(part, 10));
}

function filenameFromURL(value: string): string {
  try {
    const url = new URL(value);
    const segment = url.pathname.split("/").filter(Boolean).pop() || "";
    return decodeURIComponent(segment);
  } catch {
    const segment = value.split("?")[0]?.split("/").filter(Boolean).pop() || "";
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  }
}

export { isNativeShellRuntime };
export { isAndroidRuntime };

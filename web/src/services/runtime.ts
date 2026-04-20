import { getStoredApiBaseURL, getStoredWsBaseURL } from "./storage";

export function isBrowserRuntime(): boolean {
  return typeof window !== "undefined";
}

export function isCapacitorRuntime(): boolean {
  if (!isBrowserRuntime()) {
    return false;
  }
  const win = window as Window & {
    Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string };
  };
  if (typeof win.Capacitor?.isNativePlatform === "function") {
    return win.Capacitor.isNativePlatform();
  }
  const protocol = window.location.protocol;
  return protocol === "capacitor:" || protocol === "ionic:";
}

function sanitizeBaseURL(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  return value.trim().replace(/\/+$/, "");
}

function readMeta(name: string): string {
  if (typeof document === "undefined") {
    return "";
  }
  const node = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  return sanitizeBaseURL(node?.content);
}

function readStorage(key: string): string {
  if (key === "mindfs_api_base_url") {
    return sanitizeBaseURL(getStoredApiBaseURL());
  }
  if (key === "mindfs_ws_base_url") {
    return sanitizeBaseURL(getStoredWsBaseURL());
  }
  if (!isBrowserRuntime()) {
    return "";
  }
  try {
    return sanitizeBaseURL(window.localStorage.getItem(key));
  } catch {
    return "";
  }
}

function deriveOriginBaseURL(): string {
  if (!isBrowserRuntime()) {
    return "";
  }
  return sanitizeBaseURL(window.location.origin);
}

export function getApiBaseURL(): string {
  const configured = readStorage("mindfs_api_base_url") || readMeta("mindfs-api-base-url");
  if (configured) {
    return configured;
  }
  if (isCapacitorRuntime()) {
    return "";
  }
  return deriveOriginBaseURL();
}

export function getWsBaseURL(): string {
  const configured = readStorage("mindfs_ws_base_url") || readMeta("mindfs-ws-base-url");
  if (configured) {
    return configured;
  }
  const apiBaseURL = getApiBaseURL();
  if (!apiBaseURL) {
    return "";
  }
  if (apiBaseURL.startsWith("https://")) {
    return `wss://${apiBaseURL.slice("https://".length)}`;
  }
  if (apiBaseURL.startsWith("http://")) {
    return `ws://${apiBaseURL.slice("http://".length)}`;
  }
  return apiBaseURL;
}

export function shouldRegisterServiceWorker(): boolean {
  return !isCapacitorRuntime();
}

export function shouldEnablePWAInstall(): boolean {
  return !isCapacitorRuntime();
}

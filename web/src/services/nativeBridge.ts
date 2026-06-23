import type { LauncherNode } from "./storage";

export type NativeAppInfo = {
  version?: string;
  build?: string;
};

export type NativeDownloadResult = {
  downloadId?: number | string;
  filename?: string;
  directory?: string;
  path?: string;
};

export type NativeReplyPollerConfig = {
  apiBaseUrl: string;
  token?: string;
  e2eeRequired?: boolean;
  e2eeNodeId?: string;
  e2eeClientId?: string;
  e2eeTransportKey?: string;
};

export type NativeBridge = {
  platform?: "android" | "harmony" | string;
  download?: (input: { url: string; filename: string } | string) => Promise<NativeDownloadResult> | NativeDownloadResult | string | void;
  saveBase64?: (input: { dataBase64: string; filename: string; mimeType?: string } | string) => Promise<NativeDownloadResult> | NativeDownloadResult | string | void;
  openExternalURL?: (url: string) => Promise<string | void> | string | void;
  getAppInfo?: () => Promise<NativeAppInfo | string> | NativeAppInfo | string;
  configureReplyPoller?: (input: NativeReplyPollerConfig | string) => Promise<void> | void;
  markClearWebViewCacheOnNextLaunch?: () => Promise<{ scheduled?: boolean } | void> | { scheduled?: boolean } | void;
  clearPendingWebViewCacheClear?: () => Promise<{ scheduled?: boolean } | void> | { scheduled?: boolean } | void;
  consumeRelayNodes?: () => Promise<{ nodes?: unknown[]; count?: number } | unknown[] | string> | { nodes?: unknown[]; count?: number } | unknown[] | string;
  getLauncherNodes?: () => Promise<{ nodes?: LauncherNode[]; count?: number } | LauncherNode[] | string> | { nodes?: LauncherNode[]; count?: number } | LauncherNode[] | string;
  setLauncherNodes?: (input: { nodes: LauncherNode[] } | string) => Promise<{ stored?: boolean; count?: number } | void> | { stored?: boolean; count?: number } | void;
  storeRelayNodes?: (input: unknown[] | string) => Promise<{ stored?: boolean; count?: number } | string | void> | { stored?: boolean; count?: number } | string | void;
  syncRelayNodesFromRelayer?: () => Promise<{ scheduled?: boolean } | string | void> | { scheduled?: boolean } | string | void;
  writeClipboardText?: (text: string) => Promise<boolean | void> | boolean | void;
};

type LegacyBridgeWindow = Window & {
  MindFSNative?: NativeBridge;
  MindFSHarmony?: NativeBridge;
};

export function getNativeBridge(): NativeBridge | null {
  if (typeof window === "undefined") {
    return null;
  }
  const win = window as LegacyBridgeWindow;
  const bridges = [win.MindFSNative, win.MindFSHarmony].filter(Boolean) as NativeBridge[];
  return bridges.find(hasCallableNativeMethod) || bridges[0] || null;
}

function hasCallableNativeMethod(bridge: NativeBridge): boolean {
  return [
    bridge.download,
    bridge.saveBase64,
    bridge.openExternalURL,
    bridge.getAppInfo,
    bridge.configureReplyPoller,
    bridge.consumeRelayNodes,
    bridge.getLauncherNodes,
    bridge.setLauncherNodes,
    bridge.storeRelayNodes,
    bridge.syncRelayNodesFromRelayer,
    bridge.writeClipboardText,
  ].some((method) => typeof method === "function");
}

export function parseNativeJSON<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") {
    return (value ?? fallback) as T;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return fallback;
  }
}

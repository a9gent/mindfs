import { registerPlugin } from "@capacitor/core";
import { appURL } from "./base";
import { e2eeService } from "./e2ee";
import { isCapacitorRuntime } from "./runtime";

type ReplyPollerPlugin = {
  configure(options: {
    apiBaseUrl: string;
    token?: string;
    e2eeRequired?: boolean;
    e2eeNodeId?: string;
    e2eeClientId?: string;
    e2eeTransportKey?: string;
  }): Promise<void>;
};

type NativeReplyPollerBridge = {
  configure?: (payload: string) => void;
};

const ReplyPoller = registerPlugin<ReplyPollerPlugin>("ReplyPoller");

export async function syncNativeReplyPollerE2EE(): Promise<void> {
  if (!isCapacitorRuntime()) {
    return;
  }
  const apiBaseUrl = nativeReplyPollerBaseURL();
  if (!/^https?:\/\//i.test(apiBaseUrl) || isLocalShellURL(apiBaseUrl)) {
    return;
  }
  const e2ee = e2eeService.nativeSession();
  const payload = {
    apiBaseUrl,
    e2eeRequired: e2ee.required,
    e2eeNodeId: e2ee.nodeId,
    e2eeClientId: e2ee.clientId,
    e2eeTransportKey: e2ee.transportKey,
  };
  const bridge = (window as Window & { MindFSReplyPoller?: NativeReplyPollerBridge }).MindFSReplyPoller;
  if (typeof bridge?.configure === "function") {
    bridge.configure(JSON.stringify(payload));
    return;
  }
  await ReplyPoller.configure(payload);
}

function nativeReplyPollerBaseURL(): string {
  const direct = appURL("/");
  if (/^https?:\/\//i.test(direct)) {
    return direct.replace(/\/+$/, "");
  }
  if (typeof window === "undefined") {
    return "";
  }
  try {
    const resolved = new URL(direct, window.location.href);
    if (/^https?:$/i.test(resolved.protocol)) {
      return resolved.href.replace(/\/+$/, "");
    }
  } catch {
    // Fall through to origin-only fallback.
  }
  const origin = window.location.origin || "";
  if (/^https?:\/\//i.test(origin)) {
    return origin.replace(/\/+$/, "");
  }
  return "";
}

function isLocalShellURL(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

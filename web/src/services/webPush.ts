import { appPath } from "./base";
import { protectedJSON } from "./api";
import { isNativeShellRuntime } from "./runtime";

export type WebPushStatus = {
  supported: boolean;
  enabled: boolean;
  subscribed: boolean;
  permission: NotificationPermission | "unsupported";
  reason?: string;
  endpoint?: string;
  endpoint_hint?: string;
  platform?: string;
  subscription_count?: number;
};

type ServerStatus = {
  enabled?: boolean;
  vapid_public_key?: string;
  subscription_count?: number;
  platform_counts?: Record<string, number>;
};

type PushSubscriptionJSON = {
  endpoint?: string;
  keys?: {
    auth?: string;
    p256dh?: string;
  };
};

const serviceWorkerReadyTimeoutMs = 8000;
const pushSubscribeTimeoutMs = 15000;

function hasNotificationAPI(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia?.("(display-mode: standalone)")?.matches === true;
}

function isIOSLike(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  return /iPad|iPhone|iPod/.test(ua) || (platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function currentPlatform(): string {
  if (isIOSLike()) {
    return "ios-pwa";
  }
  if (isStandaloneDisplay()) {
    return "desktop-pwa";
  }
  return "web";
}

function endpointHint(endpoint: string): string {
  const value = String(endpoint || "").trim();
  if (!value) {
    return "";
  }
  try {
    const url = new URL(value);
    const tail = url.pathname.split("/").filter(Boolean).pop() || "";
    return tail ? `${url.hostname}/${tail.slice(-8)}` : url.hostname;
  } catch {
    return value.length > 12 ? value.slice(-12) : value;
  }
}

function capabilityReason(): string {
  if (isNativeShellRuntime()) {
    return "native_shell";
  }
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return "not_browser";
  }
  if (!window.isSecureContext) {
    return "insecure_context";
  }
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !hasNotificationAPI()) {
    return "unsupported";
  }
  if (isIOSLike() && !isStandaloneDisplay()) {
    return "ios_requires_home_screen";
  }
  return "";
}

function urlBase64ToArrayBuffer(value: string): ArrayBuffer {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i += 1) {
    out[i] = raw.charCodeAt(i);
  }
  return buffer;
}

function arrayBufferEqual(left: ArrayBuffer | null | undefined, right: ArrayBuffer): boolean {
  if (!left || left.byteLength !== right.byteLength) {
    return false;
  }
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  for (let i = 0; i < leftBytes.length; i += 1) {
    if (leftBytes[i] !== rightBytes[i]) {
      return false;
    }
  }
  return true;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutID = 0;
  const timeout = new Promise<never>((_, reject) => {
    timeoutID = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    window.clearTimeout(timeoutID);
  }
}

async function saveSubscription(subscription: PushSubscription, platform: string): Promise<void> {
  const json = subscription.toJSON() as PushSubscriptionJSON;
  await protectedJSON(appPath("/api/web-push/subscriptions"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      endpoint: json.endpoint || subscription.endpoint,
      keys: json.keys,
      platform,
    }),
  });
}

async function fetchServerStatus(): Promise<ServerStatus> {
  return protectedJSON<ServerStatus>(appPath("/api/web-push/status"));
}

function serviceWorkerURL(): URL {
  return new URL("service-worker.js", window.location.href);
}

async function ensureServiceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  if (!("serviceWorker" in navigator)) {
    throw new Error("当前浏览器不支持 Service Worker");
  }
  const existing = await navigator.serviceWorker.getRegistration("./").catch(() => undefined);
  if (existing) {
    void existing.update().catch(() => undefined);
  } else {
    await navigator.serviceWorker.register(serviceWorkerURL(), { scope: "./" });
  }

  let timeoutID = 0;
  const timeout = new Promise<never>((_, reject) => {
    timeoutID = window.setTimeout(() => {
      reject(new Error("通知服务启动超时，请刷新页面后重试；如果仍失败，请检查浏览器是否允许 Service Worker。"));
    }, serviceWorkerReadyTimeoutMs);
  });
  try {
    return await Promise.race([navigator.serviceWorker.ready, timeout]);
  } finally {
    window.clearTimeout(timeoutID);
  }
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await ensureServiceWorkerRegistration();
  return registration.pushManager.getSubscription();
}

export async function getWebPushStatus(): Promise<WebPushStatus> {
  const reason = capabilityReason();
  const permission = hasNotificationAPI() ? Notification.permission : "unsupported";
  if (reason) {
    return { supported: false, enabled: false, subscribed: false, permission, reason };
  }
  if (permission === "denied") {
    return { supported: true, enabled: false, subscribed: false, permission, reason: "permission_denied" };
  }
  const [server, subscription] = await Promise.all([
    fetchServerStatus().catch(() => ({} as ServerStatus)),
    currentSubscription().catch(() => null),
  ]);
  return {
    supported: true,
    enabled: Boolean(server.enabled && server.vapid_public_key),
    subscribed: Boolean(subscription),
    permission,
    reason: server.enabled ? "" : "server_disabled",
    endpoint: subscription?.endpoint || "",
    endpoint_hint: endpointHint(subscription?.endpoint || ""),
    platform: currentPlatform(),
    subscription_count: Number(server.subscription_count || 0),
  };
}

export async function subscribeWebPush(): Promise<WebPushStatus> {
  const reason = capabilityReason();
  if (reason) {
    return getWebPushStatus();
  }
  const server = await fetchServerStatus();
  if (!server.enabled || !server.vapid_public_key) {
    return getWebPushStatus();
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return getWebPushStatus();
  }
  const registration = await ensureServiceWorkerRegistration();
  const applicationServerKey = urlBase64ToArrayBuffer(server.vapid_public_key);
  const existing = await registration.pushManager.getSubscription();
  if (existing && !arrayBufferEqual(existing.options?.applicationServerKey, applicationServerKey)) {
    await existing.unsubscribe().catch(() => false);
  }
  const subscription =
    existing && arrayBufferEqual(existing.options?.applicationServerKey, applicationServerKey)
      ? existing
      : await withTimeout(registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        }),
        pushSubscribeTimeoutMs,
        "Chrome 通知订阅超时，请检查浏览器推送服务、网络代理/VPN，或清除站点数据后重试。",
      ).catch((error) => {
        const message = error instanceof Error ? error.message : String(error || "");
        if (/denied|notallowed|permission/i.test(message)) {
          throw new Error(isIOSLike()
            ? "iOS 已拒绝此主屏幕 App 的通知权限，请在系统设置的通知里允许 MindFS；如果找不到该项，请删除主屏幕图标后重新添加。"
            : "浏览器或系统已拒绝通知权限，请在浏览器/系统通知设置里允许 MindFS。");
        }
        throw error;
      });
  await saveSubscription(subscription, currentPlatform());
  return getWebPushStatus();
}

export async function unsubscribeWebPush(): Promise<WebPushStatus> {
  const subscription = await currentSubscription().catch(() => null);
  const endpoint = subscription?.endpoint || "";
  if (subscription) {
    await subscription.unsubscribe().catch(() => false);
  }
  if (endpoint) {
    await protectedJSON(appPath("/api/web-push/subscriptions"), {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    }).catch(() => null);
  }
  return getWebPushStatus();
}

export async function sendWebPushTest(): Promise<void> {
  const subscription = await currentSubscription();
  const endpoint = subscription?.endpoint || "";
  if (!endpoint) {
    throw new Error("当前设备还没有 PWA 通知订阅，请先开启通知");
  }
  await protectedJSON(appPath("/api/web-push/test"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
}

export function webPushReasonLabel(reason?: string): string {
  switch (reason) {
    case "ios_requires_home_screen":
      return "请先添加到主屏幕后再开启通知";
    case "insecure_context":
      return "需要 HTTPS 或 localhost";
    case "server_disabled":
      return "服务端未配置 Web Push";
    case "permission_denied":
      return "通知权限已被拒绝，请到浏览器/系统设置中允许";
    case "native_shell":
      return "原生壳使用系统通知";
    case "unsupported":
      return "当前浏览器不支持 Web Push";
    default:
      return "";
  }
}

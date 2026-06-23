import { registerPlugin } from "@capacitor/core";
import { getNativeBridge } from "./nativeBridge";
import { isNativeShellRuntime } from "./runtime";

type NativeCacheControlPlugin = {
  markClearWebViewCacheOnNextLaunch: () => Promise<{ scheduled: boolean }>;
  clearPendingWebViewCacheClear: () => Promise<{ scheduled: boolean }>;
};

const NativeCacheControl = registerPlugin<NativeCacheControlPlugin>(
  "NativeCacheControl",
);

export async function scheduleWebViewCacheClearOnNextLaunch(): Promise<void> {
  if (!isNativeShellRuntime()) {
    return;
  }
  try {
    const native = getNativeBridge();
    if (typeof native?.markClearWebViewCacheOnNextLaunch === "function") {
      await native.markClearWebViewCacheOnNextLaunch();
      return;
    }
    await NativeCacheControl.markClearWebViewCacheOnNextLaunch();
  } catch (error) {
    console.warn("[native-cache-control] schedule failed", error);
  }
}

export async function cancelScheduledWebViewCacheClear(): Promise<void> {
  if (!isNativeShellRuntime()) {
    return;
  }
  try {
    const native = getNativeBridge();
    if (typeof native?.clearPendingWebViewCacheClear === "function") {
      await native.clearPendingWebViewCacheClear();
      return;
    }
    await NativeCacheControl.clearPendingWebViewCacheClear();
  } catch (error) {
    console.warn("[native-cache-control] cancel failed", error);
  }
}

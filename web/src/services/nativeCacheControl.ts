import { registerPlugin } from "@capacitor/core";
import { isCapacitorRuntime } from "./runtime";

type NativeCacheControlPlugin = {
  markClearWebViewCacheOnNextLaunch: () => Promise<{ scheduled: boolean }>;
  clearPendingWebViewCacheClear: () => Promise<{ scheduled: boolean }>;
};

const NativeCacheControl = registerPlugin<NativeCacheControlPlugin>(
  "NativeCacheControl",
);

export async function scheduleWebViewCacheClearOnNextLaunch(): Promise<void> {
  if (!isCapacitorRuntime()) {
    return;
  }
  try {
    await NativeCacheControl.markClearWebViewCacheOnNextLaunch();
  } catch (error) {
    console.warn("[native-cache-control] schedule failed", error);
  }
}

export async function cancelScheduledWebViewCacheClear(): Promise<void> {
  if (!isCapacitorRuntime()) {
    return;
  }
  try {
    await NativeCacheControl.clearPendingWebViewCacheClear();
  } catch (error) {
    console.warn("[native-cache-control] cancel failed", error);
  }
}

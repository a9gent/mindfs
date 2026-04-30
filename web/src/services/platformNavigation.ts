import { isCapacitorRuntime } from "./runtime";

type ExternalBrowserBridge = {
  open?: (url: string) => string | void;
};

export function openExternalURL(url: string): void {
  if (typeof window === "undefined") {
    return;
  }
  if (isCapacitorRuntime()) {
    const bridge = (window as Window & {
      MindFSExternalBrowser?: ExternalBrowserBridge;
    }).MindFSExternalBrowser;
    if (typeof bridge?.open === "function") {
      const error = bridge.open(url);
      if (!error) {
        return;
      }
      console.warn("[platform-navigation] native external browser failed", error);
    }
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export function replaceLocation(url: string): void {
  if (typeof window === "undefined") {
    return;
  }
  window.location.replace(url);
}

import { Browser } from "@capacitor/browser";
import { isCapacitorRuntime } from "./runtime";

export function openExternalURL(url: string): void {
  if (typeof window === "undefined") {
    return;
  }
  if (isCapacitorRuntime()) {
    void Browser.open({ url });
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

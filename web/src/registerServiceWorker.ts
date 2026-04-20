import { shouldRegisterServiceWorker } from "./services/runtime";

export function registerServiceWorker(): void {
  if (typeof window === "undefined") {
    return;
  }
  if (!("serviceWorker" in navigator)) {
    return;
  }
  if (import.meta.env.DEV || !shouldRegisterServiceWorker()) {
    return;
  }

  const serviceWorkerURL = new URL("service-worker.js", window.location.href);

  window.addEventListener("load", () => {
    navigator.serviceWorker.register(serviceWorkerURL, { scope: "./" }).catch((error: unknown) => {
      console.error("service worker registration failed", error);
    });
  });
}

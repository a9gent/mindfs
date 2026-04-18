function deriveServiceWorkerBuildToken(): string {
  if (typeof document === "undefined") {
    return "";
  }
  const entryScript = document.querySelector<HTMLScriptElement>(
    'script[type="module"][src]',
  );
  const src = String(entryScript?.src || "");
  if (!src) {
    return "";
  }
  try {
    const url = new URL(src, window.location.href);
    return url.pathname || src;
  } catch {
    return src;
  }
}

export function registerServiceWorker(): void {
  if (typeof window === "undefined") {
    return;
  }
  if (!("serviceWorker" in navigator)) {
    return;
  }
  if (import.meta.env.DEV) {
    return;
  }

  const serviceWorkerURL = new URL("service-worker.js", window.location.href);
  const buildToken = deriveServiceWorkerBuildToken();
  if (buildToken) {
    serviceWorkerURL.searchParams.set("v", buildToken);
  }

  window.addEventListener("load", () => {
    navigator.serviceWorker.register(serviceWorkerURL, { scope: "./" }).catch((error: unknown) => {
      console.error("service worker registration failed", error);
    });
  });
}

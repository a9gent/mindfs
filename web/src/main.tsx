import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { registerServiceWorker } from "./registerServiceWorker";
import { isCapacitorRuntime } from "./services/runtime";
import { Login } from "./components/Login";

function isLocalCapacitorShell(): boolean {
  if (!isCapacitorRuntime() || typeof window === "undefined") {
    return false;
  }
  const hostname = window.location.hostname.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function normalizeSystemBarColor(input: string, fallback: string): string {
  const value = input.trim();
  if (!value) {
    return fallback;
  }
  if (/^#[0-9a-f]{6}$/i.test(value)) {
    return value.toLowerCase();
  }
  const rgbMatch = value.match(/^rgba?\(([^)]+)\)$/i);
  if (!rgbMatch) {
    return fallback;
  }
  const parts = rgbMatch[1]
    .split(",")
    .slice(0, 3)
    .map((part) => Number.parseInt(part.trim(), 10));
  if (parts.length !== 3 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return fallback;
  }
  return `#${parts.map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}

function parseColorToHex(input: string): string | null {
  const value = input.trim();
  if (!value || value === "transparent") {
    return null;
  }
  if (/^#[0-9a-f]{6}$/i.test(value)) {
    return value.toLowerCase();
  }
  const rgbMatch = value.match(/^rgba?\(([^)]+)\)$/i);
  if (!rgbMatch) {
    return null;
  }
  const parts = rgbMatch[1]
    .split(",")
    .slice(0, 4)
    .map((part) => Number.parseFloat(part.trim()));
  if (parts.length < 3 || parts.slice(0, 3).some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return null;
  }
  const alpha = parts[3] ?? 1;
  if (alpha <= 0.01) {
    return null;
  }
  return `#${parts.slice(0, 3).map((part) => Math.round(part).toString(16).padStart(2, "0")).join("")}`;
}

function isDarkColor(hexColor: string): boolean {
  const hex = hexColor.replace("#", "");
  const r = Number.parseInt(hex.slice(0, 2), 16) / 255;
  const g = Number.parseInt(hex.slice(2, 4), 16) / 255;
  const b = Number.parseInt(hex.slice(4, 6), 16) / 255;
  const [lr, lg, lb] = [r, g, b].map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  );
  const luminance = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  return luminance < 0.5;
}

function resolveTopVisibleColor(): string | null {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return null;
  }
  const safeTopRaw = getComputedStyle(document.documentElement)
    .getPropertyValue("--mindfs-safe-area-top")
    .trim();
  const safeTop = Number.parseFloat(safeTopRaw) || 0;
  const sampleX = Math.max(1, Math.min(window.innerWidth - 1, window.innerWidth / 2));
  const sampleY = Math.max(1, Math.min(window.innerHeight - 1, safeTop + 8));
  let element = document.elementFromPoint(sampleX, sampleY) as HTMLElement | null;
  while (element) {
    const styles = window.getComputedStyle(element);
    const backgroundColor = parseColorToHex(styles.backgroundColor);
    if (backgroundColor) {
      return backgroundColor;
    }
    element = element.parentElement;
  }
  return null;
}

function isTextEditableTarget(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    target.isContentEditable
  );
}

function syncViewportHeight(): void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return;
  }

  const viewportHeight = isCapacitorRuntime()
    ? window.innerHeight
    : window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty("--mindfs-viewport-height", `${viewportHeight}px`);
}

function AppRoot() {
  const [ready] = useState(() => !isLocalCapacitorShell());

  const goToLauncher = () => {
    if (typeof window === "undefined") {
      return;
    }
    window.location.assign("http://localhost");
  };

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    syncViewportHeight();
    window.addEventListener("resize", syncViewportHeight);
    window.addEventListener("orientationchange", syncViewportHeight);
    window.visualViewport?.addEventListener("resize", syncViewportHeight);
    window.visualViewport?.addEventListener("scroll", syncViewportHeight);

    if (!isCapacitorRuntime()) {
      return () => {
        window.removeEventListener("resize", syncViewportHeight);
        window.removeEventListener("orientationchange", syncViewportHeight);
        window.visualViewport?.removeEventListener("resize", syncViewportHeight);
        window.visualViewport?.removeEventListener("scroll", syncViewportHeight);
      };
    }

    const nativeCapacitor = (window as Window & {
      Capacitor?: { isPluginAvailable?: (name: string) => boolean };
    }).Capacitor;
    const hasPlugin = (name: string) =>
      typeof nativeCapacitor?.isPluginAvailable === "function"
        ? nativeCapacitor.isPluginAvailable(name)
        : false;

    let cleanupThemeSync: (() => void) | undefined;

    if (hasPlugin("StatusBar")) {
      void import("@capacitor/status-bar")
        .then(async ({ StatusBar, Style }) => {
          try {
            await StatusBar.setOverlaysWebView({ overlay: true });
            let syncQueued = false;
            const syncStatusBar = async () => {
              const fallback = window.matchMedia("(prefers-color-scheme: dark)").matches
                ? "#020617"
                : "#ffffff";
              const rootStyles = getComputedStyle(document.documentElement);
              const color = resolveTopVisibleColor()
                || normalizeSystemBarColor(rootStyles.getPropertyValue("--mindfs-system-bar-bg"), fallback);
              await StatusBar.setStyle({
                style: isDarkColor(color) ? Style.Dark : Style.Light,
              });
              await StatusBar.setBackgroundColor({
                color,
              });
            };
            const queueStatusBarSync = () => {
              if (syncQueued) {
                return;
              }
              syncQueued = true;
              window.requestAnimationFrame(() => {
                syncQueued = false;
                void syncStatusBar();
              });
            };
            await syncStatusBar();

            const media = window.matchMedia("(prefers-color-scheme: dark)");
            const handleChange = () => {
              queueStatusBarSync();
            };
            const observer = new MutationObserver(() => {
              queueStatusBarSync();
            });
            observer.observe(document.documentElement, {
              attributes: true,
              attributeFilter: ["class", "style", "data-theme"],
            });
            observer.observe(document.body, {
              attributes: true,
              childList: true,
              subtree: true,
              attributeFilter: ["class", "style", "data-theme"],
            });
            window.addEventListener("pageshow", handleChange);
            window.addEventListener("focus", handleChange);
            window.addEventListener("resize", handleChange);
            window.visualViewport?.addEventListener("resize", handleChange);
            window.visualViewport?.addEventListener("scroll", handleChange);
            window.addEventListener("scroll", handleChange, { passive: true });
            document.addEventListener("visibilitychange", handleChange);
            window.addEventListener("mindfs:safe-area-updated", handleChange as EventListener);
            window.addEventListener("mindfs:native-theme-changed", handleChange as EventListener);
            if (typeof media.addEventListener === "function") {
              media.addEventListener("change", handleChange);
              cleanupThemeSync = () => {
                media.removeEventListener("change", handleChange);
                window.removeEventListener("pageshow", handleChange);
                window.removeEventListener("focus", handleChange);
                window.removeEventListener("resize", handleChange);
                window.visualViewport?.removeEventListener("resize", handleChange);
                window.visualViewport?.removeEventListener("scroll", handleChange);
                window.removeEventListener("scroll", handleChange);
                document.removeEventListener("visibilitychange", handleChange);
                window.removeEventListener("mindfs:safe-area-updated", handleChange as EventListener);
                window.removeEventListener("mindfs:native-theme-changed", handleChange as EventListener);
                observer.disconnect();
              };
            } else {
              media.addListener(handleChange);
              cleanupThemeSync = () => {
                media.removeListener(handleChange);
                window.removeEventListener("pageshow", handleChange);
                window.removeEventListener("focus", handleChange);
                window.removeEventListener("resize", handleChange);
                window.visualViewport?.removeEventListener("resize", handleChange);
                window.visualViewport?.removeEventListener("scroll", handleChange);
                window.removeEventListener("scroll", handleChange);
                document.removeEventListener("visibilitychange", handleChange);
                window.removeEventListener("mindfs:safe-area-updated", handleChange as EventListener);
                window.removeEventListener("mindfs:native-theme-changed", handleChange as EventListener);
                observer.disconnect();
              };
            }
          } catch (error) {
            console.warn("[capacitor-status-bar] overlay unavailable", error);
          }
        })
        .catch((error) => {
          console.warn("[capacitor-status-bar] failed to load plugin", error);
        });
    }

    const scrollFocusedIntoView = () => {
      const target = document.activeElement;
      if (!isTextEditableTarget(target)) {
        return;
      }
      window.setTimeout(() => {
        try {
          target.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
        } catch {
          target.scrollIntoView();
        }
      }, 180);
    };

    const onFocusIn = (event: FocusEvent) => {
      if (isTextEditableTarget(event.target)) {
        scrollFocusedIntoView();
      }
    };
    document.addEventListener("focusin", onFocusIn);
    const onViewportResize = () => {
      scrollFocusedIntoView();
    };
    window.visualViewport?.addEventListener("resize", onViewportResize);

    const onBackRequest = () => {
      const event = new CustomEvent("mindfs:android-back-request");
      window.dispatchEvent(event);
    };

    let removeListener: (() => void) | undefined;
    if (hasPlugin("App")) {
      void import("@capacitor/app")
        .then(async ({ App: CapApp }) => {
          try {
            const handle = await CapApp.addListener("backButton", () => {
              onBackRequest();
            });
            removeListener = () => {
              void handle.remove();
            };
          } catch (error) {
            console.warn("[capacitor-app] backButton listener unavailable", error);
          }
        })
        .catch((error) => {
          console.warn("[capacitor-app] failed to load plugin", error);
        });
    }

    return () => {
      window.removeEventListener("resize", syncViewportHeight);
      window.removeEventListener("orientationchange", syncViewportHeight);
      window.visualViewport?.removeEventListener("resize", syncViewportHeight);
      window.visualViewport?.removeEventListener("scroll", syncViewportHeight);
      cleanupThemeSync?.();
      document.removeEventListener("focusin", onFocusIn);
      window.visualViewport?.removeEventListener("resize", onViewportResize);
      removeListener?.();
    };
  }, []);

  if (!ready) {
    return <Login onOpenNode={(nodeURL) => window.location.assign(nodeURL)} />;
  }
  return <App onGoHome={goToLauncher} />;
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<AppRoot />);
}

registerServiceWorker();


if (typeof window !== "undefined") {
  window.addEventListener("error", (event) => {
    console.error("[global-error]", {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: event.error instanceof Error ? {
        name: event.error.name,
        message: event.error.message,
        stack: event.error.stack,
      } : event.error,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    console.error("[unhandled-rejection]", reason instanceof Error ? {
      name: reason.name,
      message: reason.message,
      stack: reason.stack,
    } : reason);
  });
}

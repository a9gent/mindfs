import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { registerServiceWorker } from "./registerServiceWorker";
import { isCapacitorRuntime } from "./services/runtime";
import { Login } from "./components/Login";

function readableAssetPath(raw: string): string {
  const value = String(raw || "").trim();
  if (!value) {
    return "unknown resource";
  }
  try {
    const url = new URL(value, window.location.href);
    return `${url.pathname}${url.search}`;
  } catch {
    return value;
  }
}

function mindFSAssetPath(raw: string): string {
  const value = String(raw || "").trim();
  if (!value) {
    return "";
  }
  try {
    const url = new URL(value, window.location.href);
    if (url.origin !== window.location.origin) {
      return "";
    }
    const pathname = url.pathname;
    const knownAsset =
      pathname.startsWith("/assets/") ||
      pathname.startsWith("/mindfs-assets/") ||
      pathname === "/favicon.svg" ||
      pathname === "/manifest.webmanifest" ||
      pathname === "/apple-touch-icon.png" ||
      pathname === "/service-worker.js" ||
      /^\/pwa(?:-|_).*\.(?:png|svg)$/i.test(pathname);
    if (!knownAsset) {
      return "";
    }
    return `${pathname}${url.search}`;
  } catch {
    return "";
  }
}

function showFrontendAssetMissingNotice(rawPath: string): void {
  if (typeof document === "undefined") {
    return;
  }
  const path = readableAssetPath(rawPath);
  const id = "mindfs-asset-missing-notice";
  const existing = document.getElementById(id);
  if (existing) {
    const message = existing.querySelector("[data-message]");
    if (message) {
      message.textContent = `前端资源缺失或无法加载：${path}`;
    }
    return;
  }

  const notice = document.createElement("div");
  notice.id = id;
  notice.setAttribute("role", "alert");
  notice.style.position = "fixed";
  notice.style.left = "12px";
  notice.style.right = "12px";
  notice.style.top = "12px";
  notice.style.zIndex = "2147483647";
  notice.style.display = "flex";
  notice.style.alignItems = "center";
  notice.style.justifyContent = "space-between";
  notice.style.gap = "12px";
  notice.style.padding = "10px 12px";
  notice.style.border = "1px solid rgba(185, 28, 28, 0.35)";
  notice.style.borderRadius = "8px";
  notice.style.background = "#fff5f5";
  notice.style.color = "#7f1d1d";
  notice.style.boxShadow = "0 10px 30px rgba(15, 23, 42, 0.18)";
  notice.style.fontFamily = "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  notice.style.fontSize = "13px";
  notice.style.lineHeight = "1.4";

  const message = document.createElement("div");
  message.dataset.message = "1";
  message.style.minWidth = "0";
  message.style.overflowWrap = "anywhere";
  message.textContent = `前端资源缺失或无法加载：${path}`;

  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = "刷新";
  reload.style.border = "1px solid rgba(127, 29, 29, 0.3)";
  reload.style.borderRadius = "6px";
  reload.style.background = "#ffffff";
  reload.style.color = "#7f1d1d";
  reload.style.padding = "5px 9px";
  reload.style.cursor = "pointer";
  reload.style.flex = "0 0 auto";
  reload.onclick = () => window.location.reload();

  notice.append(message, reload);
  document.body.appendChild(notice);
}

function resourceURLFromEventTarget(target: EventTarget | null): string {
  if (!(target instanceof HTMLElement)) {
    return "";
  }
  const value =
    target.getAttribute("src") ||
    target.getAttribute("href") ||
    target.getAttribute("poster") ||
    "";
  return mindFSAssetPath(value);
}

function dynamicImportFailureURL(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason || "");
  if (!/dynamically imported module|module script|loading chunk|import/i.test(message)) {
    return "";
  }
  const match = message.match(/https?:\/\/[^\s"'<>]+|\/[^\s"'<>]+\.js(?:\?[^\s"'<>]+)?/);
  if (!match?.[0]) {
    return "dynamic module";
  }
  return mindFSAssetPath(match[0]);
}

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

function isIOSWebKit(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  const userAgent = navigator.userAgent || "";
  return /iP(hone|ad|od)/.test(userAgent) || (
    navigator.platform === "MacIntel" &&
    Number((navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints || 0) > 1
  );
}

let largestCapacitorViewportHeight = 0;

function readRootPixelVar(name: string): number {
  if (typeof document === "undefined") {
    return 0;
  }
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function syncViewportHeight(): void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return;
  }

  const visualViewport = window.visualViewport;
  const isNativeShell = isCapacitorRuntime();
  const rawViewportHeight = isNativeShell || !visualViewport
    ? window.innerHeight
    : visualViewport.height;
  let viewportHeight = rawViewportHeight;
  if (isNativeShell) {
    const imeBottom = readRootPixelVar("--mindfs-ime-bottom");
    if (imeBottom > 0) {
      largestCapacitorViewportHeight ||= rawViewportHeight;
    } else {
      largestCapacitorViewportHeight = rawViewportHeight;
    }
    const resizedBy = Math.max(0, largestCapacitorViewportHeight - rawViewportHeight);
    const remainingImeOverlay = Math.max(0, imeBottom - resizedBy);
    viewportHeight = Math.max(320, rawViewportHeight - remainingImeOverlay);
  }
  const viewportOffsetTop = isNativeShell || !visualViewport
    ? 0
    : Math.max(0, visualViewport.offsetTop || 0);
  document.documentElement.style.setProperty("--mindfs-viewport-height", `${viewportHeight}px`);
  document.documentElement.style.setProperty("--mindfs-viewport-offset-top", `${viewportOffsetTop}px`);
}

function syncViewportHeightAfterKeyboardChange(): void {
  syncViewportHeight();
  window.scrollTo(0, 0);
  window.requestAnimationFrame(syncViewportHeight);
  window.requestAnimationFrame(() => window.scrollTo(0, 0));
  window.setTimeout(syncViewportHeight, 120);
  window.setTimeout(() => window.scrollTo(0, 0), 120);
  window.setTimeout(syncViewportHeight, 320);
  window.setTimeout(() => window.scrollTo(0, 0), 320);
}

function canScrollTouchTarget(target: EventTarget | null, deltaY: number): boolean {
  if (!(target instanceof Element) || deltaY === 0) {
    return false;
  }

  let element: Element | null = target;
  while (element && element !== document.documentElement && element !== document.body) {
    const styles = window.getComputedStyle(element);
    const overflowY = styles.overflowY;
    const canScroll = (overflowY === "auto" || overflowY === "scroll") &&
      element.scrollHeight > element.clientHeight + 1;
    if (canScroll) {
      const scrollTop = element.scrollTop;
      const maxScrollTop = element.scrollHeight - element.clientHeight;
      if (deltaY > 0 && scrollTop > 0) {
        return true;
      }
      if (deltaY < 0 && scrollTop < maxScrollTop - 1) {
        return true;
      }
    }
    element = element.parentElement;
  }
  return false;
}

function installIOSKeyboardPanLock(): () => void {
  if (!isIOSWebKit()) {
    return () => {};
  }

  let lastTouchY = 0;
  const onTouchStart = (event: TouchEvent) => {
    lastTouchY = event.touches[0]?.clientY || 0;
  };
  const onTouchMove = (event: TouchEvent) => {
    const activeElement = document.activeElement;
    if (!isTextEditableTarget(activeElement) || event.touches.length !== 1) {
      return;
    }

    const nextTouchY = event.touches[0]?.clientY || lastTouchY;
    const deltaY = nextTouchY - lastTouchY;
    lastTouchY = nextTouchY;
    if (canScrollTouchTarget(event.target, deltaY)) {
      return;
    }
    event.preventDefault();
    window.scrollTo(0, 0);
  };

  document.addEventListener("touchstart", onTouchStart, { passive: true });
  document.addEventListener("touchmove", onTouchMove, { passive: false });
  return () => {
    document.removeEventListener("touchstart", onTouchStart);
    document.removeEventListener("touchmove", onTouchMove);
  };
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
    window.addEventListener("focusin", syncViewportHeightAfterKeyboardChange);
    window.addEventListener("focusout", syncViewportHeightAfterKeyboardChange);
    window.addEventListener("mindfs:safe-area-updated", syncViewportHeight as EventListener);
    window.visualViewport?.addEventListener("resize", syncViewportHeight);
    window.visualViewport?.addEventListener("scroll", syncViewportHeight);
    const uninstallIOSKeyboardPanLock = installIOSKeyboardPanLock();

    if (!isCapacitorRuntime()) {
      return () => {
        window.removeEventListener("resize", syncViewportHeight);
        window.removeEventListener("orientationchange", syncViewportHeight);
        window.removeEventListener("focusin", syncViewportHeightAfterKeyboardChange);
        window.removeEventListener("focusout", syncViewportHeightAfterKeyboardChange);
        window.removeEventListener("mindfs:safe-area-updated", syncViewportHeight as EventListener);
        window.visualViewport?.removeEventListener("resize", syncViewportHeight);
        window.visualViewport?.removeEventListener("scroll", syncViewportHeight);
        uninstallIOSKeyboardPanLock();
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
      if (isIOSWebKit()) {
        syncViewportHeightAfterKeyboardChange();
        return;
      }
      const target = document.activeElement;
      if (!isTextEditableTarget(target)) {
        return;
      }
      window.setTimeout(() => {
        try {
          target.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
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
      window.removeEventListener("focusin", syncViewportHeightAfterKeyboardChange);
      window.removeEventListener("focusout", syncViewportHeightAfterKeyboardChange);
      window.removeEventListener("mindfs:safe-area-updated", syncViewportHeight as EventListener);
      window.visualViewport?.removeEventListener("resize", syncViewportHeight);
      window.visualViewport?.removeEventListener("scroll", syncViewportHeight);
      cleanupThemeSync?.();
      document.removeEventListener("focusin", onFocusIn);
      window.visualViewport?.removeEventListener("resize", onViewportResize);
      uninstallIOSKeyboardPanLock();
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
    const resourceURL = resourceURLFromEventTarget(event.target);
    if (resourceURL) {
      showFrontendAssetMissingNotice(resourceURL);
    }
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
  }, true);

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const resourceURL = dynamicImportFailureURL(reason);
    if (resourceURL) {
      showFrontendAssetMissingNotice(resourceURL);
    }
    console.error("[unhandled-rejection]", reason instanceof Error ? {
      name: reason.name,
      message: reason.message,
      stack: reason.stack,
    } : reason);
  });
}

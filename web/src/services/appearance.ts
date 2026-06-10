export type AppearanceMode = "dark" | "light" | "system";

export const APPEARANCE_STORAGE_KEY = "mindfs-appearance-mode";
export const APPEARANCE_CHANGE_EVENT = "mindfs:appearance-changed";

const appearanceModes = new Set<AppearanceMode>(["dark", "light", "system"]);
const themeColors: Record<"dark" | "light", string> = {
  dark: "#0f172a",
  light: "#f3f4f6",
};

export function normalizeAppearanceMode(value: unknown): AppearanceMode {
  return appearanceModes.has(value as AppearanceMode) ? (value as AppearanceMode) : "system";
}

export function getAppearanceMode(): AppearanceMode {
  if (typeof window === "undefined") {
    return "system";
  }
  try {
    return normalizeAppearanceMode(window.localStorage.getItem(APPEARANCE_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function getEffectiveAppearanceMode(mode: AppearanceMode = getAppearanceMode()): "dark" | "light" {
  if (mode === "dark" || mode === "light") {
    return mode;
  }
  if (typeof window === "undefined") {
    return "light";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function syncThemeColor(mode: AppearanceMode = getAppearanceMode()): void {
  if (typeof document === "undefined") {
    return;
  }
  const color = themeColors[getEffectiveAppearanceMode(mode)];
  const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  metas.forEach((meta) => {
    meta.content = color;
    meta.removeAttribute("media");
  });
}

export function applyAppearanceMode(mode: AppearanceMode = getAppearanceMode()): void {
  if (typeof document === "undefined") {
    return;
  }
  if (mode === "system") {
    document.documentElement.removeAttribute("data-theme");
    syncThemeColor(mode);
    return;
  }
  document.documentElement.setAttribute("data-theme", mode);
  syncThemeColor(mode);
}

export function setAppearanceMode(mode: AppearanceMode): void {
  if (typeof window === "undefined") {
    return;
  }
  const nextMode = normalizeAppearanceMode(mode);
  try {
    if (nextMode === "system") {
      window.localStorage.removeItem(APPEARANCE_STORAGE_KEY);
    } else {
      window.localStorage.setItem(APPEARANCE_STORAGE_KEY, nextMode);
    }
  } catch {
    // Keep the current page responsive even when storage is unavailable.
  }
  applyAppearanceMode(nextMode);
  window.dispatchEvent(new CustomEvent<AppearanceMode>(APPEARANCE_CHANGE_EVENT, { detail: nextMode }));
}

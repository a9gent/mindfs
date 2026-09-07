export type FontSizeRegion = "fileSidebar" | "main" | "sessionSidebar";

export type FontSizePreferences = Record<FontSizeRegion, number>;

export const DEFAULT_FONT_SIZE_PREFERENCES: FontSizePreferences = {
  fileSidebar: 1,
  main: 1,
  sessionSidebar: 1,
};

export const FONT_SIZE_MIN = 0.8;
export const FONT_SIZE_MAX = 1.4;
export const FONT_SIZE_STEP = 0.1;

const FONT_SIZE_STORAGE_KEY = "mindfs-font-size-preferences";

function normalizeScale(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1;
  }
  const stepped = Math.round(value / FONT_SIZE_STEP) * FONT_SIZE_STEP;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Number(stepped.toFixed(1))));
}

export function loadFontSizePreferences(): FontSizePreferences {
  if (typeof window === "undefined") {
    return DEFAULT_FONT_SIZE_PREFERENCES;
  }
  try {
    const saved = JSON.parse(window.localStorage.getItem(FONT_SIZE_STORAGE_KEY) || "{}") as Partial<FontSizePreferences>;
    return {
      fileSidebar: normalizeScale(saved.fileSidebar),
      main: normalizeScale(saved.main),
      sessionSidebar: normalizeScale(saved.sessionSidebar),
    };
  } catch {
    return DEFAULT_FONT_SIZE_PREFERENCES;
  }
}

export function persistFontSizePreferences(preferences: FontSizePreferences): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // The current session can still use the selected sizes when storage is unavailable.
  }
}

export function changeFontSize(
  preferences: FontSizePreferences,
  region: FontSizeRegion,
  direction: -1 | 1,
): FontSizePreferences {
  return {
    ...preferences,
    [region]: normalizeScale(preferences[region] + direction * FONT_SIZE_STEP),
  };
}

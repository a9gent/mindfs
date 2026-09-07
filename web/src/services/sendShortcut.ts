import { getStoredString, removeStoredString, setStoredString } from "./storage";

export type SendShortcut = {
  key: string;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
};

export const SEND_SHORTCUT_STORAGE_KEY = "mindfs-send-shortcut";

const MODIFIER_KEYS = new Set(["Alt", "AltGraph", "Control", "Meta", "Shift"]);

function normalizeKey(key: string): string {
  if (key === " ") return "Space";
  return key.length === 1 ? key.toLowerCase() : key;
}

export function shortcutFromKeyboardEvent(event: KeyboardEvent): SendShortcut | null {
  if (MODIFIER_KEYS.has(event.key) || event.key === "Dead" || event.key === "Process" || event.key === "Unidentified") {
    return null;
  }
  const shortcut = {
    key: normalizeKey(event.key),
    alt: event.altKey,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    shift: event.shiftKey,
  };
  return isValidSendShortcut(shortcut) ? shortcut : null;
}

export function isValidSendShortcut(value: unknown): value is SendShortcut {
  if (!value || typeof value !== "object") return false;
  const shortcut = value as Partial<SendShortcut>;
  return typeof shortcut.key === "string"
    && shortcut.key.length > 0
    && typeof shortcut.alt === "boolean"
    && typeof shortcut.ctrl === "boolean"
    && typeof shortcut.meta === "boolean"
    && typeof shortcut.shift === "boolean"
    && (shortcut.alt || shortcut.ctrl || shortcut.meta);
}

export function matchesSendShortcut(event: KeyboardEvent, shortcut: SendShortcut | null): boolean {
  return !!shortcut
    && normalizeKey(event.key) === shortcut.key
    && event.altKey === shortcut.alt
    && event.ctrlKey === shortcut.ctrl
    && event.metaKey === shortcut.meta
    && event.shiftKey === shortcut.shift;
}

function displayKey(key: string): string {
  const labels: Record<string, string> = {
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    Backspace: "Backspace",
    Delete: "Delete",
    Enter: "Enter",
    Escape: "Esc",
    Space: "Space",
    Tab: "Tab",
  };
  return labels[key] || (key.length === 1 ? key.toUpperCase() : key);
}

export function formatSendShortcut(shortcut: SendShortcut): string {
  const parts: string[] = [];
  if (shortcut.ctrl) parts.push("Ctrl");
  if (shortcut.alt) parts.push("Alt");
  if (shortcut.shift) parts.push("Shift");
  if (shortcut.meta) parts.push("⌘");
  parts.push(displayKey(shortcut.key));
  return parts.join("+");
}

export function loadSendShortcut(): SendShortcut | null {
  const raw = getStoredString(SEND_SHORTCUT_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isValidSendShortcut(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function persistSendShortcut(shortcut: SendShortcut | null): void {
  if (shortcut) {
    setStoredString(SEND_SHORTCUT_STORAGE_KEY, JSON.stringify(shortcut));
  } else {
    removeStoredString(SEND_SHORTCUT_STORAGE_KEY);
  }
}

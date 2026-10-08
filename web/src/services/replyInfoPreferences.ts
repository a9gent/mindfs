import { useSyncExternalStore } from "react";

export const DEFAULT_REPLY_INFO_PREFERENCES = {
  agent: true,
  model: true,
  tokens: true,
  time: true,
  context: true,
};
export type ReplyInfoPreferences = typeof DEFAULT_REPLY_INFO_PREFERENCES;
const storageKey = "mindfs-mobile-reply-info";
const changeEvent = "mindfs-mobile-reply-info-change";

function readStoredValue(): string | null {
  try {
    return window.localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

// Keep an in-memory snapshot as well, so blocked storage does not disable the controls.
let snapshot = DEFAULT_REPLY_INFO_PREFERENCES;
function loadPreferences() {
  try {
    const saved = JSON.parse(readStoredValue() || "{}");
    snapshot = Object.fromEntries(
      Object.entries(DEFAULT_REPLY_INFO_PREFERENCES).map(([key, value]) => [
        key, typeof saved?.[key] === "boolean" ? saved[key] : value,
      ]),
    ) as ReplyInfoPreferences;
  } catch {
    snapshot = DEFAULT_REPLY_INFO_PREFERENCES;
  }
}
loadPreferences();

function subscribe(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === storageKey || event.key === null) {
      loadPreferences();
      onChange();
    }
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(changeEvent, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(changeEvent, onChange);
  };
}

export function setReplyInfoPreference(key: keyof ReplyInfoPreferences, value: boolean) {
  snapshot = { ...snapshot, [key]: value };
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(snapshot));
  } catch {
    // Continue applying the preference for this app session.
  }
  window.dispatchEvent(new Event(changeEvent));
}

export function useReplyInfoPreferences() {
  return useSyncExternalStore(subscribe, () => snapshot, () => DEFAULT_REPLY_INFO_PREFERENCES);
}

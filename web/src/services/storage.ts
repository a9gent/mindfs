function canUseStorage(): boolean {
  return typeof window !== "undefined";
}

export function getStoredString(key: string): string | null {
  if (!canUseStorage()) {
    return null;
  }
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function setStoredString(key: string, value: string): void {
  if (!canUseStorage()) {
    return;
  }
  try {
    window.localStorage.setItem(key, value);
  } catch {}
}

export function removeStoredString(key: string): void {
  if (!canUseStorage()) {
    return;
  }
  try {
    window.localStorage.removeItem(key);
  } catch {}
}

const TOKEN_KEY = "mindfs_token";
const API_BASE_URL_KEY = "mindfs_api_base_url";
const WS_BASE_URL_KEY = "mindfs_ws_base_url";

export function getStoredToken(): string | null {
  return getStoredString(TOKEN_KEY);
}

export function setStoredToken(token: string): void {
  setStoredString(TOKEN_KEY, token);
}

export function clearStoredToken(): void {
  removeStoredString(TOKEN_KEY);
}

export function getStoredApiBaseURL(): string | null {
  return getStoredString(API_BASE_URL_KEY);
}

export function setStoredApiBaseURL(value: string): void {
  setStoredString(API_BASE_URL_KEY, value);
}

export function getStoredWsBaseURL(): string | null {
  return getStoredString(WS_BASE_URL_KEY);
}

export function setStoredWsBaseURL(value: string): void {
  setStoredString(WS_BASE_URL_KEY, value);
}

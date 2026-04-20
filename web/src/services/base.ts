import { getApiBaseURL, getWsBaseURL, isCapacitorRuntime } from "./runtime";

function relayPrefix(): string {
  if (typeof window === "undefined" || isCapacitorRuntime()) {
    return "";
  }
  const match = /^\/n\/[^/]+/.exec(window.location.pathname);
  return match ? match[0] : "";
}

export function isRelayNodePage(): boolean {
  if (typeof window === "undefined" || isCapacitorRuntime()) {
    return false;
  }
  return /^\/n\/[^/]+/.test(window.location.pathname);
}

function ensureLeadingSlash(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function joinURL(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/, "")}${ensureLeadingSlash(path)}`;
}

export function appPath(path: string): string {
  const pathname = `${relayPrefix()}${ensureLeadingSlash(path)}`;
  // In Capacitor runtime, relative paths won't resolve to the MindFS backend.
  // Return a full URL so fetch(appPath(...)) works the same as fetch(appURL(...)).
  const apiBaseURL = getApiBaseURL();
  if (apiBaseURL) {
    return joinURL(apiBaseURL, pathname);
  }
  return pathname;
}

export function appURL(path: string, params?: URLSearchParams): string {
  const target = appPath(path);
  if (!params || !params.toString()) {
    return target;
  }
  return `${target}?${params.toString()}`;
}

export function wsURL(path: string, params?: URLSearchParams): string {
  const wsBaseURL = getWsBaseURL();
  // Use the raw pathname (with relay prefix) rather than appPath which may now
  // return a full HTTP URL when apiBaseURL is set.
  const pathname = `${relayPrefix()}${ensureLeadingSlash(path)}`;
  const target = wsBaseURL ? joinURL(wsBaseURL, pathname) : pathname;
  if (!params || !params.toString()) {
    return target;
  }
  return `${target}?${params.toString()}`;
}

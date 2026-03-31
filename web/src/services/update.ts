import { appURL } from "./base";

export type UpdateState = {
  current_version?: string;
  latest_version?: string;
  has_update?: boolean;
  status?: string;
  message?: string;
  release_url?: string;
  published_at?: string;
  last_checked_at?: string;
  auto_update_supported?: boolean;
};

export async function fetchUpdateState(): Promise<UpdateState> {
  const res = await fetch(appURL("/api/app/update"));
  if (!res.ok) {
    throw new Error(`failed to fetch update state: ${res.status}`);
  }
  return res.json();
}

export async function triggerUpdate(): Promise<UpdateState> {
  const res = await fetch(appURL("/api/app/update"), {
    method: "POST",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `failed to start update: ${res.status}`);
  }
  return res.json();
}

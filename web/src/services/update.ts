import { appURL } from "./base";
import { protectedJSON } from "./api";

export type UpdateState = {
  current_version?: string;
  latest_version?: string;
  has_update?: boolean;
  status?: string;
  message?: string;
  release_name?: string;
  release_body?: string;
  release_url?: string;
  published_at?: string;
  last_checked_at?: string;
  auto_update_supported?: boolean;
};

export async function fetchUpdateState(): Promise<UpdateState> {
  return protectedJSON<UpdateState>(appURL("/api/app/update"));
}

export async function triggerUpdate(): Promise<UpdateState> {
  return protectedJSON<UpdateState>(appURL("/api/app/update"), {
    method: "POST",
  });
}

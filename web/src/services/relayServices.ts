import { protectedJSON } from "./api";
import { appPath } from "./base";

export type RelayLocalService = {
  slug: string;
  name: string;
  local_url: string;
  enabled: boolean;
};

export async function listRelayLocalServices(): Promise<RelayLocalService[]> {
  const payload = await protectedJSON<RelayLocalService[] | null>(appPath("/api/relay/services"));
  return Array.isArray(payload) ? payload : [];
}

export async function saveRelayLocalService(input: RelayLocalService): Promise<RelayLocalService> {
  return protectedJSON<RelayLocalService>(appPath("/api/relay/services"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function deleteRelayLocalService(slug: string): Promise<{ success: boolean }> {
  return protectedJSON<{ success: boolean }>(appPath(`/api/relay/services/${encodeURIComponent(slug)}`), {
    method: "DELETE",
  });
}

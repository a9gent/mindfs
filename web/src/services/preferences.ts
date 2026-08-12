import { protectedJSON } from "./api";
import { appPath } from "./base";

export type SessionNamingPreference = {
  agent: string;
  model: string;
};

function normalizeSessionNamingPreference(value: unknown): SessionNamingPreference {
  const input = value && typeof value === "object"
    ? value as Partial<SessionNamingPreference>
    : {};
  return {
    agent: typeof input.agent === "string" ? input.agent.trim() : "",
    model: typeof input.model === "string" ? input.model.trim() : "",
  };
}

export async function fetchSessionNamingPreference(): Promise<SessionNamingPreference> {
  return normalizeSessionNamingPreference(
    await protectedJSON(appPath("/api/preferences/session-naming")),
  );
}

export async function updateSessionNamingPreference(
  preference: SessionNamingPreference,
): Promise<SessionNamingPreference> {
  return normalizeSessionNamingPreference(
    await protectedJSON(appPath("/api/preferences/session-naming"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(preference),
    }),
  );
}

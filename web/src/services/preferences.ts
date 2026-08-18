import { protectedJSON } from "./api";
import { appPath } from "./base";

export type SessionNamingPreference = {
  agent: string;
  model: string;
};

export type IdleSessionResourceReleasePreference = {
  hours: number;
};

export type NewProjectMetaLocation = "project" | "home";

function normalizeNewProjectMetaLocation(value: unknown): NewProjectMetaLocation {
  const location = value && typeof value === "object" && "location" in value
    ? String((value as { location?: unknown }).location || "")
    : "";
  return location === "home" ? "home" : "project";
}

export async function fetchNewProjectMetaLocationPreference(): Promise<NewProjectMetaLocation> {
  return normalizeNewProjectMetaLocation(
    await protectedJSON(appPath("/api/preferences/new-project-meta-location")),
  );
}

export async function updateNewProjectMetaLocationPreference(
  location: NewProjectMetaLocation,
): Promise<NewProjectMetaLocation> {
  return normalizeNewProjectMetaLocation(
    await protectedJSON(appPath("/api/preferences/new-project-meta-location"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ location }),
    }),
  );
}

const DEFAULT_IDLE_SESSION_RESOURCE_RELEASE_HOURS = 72;

function normalizeIdleSessionResourceReleasePreference(
  value: unknown,
): IdleSessionResourceReleasePreference {
  const input = value && typeof value === "object"
    ? value as Partial<IdleSessionResourceReleasePreference>
    : {};
  const hours = Number(input.hours);
  return {
    hours: Number.isInteger(hours) && hours > 0
      ? hours
      : DEFAULT_IDLE_SESSION_RESOURCE_RELEASE_HOURS,
  };
}

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

export async function fetchIdleSessionResourceReleasePreference(): Promise<IdleSessionResourceReleasePreference> {
  return normalizeIdleSessionResourceReleasePreference(
    await protectedJSON(appPath("/api/preferences/idle-session-resource-release")),
  );
}

export async function updateIdleSessionResourceReleasePreference(
  preference: IdleSessionResourceReleasePreference,
): Promise<IdleSessionResourceReleasePreference> {
  return normalizeIdleSessionResourceReleasePreference(
    await protectedJSON(appPath("/api/preferences/idle-session-resource-release"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(preference),
    }),
  );
}

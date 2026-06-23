import { appPath } from "./base";
import { protectedJSON } from "./api";

export type AgentConfigSource = {
  sourcePath: string;
  backupPath: string;
};

export type AgentConfigBackup = {
  id: string;
  agent: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  sources?: AgentConfigSource[];
  envKeys?: string[];
};

export type AgentConfigDefaults = {
  agent: string;
  file_sources: string[];
  env_keys: string[];
};

export async function fetchAgentConfigDefaults(agent: string): Promise<AgentConfigDefaults> {
  const params = new URLSearchParams({ agent });
  return protectedJSON<AgentConfigDefaults>(appPath(`/api/agent-config/defaults?${params.toString()}`));
}

export async function fetchAgentConfigBackups(agent: string): Promise<AgentConfigBackup[]> {
  const params = new URLSearchParams({ agent });
  return protectedJSON<AgentConfigBackup[]>(appPath(`/api/agent-config/backups?${params.toString()}`));
}

export async function createAgentConfigBackup(input: {
  agent: string;
  name: string;
  fileSources?: string[];
  envLines?: string[];
  overwrite?: boolean;
}): Promise<AgentConfigBackup> {
  return protectedJSON<AgentConfigBackup>(appPath("/api/agent-config/backups"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent: input.agent,
      name: input.name,
      file_sources: input.fileSources || [],
      env_lines: input.envLines || [],
      overwrite: !!input.overwrite,
    }),
  });
}

export async function deleteAgentConfigBackup(id: string): Promise<{ deleted: boolean; id: string; backups?: AgentConfigBackup[] }> {
  const params = new URLSearchParams({ id });
  return protectedJSON<{ deleted: boolean; id: string; backups?: AgentConfigBackup[] }>(appPath(`/api/agent-config/backups?${params.toString()}`), {
    method: "DELETE",
  });
}

export async function switchAgentConfig(input: {
  id: string;
  confirmOverwrite?: boolean;
}): Promise<{
  needs_confirm: boolean;
  message?: string;
  backup?: AgentConfigBackup;
}> {
  return protectedJSON(appPath("/api/agent-config/switch"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: input.id,
      confirm_overwrite: !!input.confirmOverwrite,
    }),
  });
}

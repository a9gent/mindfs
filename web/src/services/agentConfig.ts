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

export type AgentAPIProvider = {
  id: string;
  name: string;
  baseUrl: string;
  protocols: string[];
  modelFamilies: string[];
  models?: string[];
  createdAt: string;
  updatedAt: string;
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

export async function fetchAgentAPIProviders(agent?: string): Promise<AgentAPIProvider[]> {
  const params = new URLSearchParams();
  if (agent) {
    params.set("agent", agent);
  }
  const query = params.toString();
  return protectedJSON<AgentAPIProvider[]>(appPath(`/api/agent-api-providers${query ? `?${query}` : ""}`));
}

export async function createAgentAPIProvider(input: {
  name: string;
  baseUrl: string;
  apiKey: string;
}): Promise<AgentAPIProvider> {
  return protectedJSON<AgentAPIProvider>(appPath("/api/agent-api-providers"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: input.name,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
    }),
  });
}

export async function syncAgentAPIProviders(input: Array<{
  name: string;
  baseUrl: string;
  apiKey: string;
}>): Promise<{ providers: AgentAPIProvider[] }> {
  return protectedJSON<{ providers: AgentAPIProvider[] }>(appPath("/api/agent-api-providers/sync"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providers: input }),
  });
}

export type AgentAPIProviderSyncApplyResult = {
  agent: string;
  success: boolean;
  error?: string;
};

export type AgentAPIProviderSyncAllResult = {
  id: string;
  name: string;
  success: boolean;
  error?: string;
  modelCount?: number;
  applied?: AgentAPIProviderSyncApplyResult[];
};

export async function syncAllAgentAPIProviders(): Promise<{
  providers: AgentAPIProvider[];
  results: AgentAPIProviderSyncAllResult[];
}> {
  return protectedJSON<{
    providers: AgentAPIProvider[];
    results: AgentAPIProviderSyncAllResult[];
  }>(appPath("/api/agent-api-providers/sync-all"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

export type AgentAPIProviderTestResult = {
  success: boolean;
  latency_ms: number;
  model: string;
  protocol?: string;
  response?: string;
  error?: string;
};

export async function testAgentAPIProviderModel(input: {
  providerID: string;
  model?: string;
  prompt?: string;
}): Promise<AgentAPIProviderTestResult> {
  return protectedJSON<AgentAPIProviderTestResult>(appPath("/api/agent-api-providers/test"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider_id: input.providerID,
      model: input.model || "",
      prompt: input.prompt || "",
    }),
  });
}

let cachedAPIProviders: AgentAPIProvider[] | null = null;
let cachedAPIProvidersAt = 0;
const API_PROVIDERS_CACHE_TTL = 15_000;

/** 模型选择器使用的供应商目录缓存，避免每次展开菜单都请求。 */
export async function fetchAgentAPIProvidersCached(agent?: string): Promise<AgentAPIProvider[]> {
  const now = Date.now();
  if (cachedAPIProviders && now - cachedAPIProvidersAt < API_PROVIDERS_CACHE_TTL) {
    return cachedAPIProviders;
  }
  const providers = await fetchAgentAPIProviders(agent);
  cachedAPIProviders = providers;
  cachedAPIProvidersAt = now;
  return providers;
}

export function invalidateAgentAPIProvidersCache(): void {
  cachedAPIProviders = null;
  cachedAPIProvidersAt = 0;
}

export async function deleteAgentAPIProvider(id: string): Promise<{ deleted: boolean; id: string; providers?: AgentAPIProvider[] }> {
  const params = new URLSearchParams({ id });
  return protectedJSON<{ deleted: boolean; id: string; providers?: AgentAPIProvider[] }>(appPath(`/api/agent-api-providers?${params.toString()}`), {
    method: "DELETE",
  });
}

export async function switchAgentAPIProvider(input: {
  agent: string;
  providerID: string;
}): Promise<{ provider?: AgentAPIProvider }> {
  return protectedJSON(appPath("/api/agent-api-providers/switch"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent: input.agent,
      provider_id: input.providerID,
    }),
  });
}

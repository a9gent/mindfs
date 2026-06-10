import { appPath } from "./base";
import { protectedAPIReady, protectedJSON } from "./api";

// Agent status service

export type AgentStatus = {
  name: string;
  installed: boolean;
  available: boolean;
  version?: string;
  error?: string;
  last_probe?: string;
  current_model_id?: string;
  current_mode_id?: string;
  default_model_id?: string;
  default_effort?: string;
  default_fast_service?: string;
  supports_fast_service?: boolean;
  efforts?: string[];
  models?: AgentModelInfo[];
  modes?: AgentModeInfo[];
  models_error?: string;
  modes_error?: string;
  commands?: AgentCommandInfo[];
  commands_error?: string;
};

export type AgentModelInfo = {
  id: string;
  name: string;
  description?: string;
  hidden?: boolean;
  supportEffort?: boolean;
};

export type AgentModeInfo = {
  id: string;
  name: string;
  description?: string;
};

export type AgentCommandInfo = {
  name: string;
  description?: string;
  argument_hint?: string;
};

export type ShellStatus = {
  id: string;
  name?: string;
  label: string;
  command: string;
  resolved_command?: string;
  args?: string[];
  default?: boolean;
};

const VALID_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
function normalizeEfforts(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const seen = new Set<string>();
  const efforts: string[] = [];
  for (const item of input) {
    const value = String(item || "").trim().toLowerCase();
    if (!VALID_EFFORTS.includes(value as (typeof VALID_EFFORTS)[number])) {
      continue;
    }
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    efforts.push(value);
  }
  return efforts;
}

function normalizeAgentStatus(input: unknown): AgentStatus | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const agent = input as AgentStatus;
  return {
    ...agent,
    efforts: normalizeEfforts(agent.efforts),
    default_fast_service:
      typeof agent.default_fast_service === "string"
        ? agent.default_fast_service
        : "",
    supports_fast_service: !!agent.supports_fast_service,
  };
}

let cachedAgents: AgentStatus[] = [];
let cachedShells: ShellStatus[] = [];
let lastFetch = 0;
let inFlightAgents: Promise<{ agents: AgentStatus[]; shells: ShellStatus[] }> | null = null;
const CACHE_TTL = 30000; // 30 seconds

function normalizeShellStatus(input: unknown): ShellStatus | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const shell = input as ShellStatus;
  const id = String(shell.id || shell.command || "").trim();
  const command = String(shell.command || id).trim();
  if (!id || !command) {
    return null;
  }
  return {
    id,
    command,
    name: typeof shell.name === "string" ? shell.name : undefined,
    resolved_command: typeof shell.resolved_command === "string" ? shell.resolved_command : undefined,
    label: String(shell.name || shell.label || id).trim() || id,
    args: Array.isArray(shell.args) ? shell.args.map((item) => String(item)) : undefined,
    default: !!shell.default,
  };
}

async function fetchAgentRuntime(force = false): Promise<{ agents: AgentStatus[]; shells: ShellStatus[] }> {
  const now = Date.now();
  if (!force && cachedAgents.length > 0 && now - lastFetch < CACHE_TTL) {
    return { agents: cachedAgents, shells: cachedShells };
  }
  if (inFlightAgents) {
    return inFlightAgents;
  }
  if (!protectedAPIReady()) {
    return { agents: cachedAgents, shells: cachedShells };
  }

  inFlightAgents = (async () => {
    const data = await protectedJSON<any>(appPath("/api/agents"));
    const agentItems: unknown[] = Array.isArray(data) ? data : Array.isArray(data?.agents) ? data.agents : [];
    const shellItems: unknown[] = Array.isArray(data?.shells) ? data.shells : [];
    cachedAgents = agentItems
      ? agentItems.map(normalizeAgentStatus).filter((item): item is AgentStatus => item !== null)
      : [];
    cachedShells = shellItems.map(normalizeShellStatus).filter((item): item is ShellStatus => item !== null);
    lastFetch = now;
    return { agents: cachedAgents, shells: cachedShells };
  })();
  try {
    return await inFlightAgents;
  } catch (err) {
    console.error("Failed to fetch agents:", err);
    return { agents: cachedAgents, shells: cachedShells };
  } finally {
    inFlightAgents = null;
  }
}

export async function fetchAgents(force = false): Promise<AgentStatus[]> {
  const data = await fetchAgentRuntime(force);
  return data.agents;
}

export async function restartAgent(agent: string): Promise<{ restarting: boolean; agent: string }> {
  return protectedJSON<{ restarting: boolean; agent: string }>(appPath("/api/agents/restart"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent }),
  });
}

export async function fetchShells(force = false): Promise<ShellStatus[]> {
  const data = await fetchAgentRuntime(force);
  return data.shells;
}

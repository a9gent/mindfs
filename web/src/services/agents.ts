import { appPath } from "./base";

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

const VALID_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

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
  };
}

let cachedAgents: AgentStatus[] = [];
let lastFetch = 0;
const CACHE_TTL = 30000; // 30 seconds

export async function fetchAgents(force = false): Promise<AgentStatus[]> {
  const now = Date.now();
  if (!force && cachedAgents.length > 0 && now - lastFetch < CACHE_TTL) {
    return cachedAgents;
  }

  try {
    const res = await fetch(appPath("/api/agents"));
    if (!res.ok) {
      throw new Error("Failed to fetch agents");
    }
    const data = await res.json();
    cachedAgents = Array.isArray(data)
      ? data.map(normalizeAgentStatus).filter((item): item is AgentStatus => item !== null)
      : [];
    lastFetch = now;
    return cachedAgents;
  } catch (err) {
    console.error("Failed to fetch agents:", err);
    return cachedAgents;
  }
}

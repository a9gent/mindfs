import { appPath } from "./base";

// Agent status service

export type AgentStatus = {
  name: string;
  available: boolean;
  version?: string;
  error?: string;
  last_probe?: string;
  current_model_id?: string;
  models?: AgentModelInfo[];
  models_error?: string;
};

export type AgentModelInfo = {
  id: string;
  name: string;
  description?: string;
  hidden?: boolean;
};

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
    cachedAgents = Array.isArray(data) ? data : [];
    lastFetch = now;
    return cachedAgents;
  } catch (err) {
    console.error("Failed to fetch agents:", err);
    return cachedAgents;
  }
}

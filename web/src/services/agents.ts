// Agent status service

export type AgentStatus = {
  name: string;
  available: boolean;
  version?: string;
  error?: string;
  last_probe?: string;
};

let cachedAgents: AgentStatus[] = [];
let lastFetch = 0;
const CACHE_TTL = 30000; // 30 seconds

export async function fetchAgents(): Promise<AgentStatus[]> {
  const now = Date.now();
  if (cachedAgents.length > 0 && now - lastFetch < CACHE_TTL) {
    return cachedAgents;
  }

  try {
    const res = await fetch("/api/agents");
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

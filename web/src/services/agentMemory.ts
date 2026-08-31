import { protectedJSON } from "./api";
import { appPath } from "./base";

export type AgentMemoryItem = {
  name: string;
  process_count: number;
  memory_bytes: number;
  session_count: number;
};

export type AgentMemorySnapshot = {
  total_memory_bytes: number;
  measured_at: string;
  idle_hours: number;
  agents: AgentMemoryItem[];
};

export type AgentSessionReleaseResult = AgentMemorySnapshot & {
  released_sessions: number;
  failed_sessions: number;
};

export async function fetchAgentMemory(): Promise<AgentMemorySnapshot> {
  return protectedJSON<AgentMemorySnapshot>(appPath("/api/agents/memory"));
}

export async function releaseAgentSessions(): Promise<AgentSessionReleaseResult> {
  return protectedJSON<AgentSessionReleaseResult>(appPath("/api/agents/release-idle"), {
    method: "POST",
  });
}

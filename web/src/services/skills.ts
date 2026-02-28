// Skill service for MindFS

import type { Skill } from "../components/SkillSelector";

const API_BASE = "/api";

export type SkillExecuteResult = {
  success: boolean;
  output?: string;
  error?: string;
  sessionKey?: string;
};

// Fetch available skills for a directory
export async function fetchSkills(rootId: string): Promise<Skill[]> {
  const response = await fetch(`${API_BASE}/dirs/${encodeURIComponent(rootId)}/skills`);

  if (!response.ok) {
    throw new Error(`Failed to fetch skills: ${response.statusText}`);
  }

  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

// Execute a skill
export async function executeSkill(
  rootId: string,
  skillId: string,
  params?: Record<string, unknown>
): Promise<SkillExecuteResult> {
  const response = await fetch(`${API_BASE}/skills/${encodeURIComponent(skillId)}/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      root_id: rootId,
      params: params || {},
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    return {
      success: false,
      error: error.message || "执行失败",
    };
  }

  return await response.json();
}

// Built-in agent capabilities (static list)
export function getAgentCapabilities(agent: string): Skill[] {
  const capabilities: Record<string, Skill[]> = {
    claude: [
      {
        id: "claude:read_file",
        name: "读取文件",
        description: "读取指定文件的内容",
        source: "agent",
        agent: "claude",
      },
      {
        id: "claude:write_file",
        name: "写入文件",
        description: "创建或修改文件内容",
        source: "agent",
        agent: "claude",
      },
      {
        id: "claude:search",
        name: "搜索代码",
        description: "在代码库中搜索内容",
        source: "agent",
        agent: "claude",
      },
      {
        id: "claude:run_command",
        name: "执行命令",
        description: "在终端执行 shell 命令",
        source: "agent",
        agent: "claude",
      },
    ],
    gemini: [
      {
        id: "gemini:read_file",
        name: "读取文件",
        description: "读取指定文件的内容",
        source: "agent",
        agent: "gemini",
      },
      {
        id: "gemini:write_file",
        name: "写入文件",
        description: "创建或修改文件内容",
        source: "agent",
        agent: "gemini",
      },
      {
        id: "gemini:search",
        name: "搜索代码",
        description: "在代码库中搜索内容",
        source: "agent",
        agent: "gemini",
      },
    ],
    codex: [
      {
        id: "codex:read_file",
        name: "读取文件",
        description: "读取指定文件的内容",
        source: "agent",
        agent: "codex",
      },
      {
        id: "codex:write_file",
        name: "写入文件",
        description: "创建或修改文件内容",
        source: "agent",
        agent: "codex",
      },
      {
        id: "codex:run_command",
        name: "执行命令",
        description: "在终端执行 shell 命令",
        source: "agent",
        agent: "codex",
      },
    ],
  };

  return capabilities[agent] || [];
}

// Combine agent capabilities with directory skills
export async function getAllSkills(rootId: string, agent: string): Promise<Skill[]> {
  const agentSkills = getAgentCapabilities(agent);

  try {
    const directorySkills = await fetchSkills(rootId);
    return [...agentSkills, ...directorySkills];
  } catch {
    // If fetching directory skills fails, just return agent skills
    return agentSkills;
  }
}

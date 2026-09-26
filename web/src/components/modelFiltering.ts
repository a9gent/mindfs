import type { AgentModelInfo } from "../services/agents";

/** 输入关键词实时过滤：按 id / 名称 / 描述做大小写不敏感匹配。 */
export function filterAgentModels(models: AgentModelInfo[], query: string): AgentModelInfo[] {
  const keyword = query.trim().toLowerCase();
  if (!keyword) {
    return models;
  }
  return models.filter((item) => {
    const haystacks = [item.id, item.name, item.description];
    return haystacks.some((value) => (value || "").toLowerCase().includes(keyword));
  });
}

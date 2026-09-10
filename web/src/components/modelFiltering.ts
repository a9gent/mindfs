import type { AgentModelInfo } from "../services/agents";
import type { AgentAPIProvider } from "../services/agentConfig";

export type ModelProviderGroup = {
  /** 供应商显示名称；空字符串代表未匹配到供应商的内置模型。 */
  provider: string;
  models: AgentModelInfo[];
};

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

/** 模型 ID → 供应商显示名称 的映射，用于选择器按供应商分组。 */
export function buildModelProviderIndex(providers: AgentAPIProvider[] | null | undefined): Map<string, string> {
  const index = new Map<string, string>();
  if (!Array.isArray(providers)) {
    return index;
  }
  for (const provider of providers) {
    if (!provider || !provider.name) {
      continue;
    }
    for (const model of provider.models || []) {
      const id = (model || "").trim();
      if (id && !index.has(id)) {
        index.set(id, provider.name);
      }
    }
  }
  return index;
}

/** 按供应商分组；无法匹配任何供应商的模型归入“内置/其他”分组。 */
export function groupAgentModelsByProvider(
  models: AgentModelInfo[],
  providerIndex: Map<string, string>,
): ModelProviderGroup[] {
  const groups: ModelProviderGroup[] = [];
  const byProvider = new Map<string, ModelProviderGroup>();
  const ensureGroup = (provider: string): ModelProviderGroup => {
    let group = byProvider.get(provider);
    if (!group) {
      group = { provider, models: [] };
      byProvider.set(provider, group);
      groups.push(group);
    }
    return group;
  };
  for (const model of models) {
    const provider = providerIndex.get(model.id) || "";
    ensureGroup(provider).models.push(model);
  }
  // 有供应商名的分组排前面，未匹配的内置模型放最后。
  return groups.sort((a, b) => {
    if (a.provider && b.provider) {
      return a.provider.localeCompare(b.provider);
    }
    if (a.provider) return -1;
    if (b.provider) return 1;
    return 0;
  });
}

/** 未匹配任何供应商时返回 null，调用方退回平铺列表。 */
export function resolveModelGroups(
  models: AgentModelInfo[],
  providerIndex: Map<string, string>,
): ModelProviderGroup[] | null {
  if (providerIndex.size === 0 || models.length === 0) {
    return null;
  }
  const groups = groupAgentModelsByProvider(models, providerIndex);
  if (groups.length <= 1) {
    return null;
  }
  return groups;
}
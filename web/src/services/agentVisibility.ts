import { fetchAgentVisibility, updateAgentVisibility, type AgentVisibility } from "./agentConfig";
import type { AgentStatus } from "./agents";

// Agent 入口显隐：server preferences 单一真源 + 前端轻缓存（pub-sub 供
// useSyncExternalStore 订阅，设置弹层保存后所有订阅者即时刷新）。

const EMPTY_VISIBILITY: AgentVisibility = { hidden: [], customized: false };

let snapshot: AgentVisibility = EMPTY_VISIBILITY;
let loaded = false;
let inflight: Promise<AgentVisibility> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeAgentVisibility(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAgentVisibilitySnapshot(): AgentVisibility {
  return snapshot;
}

export async function refreshAgentVisibility(force = false): Promise<AgentVisibility> {
  if (!force && loaded) {
    return snapshot;
  }
  if (inflight) {
    return inflight;
  }
  inflight = fetchAgentVisibility()
    .then((next) => {
      snapshot = next;
      loaded = true;
      notify();
      return next;
    })
    .catch(() => snapshot)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export async function saveAgentVisibility(hidden: string[], customized: boolean): Promise<AgentVisibility> {
  const next = await updateAgentVisibility({ hidden, customized });
  snapshot = next;
  loaded = true;
  notify();
  return next;
}

// 同名实例组（<name>-1 / <name>-2 …）在用户从未动过显隐设置时折叠为只显示
// base；动过（customized=true）则完全按用户名单。
const INSTANCE_GROUP_PATTERN = /^(.+)-(\d+)$/;

export function foldInstanceGroups(names: string[]): string[] {
  const known = new Set(names);
  return names.filter((name) => {
    const match = INSTANCE_GROUP_PATTERN.exec(name);
    if (!match) {
      return true;
    }
    return !known.has(match[1]);
  });
}

export function filterEntryAgents(agents: AgentStatus[], visibility: AgentVisibility | null): AgentStatus[] {
  if (!visibility) {
    return agents;
  }
  if (!visibility.customized) {
    const folded = new Set(foldInstanceGroups(agents.map((item) => item.name)));
    return agents.filter((item) => folded.has(item.name));
  }
  const hidden = new Set(visibility.hidden);
  return agents.filter((item) => !hidden.has(item.name));
}

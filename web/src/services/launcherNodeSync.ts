import { registerPlugin } from "@capacitor/core";
import { getNativeBridge, parseNativeJSON } from "./nativeBridge";
import { isHarmonyRuntime, isNativeShellRuntime } from "./runtime";
import type { LauncherNode } from "./storage";

type RelayNodePayload = {
  name?: string;
  url?: string;
};

type LauncherNodeSyncPlugin = {
  storeRelayNodes: (input: {
    nodes: RelayNodePayload[];
  }) => Promise<{ stored?: boolean; count?: number }>;
  consumeRelayNodes: () => Promise<{ nodes?: RelayNodePayload[]; count?: number }>;
  getLauncherNodes: () => Promise<{ nodes?: LauncherNode[]; count?: number }>;
  setLauncherNodes: (input: {
    nodes: LauncherNode[];
  }) => Promise<{ stored?: boolean; count?: number }>;
};

const LauncherNodeSync = registerPlugin<LauncherNodeSyncPlugin>(
  "LauncherNodeSync",
);

type LauncherNodeSyncWindow = Window & {
  MindFSLauncherNodeSync?: {
    storeRelayNodes?: (rawJSON: string) => unknown;
  };
};

function normalizeNodesResult<T>(result: unknown): T[] {
  const parsed = parseNativeJSON<unknown>(result, []);
  if (Array.isArray(parsed)) {
    return parsed as T[];
  }
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { nodes?: unknown[] }).nodes)) {
    return (parsed as { nodes: T[] }).nodes;
  }
  return [];
}

export async function consumePendingRelayNodes(): Promise<RelayNodePayload[]> {
  if (!isNativeShellRuntime()) {
    return [];
  }
  try {
    const native = getNativeBridge();
    if (typeof native?.consumeRelayNodes === "function") {
      return normalizeNodesResult<RelayNodePayload>(await native.consumeRelayNodes());
    }
    if (isHarmonyRuntime()) {
      return [];
    }
    const result = await LauncherNodeSync.consumeRelayNodes();
    return Array.isArray(result?.nodes) ? result.nodes : [];
  } catch (error) {
    console.warn("[launcher-node-sync] consume failed", error);
    return [];
  }
}

export async function storeRelayNodes(nodes: RelayNodePayload[]): Promise<void> {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return;
  }
  try {
    const native = getNativeBridge();
    if (typeof native?.storeRelayNodes === "function") {
      await native.storeRelayNodes(JSON.stringify(nodes));
      return;
    }

    const legacyBridge =
      typeof window === "undefined"
        ? undefined
        : (window as LauncherNodeSyncWindow).MindFSLauncherNodeSync;
    if (typeof legacyBridge?.storeRelayNodes === "function") {
      legacyBridge.storeRelayNodes(JSON.stringify(nodes));
      return;
    }

    if (isNativeShellRuntime()) {
      if (isHarmonyRuntime()) {
        return;
      }
      await LauncherNodeSync.storeRelayNodes({ nodes });
    }
  } catch (error) {
    console.warn("[launcher-node-sync] store relay nodes failed", error);
  }
}

export async function getNativeLauncherNodes(): Promise<LauncherNode[]> {
  if (!isNativeShellRuntime()) {
    return [];
  }
  try {
    const native = getNativeBridge();
    if (typeof native?.getLauncherNodes === "function") {
      return normalizeNodesResult<LauncherNode>(await native.getLauncherNodes());
    }
    if (isHarmonyRuntime()) {
      return [];
    }
    const result = await LauncherNodeSync.getLauncherNodes();
    return Array.isArray(result?.nodes) ? result.nodes : [];
  } catch (error) {
    console.warn("[launcher-node-sync] restore failed", error);
    return [];
  }
}

export async function setNativeLauncherNodes(nodes: LauncherNode[]): Promise<void> {
  if (!isNativeShellRuntime()) {
    return;
  }
  try {
    const native = getNativeBridge();
    if (typeof native?.setLauncherNodes === "function") {
      await native.setLauncherNodes(JSON.stringify({ nodes }));
      return;
    }
    if (isHarmonyRuntime()) {
      return;
    }
    await LauncherNodeSync.setLauncherNodes({ nodes });
  } catch (error) {
    console.warn("[launcher-node-sync] persist failed", error);
  }
}

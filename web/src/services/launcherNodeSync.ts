import { registerPlugin } from "@capacitor/core";
import { isCapacitorRuntime } from "./runtime";
import type { LauncherNode } from "./storage";

type RelayNodePayload = {
  name?: string;
  url?: string;
};

type LauncherNodeSyncPlugin = {
  consumeRelayNodes: () => Promise<{ nodes?: RelayNodePayload[]; count?: number }>;
  getLauncherNodes: () => Promise<{ nodes?: LauncherNode[]; count?: number }>;
  setLauncherNodes: (input: {
    nodes: LauncherNode[];
  }) => Promise<{ stored?: boolean; count?: number }>;
};

const LauncherNodeSync = registerPlugin<LauncherNodeSyncPlugin>(
  "LauncherNodeSync",
);

export async function consumePendingRelayNodes(): Promise<RelayNodePayload[]> {
  if (!isCapacitorRuntime()) {
    return [];
  }
  try {
    const result = await LauncherNodeSync.consumeRelayNodes();
    return Array.isArray(result?.nodes) ? result.nodes : [];
  } catch (error) {
    console.warn("[launcher-node-sync] consume failed", error);
    return [];
  }
}

export async function getNativeLauncherNodes(): Promise<LauncherNode[]> {
  if (!isCapacitorRuntime()) {
    return [];
  }
  try {
    const result = await LauncherNodeSync.getLauncherNodes();
    return Array.isArray(result?.nodes) ? result.nodes : [];
  } catch (error) {
    console.warn("[launcher-node-sync] restore failed", error);
    return [];
  }
}

export async function setNativeLauncherNodes(nodes: LauncherNode[]): Promise<void> {
  if (!isCapacitorRuntime()) {
    return;
  }
  try {
    await LauncherNodeSync.setLauncherNodes({ nodes });
  } catch (error) {
    console.warn("[launcher-node-sync] persist failed", error);
  }
}

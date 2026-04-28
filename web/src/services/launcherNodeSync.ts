import { registerPlugin } from "@capacitor/core";
import { isCapacitorRuntime } from "./runtime";

type RelayNodePayload = {
  name?: string;
  url?: string;
};

type LauncherNodeSyncPlugin = {
  consumeRelayNodes: () => Promise<{ nodes?: RelayNodePayload[]; count?: number }>;
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

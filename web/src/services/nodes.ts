import { protectedJSON } from "./api";
import { appPath } from "./base";
import type { LauncherNode } from "./storage";

export const backendNodes = {
  async load(): Promise<LauncherNode[]> {
    return (await protectedJSON<{ nodes: LauncherNode[] }>(appPath("/api/nodes"))).nodes;
  },
  async save(nodes: LauncherNode[]): Promise<LauncherNode[]> {
    return (await protectedJSON<{ nodes: LauncherNode[] }>(appPath("/api/nodes"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodes }),
    })).nodes;
  },
};

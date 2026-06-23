import { appURL } from "./base";
import { protectedJSON } from "./api";

export type CandidateType = "file" | "skill" | "prompt" | "command";
export type CandidateItemType = CandidateType | "slash_command";

export type CandidateItem = {
  type: CandidateItemType;
  name: string;
  description?: string;
};

export async function fetchCandidates(params: {
  rootId: string;
  type: CandidateType;
  query: string;
  agent?: string;
  signal?: AbortSignal;
}): Promise<CandidateItem[]> {
  const search = new URLSearchParams();
  search.set("root", params.rootId);
  search.set("type", params.type);
  if (params.query) {
    search.set("q", params.query);
  }
  if (params.type === "skill" && params.agent) {
    search.set("agent", params.agent);
  }
  const data = await protectedJSON<any[]>(appURL("/api/candidates", search), {
    signal: params.signal,
  });
  return Array.isArray(data) ? data : [];
}

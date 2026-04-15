import { appURL } from "./base";

export type CandidateType = "file" | "skill" | "prompt";
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
  const response = await fetch(appURL("/api/candidates", search), {
    signal: params.signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch candidates: ${response.status}`);
  }
  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

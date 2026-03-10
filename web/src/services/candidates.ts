export type CandidateType = "file" | "skill";

export type CandidateItem = {
  type: CandidateType;
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
  const response = await fetch(`/api/candidates?${search.toString()}`, {
    signal: params.signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch candidates: ${response.status}`);
  }
  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

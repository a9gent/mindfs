import { appURL } from "./base";
import { protectedJSON } from "./api";

export async function savePrompt(text: string): Promise<string[]> {
  const data = await protectedJSON<any>(appURL("/api/prompts"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });
  return Array.isArray(data?.items) ? data.items : [];
}

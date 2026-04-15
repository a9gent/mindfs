import { appURL } from "./base";

export async function savePrompt(text: string): Promise<string[]> {
  const response = await fetch(appURL("/api/prompts"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    throw new Error(`Failed to save prompt: ${response.status}`);
  }
  const data = await response.json();
  return Array.isArray(data?.items) ? data.items : [];
}

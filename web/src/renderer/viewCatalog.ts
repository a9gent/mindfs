import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react";
import { shadcnComponentDefinitions } from "@json-render/shadcn/catalog";
import { z } from "zod";

export const baseCatalog = defineCatalog(schema, {
  name: "MindFS Base UI Catalog",
  components: shadcnComponentDefinitions as any,
  actions: {
    navigate: {
      params: z.object({
        path: z.string().optional(),
        cursor: z.number().optional(),
        query: z.record(z.string(), z.any()).optional(),
      }),
      description: "Update URL state for view plugins within current root. Built-in params: path/cursor; plugin params are exposed as file.query.",
    },
  },
} as any);

let cachedPrompt = "";

export function getViewModeSystemPrompt(): string {
  if (!cachedPrompt) {
    cachedPrompt = baseCatalog.prompt();
  }
  return cachedPrompt;
}

export function buildViewModeMessage(userPrompt: string): string {
  return [
    "[SYSTEM_PROMPT]",
    getViewModeSystemPrompt(),
    "",
    "[USER_PROMPT]",
    userPrompt,
  ].join("\n");
}

import React from "react";
import { JSONUIProvider, Renderer as JsonRenderer } from "@json-render/react";
import { registry } from "./registry";

type RendererProps = {
  tree: {
    root: string;
    elements: Record<string, unknown>;
  };
  initialState?: Record<string, unknown>;
  handlers?: Record<string, (params: Record<string, unknown>) => void | Promise<void>>;
};

function normalizeTreeSpec(tree: RendererProps["tree"]): RendererProps["tree"] {
  const elements = tree?.elements || {};
  const normalized: Record<string, unknown> = {};
  Object.entries(elements).forEach(([key, value]) => {
    if (!value || typeof value !== "object") {
      normalized[key] = value;
      return;
    }
    const element = value as Record<string, unknown>;
    normalized[key] = {
      ...element,
      props: element.props && typeof element.props === "object" ? element.props : {},
    };
  });
  return { ...tree, elements: normalized };
}

export function Renderer({ tree, initialState = {}, handlers = {} }: RendererProps) {
  const spec = normalizeTreeSpec(tree);
  return (
    <JSONUIProvider registry={registry} initialState={initialState} handlers={handlers}>
      <JsonRenderer spec={spec as any} registry={registry} />
    </JSONUIProvider>
  );
}

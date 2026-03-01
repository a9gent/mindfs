import React from "react";
import { Renderer as JsonRenderer } from "@json-render/react";
import { registry } from "./registry";
import type { UITree } from "../App";

type RendererProps = {
  tree: UITree;
};

export function Renderer({ tree }: RendererProps) {
  return <JsonRenderer tree={tree} registry={registry} />;
}

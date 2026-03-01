import React from "react";
import { AssociationView } from "../components/AssociationView";
import { useActions } from "@json-render/react";
import type { UIElement } from "../App";

type ComponentProps = {
  element: UIElement;
  children?: React.ReactNode;
  onAction?: (action: { name: string; params?: Record<string, unknown> }) => void;
};

const Container: React.FC<ComponentProps> = ({ children }) => (
  <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
    {children}
  </div>
);

const AssociationViewNode: React.FC<ComponentProps> = ({ element }) => {
  const { execute } = useActions();
  return (
    <AssociationView 
      title={(element.props?.title as string) ?? undefined} 
      files={(element.props?.files as any[]) ?? []} 
      onFileClick={(path) => execute({ name: "open", params: { path } })} 
      onSessionClick={(key) => execute({ name: "select_session", params: { key } })} 
    />
  );
};

// 后续可以根据需要添加更多用于自定义视图的组件，如 Button, Markdown 等

export const registry = { 
  Container,
  AssociationView: AssociationViewNode 
};

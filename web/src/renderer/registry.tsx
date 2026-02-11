import React from "react";
import { AppShell } from "../layout/AppShell";
import { FileTree } from "../components/FileTree";
import { DefaultListView } from "../components/DefaultListView";
import { ActionBar } from "../components/ActionBar";
import { FileViewer } from "../components/FileViewer";
import { SessionList } from "../components/SessionList";
import { SessionViewer } from "../components/SessionViewer";
import { RightSidebar } from "../components/RightSidebar";
import { SettingsPanel } from "../components/SettingsPanel";
import { useActions } from "@json-render/react";
import type { UIElement, FileEntry } from "./defaultTree";

type ComponentProps = {
  element: UIElement;
  children?: React.ReactNode;
  onAction?: (action: { name: string; params?: Record<string, unknown> }) => void;
};

const Shell: React.FC<ComponentProps> = ({ children }) => {
  const nodes = React.Children.toArray(children);
  return (
    <AppShell
      sidebar={nodes[0] ?? null}
      main={nodes[1] ?? null}
      rightSidebar={nodes[2] ?? null}
      rightCollapsed={(nodes[2] as any)?.props?.collapsed ?? false}
      onToggleRight={(nodes[2] as any)?.props?.onToggle ?? undefined}
      footer={nodes[3] ?? null}
    />
  );
};

const Sidebar: React.FC<ComponentProps> = ({ children }) => (
  <div>{children}</div>
);

const Main: React.FC<ComponentProps> = ({ children }) => (
  <div>{children}</div>
);

const Footer: React.FC<ComponentProps> = ({ children }) => (
  <div>{children}</div>
);

const FileTreeNode: React.FC<ComponentProps> = ({ element, onAction }) => {
  const { execute } = useActions();
  const handleOpen = (path: string, rootId?: string) => {
    const action = { name: "open", params: { path, root: rootId } };
    if (onAction) {
      onAction(action);
      return;
    }
    execute(action);
  };
  const handleOpenDir = (path: string, rootId?: string) => {
    const action = { name: "open_dir", params: { path, root: rootId } };
    if (onAction) {
      onAction(action);
      return;
    }
    execute(action);
  };

  return (
    <FileTree
      entries={(element.props?.entries as FileEntry[]) ?? []}
      childrenByPath={
        (element.props?.childrenByPath as Record<string, FileEntry[]>) ?? {}
      }
      expanded={(element.props?.expanded as string[]) ?? []}
      selectedDir={(element.props?.selectedDir as string) ?? null}
      onSelectFile={(entry, root) => handleOpen(entry.path, root)}
      onToggleDir={(entry, root) => handleOpenDir(entry.path, root)}
    />
  );
};

const DefaultListNode: React.FC<ComponentProps> = ({ element }) => (
  <DefaultListView entries={(element.props?.entries as FileEntry[]) ?? []} />
);

const FileViewerNode: React.FC<ComponentProps> = ({ element }) => (
  <FileViewer file={(element.props?.file as any) ?? null} />
);

const ActionBarNode: React.FC<ComponentProps> = ({ element }) => (
  <ActionBar
    status={(element.props?.status as string) ?? "Disconnected"}
    currentSession={(element.props?.currentSession as any) ?? null}
    onSendMessage={(element.props?.onSendMessage as any) ?? undefined}
    onSessionClick={(element.props?.onSessionClick as any) ?? undefined}
  />
);

const RightSidebarNode: React.FC<ComponentProps> = ({ element, children }) => (
  <RightSidebar
    collapsed={(element.props?.collapsed as boolean) ?? false}
    onToggle={(element.props?.onToggle as any) ?? undefined}
    onOpenSettings={(element.props?.onOpenSettings as any) ?? undefined}
  >
    {children}
  </RightSidebar>
);

const SessionListNode: React.FC<ComponentProps> = ({ element }) => (
  <SessionList
    sessions={(element.props?.sessions as any[]) ?? []}
    selectedKey={(element.props?.selectedKey as string) ?? ""}
    onSelect={(element.props?.onSelect as any) ?? undefined}
  />
);

const SessionViewerNode: React.FC<ComponentProps> = ({ element }) => (
  <SessionViewer session={(element.props?.session as any) ?? null} />
);

const SettingsPanelNode: React.FC<ComponentProps> = ({ element }) => (
  <SettingsPanel open={(element.props?.open as boolean) ?? false} />
);

export const registry = {
  Shell,
  Sidebar,
  Main,
  Footer,
  RightSidebar: RightSidebarNode,
  FileTree: FileTreeNode,
  DefaultListView: DefaultListNode,
  FileViewer: FileViewerNode,
  ActionBar: ActionBarNode,
  SessionList: SessionListNode,
  SessionViewer: SessionViewerNode,
  SettingsPanel: SettingsPanelNode,
};

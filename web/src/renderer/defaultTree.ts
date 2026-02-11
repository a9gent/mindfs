export type FileEntry = {
  name: string;
  path: string;
  is_dir: boolean;
};

export type UIElement = {
  key: string;
  type: string;
  props?: Record<string, unknown>;
  children?: string[];
};

export type UITree = {
  root: string;
  elements: Record<string, UIElement>;
};

export type FilePayload = {
  name: string;
  path: string;
  content: string;
  encoding: string;
  truncated: boolean;
  size: number;
  ext?: string;
  mime?: string;
  root?: string;
};

export type SessionSummary = {
  session_key: string;
  agent?: string;
  scope?: string;
  purpose?: string;
  summary?: string;
  closed_at?: string;
};

export type CurrentSession = {
  key: string;
  name: string;
  type: "chat" | "view" | "skill";
  status: "active" | "idle" | "closed";
  agent: string;
};

export function buildDefaultTree(
  rootEntries: FileEntry[],
  childrenByPath: Record<string, FileEntry[]>,
  expanded: string[],
  selectedDir: string | null,
  rootId: string | null,
  managedRoots: string[],
  mainEntries: FileEntry[],
  status: string,
  file?: FilePayload | null,
  sessions?: SessionSummary[],
  selectedSession?: SessionSummary | null,
  onSelectSession?: ((session: SessionSummary) => void) | null,
  currentSession?: CurrentSession | null,
  onSendMessage?: ((message: string, mode: "chat" | "view" | "skill", agent: string) => void) | null,
  onSessionClick?: (() => void) | null,
  rightCollapsed?: boolean,
  onToggleRight?: (() => void) | null,
  onOpenSettings?: (() => void) | null,
  settingsOpen?: boolean
): UITree {
  const elements: Record<string, UIElement> = {};
  const rootKey = "root";

  elements[rootKey] = {
    key: rootKey,
    type: "Shell",
    props: {},
    children: ["sidebar", "main", "right", "footer"],
  };

  elements.sidebar = {
    key: "sidebar",
    type: "Sidebar",
    props: {},
    children: ["file-tree"],
  };

  elements["file-tree"] = {
    key: "file-tree",
    type: "FileTree",
    props: {
      entries: rootEntries,
      childrenByPath,
      expanded,
      selectedDir,
      rootId,
      managedRoots,
    },
  };

  elements.main = {
    key: "main",
    type: "Main",
    props: {},
    children: [selectedSession ? "session-viewer" : file ? "file-viewer" : "default-list"],
  };

  if (selectedSession) {
    elements["session-viewer"] = {
      key: "session-viewer",
      type: "SessionViewer",
      props: { session: selectedSession },
    };
  }

  if (file) {
    elements["file-viewer"] = {
      key: "file-viewer",
      type: "FileViewer",
      props: { file },
    };
  } else {
    elements["default-list"] = {
      key: "default-list",
      type: "DefaultListView",
      props: { entries: mainEntries },
    };
  }

  elements.right = {
    key: "right",
    type: "RightSidebar",
    props: {
      collapsed: rightCollapsed ?? false,
      onToggle: onToggleRight ?? undefined,
      onOpenSettings: onOpenSettings ?? undefined,
    },
    children: ["session-list", "settings-panel"],
  };

  elements["session-list"] = {
    key: "session-list",
    type: "SessionList",
    props: {
      sessions: sessions ?? [],
      selectedKey: selectedSession?.session_key ?? "",
      onSelect: onSelectSession ?? undefined,
    },
  };

  elements["settings-panel"] = {
    key: "settings-panel",
    type: "SettingsPanel",
    props: {
      open: settingsOpen ?? false,
    },
  };

  elements.footer = {
    key: "footer",
    type: "Footer",
    props: {},
    children: ["action-bar"],
  };

  elements["action-bar"] = {
    key: "action-bar",
    type: "ActionBar",
    props: {
      status,
      currentSession: currentSession ?? null,
      onSendMessage: onSendMessage ?? undefined,
      onSessionClick: onSessionClick ?? undefined,
    },
  };

  return { root: rootKey, elements };
}

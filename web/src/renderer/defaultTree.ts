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
  key?: string;
  session_key?: string;
  name?: string;
  type?: "chat" | "view" | "skill";
  status?: "active" | "idle" | "closed";
  agent?: string;
  scope?: string;
  purpose?: string;
  summary?: string | { title?: string; description?: string };
  closed_at?: string;
  related_files?: Array<{ path: string; name?: string }>;
};

export type CurrentSession = {
  key: string;
  name: string;
  type: "chat" | "view" | "skill";
  status: "active" | "idle" | "closed";
  agent: string;
  exchanges?: any[];
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
  settingsOpen?: boolean,
  isFloatingOpen?: boolean,
  onToggleFloating?: (open: boolean) => void,
  onAgentResponse?: (content: string) => void
): UITree {
  const elements: Record<string, UIElement> = {};
  const rootKey = "root";

  // 1. 核心状态计算
  const isSelectedSessionActive = currentSession && (selectedSession?.key === currentSession.key || selectedSession?.session_key === currentSession.key);
  const showSessionInMain = selectedSession && !isSelectedSessionActive;
  const showAssociation = false; // 占位逻辑

  // 2. 基础框架定义
  elements[rootKey] = {
    key: rootKey,
    type: "Shell",
    props: {},
    children: ["sidebar", "main", "right", "footer", "floating-container"],
  };

  elements["floating-container"] = {
    key: "floating-container",
    type: "Container",
    props: {},
    children: [],
  };

  // 3. 浮窗逻辑
  if (currentSession) {
    if (isFloatingOpen) {
      elements["agent-panel"] = {
        key: "agent-panel",
        type: "AgentPanel",
        props: {
          onClose: () => onToggleFloating?.(false),
        },
        children: ["agent-header", "agent-messages"]
      };

      elements["agent-header"] = {
        key: "agent-header",
        type: "AgentHeader",
        props: {
          session: currentSession,
          onClose: () => onToggleFloating?.(false),
        }
      };

      elements["agent-messages"] = {
        key: "agent-messages",
        type: "AgentMessageList",
        props: {
          session: currentSession,
          exchanges: (currentSession as any).exchanges || [],
          onAgentResponse: onAgentResponse || undefined,
        }
      };

      elements["floating-container"].children = ["agent-panel"];
    } else {
      elements["agent-bubble"] = {
        key: "agent-bubble",
        type: "AgentBubble",
        props: {
          session: currentSession,
          onClick: () => onToggleFloating?.(true),
        },
      };
      elements["floating-container"].children = ["agent-bubble"];
    }
  }

  // 4. 侧边栏与文件树
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
      // 只有在显示“目录预览”时才显示目录选中态
      selectedDir: (file || showSessionInMain || showAssociation) ? null : selectedDir,
      selectedPath: file?.path,
      rootId,
      managedRoots,
    },
  };

  // 5. 主视图内容
  elements.main = {
    key: "main",
    type: "Main",
    props: {},
    children: [
      showAssociation ? "association-view" :
      showSessionInMain ? "session-viewer" : 
      file ? "file-viewer" : 
      "default-list"
    ],
  };

  if (showAssociation) {
    const allFiles = (sessions || []).flatMap(s => 
      (s.related_files || []).map(f => ({
        ...f,
        source_session: s.key || s.session_key,
        session_name: s.name || s.purpose
      }))
    );
    
    elements["association-view"] = {
      key: "association-view",
      type: "AssociationView",
      props: {
        title: "所有关联文件",
        files: allFiles
      }
    };
  }

  if (showSessionInMain) {
    elements["session-viewer"] = {
      key: "session-viewer",
      type: "SessionViewer",
      props: { 
        session: selectedSession,
        root: rootId 
      },
    };
  }

  if (file) {
    elements["file-viewer"] = {
      key: "file-viewer",
      type: "FileViewer",
      props: { file },
    };
  } else if (!showSessionInMain && !showAssociation) {
    elements["default-list"] = {
      key: "default-list",
      type: "DefaultListView",
      props: { 
        entries: mainEntries,
        path: selectedDir || "",
        root: rootId
      },
    };
  }

  // 6. 右侧边栏与底部
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
      selectedKey: selectedSession?.key ?? selectedSession?.session_key ?? "",
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

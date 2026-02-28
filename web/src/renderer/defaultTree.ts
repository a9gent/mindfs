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
  file_meta?: Array<{
    source_session: string;
    session_name?: string;
    agent?: string;
    created_at?: string;
    updated_at?: string;
    created_by?: string;
  }>;
};

export type SessionItem = {
  key?: string;
  session_key?: string;
  root_id?: string;
  name?: string;
  type?: "chat" | "view" | "skill";
  agent?: string;
  scope?: string;
  purpose?: string;
  closed_at?: string;
  related_files?: Array<{ path: string; name?: string }>;
  exchanges?: Array<{ role?: string; content?: string; timestamp?: string }>;
};

export type CurrentSession = {
  key: string;
  root_id?: string;
  name: string;
  type: "chat" | "view" | "skill";
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
  sessions?: SessionItem[],
  selectedSession?: SessionItem | null,
  onSelectSession?: ((session: SessionItem) => void) | null,
  onOpenBubbleSession?: ((session: CurrentSession) => void) | null,
  activeSessions?: CurrentSession[],
  currentSession?: CurrentSession | null,
  interactionMode?: "main" | "floating",
  onToggleInteractionMode?: ((mode: "main" | "floating") => void) | null,
  onSendMessage?: ((message: string, mode: "chat" | "view" | "skill", agent: string) => void) | null,
  onSessionClick?: (() => void) | null,
  isFloatingOpen?: boolean,
  onToggleFloating?: (open: boolean) => void,
  onAgentResponse?: (content: string) => void
): UITree {
  const elements: Record<string, UIElement> = {};
  const rootKey = "root";

  // 1. 核心状态计算
  const showSessionInMain = !!selectedSession && interactionMode !== "floating";
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
  if (currentSession && isFloatingOpen && interactionMode === "floating") {
    elements["agent-panel"] = {
      key: "agent-panel",
      type: "AgentPanel",
      props: {
        onClose: () => onToggleFloating?.(false),
      },
      children: ["agent-header", "agent-messages", "agent-input"]
    };

    elements["agent-header"] = {
      key: "agent-header",
      type: "AgentHeader",
      props: {
        session: currentSession,
        onClose: () => onToggleFloating?.(false),
        interactionMode: interactionMode ?? "main",
        onToggleMode: onToggleInteractionMode ?? undefined,
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

    elements["agent-input"] = {
      key: "agent-input",
      type: "AgentInput",
      props: {
        onSend: (message: string) => {
          onSendMessage?.(message, currentSession.type, currentSession.agent);
        },
      },
    };

    elements["floating-container"].children = ["agent-panel"];
  } else if ((activeSessions || []).length > 0) {
    const bubbles: string[] = [];
    (activeSessions || []).forEach((session, index) => {
      const key = `agent-bubble-${session.key}`;
      elements[key] = {
        key,
        type: "AgentBubble",
        props: {
          session,
          index,
          onClick: () => {
            onOpenBubbleSession?.(session);
            onToggleInteractionMode?.("floating");
            onToggleFloating?.(true);
          },
        },
      };
      bubbles.push(key);
    });
    elements["floating-container"].children = bubbles;
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
        interactionMode: interactionMode ?? "main",
        onToggleMode: onToggleInteractionMode ?? undefined,
        onAgentResponse: onAgentResponse || undefined,
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
    props: {},
    children: ["session-list"],
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
      currentSession: (() => {
        const selectedKey = selectedSession?.key || selectedSession?.session_key;
        if (selectedKey && selectedSession?.type && selectedSession?.agent) {
          return {
            key: selectedKey,
            name: selectedSession.name || "",
            type: selectedSession.type,
            agent: selectedSession.agent,
          } as CurrentSession;
        }
        return currentSession ?? null;
      })(),
      onSendMessage: onSendMessage ?? undefined,
      onSessionClick: onSessionClick ?? undefined,
    },
  };

  return { root: rootKey, elements };
}

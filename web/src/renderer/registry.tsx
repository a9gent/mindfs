import React from "react";
import { AppShell } from "../layout/AppShell";
import { FileTree } from "../components/FileTree";
import { DefaultListView } from "../components/DefaultListView";
import { ActionBar } from "../components/ActionBar";
import { FileViewer } from "../components/FileViewer";
import { SessionList } from "../components/SessionList";
import { SessionViewer } from "../components/SessionViewer";
import { RightSidebar } from "../components/RightSidebar";
import { AgentBubble } from "../components/AgentBubble";
import { AgentIcon } from "../components/AgentIcon";
import { AssociationView } from "../components/AssociationView";
import { useSessionStream, type TimelineItem } from "../hooks/useSessionStream";
import { ThinkingBlock } from "../components/stream/ThinkingBlock";
import { ToolCallCard } from "../components/stream/ToolCallCard";
import { useActions } from "@json-render/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { UIElement, FileEntry } from "./defaultTree";
import type { ToolCall } from "../services/session";

type ComponentProps = {
  element: UIElement;
  children?: React.ReactNode;
  onAction?: (action: { name: string; params?: Record<string, unknown> }) => void;
};

const formatTime = (isoString?: string) => {
  if (!isoString) return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  try {
    const date = new Date(isoString);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    const isThisYear = date.getFullYear() === now.getFullYear();
    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    if (isToday) return timeStr;
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    if (isThisYear) return `${month}-${day} ${timeStr}`;
    return `${date.getFullYear()}-${month}-${day} ${timeStr}`;
  } catch { return ""; }
};

function formatToolCallResult(toolCall: Partial<ToolCall>): string {
  const content = toolCall.content;
  const lines: string[] = [];
  if (content && content.length > 0) {
    for (const item of content) {
      if (item.type === "text" && item.text) {
        lines.push(item.text);
        continue;
      }
      if (item.type === "diff") {
        lines.push(`diff: ${item.path || "(unknown)"}`);
        if (item.oldText) lines.push(`- ${item.oldText}`);
        if (item.newText) lines.push(`+ ${item.newText}`);
      }
    }
  }
  const byContent = lines.join("\n").trim();
  if (byContent) return byContent;
  const rawInput = toolCall.meta?.input;
  if (typeof rawInput === "string" && rawInput.trim() !== "") return rawInput;
  const rawOutput = toolCall.meta?.output;
  if (typeof rawOutput === "string" && rawOutput.trim() !== "") return rawOutput;
  return "";
}

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
      floating={nodes[4] ?? null}
    />
  );
};

const Sidebar: React.FC<ComponentProps> = ({ children }) => (
  <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>{children}</div>
);

const Main: React.FC<ComponentProps> = ({ children }) => (
  <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>{children}</div>
);

const Footer: React.FC<ComponentProps> = ({ children }) => (
  <div style={{ width: "100%", display: "flex", flexDirection: "column" }}>{children}</div>
);

const Container: React.FC<ComponentProps> = ({ children }) => (
  <>{children}</>
);

const FileTreeNode: React.FC<ComponentProps> = ({ element, onAction }) => {
  const { execute } = useActions();
  const handleOpen = (path: string, rootId?: string) => {
    const action = { name: "open", params: { path, root: rootId } };
    if (onAction) { onAction(action); return; }
    execute(action);
  };
  const handleOpenDir = (path: string, rootId?: string) => {
    const action = { name: "open_dir", params: { path, root: rootId, toggle: true } };
    if (onAction) { onAction(action); return; }
    execute(action);
  };

  return (
    <FileTree
      entries={(element.props?.entries as FileEntry[]) ?? []}
      childrenByPath={(element.props?.childrenByPath as Record<string, FileEntry[]>) ?? {}}
      expanded={(element.props?.expanded as string[]) ?? []}
      selectedDir={(element.props?.selectedDir as string) ?? null}
      selectedPath={(element.props?.selectedPath as string) ?? null}
      rootId={(element.props?.rootId as string) ?? null}
      managedRoots={(element.props?.managedRoots as string[]) ?? []}
      onSelectFile={(entry, root) => handleOpen(entry.path, root)}
      onToggleDir={(entry, root) => handleOpenDir(entry.path, root)}
    />
  );
};

const DefaultListNode: React.FC<ComponentProps> = ({ element }) => {
  const { execute } = useActions();
  const root = element.props?.root as string | undefined;
  return (
    <DefaultListView 
      path={(element.props?.path as string) ?? ""}
      entries={(element.props?.entries as FileEntry[]) ?? []} 
      onItemClick={(entry) => {
        if (entry.is_dir) {
          execute({ name: "open_dir", params: { path: entry.path, root } });
        } else {
          execute({ name: "open", params: { path: entry.path, root } });
        }
      }}
      onPathClick={(path) => execute({ name: "open_dir", params: { path, root } })}
    />
  );
};

const FileViewerNode: React.FC<ComponentProps> = ({ element }) => {
  const { execute } = useActions();
  const root = (element.props?.file as any)?.root;
  return (
    <FileViewer 
      file={(element.props?.file as any) ?? null} 
      onSessionClick={(sessionKey) => execute({ name: "select_session", params: { key: sessionKey } })}
      onPathClick={(path) => execute({ name: "open_dir", params: { path, root } })}
    />
  );
};

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

const SessionViewerNode: React.FC<ComponentProps> = ({ element }) => {
  const { execute } = useActions();
  const root = element.props?.root as string | undefined;
  return (
    <SessionViewer 
      session={(element.props?.session as any) ?? null} 
      interactionMode={(element.props?.interactionMode as "main" | "floating" | undefined) ?? "main"}
      onToggleMode={(element.props?.onToggleMode as ((mode: "main" | "floating") => void) | undefined)}
      onAgentResponse={(element.props?.onAgentResponse as ((content: string) => void) | undefined)}
      onFileClick={(path) => execute({ name: "open", params: { path, root } })}
    />
  );
};

const AgentPanelNode: React.FC<ComponentProps> = ({ element, children }) => {
  const isMobile = window.innerWidth < 768;
  return (
    <>
      <div 
        onClick={(element.props?.onClose as any)}
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.1)", backdropFilter: "blur(1px)", zIndex: 90 }}
      />
      <div
        style={{
          position: "absolute", top: isMobile ? "5%" : "10%", left: isMobile ? "5%" : "10%", width: isMobile ? "90%" : "80%", height: isMobile ? "80%" : "75%",
          background: "rgba(255, 255, 255, 0.95)", backdropFilter: "blur(30px)", borderRadius: "16px", boxShadow: "0 30px 80px rgba(0,0,0,0.25)",
          display: "flex", flexDirection: "column", overflow: "hidden", zIndex: 100, animation: "panelFadeIn 0.2s ease-out", border: "1px solid rgba(255, 255, 255, 0.4)"
        }}
      >
        <style>{`@keyframes panelFadeIn { from { opacity: 0; transform: scale(0.98) translateY(10px); } to { opacity: 1; transform: scale(1) translateY(0); } }`}</style>
        {children}
      </div>
    </>
  );
};

const AgentHeaderNode: React.FC<ComponentProps> = ({ element }) => {
  const session = element.props?.session as any;
  if (!session) return null;
  const displayName = session.name || `Session ${session.key.slice(0, 8)}`;
  const interactionMode = (element.props?.interactionMode as "main" | "floating" | undefined) ?? "main";
  const onToggleMode = element.props?.onToggleMode as ((mode: "main" | "floating") => void) | undefined;
  return (
    <div style={{ padding: "10px 16px", borderBottom: "1px solid rgba(0,0,0,0.05)", display: "flex", alignItems: "center", gap: "10px", background: "transparent" }}>
      <span style={{ fontSize: "16px" }}>{session.type === "chat" ? "💬" : session.type === "view" ? "🎨" : "⚡"}</span>
      <div style={{ flex: 1, display: "flex", alignItems: "baseline", gap: "8px", minWidth: 0 }}>
        <span style={{ fontSize: "14px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayName}</span>
      </div>
      <button
        onClick={() => onToggleMode?.(interactionMode === "floating" ? "main" : "floating")}
        style={{ background: "rgba(0,0,0,0.04)", border: "1px solid rgba(0,0,0,0.08)", borderRadius: "6px", cursor: "pointer", padding: "4px 8px", fontSize: "11px", color: "var(--text-primary)" }}
      >
        {interactionMode === "floating" ? "主视图" : "浮框"}
      </button>
      <button onClick={(element.props?.onClose as any)} style={{ background: "none", border: "none", borderRadius: "4px", cursor: "pointer", padding: "4px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "14px", color: "var(--text-secondary)", transition: "background 0.2s" }} onMouseEnter={(e) => e.currentTarget.style.background = "rgba(0,0,0,0.05)"} onMouseLeave={(e) => e.currentTarget.style.background = "none"}>✕</button>
    </div>
  );
};

const AgentMessageListNode: React.FC<ComponentProps> = ({ element }) => {
  const session = element.props?.session as any;
  const exchanges = (element.props?.exchanges as { role?: string; agent?: string; content?: string; timestamp?: string }[]) ?? [];
  const { timeline, isStreaming } = useSessionStream(session?.key ?? null, exchanges);
  const messagesEndRef = React.useRef<HTMLDivElement>(null);
  const isAwaiting = !!session?.pending;

  const renderTimelineItem = (item: TimelineItem, i: number) => {
    if (item.type === "thought") {
      return <ThinkingBlock key={item.id || `thought-${i}`} content={item.content || ""} defaultExpanded={false} />;
    }
    if (item.type === "tool") {
      const tc = item.toolCall || {};
      return (
        <ToolCallCard
          key={item.id || tc.callId || `tool-${i}`}
          kind={tc.kind}
          title={(tc as any).title || (tc.meta && typeof tc.meta.title === "string" ? (tc.meta.title as string) : "")}
          callId={tc.callId || ""}
          status={tc.status || "running"}
          result={formatToolCallResult(tc)}
          locations={tc.locations}
          defaultExpanded={false}
        />
      );
    }
    const isUser = item.type === "user_text";
    const hideAssistantMeta = !isUser && isStreaming && i === timeline.length - 1;
    const time = formatTime(item.timestamp);
    return (
      <div key={`ex-${i}`} style={{ alignSelf: isUser ? "flex-end" : "flex-start", width: isUser ? "auto" : "100%", maxWidth: isUser ? "85%" : "100%", display: 'flex', flexDirection: 'column' }}>
        {isUser ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
            <div style={{ 
              padding: "12px 18px", 
              borderRadius: "20px 20px 4px 20px", 
              background: "linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)", 
              color: "#fff", 
              fontSize: "14px", 
              lineHeight: "1.6", 
              boxShadow: "0 4px 12px rgba(37,99,235,0.2)",
              border: "1px solid rgba(255,255,255,0.1)"
            }}>{item.content || ""}</div>
            <span style={{ fontSize: '10px', color: 'var(--text-secondary)', opacity: 0.5, marginRight: '4px' }}>{time}</span>
          </div>
        ) : (
          <div style={{ width: "100%", display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
            <div style={{ color: "var(--text-primary)", fontSize: "15px", lineHeight: "1.7", width: "100%" }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
                p: ({node, ...props}) => <p style={{ margin: "0 0 1em 0" }} {...props} />,
                pre: ({node, ...props}) => <pre style={{ background: "rgba(0,0,0,0.04)", padding: "16px", borderRadius: "8px", overflow: "auto", fontSize: "13px", margin: "1em 0" }} {...props} />,
                code: ({node, ...props}) => <code style={{ background: "rgba(0,0,0,0.04)", padding: "2px 4px", borderRadius: "4px" }} {...props} />
              }}>{item.content || ""}</ReactMarkdown>
            </div>
            {!hideAssistantMeta && (
              <span style={{ alignSelf: 'flex-start', display: "inline-flex", alignItems: "center", gap: "6px", fontSize: '10px', color: 'var(--text-secondary)', opacity: 0.5, marginTop: '-10px', marginBottom: '4px' }}>
                <AgentIcon agentName={item.agent || ""} style={{ width: "12px", height: "12px" }} />
                <span>{time}</span>
              </span>
            )}
          </div>
        )}
      </div>
    );
  };

  React.useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
  }, [timeline, isStreaming]);

  return (
    <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "20px 16px", display: "flex", flexDirection: "column", gap: "12px", minWidth: 0 }}>
      {timeline.map((item, i) => renderTimelineItem(item, i))}
      {(isStreaming || isAwaiting) && (
        <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "var(--text-secondary)" }}>
          <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "var(--accent-color)", animation: "pulse 1s infinite" }} />
          {isStreaming ? "正在生成..." : "已发送，等待响应..."}
        </div>
      )}
      
      <div ref={messagesEndRef} />
    </div>
  );
};

const AgentInputNode: React.FC<ComponentProps> = ({ element }) => {
  const [input, setInput] = React.useState("");
  const onSend = element.props?.onSend as (msg: string) => void;
  return (
    <div style={{ padding: "12px 16px", borderTop: "1px solid var(--border-color)", display: "flex", gap: "8px" }}>
      <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (input.trim()) { onSend(input); setInput(""); } } }} placeholder="输入消息..." style={{ flex: 1, padding: "10px 12px", borderRadius: "8px", border: "1px solid var(--border-color)", fontSize: "13px", resize: "none", minHeight: "40px", maxHeight: "120px" }} />
      <button onClick={() => { if (input.trim()) { onSend(input); setInput(""); } }} style={{ padding: "10px 20px", borderRadius: "8px", border: "none", background: "#3b82f6", color: "#fff", fontSize: "13px", cursor: "pointer" }}>发送</button>
    </div>
  );
};

const AgentBubbleNode: React.FC<ComponentProps> = ({ element }) => (
  <AgentBubble
    session={(element.props?.session as any) ?? null}
    index={(element.props?.index as number) ?? 0}
    isStreaming={(element.props?.isStreaming as boolean) ?? false}
    onClick={(element.props?.onClick as any) ?? undefined}
  />
);

const AssociationViewNode: React.FC<ComponentProps> = ({ element }) => {
  const { execute } = useActions();
  return (
    <AssociationView title={(element.props?.title as string) ?? undefined} files={(element.props?.files as any[]) ?? []} onFileClick={(path) => execute({ name: "open", params: { path } })} onSessionClick={(key) => execute({ name: "select_session", params: { key } })} />
  );
};

export const registry = { Shell, Sidebar, Main, Footer, Container, RightSidebar: RightSidebarNode, FileTree: FileTreeNode, DefaultListView: DefaultListNode, FileViewer: FileViewerNode, ActionBar: ActionBarNode, SessionList: SessionListNode, SessionViewer: SessionViewerNode, AgentPanel: AgentPanelNode, AgentHeader: AgentHeaderNode, AgentMessageList: AgentMessageListNode, AgentInput: AgentInputNode, AgentBubble: AgentBubbleNode, AssociationView: AssociationViewNode };

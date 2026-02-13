// Session service for managing agent sessions

export type SessionType = "chat" | "view" | "skill";

export type SessionStatus = "active" | "idle" | "closed";

export type Session = {
  key: string;
  type: SessionType;
  agent: string;
  name: string;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
  closed_at?: string;
  summary?: {
    title: string;
    description: string;
    key_actions: string[];
    outputs: string[];
  };
  related_files?: Array<{
    path: string;
    action: string;
  }>;
};

export type ToolCallLocation = {
  path: string;
  line?: number;
};

export type ToolCallContentItem =
  | {
      type: "text";
      text?: string;
    }
  | {
      type: "diff";
      path?: string;
      oldText?: string;
      newText?: string;
    };

export type ToolCall = {
  callId: string;
  name: string;
  status: string;
  kind: string;
  content?: ToolCallContentItem[];
  locations?: ToolCallLocation[];
};

export type StreamEvent =
  | { type: "message_chunk"; data: { content: string } }
  | { type: "thought_chunk"; data: { content: string } }
  | { type: "tool_call"; data: ToolCall }
  | { type: "tool_call_update"; data: ToolCall }
  | { type: "message_done"; data?: Record<string, never> }
  | { type: "error"; data: { message: string } };

export type PermissionRequest = {
  requestId: string;
  permission: string;
  resource?: string;
  action?: string;
};

type SessionEventHandler = {
  onStream?: (event: StreamEvent) => void;
  onDone?: () => void;
  onError?: (error: string) => void;
  onPermissionRequest?: (req: PermissionRequest) => void;
};

type SessionServiceEvent = {
  type: string;
  sessionKey?: string;
};

class SessionService {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, SessionEventHandler>();
  private listeners = new Set<(event: SessionServiceEvent) => void>();
  private reconnectTimer: number | null = null;
  private rootId: string | null = null;
  private contextCache = new Map<
    string,
    { currentPath: string; selectionKey: string }
  >();

  connect(rootId: string) {
    if (this.ws?.readyState === WebSocket.OPEN && this.rootId === rootId) {
      return;
    }

    this.rootId = rootId;
    this.disconnect();

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log("[Session] WebSocket connected");
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleMessage(msg);
      } catch (err) {
        console.error("[Session] Failed to parse message:", err);
      }
    };

    this.ws.onclose = () => {
      console.log("[Session] WebSocket closed");
      this.scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      console.error("[Session] WebSocket error:", err);
    };
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.contextCache.clear();
  }

  private buildSelectionKey(selection: unknown): string {
    if (!selection || typeof selection !== "object") return "";
    const raw = selection as Record<string, unknown>;
    const filePath = typeof raw.file_path === "string" ? raw.file_path : "";
    const start = typeof raw.start === "number" ? raw.start : -1;
    const end = typeof raw.end === "number" ? raw.end : -1;
    const text = typeof raw.text === "string" ? raw.text : "";
    return `${filePath}:${start}:${end}:${text}`;
  }

  private compactContext(
    sessionKey: string,
    context?: Record<string, unknown>
  ): Record<string, unknown> | undefined {
    if (!context) return undefined;
    const next = { ...context };
    const currentPath =
      typeof next.currentPath === "string"
        ? next.currentPath
        : typeof next.current_path === "string"
        ? (next.current_path as string)
        : "";
    const selection =
      next.selection && typeof next.selection === "object"
        ? (next.selection as Record<string, unknown>)
        : undefined;
    const selectionKey = this.buildSelectionKey(selection);

    const prev = this.contextCache.get(sessionKey);
    if (prev && prev.currentPath === currentPath) {
      delete next.currentPath;
      delete next.current_path;
    }
    if (prev && prev.selectionKey === selectionKey) {
      delete next.selection;
    }
    this.contextCache.set(sessionKey, { currentPath, selectionKey });
    return next;
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.rootId) {
        this.connect(this.rootId);
      }
    }, 3000);
  }

  private handleMessage(msg: any) {
    const type = msg.type as string;
    const payload = msg.payload || {};
    const sessionKey = payload.session_key as string;
    this.emit({ type, sessionKey });

    if (!sessionKey) return;

    const handler = this.handlers.get(sessionKey);
    if (!handler) return;

    switch (type) {
      case "session.stream":
        handler.onStream?.(payload.event as StreamEvent);
        break;
      case "session.done":
        handler.onDone?.();
        break;
      case "session.error":
        handler.onError?.(msg.error?.message || "Unknown error");
        break;
      case "permission.request":
        handler.onPermissionRequest?.(payload as PermissionRequest);
        break;
    }
  }

  subscribeEvents(listener: (event: SessionServiceEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: SessionServiceEvent) {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  subscribe(sessionKey: string, handler: SessionEventHandler) {
    this.handlers.set(sessionKey, handler);
    return () => {
      this.handlers.delete(sessionKey);
    };
  }

  async createSession(
    rootId: string,
    type: SessionType,
    agent: string
  ): Promise<Session | null> {
    try {
      const res = await fetch(`/api/sessions?root=${encodeURIComponent(rootId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          agent,
        }),
      });
      if (!res.ok) {
        throw new Error("Failed to create session");
      }
      const data = await res.json();
      return data as Session;
    } catch (err) {
      console.error("[Session] Failed to create session:", err);
      return null;
    }
  }

  async sendMessage(
    rootId: string,
    sessionKey: string,
    content: string,
    context?: Record<string, unknown>
  ): Promise<boolean> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error("[Session] WebSocket not connected");
      return false;
    }

    const msg = {
      id: `msg-${Date.now()}`,
      type: "session.message",
      payload: {
        root_id: rootId,
        session_key: sessionKey,
        content,
        context: this.compactContext(sessionKey, context),
      },
    };

    this.ws.send(JSON.stringify(msg));
    return true;
  }

  async respondToPermission(
    sessionKey: string,
    requestId: string,
    granted: boolean
  ): Promise<boolean> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    const msg = {
      id: `perm-${Date.now()}`,
      type: "permission.response",
      payload: {
        session_key: sessionKey,
        request_id: requestId,
        granted,
      },
    };

    this.ws.send(JSON.stringify(msg));
    return true;
  }

  async fetchSessions(rootId: string): Promise<Session[]> {
    try {
      const res = await fetch(
        `/api/sessions?root=${encodeURIComponent(rootId)}`
      );
      if (!res.ok) {
        throw new Error("Failed to fetch sessions");
      }
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch (err) {
      console.error("[Session] Failed to fetch sessions:", err);
      return [];
    }
  }

  async getSession(rootId: string, sessionKey: string): Promise<Session | null> {
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionKey)}?root=${encodeURIComponent(rootId)}`
      );
      if (!res.ok) {
        throw new Error("Failed to get session");
      }
      const data = await res.json();
      return data as Session;
    } catch (err) {
      console.error("[Session] Failed to get session:", err);
      return null;
    }
  }
}

export const sessionService = new SessionService();

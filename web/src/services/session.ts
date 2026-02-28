// Session service for managing agent sessions

export type SessionType = "chat" | "view" | "skill";

export type Session = {
  key: string;
  type: SessionType;
  agent?: string;
  name: string;
  created_at: string;
  updated_at: string;
  closed_at?: string;
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
  title?: string;
  status: string;
  kind: string;
  content?: ToolCallContentItem[];
  locations?: ToolCallLocation[];
  meta?: Record<string, unknown>;
  rawType?: string;
};

export type StreamEvent =
  | { type: "message_chunk"; data: { content: string } }
  | { type: "thought_chunk"; data: { content: string } }
  | { type: "tool_call"; data: ToolCall }
  | { type: "tool_call_update"; data: ToolCall }
  | { type: "message_done"; data?: Record<string, never> }
  | { type: "error"; data: { message: string } };

type SessionEventHandler = {
  onStream?: (event: StreamEvent) => void;
  onDone?: () => void;
  onError?: (error: string) => void;
};

type SessionServiceEvent = {
  type: string;
  sessionKey?: string;
  payload?: Record<string, unknown>;
};

class SessionService {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<SessionEventHandler>>();
  private pendingStreams = new Map<string, StreamEvent[]>();
  private listeners = new Set<(event: SessionServiceEvent) => void>();
  private reconnectTimer: number | null = null;
  private rootId: string | null = null;
  private hasConnected = false;
  private readonly clientId = this.generateClientId();
  private contextCache = new Map<
    string,
    { currentPath: string; selectionKey: string }
  >();

  private generateClientId(): string {
    return `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private buildWSUrl(): string {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/ws?client_id=${encodeURIComponent(this.clientId)}`;
  }

  connect(rootId: string) {
    if (this.ws?.readyState === WebSocket.OPEN && this.rootId === rootId) {
      return;
    }

    this.rootId = rootId;
    this.disconnect();

    this.ws = new WebSocket(this.buildWSUrl());

    this.ws.onopen = () => {
      if (this.hasConnected) {
        this.emit({ type: "ws.reconnected" });
      } else {
        this.emit({ type: "ws.connected" });
      }
      this.hasConnected = true;
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
    sessionKey: string | undefined,
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

    if (sessionKey) {
      const prev = this.contextCache.get(sessionKey);
      if (prev && prev.currentPath === currentPath) {
        delete next.currentPath;
        delete next.current_path;
      }
      if (prev && prev.selectionKey === selectionKey) {
        delete next.selection;
      }
      this.contextCache.set(sessionKey, { currentPath, selectionKey });
    }
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
    this.emit({ type, sessionKey, payload });

    if (!sessionKey) return;

    const handlers = this.handlers.get(sessionKey);
    if ((!handlers || handlers.size === 0) && type === "session.stream") {
      const event = payload.event as StreamEvent;
      if (event) {
        const queued = this.pendingStreams.get(sessionKey) || [];
        queued.push(event);
        this.pendingStreams.set(sessionKey, queued);
      }
      return;
    }
    if (!handlers || handlers.size === 0) return;

    switch (type) {
      case "session.stream":
        for (const handler of handlers) {
          handler.onStream?.(payload.event as StreamEvent);
        }
        break;
      case "session.done":
        for (const handler of handlers) {
          handler.onDone?.();
        }
        break;
      case "session.error":
        for (const handler of handlers) {
          handler.onError?.(msg.error?.message || "Unknown error");
        }
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
    let set = this.handlers.get(sessionKey);
    if (!set) {
      set = new Set<SessionEventHandler>();
      this.handlers.set(sessionKey, set);
    }
    set.add(handler);

    const queued = this.pendingStreams.get(sessionKey);
    if (queued && queued.length > 0) {
      for (const event of queued) {
        handler.onStream?.(event);
      }
      this.pendingStreams.delete(sessionKey);
    }

    return () => {
      const current = this.handlers.get(sessionKey);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) {
        this.handlers.delete(sessionKey);
      }
    };
  }

  async sendMessage(
    rootId: string,
    sessionKey: string | undefined,
    content: string,
    type: SessionType,
    agent: string,
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
        session_key: sessionKey || undefined,
        content,
        type,
        agent,
        context: this.compactContext(sessionKey, context),
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
      const params = new URLSearchParams({
        root: rootId,
        client_id: this.clientId,
      });
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionKey)}?${params.toString()}`
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

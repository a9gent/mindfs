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

export type StreamChunk = {
  type: "text" | "thinking" | "tool_call" | "tool_result" | "progress" | "file_start" | "file_done" | "done" | "error";
  content?: string;
  tool?: string;
  path?: string;
  percent?: number;
  error?: string;
};

export type PermissionRequest = {
  requestId: string;
  permission: string;
  resource?: string;
  action?: string;
};

type SessionEventHandler = {
  onStream?: (chunk: StreamChunk) => void;
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
        handler.onStream?.(payload.chunk as StreamChunk);
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
      return data.session as Session;
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
        context,
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
      return Array.isArray(data.sessions) ? data.sessions : [];
    } catch (err) {
      console.error("[Session] Failed to fetch sessions:", err);
      return [];
    }
  }

  async getSession(sessionKey: string): Promise<Session | null> {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionKey)}`);
      if (!res.ok) {
        throw new Error("Failed to get session");
      }
      const data = await res.json();
      return data.session as Session;
    } catch (err) {
      console.error("[Session] Failed to get session:", err);
      return null;
    }
  }
}

export const sessionService = new SessionService();

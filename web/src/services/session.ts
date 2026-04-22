import { appURL, wsURL } from "./base";
import { e2eeService } from "./e2ee";

// Session service for managing agent sessions

export type SessionType = "chat" | "plugin";

export type RelatedFile = {
  path: string;
  relation?: string;
  created_by_session?: boolean;
};

export type Session = {
  key: string;
  type: SessionType;
  agent?: string;
  model?: string;
  mode?: string;
  effort?: string;
  name: string;
  created_at: string;
  updated_at: string;
  closed_at?: string;
  related_files?: RelatedFile[];
  exchanges?: Array<{
    seq?: number;
    role?: string;
    agent?: string;
    model?: string;
    mode?: string;
    effort?: string;
    content?: string;
    timestamp?: string;
    toolCall?: ToolCall;
    pending_ack?: boolean;
  }>;
};

export type SessionSearchHit = {
  key: string;
  type: SessionType;
  agent?: string;
  model?: string;
  name: string;
  created_at: string;
  updated_at: string;
  closed_at?: string;
  match_type: "name" | "user" | "reply";
  match_score: number;
  seq: number;
  snippet?: string;
};

export type ToolCallLocation = {
  path: string;
  line?: number;
};

export type ToolCallContentItem =
  | {
      type: "text";
      text?: string;
      path?: string;
      changeKind?: string;
    }
  | {
      type: "diff";
      path?: string;
      oldText?: string;
      newText?: string;
      changeKind?: string;
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

export type SyncSessionResult = {
  session: Session | null;
  hasDelta: boolean;
};

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

type FetchSessionsOptions = {
  beforeTime?: string;
  afterTime?: string;
};

export type FetchExternalSessionsOptions = {
  beforeTime?: string;
  afterTime?: string;
  filterBound?: boolean;
  limit?: number;
};

type PendingMessage = {
  id: string;
  message: Record<string, unknown>;
};

class SessionService {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<SessionEventHandler>>();
  private pendingStreams = new Map<string, StreamEvent[]>();
  private pendingMessages = new Map<string, PendingMessage>();
  private listeners = new Set<(event: SessionServiceEvent) => void>();
  private reconnectTimer: number | null = null;
  private probeTimeoutTimer: number | null = null;
  private activeProbeId: string | null = null;
  private reconnectDelayMs = 1000;
  private fastReconnectUntil = 0;
  private rootId: string | null = null;
  private hasConnected = false;
  private readonly clientId = this.generateClientId();
  private readonly maxReconnectDelayMs = 30000;
  private readonly fastReconnectDelayMs = 1000;
  private readonly fastReconnectWindowMs = 10000;
  private readonly probeTimeoutMs = 2000;
  private contextCache = new Map<string, { selectionKey: string }>();

  constructor() {
    e2eeService.setClientId(this.clientId);
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => this.ensureConnection());
      window.addEventListener("pageshow", () => this.ensureConnection());
      window.addEventListener("focus", () => this.ensureConnection());
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
          this.ensureConnection();
        }
      });
    }
  }

  private generateClientId(): string {
    return `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  createRequestId(prefix = "msg"): string {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return `${prefix}-${crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private buildWSUrl(): string {
    return wsURL("/ws", new URLSearchParams({ client_id: this.clientId }));
  }

  connect(rootId: string) {
    this.rootId = rootId;
    if (
      this.ws?.readyState === WebSocket.OPEN ||
      this.ws?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }

    this.clearReconnectTimer();
    this.closeSocket();

    const ws = new WebSocket(this.buildWSUrl());
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.clearProbe();
      this.reconnectDelayMs = 1000;
      if (this.hasConnected) {
        this.emit({ type: "ws.reconnected" });
      } else {
        this.emit({ type: "ws.connected" });
      }
      this.hasConnected = true;
      if (e2eeService.isRequired() && e2eeService.hasSecret()) {
        void e2eeService.ensureSession().catch((err) => {
          console.error("[Session] Failed to open E2EE session:", err);
        });
      }
      this.resendPendingMessages();
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      this.clearProbe();
      void (async () => {
        try {
          const msg = await this.parseWSMessage(event.data);
          if (!msg) {
            return;
          }
          this.handleMessage(msg);
        } catch (err) {
          console.error("[Session] Failed to parse message:", err);
        }
      })();
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.fastReconnectUntil = Date.now() + this.fastReconnectWindowMs;
      this.scheduleReconnect();
    };

    ws.onerror = (err) => {
      if (this.ws !== ws) return;
      console.error("[Session] WebSocket error:", err);
    };
  }

  disconnect() {
    this.clearReconnectTimer();
    this.clearProbe();
    this.closeSocket();
    this.contextCache.clear();
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearProbe() {
    if (this.probeTimeoutTimer) {
      clearTimeout(this.probeTimeoutTimer);
      this.probeTimeoutTimer = null;
    }
    this.activeProbeId = null;
  }

  private closeSocket() {
    this.clearProbe();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.onopen = null;
      ws.close();
    }
  }

  private ensureConnection() {
    if (!this.rootId) return;
    if (!this.ws || this.ws.readyState >= WebSocket.CLOSING) {
      this.reconnectNow();
      return;
    }
    if (this.ws.readyState === WebSocket.CONNECTING) return;
    this.probeConnection();
  }

  private reconnectNow() {
    if (!this.rootId) return;
    this.clearReconnectTimer();
    this.clearProbe();
    this.reconnectDelayMs = 1000;
    this.fastReconnectUntil = Date.now() + this.fastReconnectWindowMs;
    this.connect(this.rootId);
  }

  private probeConnection() {
    if (!this.rootId || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.reconnectNow();
      return;
    }
    if (this.activeProbeId) return;
    const probeId = this.createRequestId("ping");
    this.activeProbeId = probeId;
    void this.sendWSMessage({
      id: probeId,
      type: "ping",
      payload: {},
    }).catch((err) => {
      console.error("[Session] Failed to send probe:", err);
    });
    this.probeTimeoutTimer = window.setTimeout(() => {
      if (this.activeProbeId !== probeId) return;
      console.warn("[Session] WebSocket probe timed out, reconnecting");
      this.clearProbe();
      this.reconnectNow();
    }, this.probeTimeoutMs);
  }

  private buildSelectionKey(selection: unknown): string {
    if (!selection || typeof selection !== "object") return "";
    const raw = selection as Record<string, unknown>;
    const filePath = typeof raw.file_path === "string" ? raw.file_path : "";
    const startLine = typeof raw.start_line === "number" ? raw.start_line : -1;
    const endLine = typeof raw.end_line === "number" ? raw.end_line : -1;
    const text = typeof raw.text === "string" ? raw.text : "";
    return `${filePath}:${startLine}:${endLine}:${text}`;
  }

  private compactContext(
    sessionKey: string | undefined,
    context?: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    if (!context) return undefined;
    const next = { ...context };
    const selection =
      next.selection && typeof next.selection === "object"
        ? (next.selection as Record<string, unknown>)
        : undefined;
    const selectionKey = this.buildSelectionKey(selection);

    if (sessionKey) {
      const prev = this.contextCache.get(sessionKey);
      if (prev && prev.selectionKey === selectionKey) {
        delete next.selection;
      }
      this.contextCache.set(sessionKey, { selectionKey });
    }
    return next;
  }

  private scheduleReconnect() {
    if (!this.rootId) return;
    if (this.reconnectTimer) return;
    const isFastReconnect = Date.now() < this.fastReconnectUntil;
    const delay = isFastReconnect
      ? this.fastReconnectDelayMs
      : this.reconnectDelayMs;
    if (!isFastReconnect) {
      this.reconnectDelayMs = Math.min(
        this.reconnectDelayMs * 2,
        this.maxReconnectDelayMs,
      );
    }
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.rootId) {
        this.connect(this.rootId);
      }
    }, delay);
  }

  private handleMessage(msg: any) {
    const type = msg.type as string;
    const payload = msg.payload || {};
    if (type === "pong") {
      return;
    }
    if (type === "e2ee.error") {
      const code = typeof payload.code === "string" ? payload.code : "";
      e2eeService.handleServerError(code);
      this.emit({ type, payload });
      return;
    }
    const sessionKey = payload.session_key as string;
    if (type === "session.accepted") {
      const requestId =
        typeof payload.request_id === "string"
          ? payload.request_id
          : typeof msg.id === "string"
            ? msg.id
            : "";
      if (requestId) {
        this.pendingMessages.delete(requestId);
      }
    } else if (type === "session.error" && typeof msg.id === "string") {
      this.pendingMessages.delete(msg.id);
      payload.request_id = msg.id;
    }
    this.emitDecrypted(type, sessionKey, payload, msg);
  }

  private emitDecrypted(type: string, sessionKey: string, payload: Record<string, unknown>, msg: any) {
    const nextPayload = { ...payload };
    this.emit({ type, sessionKey, payload: nextPayload });

    if (!sessionKey) return;

    const handlers = this.handlers.get(sessionKey);
    if ((!handlers || handlers.size === 0) && type === "session.stream") {
      const event = nextPayload.event as StreamEvent;
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
          handler.onStream?.(nextPayload.event as StreamEvent);
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

  private async parseWSMessage(raw: unknown): Promise<any | null> {
    if (typeof raw !== "string") {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!e2eeService.isRequired() || parsed?.type === "e2ee.error") {
      return parsed;
    }
    return e2eeService.decodeWSMessage<any>(raw);
  }

  private async sendWSMessage(message: Record<string, unknown>): Promise<boolean> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    let serialized = JSON.stringify(message);
    if (e2eeService.isRequired()) {
      await e2eeService.ensureSession();
      serialized = await e2eeService.encodeWSMessage(message);
    }
    this.ws.send(serialized);
    return true;
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
    model?: string,
    agentMode?: string,
    effort?: string,
    context?: Record<string, unknown>,
    requestId = this.createRequestId("msg"),
  ): Promise<boolean> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error("[Session] WebSocket not connected");
      return false;
    }

    const msg = {
      id: requestId,
      type: "session.message",
      payload: {
        root_id: rootId,
        session_key: sessionKey || undefined,
        content,
        type,
        agent,
        model,
        agent_mode: agentMode,
        effort,
        context: this.compactContext(sessionKey, context),
      },
    };

    this.pendingMessages.set(requestId, { id: requestId, message: msg });
    return this.sendWSMessage(msg);
  }

  private resendPendingMessages() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    for (const pending of this.pendingMessages.values()) {
      void this.sendWSMessage(pending.message).catch((err) => {
        console.error("[Session] Failed to resend message:", err);
      });
    }
  }

  async cancelMessage(rootId: string, sessionKey: string): Promise<boolean> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error("[Session] WebSocket not connected");
      return false;
    }
    if (!rootId || !sessionKey) {
      return false;
    }

    const msg = {
      id: `cancel-${Date.now()}`,
      type: "session.cancel",
      payload: {
        root_id: rootId,
        session_key: sessionKey,
      },
    };

    return this.sendWSMessage(msg);
  }

  async markSessionReady(rootId: string, sessionKey: string): Promise<boolean> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    if (!rootId || !sessionKey) {
      return false;
    }
    if (e2eeService.isRequired()) {
      await e2eeService.ensureSession();
    }
    return this.sendWSMessage({
      id: `ready-${Date.now()}`,
      type: "session.ready",
      payload: {
        root_id: rootId,
        session_key: sessionKey,
      },
    });
  }

  async fetchSessions(
    rootId: string,
    options?: FetchSessionsOptions,
  ): Promise<Session[]> {
    try {
      const params = new URLSearchParams({ root: rootId });
      if (options?.beforeTime) {
        params.set("before_time", options.beforeTime);
      }
      if (options?.afterTime) {
        params.set("after_time", options.afterTime);
      }
      const res = await fetch(appURL("/api/sessions", params));
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

  async searchSessions(
    rootId: string,
    query: string,
    limit?: number,
  ): Promise<SessionSearchHit[]> {
    try {
      const trimmed = query.trim();
      if (!rootId || !trimmed) {
        return [];
      }
      const params = new URLSearchParams({ root: rootId, q: trimmed });
      if (typeof limit === "number" && limit > 0) {
        params.set("limit", String(limit));
      }
      const res = await fetch(appURL("/api/sessions/search", params));
      if (!res.ok) {
        throw new Error("Failed to search sessions");
      }
      const data = await res.json();
      return Array.isArray(data?.items) ? (data.items as SessionSearchHit[]) : [];
    } catch (err) {
      console.error("[Session] Failed to search sessions:", err);
      return [];
    }
  }

  async getSession(
    rootId: string,
    sessionKey: string,
    seq?: number,
  ): Promise<Session | null> {
    try {
      const params = new URLSearchParams({ root: rootId });
      if (typeof seq === "number" && seq > 0) {
        params.set("seq", String(seq));
      }
      if (e2eeService.isRequired()) {
        if (!(await e2eeService.ensureSession())) {
          return null;
        }
      }
      const headers = e2eeService.isRequired()
        ? e2eeService.sessionProtectedHeaders()
        : undefined;
      const res = await fetch(appURL(`/api/sessions/${encodeURIComponent(sessionKey)}`, params), {
        headers,
      });
      if (!res.ok) {
        if (res.status === 401 && e2eeService.isRequired()) {
          const payload = (await res.json().catch(() => ({}))) as { error?: string };
          if (e2eeService.handleServerError(String(payload.error || ""))) {
            return this.getSession(rootId, sessionKey, seq);
          }
        }
        throw new Error("Failed to get session");
      }
      const data = await (e2eeService.isRequired()
        ? e2eeService.parseProtectedJSONResponse<Session>(res)
        : res.json());
      return data as Session;
    } catch (err) {
      console.error("[Session] Failed to get session:", err);
      return null;
    }
  }

  async getSessionRelatedFiles(
    rootId: string,
    sessionKey: string,
  ): Promise<RelatedFile[]> {
    try {
      const params = new URLSearchParams({
        root: rootId,
      });
      const res = await fetch(
        appURL(
          `/api/sessions/${encodeURIComponent(sessionKey)}/related-files`,
          params,
        ),
      );
      if (!res.ok) {
        throw new Error("Failed to get session related files");
      }
      const data = await res.json();
      return Array.isArray(data) ? (data as RelatedFile[]) : [];
    } catch (err) {
      console.error("[Session] Failed to get session related files:", err);
      return [];
    }
  }

  async removeSessionRelatedFile(
    rootId: string,
    sessionKey: string,
    path: string,
  ): Promise<boolean> {
    try {
      const params = new URLSearchParams({ root: rootId, path });
      const res = await fetch(
        appURL(
          `/api/sessions/${encodeURIComponent(sessionKey)}/related-files`,
          params,
        ),
        { method: "DELETE" },
      );
      if (!res.ok) {
        throw new Error("Failed to remove session related file");
      }
      return true;
    } catch (err) {
      console.error("[Session] Failed to remove session related file:", err);
      return false;
    }
  }

  async deleteSession(rootId: string, sessionKey: string): Promise<boolean> {
    try {
      const params = new URLSearchParams({ root: rootId });
      const res = await fetch(
        appURL(`/api/sessions/${encodeURIComponent(sessionKey)}`, params),
        { method: "DELETE" },
      );
      if (!res.ok) {
        throw new Error("Failed to delete session");
      }
      return true;
    } catch (err) {
      console.error("[Session] Failed to delete session:", err);
      return false;
    }
  }

  async renameSession(
    rootId: string,
    sessionKey: string,
    name: string,
  ): Promise<Session | null> {
    try {
      const params = new URLSearchParams({ root: rootId });
      const res = await fetch(
        appURL(`/api/sessions/${encodeURIComponent(sessionKey)}/rename`, params),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name }),
        },
      );
      if (!res.ok) {
        throw new Error("Failed to rename session");
      }
      const data = await res.json();
      return data as Session;
    } catch (err) {
      console.error("[Session] Failed to rename session:", err);
      return null;
    }
  }

  async fetchExternalSessions(
    rootId: string,
    agent: string,
    options?: FetchExternalSessionsOptions,
  ): Promise<Session[]> {
    try {
      if (!rootId || !agent) {
        return [];
      }
      const params = new URLSearchParams({ root: rootId, agent });
      if (options?.beforeTime) {
        params.set("before_time", options.beforeTime);
      }
      if (options?.afterTime) {
        params.set("after_time", options.afterTime);
      }
      if (options?.filterBound) {
        params.set("filter_bound", "true");
      }
      if (typeof options?.limit === "number" && options.limit > 0) {
        params.set("limit", String(options.limit));
      }
      const res = await fetch(appURL("/api/sessions/external", params));
      if (!res.ok) {
        throw new Error("Failed to fetch external sessions");
      }
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch (err) {
      console.error("[Session] Failed to fetch external sessions:", err);
      return [];
    }
  }

  async importExternalSession(
    rootId: string,
    agent: string,
    agentSessionId: string,
  ): Promise<{ session_key: string } | null> {
    try {
      const res = await fetch(appURL("/api/sessions/import"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          root_id: rootId,
          agent,
          agent_session_id: agentSessionId,
        }),
      });
      if (!res.ok) {
        throw new Error("Failed to import external session");
      }
      return await res.json();
    } catch (err) {
      console.error("[Session] Failed to import external session:", err);
      return null;
    }
  }

}

export const sessionService = new SessionService();

type CachedSessionRecord = {
  cacheKey: string;
  rootId: string;
  sessionKey: string;
  touchedAt: number;
  session: Session;
};

const SESSION_CACHE_DB = "mindfs-session-cache";
const SESSION_CACHE_STORE = "sessions";
const SESSION_CACHE_VERSION = 2;
let sessionDBPromise: Promise<IDBDatabase> | null = null;

function buildSessionCacheKey(rootId: string, sessionKey: string): string {
  return `${rootId}::${sessionKey}`;
}

function openSessionDB(): Promise<IDBDatabase> {
  if (typeof window === "undefined" || !("indexedDB" in window)) {
    return Promise.reject(new Error("indexeddb unavailable"));
  }
  if (sessionDBPromise) {
    return sessionDBPromise;
  }
  sessionDBPromise = new Promise((resolve, reject) => {
    const request = window.indexedDB.open(
      SESSION_CACHE_DB,
      SESSION_CACHE_VERSION,
    );
    request.onerror = () =>
      reject(request.error || new Error("failed to open indexeddb"));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains(SESSION_CACHE_STORE)) {
        db.deleteObjectStore(SESSION_CACHE_STORE);
      }
      db.createObjectStore(SESSION_CACHE_STORE, { keyPath: "cacheKey" });
    };
    request.onsuccess = () => resolve(request.result);
  });
  return sessionDBPromise;
}

function sessionRequestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("indexeddb request failed"));
  });
}

function withSessionStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  return openSessionDB().then((db) => {
    const tx = db.transaction(SESSION_CACHE_STORE, mode);
    const store = tx.objectStore(SESSION_CACHE_STORE);
    const completion = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(tx.error || new Error("indexeddb transaction failed"));
      tx.onabort = () =>
        reject(tx.error || new Error("indexeddb transaction aborted"));
    });
    return run(store).then(async (result) => {
      await completion;
      return result;
    });
  });
}

function getSessionMaxSeq(session: Session | null | undefined): number {
  const exchanges = Array.isArray(session?.exchanges) ? session.exchanges : [];
  return exchanges.reduce((max, exchange) => {
    const seq = Number((exchange as any)?.seq || 0);
    return Number.isFinite(seq) && seq > max ? seq : max;
  }, 0);
}

function preferIncomingText(next?: string, prev?: string) {
  const normalizedNext = (next || "").trim();
  if (normalizedNext) {
    return next;
  }
  return prev;
}

function withSessionMeta(
  base: Session | null | undefined,
  incoming: Session | null | undefined,
): Session | null {
  if (!base && !incoming) {
    return null;
  }
  if (!base) {
    return incoming
      ? {
          ...incoming,
          exchanges: Array.isArray(incoming.exchanges)
            ? [...incoming.exchanges]
            : [],
        }
      : null;
  }
  if (!incoming) {
    return {
      ...base,
      exchanges: Array.isArray(base.exchanges) ? [...base.exchanges] : [],
    };
  }
  return {
    ...base,
    ...incoming,
    agent: preferIncomingText(incoming.agent, base.agent),
    model: preferIncomingText((incoming as any).model, (base as any).model),
    mode: preferIncomingText((incoming as any).mode, (base as any).mode),
    name: preferIncomingText(incoming.name, base.name) || "",
    exchanges: Array.isArray(incoming.exchanges) ? [...incoming.exchanges] : [],
  };
}

function appendSessionDelta(
  base: Session | null | undefined,
  incoming: Session | null | undefined,
): Session | null {
  const baseWithMeta = withSessionMeta(base, incoming);
  if (!baseWithMeta) {
    return null;
  }
  const baseExchanges = Array.isArray(base?.exchanges)
    ? base.exchanges.filter(
        (exchange) => Number((exchange as any)?.seq || 0) > 0,
      )
    : [];
  const incomingExchanges = Array.isArray(incoming?.exchanges)
    ? incoming.exchanges.filter(
        (exchange) => Number((exchange as any)?.seq || 0) > 0,
      )
    : [];
  return {
    ...baseWithMeta,
    exchanges: [...baseExchanges, ...incomingExchanges],
  };
}

async function loadCachedSession(
  rootId: string,
  sessionKey: string,
): Promise<Session | null> {
  try {
    const record = await withSessionStore("readonly", (store) =>
      sessionRequestToPromise(
        store.get(buildSessionCacheKey(rootId, sessionKey)) as IDBRequest<
          CachedSessionRecord | undefined
        >,
      ),
    );
    return record?.session || null;
  } catch {
    return null;
  }
}

async function saveCachedSession(
  rootId: string,
  session: Session | null | undefined,
): Promise<void> {
  if (!rootId || !session?.key) {
    return;
  }
  const persistentSession = toPersistentSession(session);
  const record: CachedSessionRecord = {
    cacheKey: buildSessionCacheKey(rootId, session.key),
    rootId,
    sessionKey: session.key,
    touchedAt: Date.now(),
    session: persistentSession,
  };
  try {
    await withSessionStore("readwrite", (store) =>
      sessionRequestToPromise(store.put(record)),
    );
  } catch {}
}

export async function deleteCachedSession(
  rootId: string,
  sessionKey: string,
): Promise<void> {
  try {
    await withSessionStore("readwrite", (store) =>
      sessionRequestToPromise(
        store.delete(buildSessionCacheKey(rootId, sessionKey)),
      ),
    );
  } catch {}
}

function cloneSession(session: Session): Session {
  return {
    ...session,
    related_files: Array.isArray(session.related_files)
      ? [...session.related_files]
      : [],
    exchanges: Array.isArray(session.exchanges) ? [...session.exchanges] : [],
  };
}

function toPersistentSession(session: Session): Session {
  return {
    ...session,
    exchanges: Array.isArray(session.exchanges)
      ? session.exchanges.filter((exchange) => {
          const seq = Number((exchange as any)?.seq || 0);
          return Number.isFinite(seq) && seq > 0;
        })
      : [],
  };
}

export async function getCachedSession(
  rootId: string,
  sessionKey: string,
): Promise<Session | null> {
  const cached = await loadCachedSession(rootId, sessionKey);
  return cached ? cloneSession(cached) : null;
}

export async function setCachedSessionRelatedFiles(
  rootId: string,
  sessionKey: string,
  relatedFiles: RelatedFile[],
): Promise<Session | null> {
  const cached = await loadCachedSession(rootId, sessionKey);
  if (!cached) {
    return null;
  }
  const next: Session = {
    ...cached,
    related_files: Array.isArray(relatedFiles) ? [...relatedFiles] : [],
  };
  await saveCachedSession(rootId, next);
  return cloneSession(next);
}

export async function syncSession(
  rootId: string,
  sessionKey: string,
): Promise<SyncSessionResult> {
  const base = await getCachedSession(rootId, sessionKey);
  const seq = getSessionMaxSeq(base);
  const incoming = await sessionService.getSession(rootId, sessionKey, seq);
  if (!incoming) {
    return { session: base, hasDelta: false };
  }
  const incomingExchanges = Array.isArray(incoming.exchanges)
    ? incoming.exchanges
    : [];
  const persistedDelta = incomingExchanges.filter((exchange) => {
    const exchangeSeq = Number((exchange as any)?.seq || 0);
    return Number.isFinite(exchangeSeq) && exchangeSeq > 0;
  });
  const transientTail = incomingExchanges.filter(
    (exchange) => Number((exchange as any)?.seq || 0) === 0,
  );
  const persistedSession = appendSessionDelta(base, {
    ...incoming,
    key: sessionKey,
    exchanges: persistedDelta,
  });
  if (!persistedSession) {
    return { session: null, hasDelta: false };
  }
  await saveCachedSession(rootId, persistedSession);
  const displaySession = withSessionMeta(persistedSession, {
    ...incoming,
    key: sessionKey,
    exchanges: [...(persistedSession.exchanges || []), ...transientTail],
  });
  return {
    session: displaySession ? cloneSession(displaySession) : null,
    hasDelta: persistedDelta.length > 0,
  };
}

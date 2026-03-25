import { appURL, wsURL } from "./base";

// Session service for managing agent sessions

export type SessionType = "chat" | "plugin";

export type Session = {
  key: string;
  type: SessionType;
  agent?: string;
  model?: string;
  name: string;
  created_at: string;
  updated_at: string;
  closed_at?: string;
  related_files?: Array<{
    path: string;
    action: string;
  }>;
  exchanges?: Array<{
    seq?: number;
    role?: string;
    agent?: string;
    model?: string;
    content?: string;
    timestamp?: string;
    toolCall?: ToolCall;
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
    { selectionKey: string }
  >();

  private generateClientId(): string {
    return `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private buildWSUrl(): string {
    return wsURL("/ws", new URLSearchParams({ client_id: this.clientId }));
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
    const startLine = typeof raw.start_line === "number" ? raw.start_line : -1;
    const endLine = typeof raw.end_line === "number" ? raw.end_line : -1;
    const text = typeof raw.text === "string" ? raw.text : "";
    return `${filePath}:${startLine}:${endLine}:${text}`;
  }

  private compactContext(
    sessionKey: string | undefined,
    context?: Record<string, unknown>
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
    model?: string,
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
        model,
        context: this.compactContext(sessionKey, context),
      },
    };

    this.ws.send(JSON.stringify(msg));
    return true;
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

    this.ws.send(JSON.stringify(msg));
    return true;
  }

  async markSessionReady(rootId: string, sessionKey: string): Promise<boolean> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    if (!rootId || !sessionKey) {
      return false;
    }
    this.ws.send(JSON.stringify({
      id: `ready-${Date.now()}`,
      type: "session.ready",
      payload: {
        root_id: rootId,
        session_key: sessionKey,
      },
    }));
    return true;
  }

  async fetchSessions(rootId: string, options?: FetchSessionsOptions): Promise<Session[]> {
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

  async getSession(rootId: string, sessionKey: string, seq?: number): Promise<Session | null> {
    try {
      const params = new URLSearchParams({
        root: rootId,
        client_id: this.clientId,
      });
      if (typeof seq === "number" && seq > 0) {
        params.set("seq", String(seq));
      }
      const res = await fetch(
        appURL(`/api/sessions/${encodeURIComponent(sessionKey)}`, params)
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

  async deleteSession(rootId: string, sessionKey: string): Promise<boolean> {
    try {
      const params = new URLSearchParams({ root: rootId });
      const res = await fetch(
        appURL(`/api/sessions/${encodeURIComponent(sessionKey)}`, params),
        { method: "DELETE" }
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
    const request = window.indexedDB.open(SESSION_CACHE_DB, SESSION_CACHE_VERSION);
    request.onerror = () => reject(request.error || new Error("failed to open indexeddb"));
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
    request.onerror = () => reject(request.error || new Error("indexeddb request failed"));
  });
}

function withSessionStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => Promise<T>): Promise<T> {
  return openSessionDB().then((db) => {
    const tx = db.transaction(SESSION_CACHE_STORE, mode);
    const store = tx.objectStore(SESSION_CACHE_STORE);
    const completion = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("indexeddb transaction failed"));
      tx.onabort = () => reject(tx.error || new Error("indexeddb transaction aborted"));
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

function mergeSessionData(base: Session | null | undefined, incoming: Session | null | undefined): Session | null {
  if (!base && !incoming) {
    return null;
  }
  if (!base) {
    return incoming ? { ...incoming, exchanges: Array.isArray(incoming.exchanges) ? [...incoming.exchanges] : [] } : null;
  }
  if (!incoming) {
    return { ...base, exchanges: Array.isArray(base.exchanges) ? [...base.exchanges] : [] };
  }
  const baseExchanges = Array.isArray(base.exchanges) ? base.exchanges : [];
  const incomingExchanges = Array.isArray(incoming.exchanges) ? incoming.exchanges : [];
  const preferIncomingText = (next?: string, prev?: string) => {
    const normalizedNext = (next || "").trim();
    if (normalizedNext) {
      return next;
    }
    return prev;
  };
  const mergedBySeq = new Map<number, NonNullable<Session["exchanges"]>[number]>();
  const extras: NonNullable<Session["exchanges"]> = [];
  const normalizeRole = (role?: string) => (role || "").trim().toLowerCase();
  const normalizeText = (value?: string) => (value || "").trim();
  const toolCallID = (exchange: NonNullable<Session["exchanges"]>[number]) => {
    const toolCall = (exchange as any)?.toolCall;
    if (!toolCall) {
      return "";
    }
    return String((toolCall as ToolCall & { toolCallId?: string; tool_call_id?: string }).callId || (toolCall as any).toolCallId || (toolCall as any).tool_call_id || "").trim();
  };
  const sameExchange = (left: NonNullable<Session["exchanges"]>[number], right: NonNullable<Session["exchanges"]>[number]) => {
    const leftRole = normalizeRole((left as any)?.role);
    const rightRole = normalizeRole((right as any)?.role);
    if (!leftRole || leftRole !== rightRole) {
      return false;
    }
    if (leftRole === "tool") {
      const leftCallID = toolCallID(left);
      const rightCallID = toolCallID(right);
      return !!leftCallID && leftCallID === rightCallID;
    }
    return normalizeText((left as any)?.content) !== "" &&
      normalizeText((left as any)?.content) === normalizeText((right as any)?.content) &&
      normalizeText((left as any)?.agent) === normalizeText((right as any)?.agent);
  };
  const push = (exchange: NonNullable<Session["exchanges"]>[number]) => {
    const seq = Number((exchange as any)?.seq || 0);
    if (Number.isFinite(seq) && seq > 0) {
      mergedBySeq.set(seq, { ...(mergedBySeq.get(seq) || {}), ...exchange });
      return;
    }
    extras.push(exchange);
  };
  baseExchanges.forEach(push);
  incomingExchanges.forEach(push);
  const seqValues = Array.from(mergedBySeq.values());
  const exchanges = Array.from(mergedBySeq.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, exchange]) => exchange)
    .concat(extras.filter((extra) => !seqValues.some((entry) => sameExchange(extra, entry))));
  return {
    ...base,
    ...incoming,
    agent: preferIncomingText(incoming.agent, base.agent),
    model: preferIncomingText((incoming as any).model, (base as any).model),
    name: preferIncomingText(incoming.name, base.name) || "",
    exchanges,
  };
}

async function loadCachedSession(rootId: string, sessionKey: string): Promise<Session | null> {
  try {
    const record = await withSessionStore("readonly", (store) =>
      sessionRequestToPromise(store.get(buildSessionCacheKey(rootId, sessionKey)) as IDBRequest<CachedSessionRecord | undefined>),
    );
    return record?.session || null;
  } catch {
    return null;
  }
}

async function saveCachedSession(rootId: string, session: Session | null | undefined): Promise<void> {
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
    await withSessionStore("readwrite", (store) => sessionRequestToPromise(store.put(record)));
  } catch {
  }
}

export async function deleteCachedSession(rootId: string, sessionKey: string): Promise<void> {
  try {
    await withSessionStore("readwrite", (store) => sessionRequestToPromise(store.delete(buildSessionCacheKey(rootId, sessionKey))));
  } catch {
  }
}

function cloneSession(session: Session): Session {
  return {
    ...session,
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

export async function getCachedSession(rootId: string, sessionKey: string): Promise<Session | null> {
  const cached = await loadCachedSession(rootId, sessionKey);
  return cached ? cloneSession(cached) : null;
}

export async function syncSession(rootId: string, sessionKey: string): Promise<SyncSessionResult> {
  const base = await getCachedSession(rootId, sessionKey);
  const seq = getSessionMaxSeq(base);
  const incoming = await sessionService.getSession(rootId, sessionKey, seq);
  if (!incoming) {
    return { session: base, hasDelta: false };
  }
  const incomingExchanges = Array.isArray(incoming.exchanges) ? incoming.exchanges : [];
  const merged = mergeSessionData(base, { ...incoming, key: sessionKey });
  if (!merged) {
    return { session: null, hasDelta: false };
  }
  await saveCachedSession(rootId, merged);
  return {
    session: cloneSession(merged),
    hasDelta: incomingExchanges.length > 0,
  };
}

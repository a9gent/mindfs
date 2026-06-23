import { appURL, wsURL } from "./base";
import { protectedFetch, protectedJSON } from "./api";
import { e2eeService } from "./e2ee";

// Session service for managing agent sessions

export type SessionType = "chat" | "plugin" | "command";

export type QueuedUserMessage = {
  id: string;
  agent?: string;
  model?: string;
  mode?: string;
  effort?: string;
  fast_service?: string;
  content: string;
  timestamp: string;
};

const commandTerminalFontSize = 12;
const commandTerminalFontFamily =
  '"Cascadia Mono", "Cascadia Code", Consolas, "Microsoft YaHei Mono", "Microsoft YaHei", "Noto Sans Mono CJK SC", monospace';

function measureCommandTerminalCellWidth(): number {
  if (typeof document === "undefined") return 7.25;
  const probe = document.createElement("span");
  probe.textContent = "mmmmmmmmmm";
  probe.style.position = "fixed";
  probe.style.left = "-9999px";
  probe.style.top = "0";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.whiteSpace = "pre";
  probe.style.fontFamily = commandTerminalFontFamily;
  probe.style.fontSize = `${commandTerminalFontSize}px`;
  document.body.appendChild(probe);
  const width = probe.getBoundingClientRect().width / 10;
  probe.remove();
  return width > 0 ? width : 7.25;
}

function estimateCommandTerminalCols(): number | undefined {
  if (typeof window === "undefined") return undefined;
  const maxElementWidth = (selector: string) =>
    Array.from(document.querySelectorAll<HTMLElement>(selector)).reduce((max, element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 ? Math.max(max, rect.width) : max;
    }, 0);
  const inputWidth = maxElementWidth('[data-mindfs-command-input-width="1"]');
  const contentWidth = maxElementWidth('[data-mindfs-session-content-width="1"]');
  const elementWidth = Math.max(inputWidth, contentWidth);
  const width = elementWidth || window.visualViewport?.width || window.innerWidth || 0;
  if (width <= 0) return undefined;
  const isMobile = width < 768;
  const terminalChrome = isMobile ? 92 : 72;
  const usableWidth = Math.max(280, width - terminalChrome);
  const cellWidth = measureCommandTerminalCellWidth();
  const cols = Math.floor(usableWidth / cellWidth) - 1;
  return Math.max(40, Math.min(500, cols));
}

export type RelatedFile = {
  path: string;
  relation?: string;
  created_by_session?: boolean;
};

export type ExchangeAux = {
  seq: number;
  line: number;
  toolcall?: ToolCall | null;
  thought?: string | null;
  thought_id?: string;
  plan?: PlanUpdate | null;
  compact?: CompactNotice | null;
};

export type Session = {
  key: string;
  type: SessionType;
  parent_session_key?: string;
  parent_tool_call_id?: string;
  source?: string;
  agent?: string;
  model?: string;
  shell?: string;
  mode?: string;
  effort?: string;
  fast_service?: string;
  plan_mode?: boolean;
  name: string;
  created_at: string;
  updated_at: string;
  closed_at?: string;
  context_window?: {
    totalTokens: number;
    modelContextWindow: number;
  };
  related_files?: RelatedFile[];
  exchange_aux?: Record<string, ExchangeAux[]>;
  exchanges?: Array<{
    seq?: number;
    role?: string;
    agent?: string;
    model?: string;
    model_display_name?: string;
    mode?: string;
    effort?: string;
    fast_service?: string;
    content?: string;
    context_window?: {
      totalTokens: number;
      modelContextWindow: number;
    };
    timestamp?: string;
    toolCall?: ToolCall;
    todoUpdate?: TodoUpdate;
    planUpdate?: PlanUpdate;
    compactNotice?: CompactNotice;
    pending_ack?: boolean;
  }>;
};

export type SessionSearchHit = {
  key: string;
  type: SessionType;
  parent_session_key?: string;
  parent_tool_call_id?: string;
  source?: string;
  agent?: string;
  model?: string;
  shell?: string;
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

export type TodoItem = {
  content: string;
  activeForm?: string;
  status: string;
};

export type TodoUpdate = {
  items: TodoItem[];
};

export type PlanUpdate = {
  id?: string;
  content: string;
  delta?: boolean;
};

export type CompactNotice = {
  id?: string;
  status?: string;
  summary?: string;
};

export type StreamEvent =
  | { type: "message_chunk"; data: { content: string } }
  | { type: "thought_chunk"; data: { id?: string; content: string } }
  | { type: "tool_call"; data: ToolCall }
  | { type: "tool_call_update"; data: ToolCall }
  | { type: "todo_update"; data: TodoUpdate }
  | { type: "plan_update"; data: PlanUpdate }
  | { type: "compact_notice"; data: CompactNotice }
  | { type: "recovery"; data: { message: string } }
  | {
      type: "message_done";
      data?: {
        contextWindow?: {
          totalTokens: number;
          modelContextWindow: number;
        };
      };
    }
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
  private activeStreams = new Set<string>();
  private pendingMessages = new Map<string, PendingMessage>();
  private listeners = new Set<(event: SessionServiceEvent) => void>();
  private reconnectTimer: number | null = null;
  private connectTimeoutTimer: number | null = null;
  private probeTimeoutTimer: number | null = null;
  private activeProbeId: string | null = null;
  private connectingStartedAt = 0;
  private openingSocket = false;
  private reconnectDelayMs = 1000;
  private fastReconnectUntil = 0;
  private rootId: string | null = null;
  private hasConnected = false;
  private readonly clientId = this.generateClientId();
  private readonly maxReconnectDelayMs = 30000;
  private readonly fastReconnectDelayMs = 1000;
  private readonly fastReconnectWindowMs = 10000;
  private readonly connectTimeoutMs = 5000;
  private readonly probeTimeoutMs = 2000;
  private readonly reconnectWatchdogMs = 3000;
  private contextCache = new Map<string, { selectionKey: string }>();

  constructor() {
    e2eeService.setClientId(this.clientId);
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => this.ensureConnection());
      window.addEventListener("pageshow", () => this.ensureConnection());
      window.addEventListener("focus", () => this.ensureConnection());
      window.setInterval(() => this.ensureReconnectLoop(), this.reconnectWatchdogMs);
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

  private async buildWSUrl(): Promise<string> {
    const params = new URLSearchParams({ client_id: this.clientId });
    const proofTarget = wsURL("/ws", params);
    if (e2eeService.isRequired()) {
      const proofParams = await e2eeService.wsProofParams("GET", proofTarget);
      for (const [key, value] of proofParams) {
        params.set(key, value);
      }
    }
    return wsURL("/ws", params);
  }

  connect(rootId: string) {
    this.rootId = rootId;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.emit({ type: this.hasConnected ? "ws.reconnected" : "ws.connected" });
      this.hasConnected = true;
      return;
    }
    if (this.openingSocket || this.ws?.readyState === WebSocket.CONNECTING) {
      if (
        this.connectingStartedAt > 0 &&
        Date.now() - this.connectingStartedAt > this.connectTimeoutMs
      ) {
        this.reconnectNow();
        return;
      }
      this.emit({ type: this.hasConnected ? "ws.reconnecting" : "ws.connecting" });
      return;
    }

    this.clearReconnectTimer();
    this.closeSocket();
    this.emit({ type: this.hasConnected ? "ws.reconnecting" : "ws.connecting" });

    void this.openSocket();
  }

  private async openSocket() {
    if (this.openingSocket) {
      return;
    }
    this.openingSocket = true;
    let target = "";
    try {
      target = await this.buildWSUrl();
    } catch (err) {
      this.openingSocket = false;
      console.error("[Session] Failed to prepare WebSocket proof:", err);
      this.emit({ type: "ws.closed", payload: { code: 0, reason: "e2ee_proof_failed", was_clean: false } });
      this.scheduleReconnect();
      return;
    }
    if (!this.rootId || this.ws) {
      this.openingSocket = false;
      return;
    }
    const ws = new WebSocket(target);
    this.openingSocket = false;
    this.ws = ws;
    this.connectingStartedAt = Date.now();
    this.connectTimeoutTimer = window.setTimeout(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.CONNECTING) return;
      console.warn("[Session] WebSocket connect timed out, reconnecting");
      this.reconnectNow();
    }, this.connectTimeoutMs);

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.clearConnectTimeout();
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

    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.clearConnectTimeout();
      this.ws = null;
      this.emit({
        type: "ws.closed",
        payload: {
          code: event.code,
          reason: event.reason,
          was_clean: event.wasClean,
        },
      });
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
    this.clearConnectTimeout();
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

  private clearConnectTimeout() {
    if (this.connectTimeoutTimer) {
      clearTimeout(this.connectTimeoutTimer);
      this.connectTimeoutTimer = null;
    }
    this.connectingStartedAt = 0;
  }

  private clearProbe() {
    if (this.probeTimeoutTimer) {
      clearTimeout(this.probeTimeoutTimer);
      this.probeTimeoutTimer = null;
    }
    this.activeProbeId = null;
  }

  private closeSocket() {
    this.clearConnectTimeout();
    this.clearProbe();
    this.openingSocket = false;
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
    if (this.ws.readyState === WebSocket.CONNECTING) {
      if (
        this.connectingStartedAt > 0 &&
        Date.now() - this.connectingStartedAt > this.connectTimeoutMs
      ) {
        this.reconnectNow();
      }
      return;
    }
    this.probeConnection();
  }

  private ensureReconnectLoop() {
    if (!this.rootId) return;
    if (!this.ws || this.ws.readyState >= WebSocket.CLOSING) {
      this.reconnectNow();
      return;
    }
    if (
      this.ws.readyState === WebSocket.CONNECTING &&
      this.connectingStartedAt > 0 &&
      Date.now() - this.connectingStartedAt > this.connectTimeoutMs
    ) {
      this.reconnectNow();
    }
  }

  private reconnectNow() {
    if (!this.rootId) return;
    const rootId = this.rootId;
    this.clearReconnectTimer();
    this.clearProbe();
    this.closeSocket();
    this.reconnectDelayMs = 1000;
    this.fastReconnectUntil = Date.now() + this.fastReconnectWindowMs;
    this.connect(rootId);
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

  private emitDecrypted(
    type: string,
    sessionKey: string,
    payload: Record<string, unknown>,
    msg: any,
  ) {
    const nextPayload = { ...payload };
    this.emit({ type, sessionKey, payload: nextPayload });

    if (!sessionKey) return;
    this.updateActiveStreamState(type, sessionKey, nextPayload);

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

  private async sendWSMessage(
    message: Record<string, unknown>,
  ): Promise<boolean> {
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

  private updateActiveStreamState(
    type: string,
    sessionKey: string,
    payload: Record<string, unknown>,
  ) {
    if (type === "session.done" || type === "session.error") {
      this.activeStreams.delete(sessionKey);
      return;
    }
    if (type !== "session.stream") return;
    const event = payload.event as StreamEvent | undefined;
    if (!event) return;
    if (event.type === "error") {
      this.activeStreams.delete(sessionKey);
      return;
    }
    if (event.type !== "message_done") {
      this.activeStreams.add(sessionKey);
    }
  }

  isSessionStreaming(sessionKey: string) {
    return this.activeStreams.has(sessionKey);
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
    fastService?: string,
    context?: Record<string, unknown>,
    shell?: string,
    requestId = this.createRequestId("msg"),
  ): Promise<boolean> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn("[session/send] blocked", {
        requestId,
        rootId,
        sessionKey: sessionKey || null,
        readyState: this.ws?.readyState ?? null,
      });
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
        fast_service: fastService,
        shell,
        terminal_cols: type === "command" ? estimateCommandTerminalCols() : undefined,
        context: this.compactContext(sessionKey, context),
      },
    };

    this.pendingMessages.set(requestId, { id: requestId, message: msg });
    return this.sendWSMessage(msg);
  }

  async setPlanMode(
    rootId: string,
    sessionKey: string,
    enabled: boolean,
    requestId = this.createRequestId("plan"),
  ): Promise<boolean> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    if (!rootId || !sessionKey) {
      return false;
    }
    return this.sendWSMessage({
      id: requestId,
      type: "session.plan_mode.set",
      payload: {
        root_id: rootId,
        session_key: sessionKey,
        enabled,
      },
    });
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

  async removeQueuedMessage(rootId: string, sessionKey: string, queueId: string): Promise<boolean> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !rootId || !sessionKey || !queueId) {
      return false;
    }
    return this.sendWSMessage({
      id: `queue-remove-${Date.now()}`,
      type: "session.queue.remove",
      payload: {
        root_id: rootId,
        session_key: sessionKey,
        queue_id: queueId,
      },
    });
  }

  async updateQueuedMessage(rootId: string, sessionKey: string, queueId: string, content: string): Promise<boolean> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !rootId || !sessionKey || !queueId || !content.trim()) {
      return false;
    }
    return this.sendWSMessage({
      id: `queue-update-${Date.now()}`,
      type: "session.queue.update",
      payload: {
        root_id: rootId,
        session_key: sessionKey,
        queue_id: queueId,
        content,
      },
    });
  }

  async sendQueuedMessageNow(rootId: string, sessionKey: string, queueId: string): Promise<boolean> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !rootId || !sessionKey || !queueId) {
      return false;
    }
    return this.sendWSMessage({
      id: `queue-send-now-${Date.now()}`,
      type: "session.queue.send_now",
      payload: {
        root_id: rootId,
        session_key: sessionKey,
        queue_id: queueId,
      },
    });
  }

  async answerQuestion(
    rootId: string,
    sessionKey: string,
    agent: string | undefined,
    toolUseId: string,
    answers: Record<string, string>,
  ): Promise<boolean> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error("[Session] WebSocket not connected");
      return false;
    }
    if (!rootId || !sessionKey || !toolUseId) {
      return false;
    }

    const msg = {
      id: this.createRequestId("answer"),
      type: "session.answer_question",
      payload: {
        root_id: rootId,
        session_key: sessionKey,
        agent,
        tool_use_id: toolUseId,
        answers,
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
    const now = Date.now();
    if (e2eeService.isRequired()) {
      await e2eeService.ensureSession();
    }
    return this.sendWSMessage({
      id: `ready-${now}`,
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
      const data = await protectedJSON<any[]>(appURL("/api/sessions", params));
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
      const data = await protectedJSON<any>(appURL("/api/sessions/search", params));
      return Array.isArray(data?.items)
        ? (data.items as SessionSearchHit[])
        : [];
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
      const data = await protectedJSON<Session>(
        appURL(`/api/sessions/${encodeURIComponent(sessionKey)}`, params),
      );
      return data as Session;
    } catch (err) {
      console.error("[Session] Failed to get session:", err);
      return null;
    }
  }

  async getToolCall(
    rootId: string,
    sessionKey: string,
    callId: string,
  ): Promise<ToolCall | null> {
    try {
      if (!rootId || !sessionKey || !callId) return null;
      const params = new URLSearchParams({ root: rootId });
      const data = await protectedJSON<{ toolcall?: ToolCall; toolCall?: ToolCall } | ToolCall>(
        appURL(
          `/api/sessions/${encodeURIComponent(sessionKey)}/toolcalls/${encodeURIComponent(callId)}`,
          params,
        ),
      );
      const wrapped = data as { toolcall?: ToolCall; toolCall?: ToolCall };
      if (wrapped?.toolcall) return wrapped.toolcall;
      if (wrapped?.toolCall) return wrapped.toolCall;
      const direct = data as ToolCall;
      return direct?.callId ? direct : null;
    } catch (err) {
      console.error("[Session] Failed to get toolcall:", err);
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
      const data = await protectedJSON<any[]>(
        appURL(
          `/api/sessions/${encodeURIComponent(sessionKey)}/related-files`,
          params,
        ),
      );
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
      const res = await protectedFetch(
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
      const res = await protectedFetch(
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
      const data = await protectedJSON<Session>(
        appURL(
          `/api/sessions/${encodeURIComponent(sessionKey)}/rename`,
          params,
        ),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name }),
        },
      );
      return data as Session;
    } catch (err) {
      console.error("[Session] Failed to rename session:", err);
      return null;
    }
  }

  async forkSession(
    rootId: string,
    sessionKey: string,
    seq: number,
  ): Promise<{ session_key: string; session?: Session } | null> {
    try {
      if (!rootId || !sessionKey || !seq) {
        return null;
      }
      return await protectedJSON<{ session_key: string; session?: Session }>(
        appURL("/api/sessions/fork"),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            root_id: rootId,
            session_key: sessionKey,
            seq,
          }),
        },
      );
    } catch (err) {
      console.error("[Session] Failed to fork session:", err);
      return null;
    }
  }

  async fetchExternalSessions(
    rootId: string,
    agent: string,
    options?: FetchExternalSessionsOptions,
  ): Promise<Session[]> {
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
    const data = await protectedJSON<any[]>(appURL("/api/sessions/external", params));
    return Array.isArray(data) ? data : [];
  }

  async importExternalSession(
    rootId: string,
    agent: string,
    agentSessionId: string,
  ): Promise<{ session_key: string } | null> {
    try {
      return await protectedJSON<{ session_key: string }>(appURL("/api/sessions/import"), {
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
    } catch (err) {
      console.error("[Session] Failed to import external session:", err);
      return null;
    }
  }

  async importExternalSessionsBatch(
    rootId: string,
    agent: string,
    agentSessionIds: string[],
  ): Promise<{
    items: Array<{
      agent_session_id: string;
      session_key?: string;
      imported_count?: number;
      success: boolean;
      error?: string;
      error_code?: string;
      error_detail?: string;
      error_path?: string;
      error_operation?: string;
    }>;
  } | null> {
    try {
      return await protectedJSON(appURL("/api/sessions/import/batch"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          root_id: rootId,
          agent,
          agent_session_ids: agentSessionIds,
        }),
      });
    } catch (err) {
      console.error("[Session] Failed to import external sessions:", err);
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

function cloneExchangeAux(
  exchangeAux?: Record<string, ExchangeAux[]>,
): Record<string, ExchangeAux[]> {
  const out: Record<string, ExchangeAux[]> = {};
  for (const [seq, items] of Object.entries(exchangeAux || {})) {
    out[seq] = Array.isArray(items) ? [...items] : [];
  }
  return out;
}

function toPersistentExchangeAux(
  exchangeAux?: Record<string, ExchangeAux[]>,
): Record<string, ExchangeAux[]> {
  const out: Record<string, ExchangeAux[]> = {};
  for (const [seq, items] of Object.entries(exchangeAux || {})) {
    const seqNum = Number(seq || 0);
    if (!Number.isFinite(seqNum) || seqNum <= 0) {
      continue;
    }
    const nextItems = Array.isArray(items)
      ? items.filter((item) => Number(item?.seq || 0) > 0)
      : [];
    if (nextItems.length > 0) {
      out[String(seqNum)] = nextItems;
    }
  }
  return out;
}

function appendExchangeAuxDelta(
  base?: Record<string, ExchangeAux[]>,
  incoming?: Record<string, ExchangeAux[]>,
): Record<string, ExchangeAux[]> {
  const out = cloneExchangeAux(base);
  for (const [seq, items] of Object.entries(incoming || {})) {
    if (!Array.isArray(items) || items.length === 0) {
      continue;
    }
    out[seq] = [...(out[seq] || []), ...items];
  }
  return out;
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
    effort: preferIncomingText((incoming as any).effort, (base as any).effort),
    fast_service:
      typeof (incoming as any).fast_service === "string"
        ? (incoming as any).fast_service
        : typeof (base as any).fast_service === "string"
          ? (base as any).fast_service
          : "",
    plan_mode:
      typeof (incoming as any).plan_mode === "boolean"
        ? (incoming as any).plan_mode
        : !!(base as any).plan_mode,
    name: preferIncomingText(incoming.name, base.name) || "",
    exchanges: Array.isArray(incoming.exchanges) ? [...incoming.exchanges] : [],
    exchange_aux: cloneExchangeAux(incoming.exchange_aux || base.exchange_aux),
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
  const baseExchangeAux = toPersistentExchangeAux(base?.exchange_aux);
  const incomingExchangeAux = toPersistentExchangeAux(incoming?.exchange_aux);
  return {
    ...baseWithMeta,
    exchanges: [...baseExchanges, ...incomingExchanges],
    exchange_aux: appendExchangeAuxDelta(baseExchangeAux, incomingExchangeAux),
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
    exchange_aux: cloneExchangeAux(session.exchange_aux),
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
    exchange_aux: toPersistentExchangeAux(session.exchange_aux),
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
    exchange_aux: toPersistentExchangeAux(incoming.exchange_aux),
  });
  if (!persistedSession) {
    return { session: null, hasDelta: false };
  }
  await saveCachedSession(rootId, persistedSession);
  const displaySession = withSessionMeta(persistedSession, {
    ...incoming,
    key: sessionKey,
    exchanges: [...(persistedSession.exchanges || []), ...transientTail],
    exchange_aux: persistedSession.exchange_aux,
  });
  return {
    session: displaySession ? cloneSession(displaySession) : null,
    hasDelta: persistedDelta.length > 0,
  };
}

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { JSONUIProvider } from "@json-render/react";
import { Renderer } from "./renderer/Renderer";
import {
  buildDefaultTree,
  type FileEntry,
  type FilePayload,
  type SessionItem,
  type UITree,
} from "./renderer/defaultTree";
import { registry } from "./renderer/registry";
import { mergeViewIntoShell } from "./renderer/merge";
import { sessionService, type Session } from "./services/session";
import { buildClientContext } from "./services/context";

type ManagedDir = {
  id: string;
  root_path: string;
  display_name?: string;
  created_at: string;
  updated_at: string;
};

type ViewRoutePayload = {
  view_data?: UITree | null;
};

type TreeResponse = {
  entries?: FileEntry[];
  view_routes?: ViewRoutePayload[];
};

type FileResponse = {
  file?: FilePayload;
  view_routes?: ViewRoutePayload[];
};

type Exchange = {
  role: "user" | "agent" | "assistant" | "thought" | "tool";
  content: string;
  timestamp: string;
  agent?: string;
  toolCall?: any;
};

type PendingSend = {
  rootId: string;
  mode: "chat" | "view" | "skill";
  agent: string;
  message: string;
  timestamp: string;
};

export function App() {
  const [rootEntries, setRootEntries] = useState<FileEntry[]>([]);
  const [entriesByPath, setEntriesByPath] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<string[]>([]);
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  const [mainEntries, setMainEntries] = useState<FileEntry[]>([]);
  const [status, setStatus] = useState("Connecting");
  const [file, setFile] = useState<FilePayload | null>(null);
  const [viewTree, setViewTree] = useState<UITree | null>(null);
  const [currentRootId, setCurrentRootId] = useState<string | null>(null);
  const [managedRootIds, setManagedRootIds] = useState<string[]>([]);
  
  // 关键：创建 Ref 镜像以解决 Action 闭包状态滞后问题
  const currentRootIdRef = useRef<string | null>(null);
  const managedRootIdsRef = useRef<Set<string>>(new Set());
  const expandedRef = useRef<string[]>([]);
  const selectedDirRef = useRef<string | null>(null);
  const fileRef = useRef<FilePayload | null>(null);
  const selectedSessionRef = useRef<SessionItem | null>(null);
  const currentSessionRef = useRef<Session | null>(null);
  const interactionModeRef = useRef<"main" | "floating">("main");
  const pendingDraftRef = useRef<PendingSend | null>(null);
  const pendingBySessionRef = useRef<Record<string, PendingSend>>({});
  const loadedSessionRef = useRef<Record<string, boolean>>({});
  const sessionCacheRef = useRef<Record<string, Session>>({});
  const loadingSessionRef = useRef<Record<string, Promise<Session | null>>>({});
  
  const [sessions, setSessions] = useState<any[]>([]);
  const [sessionsByRoot, setSessionsByRoot] = useState<Record<string, any[]>>({});
  const [sessionsReady, setSessionsReady] = useState(false);
  const [selectedSession, setSelectedSession] = useState<SessionItem | null>(null);
  const [currentSession, setCurrentSession] = useState<Session | null>(null);
  const [currentSessionExchanges, setCurrentSessionExchanges] = useState<any[]>([]);
  const [currentSessionByRoot, setCurrentSessionByRoot] = useState<Record<string, Session>>({});
  const [sessionExchangesByRootSession, setSessionExchangesByRootSession] = useState<Record<string, any[]>>({});
  const [interactionMode, setInteractionMode] = useState<"main" | "floating">("main");
  const [isFloatingOpen, setIsFloatingOpen] = useState(false);
  const rootSessionKey = useCallback((rootId: string, sessionKey: string) => `${rootId}::${sessionKey}`, []);
  const applySessionSnapshot = useCallback((rootID: string, session: Session) => {
    const exchangeKey = rootSessionKey(rootID, session.key);
    const exchanges = ((session as any).exchanges || []) as any[];
    const normalized = { ...(session as any), key: session.key, exchanges } as Session;
    loadedSessionRef.current[exchangeKey] = true;
    sessionCacheRef.current[exchangeKey] = normalized;
    setCurrentSessionByRoot((prev) => ({ ...prev, [rootID]: session }));
    setSessionExchangesByRootSession((prev) => ({ ...prev, [exchangeKey]: exchanges }));
  }, [rootSessionKey]);

  const seedCurrentSessionFromPending = useCallback((rootID: string, sessionKey: string, pending: PendingSend) => {
    setCurrentSessionByRoot((prev) => {
      const existed = prev[rootID];
      if (existed && existed.key === sessionKey) {
        return prev;
      }
      return {
        ...prev,
        [rootID]: {
          key: sessionKey,
          type: pending.mode,
          agent: pending.agent,
          name: existed?.name || "",
          pending: true,
          created_at: existed?.created_at || new Date().toISOString(),
          updated_at: new Date().toISOString(),
        } as Session,
      };
    });
    const userExchange: Exchange = { role: "user", content: pending.message, timestamp: pending.timestamp };
    const exchangeKey = rootSessionKey(rootID, sessionKey);
    setSessionExchangesByRootSession((prev) => {
      if (Array.isArray(prev[exchangeKey]) && prev[exchangeKey].length > 0) {
        return prev;
      }
      return {
        ...prev,
        [exchangeKey]: [userExchange],
      };
    });
    setCurrentSessionExchanges((prev) => (prev.length > 0 ? prev : [userExchange]));
  }, [rootSessionKey]);

  const setSelectedPendingByKey = useCallback((sessionKey: string, pending: boolean) => {
    setSelectedSession((prev) => {
      const prevKey = prev?.key || prev?.session_key;
      if (!prev || prevKey !== sessionKey) {
        return prev;
      }
      return { ...(prev as any), pending } as SessionItem;
    });
  }, []);

  const openSessionInMain = useCallback((rootID: string, session: Session) => {
    const exchanges = (((session as any).exchanges || []) as any[]);
    setSelectedSession(session as any);
    setFile(null);
    setInteractionMode("main");
    setIsFloatingOpen(false);
    if (session.closed_at) {
      return;
    }
    applySessionSnapshot(rootID, session);
    setCurrentSession(session);
    setCurrentSessionExchanges(exchanges);
  }, [applySessionSnapshot]);

  const resolveAgentForSession = useCallback((rootID: string, sessionKey: string, fallbackAgent?: string): string => {
    if (fallbackAgent) return fallbackAgent;
    const cacheKey = rootSessionKey(rootID, sessionKey);
    const cached = sessionCacheRef.current[cacheKey] as any;
    if (cached && typeof cached.agent === "string" && cached.agent) {
      return cached.agent;
    }
    const current = currentSessionRef.current as any;
    if (current && current.key === sessionKey && typeof current.agent === "string" && current.agent) {
      return current.agent;
    }
    const selected = selectedSessionRef.current as any;
    const selectedKey = selected?.key || selected?.session_key;
    if (selectedKey === sessionKey && typeof selected?.agent === "string" && selected.agent) {
      return selected.agent;
    }
    return "";
  }, [rootSessionKey]);

  const appendAgentChunkForSession = useCallback((rootID: string, sessionKey: string, content: string, agentHint?: string) => {
    if (!content) {
      return;
    }
    const now = new Date().toISOString();
    const cacheKey = rootSessionKey(rootID, sessionKey);
    const resolvedAgent = resolveAgentForSession(rootID, sessionKey, agentHint);
    setSessionExchangesByRootSession((prev) => ({
      ...prev,
      [cacheKey]: (() => {
        const list = [...(prev[cacheKey] || [])];
        const last = list.length > 0 ? list[list.length - 1] : null;
        if (last && last.role === "agent") {
          list[list.length - 1] = {
            ...last,
            agent: last.agent || resolvedAgent,
            content: `${last.content || ""}${content}`,
            timestamp: now,
          };
          return list;
        }
        list.push({ role: "agent", agent: resolvedAgent, content, timestamp: now });
        return list;
      })(),
    }));
    const cached = sessionCacheRef.current[cacheKey];
    if (cached) {
      const prevExchanges = Array.isArray((cached as any).exchanges) ? ((cached as any).exchanges as any[]) : [];
      const last = prevExchanges.length > 0 ? prevExchanges[prevExchanges.length - 1] : null;
      const nextExchanges = [...prevExchanges];
      if (last && last.role === "agent") {
        nextExchanges[nextExchanges.length - 1] = {
          ...last,
          agent: last.agent || resolvedAgent,
          content: `${last.content || ""}${content}`,
          timestamp: now,
        };
      } else {
        nextExchanges.push({ role: "agent", agent: resolvedAgent, content, timestamp: now });
      }
      sessionCacheRef.current[cacheKey] = {
        ...(cached as any),
        exchanges: nextExchanges,
      } as Session;
    }
    if (currentRootIdRef.current === rootID && currentSessionRef.current?.key === sessionKey) {
      setCurrentSessionExchanges((prev) => {
        const list = [...prev];
        const last = list.length > 0 ? list[list.length - 1] : null;
        if (last && last.role === "agent") {
          list[list.length - 1] = {
            ...last,
            agent: last.agent || resolvedAgent,
            content: `${last.content || ""}${content}`,
            timestamp: now,
          };
          return list;
        }
        list.push({ role: "agent", agent: resolvedAgent, content, timestamp: now });
        return list;
      });
    }
    setSelectedSession((prev) => {
      const prevKey = prev?.key || prev?.session_key;
      if (!prev || prevKey !== sessionKey) {
        return prev;
      }
      const prevExchanges = Array.isArray((prev as any).exchanges) ? (prev as any).exchanges : [];
      const list = [...prevExchanges];
      const last = list.length > 0 ? list[list.length - 1] : null;
      if (last && last.role === "agent") {
        list[list.length - 1] = {
          ...last,
          agent: last.agent || resolvedAgent,
          content: `${last.content || ""}${content}`,
          timestamp: now,
        };
      } else {
        list.push({ role: "agent", agent: resolvedAgent, content, timestamp: now });
      }
      return {
        ...(prev as any),
        exchanges: list,
      } as SessionItem;
    });
  }, [rootSessionKey, resolveAgentForSession]);

  const appendThoughtChunkForSession = useCallback((rootID: string, sessionKey: string, content: string) => {
    if (!content) return;
    const now = new Date().toISOString();
    const cacheKey = rootSessionKey(rootID, sessionKey);
    setSessionExchangesByRootSession((prev) => ({
      ...prev,
      [cacheKey]: (() => {
        const list = [...(prev[cacheKey] || [])];
        const last = list.length > 0 ? list[list.length - 1] : null;
        if (last && last.role === "thought") {
          list[list.length - 1] = { ...last, content: `${last.content || ""}${content}`, timestamp: now };
          return list;
        }
        list.push({ role: "thought", content, timestamp: now });
        return list;
      })(),
    }));
    const cached = sessionCacheRef.current[cacheKey];
    if (cached) {
      const prevExchanges = Array.isArray((cached as any).exchanges) ? ((cached as any).exchanges as any[]) : [];
      const list = [...prevExchanges];
      const last = list.length > 0 ? list[list.length - 1] : null;
      if (last && last.role === "thought") {
        list[list.length - 1] = { ...last, content: `${last.content || ""}${content}`, timestamp: now };
      } else {
        list.push({ role: "thought", content, timestamp: now });
      }
      sessionCacheRef.current[cacheKey] = { ...(cached as any), exchanges: list } as Session;
    }
    if (currentRootIdRef.current === rootID && currentSessionRef.current?.key === sessionKey) {
      setCurrentSessionExchanges((prev) => {
        const list = [...prev];
        const last = list.length > 0 ? list[list.length - 1] : null;
        if (last && last.role === "thought") {
          list[list.length - 1] = { ...last, content: `${last.content || ""}${content}`, timestamp: now };
          return list;
        }
        list.push({ role: "thought", content, timestamp: now });
        return list;
      });
    }
    setSelectedSession((prev) => {
      const prevKey = prev?.key || prev?.session_key;
      if (!prev || prevKey !== sessionKey) return prev;
      const prevExchanges = Array.isArray((prev as any).exchanges) ? (prev as any).exchanges : [];
      const list = [...prevExchanges];
      const last = list.length > 0 ? list[list.length - 1] : null;
      if (last && last.role === "thought") {
        list[list.length - 1] = { ...last, content: `${last.content || ""}${content}`, timestamp: now };
      } else {
        list.push({ role: "thought", content, timestamp: now });
      }
      return { ...(prev as any), exchanges: list } as SessionItem;
    });
  }, [rootSessionKey]);

  const appendToolCallForSession = useCallback(
    (rootID: string, sessionKey: string, toolCall: Record<string, unknown>, update: boolean) => {
      if (!toolCall) return;
      const now = new Date().toISOString();
      const cacheKey = rootSessionKey(rootID, sessionKey);
      const mergeToolCall = (existing: Record<string, unknown> | undefined, incoming: Record<string, unknown>): Record<string, unknown> => {
        const merged = { ...(existing || {}), ...incoming };
        const incomingKind = typeof incoming.kind === "string" ? incoming.kind.trim() : "";
        const existingKind = existing && typeof existing.kind === "string" ? (existing.kind as string).trim() : "";
        if (!incomingKind && existingKind) {
          merged.kind = existingKind;
        }
        const incomingTitle = typeof incoming.title === "string" ? incoming.title.trim() : "";
        const existingTitle = existing && typeof existing.title === "string" ? (existing.title as string).trim() : "";
        if (!incomingTitle && existingTitle) {
          merged.title = existingTitle;
        }
        return merged;
      };
      const upsert = (source: any[]): any[] => {
        const list = [...source];
        const callId = (toolCall.callId as string) || (toolCall.toolCallId as string) || (toolCall.tool_call_id as string) || "";
        if (update && callId) {
          for (let i = list.length - 1; i >= 0; i--) {
            const item = list[i];
            if (item?.role !== "tool") continue;
            const itemCallId = item?.toolCall?.callId || item?.toolCall?.toolCallId || item?.toolCall?.tool_call_id || "";
            if (itemCallId === callId) {
              list[i] = {
                ...item,
                timestamp: now,
                toolCall: mergeToolCall((item.toolCall || {}) as Record<string, unknown>, toolCall),
              };
              return list;
            }
          }
        }
        list.push({ role: "tool", content: "", timestamp: now, toolCall });
        return list;
      };

      setSessionExchangesByRootSession((prev) => ({
        ...prev,
        [cacheKey]: upsert(prev[cacheKey] || []),
      }));
      const cached = sessionCacheRef.current[cacheKey];
      if (cached) {
        const prevExchanges = Array.isArray((cached as any).exchanges) ? ((cached as any).exchanges as any[]) : [];
        sessionCacheRef.current[cacheKey] = { ...(cached as any), exchanges: upsert(prevExchanges) } as Session;
      }
      if (currentRootIdRef.current === rootID && currentSessionRef.current?.key === sessionKey) {
        setCurrentSessionExchanges((prev) => upsert(prev));
      }
      setSelectedSession((prev) => {
        const prevKey = prev?.key || prev?.session_key;
        if (!prev || prevKey !== sessionKey) return prev;
        const prevExchanges = Array.isArray((prev as any).exchanges) ? (prev as any).exchanges : [];
        return { ...(prev as any), exchanges: upsert(prevExchanges) } as SessionItem;
      });
    },
    [rootSessionKey]
  );

  // 同步状态到 Ref
  useEffect(() => { currentRootIdRef.current = currentRootId; }, [currentRootId]);
  useEffect(() => { expandedRef.current = expanded; }, [expanded]);
  useEffect(() => { selectedDirRef.current = selectedDir; }, [selectedDir]);
  useEffect(() => { fileRef.current = file; }, [file]);
  useEffect(() => { selectedSessionRef.current = selectedSession; }, [selectedSession]);
  useEffect(() => { currentSessionRef.current = currentSession; }, [currentSession]);
  useEffect(() => { interactionModeRef.current = interactionMode; }, [interactionMode]);

  const pickViewTree = useCallback((routes: ViewRoutePayload[] | undefined): UITree | null => {
    const first = (Array.isArray(routes) ? routes : []).find((item) => item?.view_data);
    return (first?.view_data as UITree | null) || null;
  }, []);

  const normalizeTreeResponse = useCallback((payload: unknown): { entries: FileEntry[]; viewRoutes: ViewRoutePayload[] } => {
    if (Array.isArray(payload)) {
      return { entries: payload as FileEntry[], viewRoutes: [] };
    }
    const obj = (payload && typeof payload === "object") ? (payload as TreeResponse) : {};
    return {
      entries: Array.isArray(obj.entries) ? obj.entries : [],
      viewRoutes: Array.isArray(obj.view_routes) ? obj.view_routes : [],
    };
  }, []);

  const normalizeFileResponse = useCallback((payload: unknown): { file: FilePayload | null; viewRoutes: ViewRoutePayload[] } => {
    const obj = (payload && typeof payload === "object") ? (payload as FileResponse) : {};
    if (obj.file && typeof obj.file === "object") {
      return {
        file: obj.file,
        viewRoutes: Array.isArray(obj.view_routes) ? obj.view_routes : [],
      };
    }
    // Backward compatibility: old API returned file payload directly.
    const raw = payload as Record<string, unknown> | null;
    if (raw && typeof raw.path === "string") {
      return {
        file: raw as unknown as FilePayload,
        viewRoutes: [],
      };
    }
    return { file: null, viewRoutes: [] };
  }, []);
  useEffect(() => {
    if (interactionMode === "floating" && isFloatingOpen) return;
    if (!currentRootId) return;
    const session = currentSessionByRoot[currentRootId];
    if (!session) {
      setCurrentSession(null);
      setCurrentSessionExchanges([]);
      return;
    }
    setCurrentSession(session);
    setCurrentSessionExchanges(sessionExchangesByRootSession[rootSessionKey(currentRootId, session.key)] || []);
  }, [currentRootId, currentSessionByRoot, sessionExchangesByRootSession, rootSessionKey, interactionMode, isFloatingOpen]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const dirsRes = await fetch("/api/dirs");
        const dirsPayload = await dirsRes.json();
        if (cancelled) return;
        const dirs = (Array.isArray(dirsPayload) ? dirsPayload : []) as ManagedDir[];
        const ids = dirs.map((dir) => dir.id);
        managedRootIdsRef.current = new Set(ids);
        setManagedRootIds(ids);
        const managedEntries: FileEntry[] = dirs.map((dir) => ({
          name: dir.display_name ?? dir.id,
          path: dir.id,
          is_dir: true,
        }));
        setRootEntries(managedEntries);
        if (managedEntries.length === 0) return;

        const first = managedEntries[0];
        setCurrentRootId(first.path);
        const treeRes = await fetch(`/api/tree?root=${encodeURIComponent(first.path)}&dir=.`);
        const treePayload = await treeRes.json();
        if (cancelled) return;
        const { entries, viewRoutes } = normalizeTreeResponse(treePayload);
        
        const cacheKey = `${first.path}:.`;
        setEntriesByPath((prev) => ({ ...prev, [cacheKey]: entries }));
        setExpanded([first.path]);
        setSelectedDir(first.path);
        setMainEntries(entries);
        setViewTree(pickViewTree(viewRoutes));
        setStatus("Connected");
      } catch (err) { console.error("Init failed:", err); }
    };
    load();
    return () => { cancelled = true; };
  }, [normalizeTreeResponse, pickViewTree]);

  const handleSelectSession = useCallback(
    async (session: any) => {
      const key = session?.key || session?.session_key;
      const targetRoot = (session?.root_id as string | undefined) || currentRootIdRef.current;
      
      if (!targetRoot || !key) {
        console.error("[handleSelectSession] Failed: context missing.");
        return;
      }
      if (typeof key === "string" && key.startsWith("pending-")) {
        return;
      }

      // Optimistically switch selection immediately so follow-up send targets this key,
      // even before async session hydrate finishes.
      const optimistic = { ...(session as Record<string, unknown>), key, root_id: targetRoot } as Session;
      setSelectedSession(optimistic as any);
      setCurrentSessionByRoot((prev) => ({ ...prev, [targetRoot]: optimistic }));
      setCurrentSession(optimistic);
      const optimisticCacheKey = rootSessionKey(targetRoot, key);
      setCurrentSessionExchanges(sessionExchangesByRootSession[optimisticCacheKey] || []);

      const cacheKey = rootSessionKey(targetRoot, key);
      const cachedSession = sessionCacheRef.current[cacheKey];
      if (cachedSession) {
        openSessionInMain(targetRoot, cachedSession);
        return;
      }
      const loaded = !!loadedSessionRef.current[cacheKey];
      const hasCachedExchanges = Object.prototype.hasOwnProperty.call(sessionExchangesByRootSession, cacheKey);
      if (loaded || hasCachedExchanges) {
        const cachedExchanges = sessionExchangesByRootSession[cacheKey] || [];
        const inMemory = {
          ...(session as Record<string, unknown>),
          key,
          exchanges: cachedExchanges,
        } as Session;
        sessionCacheRef.current[cacheKey] = inMemory;
        openSessionInMain(targetRoot, inMemory);
        return;
      }

      try {
        const existing = loadingSessionRef.current[cacheKey];
        if (existing) {
          const full = await existing;
          if (!full) return;
          openSessionInMain(targetRoot, full);
          return;
        }
        const request = sessionService
          .getSession(targetRoot, key)
          .then((full) => {
            if (!full) return null;
            const normalized = { ...(full as any), key } as Session;
            sessionCacheRef.current[cacheKey] = normalized;
            return normalized;
          })
          .finally(() => {
            delete loadingSessionRef.current[cacheKey];
          });
        loadingSessionRef.current[cacheKey] = request;
        const full = await request;
        if (!full) return;
        openSessionInMain(targetRoot, full as Session);
      } catch (err) { console.error(err); }
    },
    [openSessionInMain, rootSessionKey, sessionExchangesByRootSession]
  );

  const handleSendMessage = useCallback(
    async (message: string, mode: "chat" | "view" | "skill", agent: string) => {
      const activeRoot = currentRootIdRef.current;
      if (!activeRoot) return;
      const keepFloating = interactionMode === "floating";

      const selected = selectedSessionRef.current;
      const selectedKey = selected?.key || selected?.session_key;
      const canReuseSelected = typeof selectedKey === "string" && selectedKey !== "" && !selectedKey.startsWith("pending-");

      let session: Session | null = null;
      let sendSessionKey: string | undefined;
      if (canReuseSelected && selectedKey) {
        const cacheKey = rootSessionKey(activeRoot, selectedKey);
        session = sessionCacheRef.current[cacheKey] || ({ ...(selected as any), key: selectedKey } as Session);
        sendSessionKey = selectedKey;
      }

      let effectiveMode: "chat" | "view" | "skill" = mode;
      let effectiveAgent = agent;
      if (sendSessionKey && session && session.key && !session.key.startsWith("pending-")) {
        const useMode = (session.type as "chat" | "view" | "skill" | undefined) || mode;
        const useAgent = agent || session.agent || "";
        effectiveMode = useMode;
        effectiveAgent = useAgent;
        session = { ...session, type: useMode, agent: useAgent } as Session;
        setCurrentSession(session);
        setCurrentSessionExchanges(sessionExchangesByRootSession[rootSessionKey(activeRoot, session.key)] || []);
        setCurrentSessionByRoot((prev) => ({ ...prev, [activeRoot]: session as Session }));
        setSelectedSession((prev) => {
          const prevKey = prev?.key || prev?.session_key;
          if (prevKey === session?.key) {
            return { ...(prev as any), pending: true } as SessionItem;
          }
          return { ...(session as unknown as SessionItem), pending: true } as SessionItem;
        });
      } else {
        sendSessionKey = undefined;
        const tempKey = `pending-${Date.now()}`;
        const tempSession = {
          key: tempKey,
          type: mode,
          agent,
          name: "",
          pending: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        } as any;
        session = tempSession as Session;
        setCurrentSession(tempSession);
        setCurrentSessionByRoot((prev) => ({ ...prev, [activeRoot]: tempSession as Session }));
        setCurrentSessionExchanges([]);
        setSelectedSession(tempSession);
      }
      
      if (keepFloating) {
        setInteractionMode("floating");
        setIsFloatingOpen(true);
      } else {
        setInteractionMode("main");
        setIsFloatingOpen(false);
      }
      setFile(null);
      const nowISO = new Date().toISOString();
      const pendingSend: PendingSend = {
        rootId: activeRoot,
        mode: effectiveMode,
        agent: effectiveAgent,
        message,
        timestamp: nowISO,
      };
      if (sendSessionKey) {
        pendingBySessionRef.current[rootSessionKey(activeRoot, sendSessionKey)] = pendingSend;
      } else {
        pendingDraftRef.current = pendingSend;
      }
      const newUserExchange: Exchange = { role: "user", content: message, timestamp: nowISO };
      if (session?.key) {
        const exchangeKey = rootSessionKey(activeRoot, session.key);
        setSessionExchangesByRootSession((prev) => ({
          ...prev,
          [exchangeKey]: [...(prev[exchangeKey] || []), newUserExchange],
        }));
        const cached = sessionCacheRef.current[exchangeKey];
        if (cached) {
          const prevExchanges = Array.isArray((cached as any).exchanges) ? ((cached as any).exchanges as any[]) : [];
          sessionCacheRef.current[exchangeKey] = {
            ...(cached as any),
            exchanges: [...prevExchanges, newUserExchange],
          } as Session;
        }
        setSelectedSession((prev) => {
          const prevKey = prev?.key || prev?.session_key;
          if (prevKey !== session?.key) {
            return prev;
          }
          const prevExchanges = Array.isArray((prev as any)?.exchanges) ? (prev as any).exchanges : [];
          return {
            ...(prev as any),
            exchanges: [...prevExchanges, newUserExchange],
          } as SessionItem;
        });
      }
      setCurrentSessionExchanges((prev) => [...prev, newUserExchange]);
      const context = buildClientContext({
        currentRoot: activeRoot,
        currentPath: file?.path ?? selectedDir ?? undefined,
      });
      const sent = await sessionService.sendMessage(activeRoot, sendSessionKey, message, effectiveMode, effectiveAgent, context);
      if (!sent) {
        if (sendSessionKey) {
          delete pendingBySessionRef.current[rootSessionKey(activeRoot, sendSessionKey)];
        } else {
          pendingDraftRef.current = null;
        }
        setSelectedSession((prev) => (prev ? ({ ...(prev as any), pending: false } as SessionItem) : prev));
        if (session?.key) {
          setCurrentSessionByRoot((prev) => {
            const current = prev[activeRoot];
            if (!current || current.key !== session?.key) return prev;
            return { ...prev, [activeRoot]: { ...(current as any), pending: false } as Session };
          });
        }
      }
    },
    [currentSessionByRoot, sessionExchangesByRootSession, file?.path, selectedDir, rootSessionKey, interactionMode]
  );

  const handleAgentResponseAppend = useCallback((content: string) => {
    if (!content) return;
    const activeRoot = currentRootIdRef.current;
    if (activeRoot && currentSession) {
      const key = rootSessionKey(activeRoot, currentSession.key);
      const reply: Exchange = { role: "agent", agent: currentSession.agent || "", content, timestamp: new Date().toISOString() };
      setSessionExchangesByRootSession((prev) => ({
        ...prev,
        [key]: [...(prev[key] || []), reply],
      }));
      setSelectedSession((prev) => {
        const prevKey = prev?.key || prev?.session_key;
        if (prevKey !== currentSession.key) {
          return prev;
        }
        const prevExchanges = Array.isArray((prev as any)?.exchanges) ? (prev as any).exchanges : [];
        return {
          ...(prev as any),
          exchanges: [...prevExchanges, reply],
        } as SessionItem;
      });
    }
    const newAgentExchange: Exchange = { role: "agent", agent: currentSession?.agent || "", content, timestamp: new Date().toISOString() };
    setCurrentSessionExchanges((prev) => [...prev, newAgentExchange]);
  }, [currentSession, rootSessionKey]);

  const handleOpenBubbleSession = useCallback((session: any) => {
    if (!session?.key) return;
    const rootID = session.root_id as string | undefined;
    if (!rootID) return;
    const exchangeKey = rootSessionKey(rootID, session.key);
    const exchanges = sessionExchangesByRootSession[exchangeKey] || [];
    const full = { ...session, exchanges };
    // Floating panel is an overlay shortcut and should not affect main view selection.
    setCurrentSession(full);
    setCurrentSessionExchanges(exchanges);
    setInteractionMode("floating");
    setIsFloatingOpen(true);
  }, [sessionExchangesByRootSession, rootSessionKey]);

  const handleToggleInteractionMode = useCallback((mode: "main" | "floating") => {
    setInteractionMode(mode);
    if (mode === "floating") {
      if (currentSession) {
        setIsFloatingOpen(true);
      }
      return;
    }
    setIsFloatingOpen(false);
  }, [currentSession]);

  const activeSessions = useMemo(() => {
    const list: any[] = [];
    Object.entries(sessionsByRoot).forEach(([rootID, rootSessions]) => {
      (rootSessions || []).forEach((s: any) => {
        if (!s || s.closed_at || !s.key) return;
        const key = rootSessionKey(rootID, s.key);
        const exchanges = sessionExchangesByRootSession[key] || [];
        if (exchanges.length === 0) return;
        list.push({ ...s, root_id: rootID, exchanges });
      });
    });
    return list;
  }, [sessionsByRoot, sessionExchangesByRootSession, rootSessionKey]);

  const shellTree = useMemo(
    () =>
      buildDefaultTree(
        rootEntries,
        entriesByPath,
        expanded,
        selectedDir,
        currentRootId,
        managedRootIds,
        mainEntries,
        status,
        file,
        sessions,
        selectedSession,
        handleSelectSession,
        handleOpenBubbleSession,
        sessionsReady ? activeSessions : [],
        currentSession ? { ...currentSession, exchanges: currentSessionExchanges } : null,
        interactionMode,
        handleToggleInteractionMode,
        handleSendMessage,
        () => {
          setInteractionMode("floating");
          if (currentSession) {
            setIsFloatingOpen(true);
          }
        },
        isFloatingOpen,
        setIsFloatingOpen,
        handleAgentResponseAppend
      ),
    [rootEntries, entriesByPath, expanded, selectedDir, currentRootId, managedRootIds, mainEntries, status, file, sessions, selectedSession, activeSessions, currentSession, currentSessionExchanges, interactionMode, handleToggleInteractionMode, handleSendMessage, handleSelectSession, handleOpenBubbleSession, isFloatingOpen, handleAgentResponseAppend]
  );

  const tree = useMemo(() => {
    const showSessionInMain = !!selectedSession && interactionMode !== "floating";
    return showSessionInMain || file ? shellTree : mergeViewIntoShell(shellTree, viewTree);
  }, [shellTree, viewTree, selectedSession, interactionMode, file]);

  const actionHandlers = useMemo(
    () => {
      const getParentKeys = (path: string, root: string) => {
        const parts = path.split('/').filter(Boolean);
        const parentKeys = [root];
        for (let i = 1; i < parts.length; i++) {
          const parentPath = parts.slice(0, i).join('/');
          parentKeys.push(`${root}:${parentPath}`);
        }
        return parentKeys;
      };

      return {
        select_session: async (params: Record<string, unknown>) => {
          if (params.key) {
            handleSelectSession({ key: params.key, root_id: params.root });
          }
        },
        open: async (params: Record<string, unknown>) => {
          const path = params.path as string | undefined;
          const rootParam = params.root as string | undefined;
          if (!path) return;
          const root = rootParam || currentRootIdRef.current || managedRootIds[0] || "";
          if (!root) return;

          const parents = getParentKeys(path, root);
          setExpanded((prev) => Array.from(new Set([...prev, ...parents])));
          try {
            if (root !== currentRootIdRef.current) setCurrentRootId(root);
            const query = new URLSearchParams({ path, root });
            const res = await fetch(`/api/file?${query.toString()}`);
            const payload = await res.json().catch(() => ({}));
            if (res.ok) {
              const next = normalizeFileResponse(payload);
              if (next.file) {
                setFile(next.file);
              }
              setViewTree(pickViewTree(next.viewRoutes));
              setSelectedSession(null);
            }
          } catch (err) {}
        },
        open_dir: async (params: Record<string, unknown>) => {
          const path = params.path as string | undefined;
          const rootParam = params.root as string | undefined;
          const isToggle = !!params.toggle;
          if (!path) return;
          const isActuallyRoot = managedRootIdsRef.current.has(path);
          const root = isActuallyRoot ? path : (rootParam || currentRootIdRef.current || managedRootIds[0]);
          const expandedKey = isActuallyRoot ? path : `${root}:${path}`;
          const apiDir = isActuallyRoot ? "." : path;
          if (isToggle && expandedRef.current.includes(expandedKey)) {
            setExpanded((prev) => prev.filter(k => k !== expandedKey));
            return;
          }
          if (isActuallyRoot) {
            setCurrentRootId(path);
            setExpanded((prev) => Array.from(new Set([...prev, path])));
          } else {
            const parents = getParentKeys(path, root);
            setExpanded((prev) => Array.from(new Set([...prev, ...parents, expandedKey])));
          }
          try {
            const res = await fetch(`/api/tree?root=${encodeURIComponent(root)}&dir=${encodeURIComponent(apiDir)}`);
            const payload = await res.json();
            const parsed = normalizeTreeResponse(payload);
            const cacheKey = `${root}:${apiDir}`;
            setEntriesByPath((prev) => ({ ...prev, [cacheKey]: parsed.entries }));
            setSelectedDir(path);
            setMainEntries(parsed.entries);
            setViewTree(pickViewTree(parsed.viewRoutes));
            setFile(null);
            setSelectedSession(null);
          } catch (err) {}
        },
      };
    },
    [handleSelectSession, normalizeFileResponse, normalizeTreeResponse, pickViewTree]
  );

  useEffect(() => {
    if (!currentRootId) return;
    sessionService.connect(currentRootId);
    let cancelled = false;
    const loadSessions = async (rootID: string) => {
      try {
        const res = await fetch(`/api/sessions?root=${encodeURIComponent(rootID)}`);
        const payload = await res.json();
        if (!cancelled) {
          const next = Array.isArray(payload) ? payload : [];
          if (rootID === currentRootIdRef.current) {
            setSessions(next);
          }
          setSessionsByRoot((prev) => ({ ...prev, [rootID]: next }));
        }
      } catch {}
    };

    const refreshCurrentFile = async (rootID: string, path: string) => {
      try {
        const query = new URLSearchParams({ path, root: rootID });
        const res = await fetch(`/api/file?${query.toString()}`);
        const payload = await res.json().catch(() => ({}));
        if (!res.ok || cancelled) {
          if (cancelled) return;
          setFile(null);
          const activeDir = selectedDirRef.current;
          if (activeDir) {
            await refreshCurrentDir(rootID, activeDir);
          } else {
            await refreshCurrentDir(rootID, rootID);
          }
          return;
        }
        const next = normalizeFileResponse(payload);
        if (!next.file) {
          setFile(null);
          return;
        }
        setFile(next.file);
        setViewTree(pickViewTree(next.viewRoutes));
      } catch {}
    };

    const refreshCurrentDir = async (rootID: string, dir: string) => {
      const apiDir = managedRootIdsRef.current.has(dir) ? "." : dir;
      try {
        const res = await fetch(`/api/tree?root=${encodeURIComponent(rootID)}&dir=${encodeURIComponent(apiDir)}`);
        const payload = await res.json().catch(() => ({}));
        if (!res.ok || cancelled) {
          if (cancelled) return;
          if (apiDir === ".") return;
          const normalized = dir.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
          const parentDir = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : rootID;
          if (parentDir && parentDir !== dir) {
            setSelectedDir(parentDir);
            await refreshCurrentDir(rootID, parentDir);
          }
          return;
        }
        const parsed = normalizeTreeResponse(payload);
        const cacheKey = `${rootID}:${apiDir}`;
        setEntriesByPath((prev) => ({ ...prev, [cacheKey]: parsed.entries }));
        setMainEntries(parsed.entries);
        setSelectedDir(dir);
        setViewTree(pickViewTree(parsed.viewRoutes));
      } catch {}
    };

    const isPathInDir = (path: string, dir: string, rootID: string): boolean => {
      if (!path) return false;
      if (managedRootIdsRef.current.has(dir) || dir === rootID || dir === "." || dir === "") {
        return true;
      }
      return path === dir || path.startsWith(`${dir}/`);
    };

    const handleReconnect = () => {
      const rootID = currentRootIdRef.current;
      if (!rootID) {
        return;
      }
      loadSessions(rootID);
      const selected = selectedSessionRef.current;
      const sessionKey = selected?.key || selected?.session_key;
      if (!sessionKey) {
        return;
      }
      if (typeof sessionKey === "string" && sessionKey.startsWith("pending-")) {
        return;
      }
      void (async () => {
        const full = await sessionService.getSession(rootID, sessionKey);
        if (!full || cancelled || full.closed_at) {
          return;
        }
        const fullWithPending = { ...(full as any), pending: false } as Session;
        if (interactionModeRef.current !== "floating") {
          openSessionInMain(rootID, fullWithPending);
        }
      })();
    };

    const handleSessionStream = (payload: Record<string, unknown>) => {
      const streamKey = typeof payload.session_key === "string" ? payload.session_key : "";
      const activeRoot = currentRootIdRef.current;
      if (!streamKey || !activeRoot) {
        return;
      }
      const event = (payload.event || null) as { type?: string; data?: Record<string, unknown> } | null;
      const cacheKey = rootSessionKey(activeRoot, streamKey);
      let pending = pendingBySessionRef.current[cacheKey];
      if (!pending) {
        const draft = pendingDraftRef.current;
        if (draft && draft.rootId === activeRoot) {
          pending = draft;
          pendingBySessionRef.current[cacheKey] = draft;
          pendingDraftRef.current = null;
        }
      }
      setFile(null);
      setSelectedSession((prev) => {
        const prevKey = prev?.key || prev?.session_key;
        if (prevKey === streamKey) {
          return { ...(prev as any), pending: true } as SessionItem;
        }
        const isPendingPlaceholder = typeof prevKey === "string" && prevKey.startsWith("pending-");
        if (!isPendingPlaceholder || !pending) {
          return prev;
        }
        const seedExchanges = [{ role: "user", content: pending.message, timestamp: pending.timestamp } as Exchange];
        return {
          key: streamKey,
          root_id: activeRoot,
          type: pending?.mode,
          agent: pending?.agent,
          pending: true,
          exchanges: seedExchanges,
        } as SessionItem;
      });
      if (pending) {
        seedCurrentSessionFromPending(activeRoot, streamKey, pending);
      }
      if (!event || !event.type) {
        return;
      }
      if (event.type === "message_chunk") {
        const content = typeof event.data?.content === "string" ? event.data.content : "";
        if (content) {
          appendAgentChunkForSession(activeRoot, streamKey, content, pending?.agent);
        }
        return;
      }
      if (event.type === "thought_chunk") {
        const content = typeof event.data?.content === "string" ? event.data.content : "";
        if (content) {
          appendThoughtChunkForSession(activeRoot, streamKey, content);
        }
        return;
      }
      if (event.type === "tool_call") {
        appendToolCallForSession(activeRoot, streamKey, (event.data || {}) as Record<string, unknown>, false);
        return;
      }
      if (event.type === "tool_call_update") {
        appendToolCallForSession(activeRoot, streamKey, (event.data || {}) as Record<string, unknown>, true);
        return;
      }
      if (event.type === "error") {
        delete pendingBySessionRef.current[cacheKey];
        setSelectedPendingByKey(streamKey, false);
        return;
      }
      if (event.type === "message_done") {
        return;
      }
    };

    const handleSessionDone = (payload: Record<string, unknown>) => {
      const doneKey = typeof payload.session_key === "string" ? payload.session_key : "";
      const activeRoot = currentRootIdRef.current;
      if (activeRoot) {
        loadSessions(activeRoot);
      }
      if (!doneKey || !activeRoot) {
        return;
      }
      delete pendingBySessionRef.current[rootSessionKey(activeRoot, doneKey)];
      setSelectedPendingByKey(doneKey, false);
    };

    const handleFileChange = (payload: Record<string, unknown>) => {
      const eventRoot = typeof payload.root_id === "string" ? payload.root_id : "";
      const eventPath = typeof payload.path === "string" ? payload.path : "";
      if (!eventRoot || eventRoot !== currentRootIdRef.current) {
        return;
      }
      const activeFile = fileRef.current;
      if (activeFile?.path && activeFile.path === eventPath) {
        refreshCurrentFile(eventRoot, activeFile.path);
        return;
      }
      const activeDir = selectedDirRef.current;
      if (activeDir && isPathInDir(eventPath, activeDir, eventRoot)) {
        refreshCurrentDir(eventRoot, activeDir);
      }
    };

    const unsubscribeEvents = sessionService.subscribeEvents((event) => {
      const payload = (event.payload || {}) as Record<string, unknown>;
      switch (event.type) {
        case "ws.reconnected":
          handleReconnect();
          return;
        case "session.stream":
          handleSessionStream(payload);
          return;
        case "session.done":
          handleSessionDone(payload);
          return;
        case "file.changed":
          handleFileChange(payload);
          return;
        default:
          return;
      }
    });
    loadSessions(currentRootId);
    return () => { cancelled = true; unsubscribeEvents(); sessionService.disconnect(); };
  }, [currentRootId, normalizeFileResponse, normalizeTreeResponse, pickViewTree, openSessionInMain, seedCurrentSessionFromPending, setSelectedPendingByKey, rootSessionKey, appendAgentChunkForSession, appendThoughtChunkForSession, appendToolCallForSession]);

  useEffect(() => {
    if (managedRootIds.length === 0) return;
    setSessionsReady(false);
    let cancelled = false;
    const loadAllRoots = async () => {
      await Promise.all(
        managedRootIds.map(async (rootID) => {
          try {
            const res = await fetch(`/api/sessions?root=${encodeURIComponent(rootID)}`);
            const payload = await res.json();
            if (cancelled) return;
            const next = Array.isArray(payload) ? payload : [];
            setSessionsByRoot((prev) => ({ ...prev, [rootID]: next }));
            if (rootID === currentRootIdRef.current) {
              setSessions(next);
            }
          } catch {}
        })
      );
      if (!cancelled) {
        setSessionsReady(true);
      }
    };
    loadAllRoots();
    return () => {
      cancelled = true;
    };
  }, [managedRootIds]);

  return (
    <JSONUIProvider registry={registry} initialData={{}} actionHandlers={actionHandlers}>
      <Renderer tree={tree} registry={registry} />
    </JSONUIProvider>
  );
}

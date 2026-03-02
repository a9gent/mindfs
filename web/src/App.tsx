import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { JSONUIProvider } from "@json-render/react";
import { Renderer } from "./renderer/Renderer";
import { registry } from "./renderer/registry";
import { sessionService, type Session } from "./services/session";
import { buildClientContext } from "./services/context";

// 直接导入标准组件
import { AppShell } from "./layout/AppShell";
import { FileTree } from "./components/FileTree";
import { FileViewer } from "./components/FileViewer";
import { SessionViewer } from "./components/SessionViewer";
import { DefaultListView } from "./components/DefaultListView";
import { SessionList } from "./components/SessionList";
import { ActionBar } from "./components/ActionBar";
import { BottomSheet } from "./components/BottomSheet";

// 类型定义
export type FileEntry = { name: string; path: string; is_dir: boolean; };
export type UIElement = { key: string; type: string; props?: Record<string, unknown>; children?: string[]; };
export type UITree = { root: string; elements: Record<string, UIElement>; };
export type FilePayload = { name: string; path: string; content: string; encoding: string; truncated: boolean; size: number; ext?: string; mime?: string; root?: string; file_meta?: any[]; };
export type SessionItem = { key?: string; session_key?: string; root_id?: string; name?: string; type?: "chat" | "view" | "skill"; agent?: string; scope?: string; purpose?: string; closed_at?: string; related_files?: Array<{ path: string; name?: string }>; exchanges?: Array<{ role?: string; content?: string; timestamp?: string }>; pending?: boolean; };
type Exchange = { role: string; agent?: string; content?: string; timestamp?: string; toolCall?: any; };
type PendingSend = { rootId: string; mode: "chat" | "view" | "skill"; agent: string; message: string; timestamp: string; };

// Hook for responsive detection
function useResponsive() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const checkSize = () => {
      const width = window.innerWidth;
      setIsMobile(width < 768);
    };
    checkSize();
    window.addEventListener("resize", checkSize);
    return () => window.removeEventListener("resize", checkSize);
  }, []);
  return { isMobile };
}

export function App() {
  const managedRootIdsRef = useRef<Set<string>>(new Set());
  const expandedRef = useRef<string[]>([]);
  const selectedDirRef = useRef<string | null>(null);
  const fileRef = useRef<FilePayload | null>(null);
  const selectedSessionRef = useRef<SessionItem | null>(null);
  const currentSessionRef = useRef<Session | null>(null);
  const interactionModeRef = useRef<"main" | "floating">("main");
  const pendingDraftRef = useRef<PendingSend | null>(null);
  const pendingBySessionRef = useRef<Record<string, PendingSend>>({});
  const sessionCacheRef = useRef<Record<string, Session>>({});
  const loadedSessionRef = useRef<Record<string, boolean>>({});
  const loadingSessionRef = useRef<Record<string, Promise<Session | null>>>({});
  
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [selectedSession, setSelectedSession] = useState<SessionItem | null>(null);
  const [activeBoundSessionKey, setActiveBoundSessionKey] = useState<string | null>(null);
  const [currentSession, setCurrentSession] = useState<Session | null>(null);
  const [cacheVersion, setCacheVersion] = useState(0);
  const [interactionMode, setInteractionMode] = useState<"main" | "floating">("main");
  const [agentsVersion, setAgentsVersion] = useState(0);
  const [isFloatingOpen, setIsFloatingOpen] = useState(false);
  const { isMobile } = useResponsive();
  const [isLeftOpen, setIsLeftOpen] = useState(!isMobile);
  const [isRightOpen, setIsRightOpen] = useState(!isMobile);
  const [currentRootId, setCurrentRootId] = useState<string | null>(null);
  const currentRootIdRef = useRef<string | null>(null);
  const [managedRootIds, setManagedRootIds] = useState<string[]>([]);
  const [rootEntries, setRootEntries] = useState<FileEntry[]>([]);
  const [entriesByPath, setEntriesByPath] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<string[]>([]);
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  const [mainEntries, setMainEntries] = useState<FileEntry[]>([]);
  const [status, setStatus] = useState("Disconnected");
  const [file, setFile] = useState<FilePayload | null>(null);
  const [viewTree, setViewTree] = useState<UITree | null>(null);

  useEffect(() => { currentRootIdRef.current = currentRootId; }, [currentRootId]);
  useEffect(() => { expandedRef.current = expanded; }, [expanded]);
  useEffect(() => { selectedDirRef.current = selectedDir; }, [selectedDir]);
  useEffect(() => { fileRef.current = file; }, [file]);
  useEffect(() => { selectedSessionRef.current = selectedSession; }, [selectedSession]);
  useEffect(() => { currentSessionRef.current = currentSession; }, [currentSession]);
  useEffect(() => { interactionModeRef.current = interactionMode; }, [interactionMode]);

  const rootSessionKey = useCallback((rootId: string, sessionKey: string) => `${rootId}::${sessionKey}`, []);
  const bumpCacheVersion = useCallback(() => setCacheVersion((v) => v + 1), []);
  const getSessionSnapshot = useCallback((rootId: string | null | undefined, session: Session | SessionItem | null | undefined) => {
    if (!rootId || !session) return null;
    const key = (session as any).key || (session as any).session_key;
    if (!key) return null;
    const ck = rootSessionKey(rootId, key);
    const cached = sessionCacheRef.current[ck];
    const fallbackExchanges = Array.isArray((session as any).exchanges) ? ((session as any).exchanges as Exchange[]) : [];
    const exchanges = Array.isArray((cached as any)?.exchanges) ? (((cached as any).exchanges as Exchange[]) || []) : fallbackExchanges;
    return { ...(session as any), ...(cached as any), key, exchanges } as any;
  }, [rootSessionKey, cacheVersion]);

  const setSelectedPendingByKey = useCallback((sessionKey: string, pending: boolean) => {
    setSelectedSession((prev) => {
      const prevKey = prev?.key || prev?.session_key;
      if (!prev || prevKey !== sessionKey) return prev;
      return { ...(prev as any), pending } as SessionItem;
    });
  }, []);

  const resolveAgentForSession = useCallback((rootID: string, sessionKey: string, fallbackAgent?: string): string => {
    if (fallbackAgent) return fallbackAgent;
    const cacheKey = rootSessionKey(rootID, sessionKey);
    const cached = sessionCacheRef.current[cacheKey] as any;
    if (cached?.agent) return cached.agent;
    const current = currentSessionRef.current as any;
    if (current?.key === sessionKey && current?.agent) return current.agent;
    const selected = selectedSessionRef.current as any;
    if ((selected?.key || selected?.session_key) === sessionKey && selected?.agent) return selected.agent;
    return "";
  }, [rootSessionKey]);

  const appendAgentChunkForSession = useCallback((rootID: string, sessionKey: string, content: string, agentHint?: string) => {
    if (!content) return;
    const now = new Date().toISOString();
    const cacheKey = rootSessionKey(rootID, sessionKey);
    const resolvedAgent = resolveAgentForSession(rootID, sessionKey, agentHint);
    const updateList = (prevList: Exchange[]) => {
      const list = [...(prevList || [])];
      const last = list.length > 0 ? list[list.length - 1] : null;
      if (last && (last.role === "agent" || last.role === "assistant")) {
        list[list.length - 1] = { ...last, agent: last.agent || resolvedAgent, content: `${last.content || ""}${content}`, timestamp: now };
        return list;
      }
      list.push({ role: "agent", agent: resolvedAgent, content, timestamp: now });
      return list;
    };
    const cached = sessionCacheRef.current[cacheKey];
    const base = cached || ({
      key: sessionKey,
      type: "chat",
      agent: resolvedAgent,
      name: "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      exchanges: [],
    } as any);
    const nextList = updateList((((base as any).exchanges || []) as Exchange[]));
    sessionCacheRef.current[cacheKey] = {
      ...(base as any),
      agent: (base as any).agent || resolvedAgent,
      exchanges: nextList,
      updated_at: new Date().toISOString(),
    } as Session;
    bumpCacheVersion();
  }, [rootSessionKey, resolveAgentForSession, bumpCacheVersion]);

  const appendThoughtChunkForSession = useCallback((rootID: string, sessionKey: string, content: string) => {
    if (!content) return;
    const now = new Date().toISOString();
    const cacheKey = rootSessionKey(rootID, sessionKey);
    const updateList = (prevList: Exchange[]) => {
      const list = [...(prevList || [])];
      const last = list.length > 0 ? list[list.length - 1] : null;
      if (last && last.role === "thought") {
        list[list.length - 1] = { ...last, content: `${last.content || ""}${content}`, timestamp: now };
        return list;
      }
      list.push({ role: "thought", content, timestamp: now });
      return list;
    };
    const cached = sessionCacheRef.current[cacheKey];
    const base = cached || ({
      key: sessionKey,
      type: "chat",
      agent: "",
      name: "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      exchanges: [],
    } as any);
    const nextList = updateList((((base as any).exchanges || []) as Exchange[]));
    sessionCacheRef.current[cacheKey] = {
      ...(base as any),
      exchanges: nextList,
      updated_at: new Date().toISOString(),
    } as Session;
    bumpCacheVersion();
  }, [rootSessionKey, bumpCacheVersion]);

  const appendToolCallForSession = useCallback((rootID: string, sessionKey: string, toolCall: any, update: boolean) => {
    if (!toolCall) return;
    const now = new Date().toISOString();
    const cacheKey = rootSessionKey(rootID, sessionKey);
    const mergeToolCall = (existing: any, incoming: any) => {
      const merged = { ...(existing || {}), ...incoming };
      if (!incoming.kind && existing?.kind) merged.kind = existing.kind;
      if (!incoming.title && existing?.title) merged.title = existing.title;
      return merged;
    };
    const updateList = (prevList: Exchange[]) => {
      const list = [...(prevList || [])];
      const callId = toolCall.callId || toolCall.toolCallId || toolCall.tool_call_id || "";
      if (update && callId) {
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i]?.role === "tool" && (list[i]?.toolCall?.callId === callId || list[i]?.toolCall?.toolCallId === callId || list[i]?.toolCall?.tool_call_id === callId)) {
            list[i] = { ...list[i], timestamp: now, toolCall: mergeToolCall(list[i].toolCall, toolCall) };
            return list;
          }
        }
      }
      list.push({ role: "tool", content: "", timestamp: now, toolCall });
      return list;
    };
    const cached = sessionCacheRef.current[cacheKey];
    const base = cached || ({
      key: sessionKey,
      type: "chat",
      agent: "",
      name: "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      exchanges: [],
    } as any);
    const nextList = updateList((((base as any).exchanges || []) as Exchange[]));
    sessionCacheRef.current[cacheKey] = {
      ...(base as any),
      exchanges: nextList,
      updated_at: new Date().toISOString(),
    } as Session;
    bumpCacheVersion();
  }, [rootSessionKey, bumpCacheVersion]);

  const normalizeFileResponse = useCallback((payload: any) => {
    if (payload && payload.file) return { file: payload.file as FilePayload, viewRoutes: (payload.view_routes || []) as any[] };
    return { file: null, viewRoutes: [] };
  }, []);

  const normalizeTreeResponse = useCallback((payload: any) => {
    if (payload && payload.entries) return { entries: payload.entries as FileEntry[], viewRoutes: (payload.view_routes || []) as any[] };
    return { entries: [], viewRoutes: [] };
  }, []);

  const pickViewTree = useCallback((routes: any[]): UITree | null => {
    if (!routes || routes.length === 0) return null;
    return routes[0].tree as UITree;
  }, []);

  const handleSelectSession = useCallback(async (session: any) => {
    const key = session?.key || session?.session_key;
    const targetRoot = (session?.root_id as string | undefined) || currentRootIdRef.current;
    if (!targetRoot || !key) return;
    setSelectedSession(session);
    setInteractionMode("main");
    setIsFloatingOpen(false);
    if (isMobile) setIsRightOpen(false);
    const cacheKey = rootSessionKey(targetRoot, key);
    const applySession = (fullSession: Session) => {
      sessionCacheRef.current[cacheKey] = fullSession;
      loadedSessionRef.current[cacheKey] = true;
      if (activeBoundSessionKey === key) setCurrentSession(fullSession);
      bumpCacheVersion();
    };
    const cached = sessionCacheRef.current[cacheKey];
    if (cached) {
      applySession(cached);
      return;
    }
    if (loadedSessionRef.current[cacheKey]) {
      return;
    }
    try {
      const inflight = loadingSessionRef.current[cacheKey];
      if (inflight) {
        const fullSession = await inflight;
        if (fullSession) applySession(fullSession);
        return;
      }
      const request = sessionService
        .getSession(targetRoot, key)
        .then((full) => (full ? ({ ...(full as any), key } as Session) : null))
        .finally(() => {
          delete loadingSessionRef.current[cacheKey];
        });
      loadingSessionRef.current[cacheKey] = request;
      const fullSession = await request;
      if (fullSession) {
        applySession(fullSession);
      }
    } catch (err) {}
  }, [activeBoundSessionKey, isMobile, rootSessionKey, bumpCacheVersion]);

  const handleSendMessage = useCallback(async (message: string, mode: "chat" | "view" | "skill", agent: string) => {
    const activeRoot = currentRootIdRef.current;
    if (!activeRoot) return;
    let sendSessionKey = activeBoundSessionKey;
    let session: Session | null = null;
    if (sendSessionKey) {
      session = sessionCacheRef.current[rootSessionKey(activeRoot, sendSessionKey)];
    } else {
      const selected = selectedSessionRef.current;
      const selectedKey = selected?.key || selected?.session_key;
      if (selectedKey && !selectedKey.startsWith("pending-")) {
        sendSessionKey = selectedKey;
        session = sessionCacheRef.current[rootSessionKey(activeRoot, sendSessionKey)] || ({ ...selected, key: selectedKey } as Session);
      }
    }
    let effectiveMode = mode, effectiveAgent = agent;
    if (sendSessionKey && session) {
      effectiveMode = (session.type as any) || mode;
      effectiveAgent = agent || session.agent || "";
      setActiveBoundSessionKey(sendSessionKey);
      setSelectedPendingByKey(sendSessionKey, true);
      setCurrentSession((prev) => {
        if (!prev || prev.key !== sendSessionKey) return prev;
        return { ...(prev as any), pending: true } as Session;
      });
    } else {
      sendSessionKey = undefined;
      const tempKey = `pending-${Date.now()}`;
      session = { key: tempKey, type: mode, agent, name: "新会话", pending: true } as any;
    }
    const now = new Date().toISOString();
    const userEx: Exchange = { role: "user", content: message, timestamp: now };
    if (sendSessionKey) {
      const ck = rootSessionKey(activeRoot, sendSessionKey);
      const cached = sessionCacheRef.current[ck] || ({ ...(session as any) } as Session);
      const prevExchanges = Array.isArray((cached as any).exchanges) ? ((cached as any).exchanges as Exchange[]) : [];
      sessionCacheRef.current[ck] = {
        ...(cached as any),
        exchanges: [...prevExchanges, userEx],
        updated_at: now,
      } as Session;
      bumpCacheVersion();
    } else {
      pendingDraftRef.current = { rootId: activeRoot, mode: effectiveMode, agent: effectiveAgent, message, timestamp: now };
    }
    const isBoundInMain = !!selectedSessionRef.current && selectedSessionRef.current.key === sendSessionKey && interactionModeRef.current !== "floating";
    if (!isBoundInMain) { setInteractionMode("floating"); setIsFloatingOpen(true); }
    setCurrentSession({ ...(session as any), pending: true } as Session);
    setFile(null);
    const context = buildClientContext({ currentRoot: activeRoot, currentPath: fileRef.current?.path ?? selectedDirRef.current ?? undefined });
    const sent = await sessionService.sendMessage(activeRoot, sendSessionKey, message, effectiveMode, effectiveAgent, context);
    if (!sent && sendSessionKey) {
      setSelectedPendingByKey(sendSessionKey, false);
      setCurrentSession((prev) => {
        if (!prev || prev.key !== sendSessionKey) return prev;
        return { ...(prev as any), pending: false } as Session;
      });
    }
  }, [activeBoundSessionKey, rootSessionKey, setSelectedPendingByKey, bumpCacheVersion]);

  const handleNewSession = useCallback(() => {
    setSelectedSession(null); setActiveBoundSessionKey(null); setCurrentSession(null);
    setViewTree(null); setInteractionMode("main"); setIsFloatingOpen(false);
  }, []);

  const actionHandlers = useMemo(() => ({
    open: async (params: any) => {
      const path = params.path, root = params.root || currentRootIdRef.current;
      if (!path || !root) return;
      try {
        const res = await fetch(`/api/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
        const payload = await res.json();
        const next = normalizeFileResponse(payload);
        if (next.file) setFile(next.file);
        setViewTree(pickViewTree(next.viewRoutes));
        setSelectedSession(null);
        setIsFloatingOpen(false);
        if (isMobile) setIsLeftOpen(false);
      } catch {}
    },
    open_dir: async (params: any) => {
      const path = params.path, rootParam = params.root || currentRootIdRef.current, isToggle = !!params.toggle;
      if (!path || !rootParam) return;
      const isActuallyRoot = managedRootIdsRef.current.has(path);
      const root = isActuallyRoot ? path : rootParam;
      const expandedKey = isActuallyRoot ? path : `${root}:${path}`;
      const apiDir = isActuallyRoot ? "." : path;
      if (isToggle && expandedRef.current.includes(expandedKey)) { setExpanded((prev) => prev.filter(k => k !== expandedKey)); return; }
      if (isActuallyRoot) { setCurrentRootId(path); setExpanded((prev) => Array.from(new Set([...prev, path]))); } else { setExpanded((prev) => Array.from(new Set([...prev, expandedKey]))); }
      try {
        const res = await fetch(`/api/tree?root=${encodeURIComponent(root)}&dir=${encodeURIComponent(apiDir)}`);
        const payload = await res.json();
        const parsed = normalizeTreeResponse(payload);
        setEntriesByPath((prev) => ({ ...prev, [`${root}:${apiDir}`]: parsed.entries }));
        setMainEntries(parsed.entries); setSelectedDir(path); setViewTree(pickViewTree(parsed.viewRoutes)); setFile(null); setSelectedSession(null);
        setIsFloatingOpen(false);
        if (isMobile) setIsLeftOpen(false);
      } catch {}
    }
  }), [isMobile, normalizeFileResponse, normalizeTreeResponse, pickViewTree]);

  useEffect(() => {
    if (!currentRootId) return;
    sessionService.connect(currentRootId); setStatus("Connected");
    let cancelled = false;
    const loadSessions = async (rootID: string) => {
      try {
        const res = await fetch(`/api/sessions?root=${encodeURIComponent(rootID)}`);
        const payload = await res.json();
        if (!cancelled) { const next = Array.isArray(payload) ? payload : []; setSessions(next); }
      } catch {}
    };
    const handleSessionStream = (payload: any) => {
      const streamKey = payload.session_key, activeRoot = currentRootIdRef.current;
      if (!streamKey || !activeRoot) return;
      const ck = rootSessionKey(activeRoot, streamKey);
      let pending = pendingBySessionRef.current[ck];
      if (!pending) { const draft = pendingDraftRef.current; if (draft && draft.rootId === activeRoot) { pending = draft; pendingBySessionRef.current[ck] = draft; pendingDraftRef.current = null; } }
      if (!activeBoundSessionKey) {
        setActiveBoundSessionKey(streamKey);
        if (pending) {
          const userEx = { role: "user", content: pending.message, timestamp: pending.timestamp };
          const cached = sessionCacheRef.current[ck] || ({
            key: streamKey,
            type: pending.mode,
            agent: pending.agent,
            name: "",
            created_at: pending.timestamp,
            updated_at: pending.timestamp,
            exchanges: [],
          } as any);
          const prevExchanges = Array.isArray((cached as any).exchanges) ? ((cached as any).exchanges as Exchange[]) : [];
          sessionCacheRef.current[ck] = {
            ...(cached as any),
            exchanges: prevExchanges.length > 0 ? prevExchanges : [userEx],
            updated_at: new Date().toISOString(),
          } as Session;
          bumpCacheVersion();
        }
      }
      const event = payload.event; if (!event?.type) return;
      if (event.type === "message_chunk") appendAgentChunkForSession(activeRoot, streamKey, event.data?.content || "", pending?.agent);
      else if (event.type === "thought_chunk") appendThoughtChunkForSession(activeRoot, streamKey, event.data?.content || "");
      else if (event.type === "tool_call") appendToolCallForSession(activeRoot, streamKey, event.data || {}, false);
      else if (event.type === "tool_call_update") appendToolCallForSession(activeRoot, streamKey, event.data || {}, true);
      else if (event.type === "message_done") {
        delete pendingBySessionRef.current[ck];
        setSelectedPendingByKey(streamKey, false);
        setCurrentSession((prev) => {
          if (!prev || prev.key !== streamKey) return prev;
          return { ...(prev as any), pending: false } as Session;
        });
      } else if (event.type === "error") {
        delete pendingBySessionRef.current[ck];
        setSelectedPendingByKey(streamKey, false);
        setCurrentSession((prev) => {
          if (!prev || prev.key !== streamKey) return prev;
          return { ...(prev as any), pending: false } as Session;
        });
      }
    };
    const dirname = (path: string): string => {
      const clean = (path || "").replace(/^\/+|\/+$/g, "");
      if (!clean || clean === ".") return ".";
      const idx = clean.lastIndexOf("/");
      return idx <= 0 ? "." : clean.slice(0, idx);
    };
    const currentDirAPI = (rootID: string): string => {
      const selected = selectedDirRef.current;
      if (!selected || selected === rootID) return ".";
      return selected;
    };
    const refreshDir = async (rootID: string, dirPath: string, syncMain: boolean) => {
      try {
        const res = await fetch(`/api/tree?root=${encodeURIComponent(rootID)}&dir=${encodeURIComponent(dirPath)}`);
        if (!res.ok) return;
        const payload = await res.json();
        const parsed = normalizeTreeResponse(payload);
        if (cancelled) return;
        setEntriesByPath((prev) => ({ ...prev, [`${rootID}:${dirPath}`]: parsed.entries }));
        if (syncMain) {
          setMainEntries(parsed.entries);
        }
      } catch {}
    };
    const handleFileChanged = (payload: any) => {
      const rootID = typeof payload?.root_id === "string" ? payload.root_id : "";
      const changedPath = typeof payload?.path === "string" ? payload.path : "";
      if (!rootID || !changedPath) return;
      const parentDir = dirname(changedPath);
      const currentDir = currentDirAPI(rootID);
      const syncMain = rootID === currentRootIdRef.current && parentDir === currentDir;
      void refreshDir(rootID, parentDir, syncMain);
    };
    const unsubscribeEvents = sessionService.subscribeEvents((event) => {
      const payload = (event.payload || {}) as any;
      switch (event.type) {
        case "session.stream": handleSessionStream(payload); break;
        case "session.done": loadSessions(currentRootIdRef.current!); break;
        case "file.changed": handleFileChanged(payload); break;
        case "agent.status.changed": setAgentsVersion(v => v + 1); break;
      }
    });
    loadSessions(currentRootId);
    return () => { cancelled = true; unsubscribeEvents(); sessionService.disconnect(); setStatus("Disconnected"); };
  }, [currentRootId, activeBoundSessionKey, rootSessionKey, appendAgentChunkForSession, appendThoughtChunkForSession, appendToolCallForSession, setSelectedPendingByKey]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/dirs").then(r => r.json()).then(dirs => {
      if (cancelled || !dirs.length) return;
      const ids = dirs.map((d: any) => d.id);
      managedRootIdsRef.current = new Set(ids); setManagedRootIds(ids);
      setRootEntries(ids.map((id: string) => ({
        name: id.split("/").filter(Boolean).pop() || id,
        path: id,
        is_dir: true,
      })));
      const first = ids[0]; setCurrentRootId(first); actionHandlers.open_dir({ path: first, root: first });
    });
    return () => { cancelled = true; };
  }, [actionHandlers]);

  return (
    <AppShell
      leftOpen={isLeftOpen} rightOpen={isRightOpen}
      onCloseLeft={() => setIsLeftOpen(false)} onCloseRight={() => setIsRightOpen(false)}
      sidebar={<FileTree entries={rootEntries} childrenByPath={entriesByPath} expanded={expanded} selectedPath={file?.path} rootId={currentRootId} managedRoots={managedRootIds} onSelectFile={(e, r) => { actionHandlers.open({path: e.path, root: r}); if (isMobile) setIsLeftOpen(false); }} onToggleDir={(e, r) => actionHandlers.open_dir({path: e.path, root: r, toggle: true})} />}
      rightSidebar={<SessionList sessions={sessions} selectedKey={selectedSession?.key} onSelect={(s) => { handleSelectSession(s); if (isMobile) setIsRightOpen(false); }} />}
      main={
        <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", position: "relative" }}>
          <div style={{ position: "absolute", top: "10px", left: isMobile ? "10px" : (isLeftOpen ? "-40px" : "10px"), right: isMobile ? "10px" : (isRightOpen ? "-40px" : "10px"), display: "flex", justifyContent: "space-between", pointerEvents: "none", zIndex: 100 }}>
            <button onClick={() => setIsLeftOpen(!isLeftOpen)} style={{ pointerEvents: "auto", background: "var(--content-bg)", border: "1px solid var(--border-color)", borderRadius: "8px", width: "32px", height: "32px", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", opacity: isLeftOpen && !isMobile ? 0 : 1 }}>📁</button>
            <button onClick={() => setIsRightOpen(!isRightOpen)} style={{ pointerEvents: "auto", background: "var(--content-bg)", border: "1px solid var(--border-color)", borderRadius: "8px", width: "32px", height: "32px", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", opacity: isRightOpen && !isMobile ? 0 : 1 }}>🕒</button>
          </div>
          <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
            {selectedSession && interactionMode !== "floating" ? (
              <SessionViewer session={getSessionSnapshot(selectedSession.root_id || currentRootId, selectedSession)} />
            ) : file ? (
              <FileViewer
                file={file}
                onSessionClick={handleSelectSession}
                onPathClick={(path) => {
                  const root = file.root || currentRootIdRef.current;
                  if (!root) return;
                  actionHandlers.open_dir({ path: path === "." ? root : path, root });
                }}
              />
            ) : (
              <DefaultListView
                root={currentRootId || undefined}
                path={selectedDir || ""}
                entries={mainEntries}
                onItemClick={(e) => e.is_dir ? actionHandlers.open_dir({ path: e.path }) : actionHandlers.open({ path: e.path })}
                onPathClick={(path) => {
                  const root = currentRootIdRef.current;
                  if (!root) return;
                  actionHandlers.open_dir({ path: path === "." ? root : path, root });
                }}
              />
            )}
          </div>
        </div>
      }
      footer={<ActionBar status={status} agentsVersion={agentsVersion} currentSession={activeBoundSessionKey ? { ...currentSession, pending: false } as any : (selectedSession ? { ...selectedSession, pending: true } as any : null)} onSendMessage={handleSendMessage} onNewSession={handleNewSession} onSessionClick={() => {
        if (!activeBoundSessionKey) return;
        const selectedKey = selectedSession?.key || selectedSession?.session_key;
        const isBoundSessionInMain = selectedKey === activeBoundSessionKey && interactionMode !== "floating";
        if (isBoundSessionInMain) return;
        setInteractionMode("floating");
        setIsFloatingOpen((prev) => !prev);
      }} />}
      floating={<BottomSheet isOpen={isFloatingOpen} onClose={() => setIsFloatingOpen(false)} onFullScreen={() => { handleSelectSession(currentSession); setIsFloatingOpen(false); }}>{currentSession ? <SessionViewer session={getSessionSnapshot(currentRootId, currentSession)} interactionMode="floating" /> : <div style={{ padding: "40px", textAlign: "center" }}>点击蓝点或发消息开始</div>}</BottomSheet>}
    />
  );
}

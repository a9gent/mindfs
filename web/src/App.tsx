import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { JSONUIProvider } from "@json-render/react";
import { Renderer } from "./renderer/Renderer";
import {
  buildDefaultTree,
  type FileEntry,
  type FilePayload,
  type SessionSummary,
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
  const managedRootIdsRef = useRef<Set<string>>(new Set());
  const expandedRef = useRef<string[]>([]);
  const [sessions, setSessions] = useState<any[]>([]);
  const [selectedSession, setSelectedSession] = useState<SessionSummary | null>(null);
  const selectedSessionRef = useRef<SessionSummary | null>(null);
  const [currentSession, setCurrentSession] = useState<Session | null>(null);
  const [currentSessionExchanges, setCurrentSessionExchanges] = useState<any[]>([]);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isFloatingOpen, setIsFloatingOpen] = useState(false);

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
        const list = await treeRes.json();
        if (cancelled) return;
        
        const cacheKey = `${first.path}:.`;
        setEntriesByPath((prev) => ({ ...prev, [cacheKey]: list }));
        setExpanded([first.path]);
        setSelectedDir(first.path);
        setMainEntries(list);
        setStatus("Connected");
      } catch (err) { console.error("Init failed:", err); }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  useEffect(() => {
    selectedSessionRef.current = selectedSession;
  }, [selectedSession]);

  const handleSelectSession = useCallback(
    async (session: any) => {
      const key = session?.key || session?.session_key;
      if (!currentRootId || !key) {
        setSelectedSession(null);
        return;
      }
      if (currentSession && key === currentSession.key && currentSession.status !== "closed") {
        setIsFloatingOpen(true);
        const full = await sessionService.getSession(currentRootId, key);
        if (full) {
          setSelectedSession(full as any);
          setCurrentSessionExchanges(full.exchanges || []);
        }
        return;
      }
      const full = await sessionService.getSession(currentRootId, key);
      if (!full) return;
      if (full.status === "closed") {
        setSelectedSession(full as any);
        setFile(null);
        setIsFloatingOpen(false);
      } else {
        setSelectedSession(full as any);
        setCurrentSession(full as any);
        setCurrentSessionExchanges(full.exchanges || []);
        setIsFloatingOpen(true);
      }
    },
    [currentRootId, currentSession]
  );

  const handleSendMessage = useCallback(
    async (message: string, mode: "chat" | "view" | "skill", agent: string) => {
      if (!currentRootId) return;
      let session = currentSession;
      if (!session || session.status === "closed" || session.type !== mode || session.agent !== agent) {
        session = await sessionService.createSession(currentRootId, mode, agent);
        if (!session) return;
        setCurrentSession(session);
      }
      setIsFloatingOpen(true);
      const snapshot = await sessionService.getSession(currentRootId, session.key);
      setSelectedSession((snapshot as any) ?? (session as any));
      const nowISO = new Date().toISOString();
      const newUserExchange = { role: "user", content: message, timestamp: nowISO };
      setCurrentSessionExchanges((prev) => [...prev, newUserExchange]);
      setSelectedSession((prev: any) => {
        if (!prev) return prev;
        const prevKey = prev.key || prev.session_key;
        if (prevKey !== session!.key) return prev;
        return { ...prev, exchanges: [...(prev.exchanges || []), newUserExchange] };
      });
      const context = buildClientContext({ currentRoot: currentRootId, currentPath: file?.path ?? selectedDir ?? undefined });
      await sessionService.sendMessage(currentRootId, session.key, message, context);
    },
    [currentRootId, currentSession, file?.path, selectedDir]
  );

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
        currentSession ? { ...currentSession, exchanges: currentSessionExchanges } : null,
        handleSendMessage,
        () => setIsFloatingOpen((prev) => !prev),
        rightCollapsed,
        () => setRightCollapsed((prev) => !prev),
        () => { setSettingsOpen((prev) => !prev); setRightCollapsed(false); },
        settingsOpen,
        isFloatingOpen,
        setIsFloatingOpen
      ),
    [rootEntries, entriesByPath, expanded, selectedDir, currentRootId, managedRootIds, mainEntries, status, file, sessions, selectedSession, currentSession, currentSessionExchanges, handleSendMessage, rightCollapsed, handleSelectSession, settingsOpen, isFloatingOpen]
  );

  const tree = useMemo(() => {
    const isSelectedSessionActive = currentSession && (selectedSession?.key === currentSession.key || selectedSession?.session_key === currentSession.key);
    const showSessionInMain = selectedSession && !isSelectedSessionActive;
    return showSessionInMain || file ? shellTree : mergeViewIntoShell(shellTree, viewTree);
  }, [shellTree, viewTree, selectedSession, currentSession, file]);

  const actionHandlers = useMemo(
    () => {
      const getExpandedKey = (path: string, root: string) => {
        if (managedRootIdsRef.current.has(path)) return path;
        return `${root}:${path}`;
      };

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
          if (params.key) handleSelectSession({ key: params.key });
        },
        open: async (params: Record<string, unknown>) => {
          const path = params.path as string | undefined;
          let rootParam = params.root as string | undefined;
          if (!path) return;
          const root = rootParam || currentRootId || managedRootIds[0] || "";
          if (!root) return;

          const parents = getParentKeys(path, root);
          setExpanded((prev) => Array.from(new Set([...prev, ...parents])));

          try {
            if (root !== currentRootId) setCurrentRootId(root);
            const query = new URLSearchParams({ path, root });
            const res = await fetch(`/api/file?${query.toString()}`);
            const payload = await res.json().catch(() => ({}));
            if (res.ok) {
              setFile(payload as FilePayload);
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
          const root = isActuallyRoot ? path : (rootParam || currentRootId || managedRootIds[0]);
          const expandedKey = isActuallyRoot ? path : `${root}:${path}`;
          const apiDir = isActuallyRoot ? "." : path;

          // 关键修复：只要目标 root 与当前活跃 root 不同，立即同步切换上下文
          if (root && root !== currentRootId) {
            setCurrentRootId(root);
          }

          // 1. 处理 Toggle 逻辑
          if (isToggle && expandedRef.current.includes(expandedKey)) {
            setExpanded((prev) => prev.filter(k => k !== expandedKey));
            return;
          }

          // 2. 更新展开状态
          if (isActuallyRoot) {
            setExpanded((prev) => Array.from(new Set([...prev, path])));
          } else {
            const parents = getParentKeys(path, root);
            setExpanded((prev) => Array.from(new Set([...prev, ...parents, expandedKey])));
          }

          // 3. 拉取并缓存数据
          try {
            const res = await fetch(`/api/tree?root=${encodeURIComponent(root)}&dir=${encodeURIComponent(apiDir)}`);
            const list = await res.json();
            const cacheKey = `${root}:${apiDir}`;
            setEntriesByPath((prev) => ({ ...prev, [cacheKey]: Array.isArray(list) ? list : [] }));
            setSelectedDir(path);
            setMainEntries(Array.isArray(list) ? list : []);
            setFile(null);
            setSelectedSession(null);
          } catch (err) { console.error("Open dir failed", err); }
        },
      };
    },
    [currentRootId, managedRootIds, handleSelectSession]
  );

  useEffect(() => {
    if (!currentRootId) return;
    sessionService.connect(currentRootId);
    let cancelled = false;
    const loadSessions = async () => {
      try {
        const res = await fetch(`/api/sessions?root=${encodeURIComponent(currentRootId)}`);
        const payload = await res.json();
        if (!cancelled) setSessions(Array.isArray(payload) ? payload : []);
      } catch {}
    };
    const pollView = async () => {
      try {
        const res = await fetch(`/api/view/routes?root=${encodeURIComponent(currentRootId)}`);
        const payload = await res.json();
        const first = (Array.isArray(payload) ? payload : []).find((r: any) => r.view_data);
        if (!cancelled && first) setViewTree(first.view_data as UITree);
      } catch {}
    };
    const unsubscribeEvents = sessionService.subscribeEvents((event) => {
      if (["session.done", "session.created", "session.closed", "session.resumed"].includes(event.type)) {
        loadSessions();
        if (event.sessionKey && currentRootId) {
          sessionService.getSession(currentRootId, event.sessionKey).then(full => {
            if (full) {
              if (currentSession?.key === event.sessionKey) setCurrentSessionExchanges(full.exchanges || []);
              if (selectedSessionRef.current?.key === event.sessionKey || !selectedSessionRef.current) setSelectedSession(full as any);
            }
          });
        }
      }
    });
    loadSessions(); pollView();
    const interval = setInterval(() => { loadSessions(); pollView(); }, 30000);
    return () => { cancelled = true; clearInterval(interval); unsubscribeEvents(); sessionService.disconnect(); };
  }, [currentRootId]);

  return (
    <JSONUIProvider registry={registry} initialData={{}} actionHandlers={actionHandlers}>
      <Renderer tree={tree} registry={registry} />
    </JSONUIProvider>
  );
}

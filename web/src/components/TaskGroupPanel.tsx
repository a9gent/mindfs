import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { sessionService } from "../services/session";
import { fetchTaskGroups, fetchGroupGraph, groupOperation, updateGroupContext, type TaskGroup, type GroupGraph, type TaskDetail } from "../services/tasks";

const button: React.CSSProperties = {
  border: "1px solid var(--border-color)", borderRadius: 6,
  background: "var(--menu-bg)", color: "var(--text-color)", padding: "5px 9px", cursor: "pointer",
};

export function TaskGroupPanel({ rootId, sessionKey, renderTask }: {
  rootId: string;
  sessionKey: string;
  renderTask: (detail: TaskDetail, close: () => void) => React.ReactNode;
}) {
  const { t } = useI18n();
  const tabsId = useId();
  const [groups, setGroups] = useState<TaskGroup[]>([]);
  const [selected, setSelected] = useState("");
  const [graph, setGraph] = useState<GroupGraph | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [groupMenu, setGroupMenu] = useState<{left: number; top: number; width: number} | null>(null);
  const groupTrigger = useRef<HTMLButtonElement>(null);
  const groupOptions = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<"dag" | "context" | "messages">("dag");
  const [draft, setDraft] = useState<{value: string; version: number} | null>(null);
  const request = useRef(0);
  const refresh = useCallback(async (includeGroups = true) => {
    const ticket = ++request.current;
    try {
      if (includeGroups) {
        const items = await fetchTaskGroups(rootId);
        if (ticket !== request.current) return;
        const ownGroups = items.filter(item => item.session_key === sessionKey);
        setGroups(ownGroups);
        if (selected && !ownGroups.some(item => item.id === selected)) {
          setSelected("");
          setGraph(null);
          return;
        }
      }
      if (selected) {
        const result = await fetchGroupGraph(rootId, selected);
        if (ticket === request.current) setGraph(result);
      }
    } catch (e) {
      if (ticket === request.current) setError(String(e));
    }
  }, [rootId, sessionKey, selected]);
  useEffect(() => {
    let timer: number | undefined;
    let includeGroups = false;
    const scheduleRefresh = (list: boolean) => {
      includeGroups ||= list;
      if (timer !== undefined) return;
      // Coalesce bursts of push events; this is not a periodic refresh.
      timer = window.setTimeout(() => {
        timer = undefined;
        const list = includeGroups;
        includeGroups = false;
        void refresh(list);
      }, 100);
    };
    const unsubscribe = sessionService.subscribeEvents(event => {
      if (event.type === "ws.connected" || event.type === "ws.reconnected") {
        scheduleRefresh(true);
        return;
      }
      const payload = event.payload;
      if (payload?.root_id !== rootId) return;
      if (event.type === "task-group.updated") {
        const group = payload.group as TaskGroup | undefined;
        if (group?.session_key === sessionKey) scheduleRefresh(true);
      } else if (event.type === "task.updated" && selected) {
        const task = payload.task as TaskDetail["task"] | undefined;
        if (task?.group_id === selected) scheduleRefresh(false);
      } else if (event.type === "task.deleted" && selected) {
        scheduleRefresh(true);
      }
    });
    void refresh();
    return () => {
      ++request.current;
      unsubscribe();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [refresh, rootId, sessionKey, selected]);
  useEffect(() => {
    setDraft(null);
    setError("");
    setGroupMenu(null);
  }, [selected]);
  useEffect(() => {
    if (!groupMenu) return;
    groupOptions.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (!groupTrigger.current?.contains(event.target as Node) && !groupOptions.current?.contains(event.target as Node)) setGroupMenu(null);
    };
    const resize = () => setGroupMenu(null);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", resize);
    };
  }, [groupMenu]);
  useEffect(() => {
    if (!selected) return;
    const close = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (groupMenu) { setGroupMenu(null); groupTrigger.current?.focus(); }
      else setSelected("");
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [selected, groupMenu]);

  const act = async (operation: string, input: Record<string, unknown> = {}) => {
    setBusy(true); setError("");
    try { await groupOperation(rootId, selected, operation, input); await refresh(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const saveContext = async () => {
    if (!draft) return;
    setBusy(true); setError("");
    try {
      const updated = await updateGroupContext(rootId, selected, draft.value, draft.version);
      setGraph(prev => prev ? {...prev, group: updated} : prev);
      setDraft(null);
      await refresh();
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const open = (id: string) => { setGraph(null); setSelected(id); setTab("dag"); };
  const group = graph?.group;
  const contextEditable = !!group && !["success","cancelled"].includes(group.status);
  const messageParty = (id: string) => {
    if (id === group?.session_key) return t("taskGroup.parentConversation");
    const task = graph?.tasks.find(detail => detail.task.id === id)?.task;
    return task ? `#${task.task_number}` : "—";
  };
  if (!groups.length && !selected) return null;
  return <>
    <button type="button" className="mindfs-agent-memory-badge" aria-haspopup="dialog"
      onClick={() => groups[0] && open(groups[0].id)}
      style={{height:20,padding:"0 8px",borderRadius:999,fontSize:11,fontWeight:700,lineHeight:1,whiteSpace:"nowrap",cursor:"pointer"}}>
      {t("taskGroup.title")}
    </button>
    {selected && createPortal(
      <div role="dialog" aria-modal="true" aria-label={t("taskGroup.title")}
        onClick={event => { if (event.target === event.currentTarget) setSelected(""); }}
        style={{position:"fixed",inset:0,zIndex:100,background:"rgba(0,0,0,.35)",display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
        <section style={{width:"min(800px,100%)",maxHeight:"88vh",overflow:"hidden",display:"flex",flexDirection:"column",background:"var(--menu-bg)",color:"var(--text-color)",border:"1px solid var(--border-color)",borderRadius:10,padding:16,minWidth:0}}>
          <header style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
            <button ref={groupTrigger} type="button" disabled={busy || groups.length < 2}
              aria-haspopup={groups.length > 1 ? "menu" : undefined} aria-expanded={!!groupMenu} aria-controls={groupMenu ? `${tabsId}-groups` : undefined}
              onClick={() => {
                if (groupMenu) { setGroupMenu(null); return; }
                const rect = groupTrigger.current!.getBoundingClientRect();
                const width = Math.min(Math.max(rect.width, 220), window.innerWidth-32);
                setGroupMenu({left:Math.max(16,Math.min(rect.left,window.innerWidth-width-16)),top:rect.bottom+6,width});
              }}
              style={{display:"inline-flex",alignItems:"center",gap:6,minWidth:0,maxWidth:"100%",border:0,padding:0,background:"transparent",color:"inherit",font:"inherit",textAlign:"left",cursor:groups.length > 1 && !busy ? "pointer" : "default",opacity:busy ? 0.6 : 1}}>
              <strong style={{minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{group?.title || groups.find(item => item.id === selected)?.title || t("taskGroup.title")}</strong>
              {groups.length > 1 && <>
                <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" style={{flexShrink:0}}>
                  <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </>}
            </button>
            {groupMenu && createPortal(<div ref={groupOptions} id={`${tabsId}-groups`} role="menu" aria-label={t("taskGroup.title")}
              style={{position:"fixed",left:groupMenu.left,top:groupMenu.top,width:groupMenu.width,maxHeight:Math.min(240,window.innerHeight-groupMenu.top-16),overflowY:"auto",zIndex:101,boxSizing:"border-box",padding:4,border:"1px solid var(--border-color)",borderRadius:8,background:"var(--menu-bg)",color:"var(--text-color)",boxShadow:"0 6px 24px rgba(0,0,0,.18)"}}
              onKeyDown={event => {
                const options = Array.from(groupOptions.current?.querySelectorAll<HTMLButtonElement>("button") || []);
                const index = options.indexOf(document.activeElement as HTMLButtonElement);
                let next = index;
                if (event.key === "ArrowDown") next = (index+1)%options.length;
                else if (event.key === "ArrowUp") next = (index+options.length-1)%options.length;
                else if (event.key === "Home") next = 0;
                else if (event.key === "End") next = options.length-1;
                else if (event.key === "Tab") { setGroupMenu(null); groupTrigger.current?.focus(); return; }
                else return;
                event.preventDefault();
                options[next]?.focus();
              }}>
              {groups.map(item => <button key={item.id} type="button" role="menuitemradio" aria-checked={item.id === selected}
                onClick={() => { setGroupMenu(null); groupTrigger.current?.focus(); if (item.id !== selected) open(item.id); }}
                style={{display:"flex",alignItems:"center",gap:8,width:"100%",border:0,borderRadius:4,padding:"10px 12px",textAlign:"left",font:"inherit",fontSize:13,cursor:"pointer",background:item.id === selected ? "rgba(37,99,235,.12)" : "transparent",color:item.id === selected ? "#2563eb" : "var(--text-color)"}}>
                <span style={{flex:1,minWidth:0,overflowWrap:"anywhere"}}>{item.title || item.id}</span>
                {item.id === selected && <span aria-hidden="true">✓</span>}
              </button>)}
            </div>, document.body)}
          </header>
          {error && <p role="alert" style={{color:"#dc2626"}}>{error}</p>}
          {group && <>
            {group.block_reason && group.block_reason !== "publish_approval" && <p>{group.block_reason}</p>}
            <nav role="tablist" aria-label={t("taskGroup.title")} style={{display:"flex",flexShrink:0,margin:"16px 0 12px",borderBottom:"1px solid var(--border-color)"}}>
              {(["dag","context","messages"] as const).map((value,index,values) => <button
                key={value} type="button" role="tab" id={`${tabsId}-${value}`}
                aria-selected={tab === value} aria-controls={`${tabsId}-panel`} tabIndex={tab === value ? 0 : -1}
                style={{border:0,borderBottom:tab === value ? "2px solid #2563eb" : "2px solid transparent",marginBottom:-1,padding:"10px 12px",background:"transparent",color:tab === value ? "#2563eb" : "var(--text-secondary)",fontSize:13,fontWeight:tab === value ? 700 : 500,cursor:"pointer",whiteSpace:"nowrap"}}
                onClick={() => setTab(value)}
                onKeyDown={event => {
                  let next = index;
                  if (event.key === "ArrowRight") next = (index+1)%values.length;
                  else if (event.key === "ArrowLeft") next = (index+values.length-1)%values.length;
                  else if (event.key === "Home") next = 0;
                  else if (event.key === "End") next = values.length-1;
                  else return;
                  event.preventDefault();
                  setTab(values[next]);
                  document.getElementById(`${tabsId}-${values[next]}`)?.focus();
                }}>{t(`taskGroup.${value}`)}</button>)}
            </nav>
            <div role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${tab}`} style={{minHeight:120,overflow:"auto",minWidth:0}}>
            {tab === "dag" && <GroupDAG graph={graph!} renderTask={detail => renderTask(detail, () => setSelected(""))} />}
            {tab === "context" && (
              <div style={{position:"relative"}}>
                <textarea aria-label={t("taskGroup.context")} rows={12} value={draft?.value ?? group.project_context ?? ""}
                  disabled={busy || !contextEditable}
                  onChange={e => setDraft(prev => ({value:e.target.value,version:prev?.version ?? group.plan_version}))}
                  style={{display:"block",width:"100%",boxSizing:"border-box",resize:"vertical",minHeight:140,padding:contextEditable ? "10px 10px 52px" : "10px",color:"var(--text-color)",background:"var(--content-bg)",border:"1px solid var(--border-color)",borderRadius:6}} />
                {contextEditable && <button type="button" style={{...button,position:"absolute",right:16,bottom:12}}
                  disabled={busy || !draft}
                  onClick={() => void saveContext()}>{t("common.save")}</button>}
              </div>
            )}
            {tab === "messages" && <div style={{overflowX:"auto"}}>
              <table aria-label={t("taskGroup.messages")} style={{width:"100%",minWidth:640,tableLayout:"auto",borderCollapse:"collapse",fontSize:13,textAlign:"left"}}>
                <thead><tr>
                  {(["from","to","message","timestamp"] as const).map(field => <th key={field} scope="col" style={{width:field === "message" ? undefined : "1%",whiteSpace:"nowrap",padding:"10px 12px",borderBottom:"1px solid var(--border-color)",color:"var(--text-secondary)",background:"var(--content-bg)"}}>{field}</th>)}
                </tr></thead>
                <tbody>
                  {!graph?.message_history?.length && <tr><td colSpan={4} style={{padding:16,color:"var(--text-secondary)",textAlign:"center"}}>{t("taskGroup.noMessages")}</td></tr>}
                  {graph?.message_history?.map((message,index) => <tr key={`${message.timestamp}-${index}`}>
                    {(["from","to","message","timestamp"] as const).map(field => <td key={field} style={{padding:"10px 12px",borderBottom:"1px solid var(--border-color)",verticalAlign:"top",whiteSpace:field === "message" ? "pre-wrap" : "nowrap",overflowWrap:"anywhere"}}>
                      {field === "from" || field === "to" ? messageParty(message[field]) : field === "timestamp" ? <time dateTime={message.timestamp}>{new Date(message.timestamp).toLocaleString()}</time> : message.message}
                    </td>)}
                  </tr>)}
                </tbody>
              </table>
            </div>}
            </div>
            {tab === "dag" && !["success","cancelled"].includes(group.status) && (
              <footer style={{display:"flex",justifyContent:"flex-end",gap:8,flexShrink:0,marginTop:16,paddingTop:12}}>
                {!group.published && group.block_reason === "publish_approval" &&
                  <button type="button" style={{...button,background:"#2563eb",borderColor:"#2563eb",color:"#fff",padding:"7px 20px",fontWeight:600,opacity:busy ? 0.6 : 1}} disabled={busy} onClick={() => void act("approve-plan",{plan_version:group.plan_version})}>{t("taskGroup.start")}</button>}
                {group.published &&
                  <button type="button" style={button} disabled={busy} onClick={() => void act(["paused","blocked"].includes(group.status) ? "resume" : "pause")}>
                    {["paused","blocked"].includes(group.status) ? t("taskGroup.resume") : t("taskGroup.pause")}
                  </button>}
              </footer>
            )}
          </>}
        </section>
      </div>, document.body)}
  </>;
}

function GroupDAG({graph, renderTask}: {graph: GroupGraph; renderTask: (detail: TaskDetail) => React.ReactNode}) {
  const { t } = useI18n();
  const marker = useId().replace(/:/g, "");
  const canvas = useRef<HTMLDivElement>(null);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 767px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const cardWidth = isMobile ? 180 : 300;
  const padding = isMobile ? 8 : 20;
  const columnGap = isMobile ? 54 : 90;
  const ids = graph.tasks.map(detail => detail.task.id).join(",");
  useEffect(() => {
    const observer = new ResizeObserver(entries => {
      setHeights(previous => {
        const next = {...previous};
        let changed = false;
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.taskId!;
          const height = Math.ceil(entry.target.getBoundingClientRect().height);
          if (next[id] !== height) { next[id] = height; changed = true; }
        }
        return changed ? next : previous;
      });
    });
    canvas.current?.querySelectorAll<HTMLElement>("[data-task-id]").forEach(node => observer.observe(node));
    return () => observer.disconnect();
  }, [ids]);
  const levels = new Map<string, number>();
  const level = (id: string, path = new Set<string>()): number => {
    if (levels.has(id)) return levels.get(id)!;
    if (path.has(id)) return 0;
    const next = new Set(path).add(id);
    const deps = graph.edges[id] || [];
    const value = deps.length ? 1 + Math.max(...deps.map(dep => level(dep,next))) : 0;
    levels.set(id,value);
    return value;
  };
  const bottoms = new Map<number,number>();
  const points = new Map<string,{x:number;y:number;height:number}>();
  for (const detail of graph.tasks) {
    const col = level(detail.task.id), y = bottoms.get(col) ?? 20, height = heights[detail.task.id] ?? 180;
    points.set(detail.task.id,{x:padding+col*(cardWidth+columnGap),y,height});
    bottoms.set(col,y+height+28);
  }
  const width = Math.max(cardWidth+padding*2,...Array.from(points.values(),point => point.x+cardWidth+padding));
  const height = Math.max(120,...Array.from(points.values(),point => point.y+point.height+20));
  return <div style={{overflow:"auto",maxHeight:"60vh",border:"1px solid var(--border-color)",borderRadius:8,background:"var(--content-bg)"}} aria-label={t("taskGroup.dag")}>
    {!graph.tasks.length ? <p style={{padding:16}}>{t("task.empty")}</p> :
    <div ref={canvas} style={{position:"relative",width,height}}>
      <svg width={width} height={height} aria-hidden="true" style={{position:"absolute",inset:0,pointerEvents:"none",color:"var(--text-secondary)"}}>
        <defs><marker id={marker} markerWidth={8} markerHeight={8} refX={7} refY={4} orient="auto"><path d="M0,0 L0,8 L8,4 z" fill="currentColor"/></marker></defs>
        {Object.entries(graph.edges).flatMap(([id,deps]) => deps.map(dep => {
          const from = points.get(dep), to = points.get(id);
          if (!from || !to) return null;
          const x = from.x+cardWidth,y = from.y+from.height/2,endY=to.y+to.height/2,mid=(x+to.x)/2;
          return <path key={`${dep}-${id}`} d={`M${x},${y} C${mid},${y} ${mid},${endY} ${to.x-4},${endY}`} fill="none" stroke="currentColor" strokeWidth={1.5} markerEnd={`url(#${marker})`}/>;
        }))}
      </svg>
      {graph.tasks.map(detail => {
        const point = points.get(detail.task.id)!;
        return <div key={detail.task.id} data-task-id={detail.task.id} style={{position:"absolute",left:point.x,top:point.y,width:cardWidth}}>{renderTask(detail)}</div>;
      })}
    </div>}
  </div>;
}

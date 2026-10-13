import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { sessionService, type Session } from "../services/session";
import {
  effectiveBlueRingActions,
  BLUE_RING_ACTION_LABEL_KEYS,
  BLUE_RING_GESTURE_LABEL_KEYS,
  recentQuickSwitchGroups,
  ringPathGesture,
  type BlueRingAction,
  type BlueRingGestureConfig,
  type RingPathPoint,
} from "../services/quickSwitch";
import "./SessionQuickActions.css";

export type SessionQuickActionsProps = {
  currentRootId?: string | null;
  currentSessionKey?: string;
  gestureConfig?: BlueRingGestureConfig;
  variant?: "ring" | "button";
  onNewSession: () => void;
  onSelectProject: (rootId: string) => void;
  onSelectSession: (session: Session) => void;
  onToggleFileSidebar?: () => void;
  onToggleSessionSidebar?: () => void;
  onOpenModelSelector?: () => void;
  onOpenGestureSettings?: () => void;
};

type PanelView = "actions" | "switch" | "recent";

export function SessionQuickActions({ currentRootId, currentSessionKey, gestureConfig, variant = "ring", onNewSession, onSelectProject, onSelectSession, onToggleFileSidebar, onToggleSessionSidebar, onOpenModelSelector, onOpenGestureSettings }: SessionQuickActionsProps) {
  const { t } = useI18n();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; points: RingPathPoint[] } | null>(null);
  const suppressClick = useRef(false);
  const [path, setPath] = useState<RingPathPoint[]>([]);
  const [open, setOpen] = useState<PanelView | null>(null);
  const [loading, setLoading] = useState(false);
  const [groups, setGroups] = useState<ReturnType<typeof recentQuickSwitchGroups>>([]);
  const [position, setPosition] = useState<React.CSSProperties>({ left: 8, bottom: 64, width: 272, maxHeight: 400 });
  const isButton = variant === "button";

  useEffect(() => { setOpen(null); }, [currentRootId, currentSessionKey, variant]);
  useEffect(() => {
    if (!open || open === "actions") return;
    let active = true;
    setLoading(true);
    void sessionService.fetchMultiRootSessions(3).then((items) => {
      if (active) { setGroups(recentQuickSwitchGroups(items)); setLoading(false); }
    });
    return () => { active = false; };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const inputRect = buttonRef.current?.closest('[data-onboarding="message-input"]')?.getBoundingClientRect();
      const buttonRect = buttonRef.current?.getBoundingClientRect();
      const rect = inputRect || buttonRect;
      if (!rect) return;
      const width = Math.min(272, window.innerWidth - 16);
      const left = isButton && buttonRect ? buttonRect.left : rect.right - width;
      const fontScaleStyle = {
        "--mindfs-font-scale": getComputedStyle(buttonRef.current!).getPropertyValue("--mindfs-font-scale").trim() || "1",
      } as React.CSSProperties;
      setPosition({ ...fontScaleStyle, left: Math.max(8, Math.min(left, window.innerWidth - width - 8)), bottom: window.innerHeight - rect.top + (isButton ? 8 : 0), width, maxHeight: Math.max(0, Math.min(440, rect.top - 16)) });
    };
    const outside = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node) && !buttonRef.current?.contains(event.target as Node) && !menuButtonRef.current?.contains(event.target as Node)) setOpen(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(null);
        (isButton ? menuButtonRef.current : buttonRef.current)?.focus();
      }
    };
    place();
    const fontRegion = buttonRef.current?.closest(".mindfs-font-scale-region");
    const fontObserver = new MutationObserver(place);
    if (fontRegion) fontObserver.observe(fontRegion, { attributes: true, attributeFilter: ["style"] });
    panelRef.current?.focus();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape, true);
    return () => {
      fontObserver.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", escape, true);
    };
  }, [open, isButton]);

  const actions = effectiveBlueRingActions(gestureConfig);
  const gesturesEnabled = gestureConfig?.enabled === true;

  const reset = () => { drag.current = null; setPath([]); };
  const runAction = (action: BlueRingAction) => {
    switch (action) {
      case "newSession": setOpen(null); onNewSession(); break;
      case "quickSwitch": setOpen("switch"); break;
      case "toggleFileSidebar": onToggleFileSidebar?.(); break;
      case "toggleSessionSidebar": onToggleSessionSidebar?.(); break;
      case "modelSelector": onOpenModelSelector?.(); break;
      case "recentSession": {
        void sessionService.fetchMultiRootSessions(5).then((items) => {
          for (const group of recentQuickSwitchGroups(items)) {
            for (const session of group.items) {
              const key = session.key || session.session_key;
              if (key && key !== currentSessionKey) {
                setOpen(null);
                onSelectSession({ ...session, root_id: group.rootId });
                return;
              }
            }
          }
          setOpen("switch");
        });
        break;
      }
      case "none": break;
    }
  };

  const start = path.length ? path[0] : null;
  const last = path.length ? path[path.length - 1] : null;
  const offset = start && last ? { x: last.x - start.x, y: last.y - start.y } : { x: 0, y: 0 };
  const hint = ringPathGesture(path, false);
  const hintAction: BlueRingAction | null = hint ? actions[hint.gesture] : null;
  const hintText = hint && hintAction && hintAction !== "none"
    ? (gesturesEnabled
      ? (() => {
        const actionLabel = t(BLUE_RING_ACTION_LABEL_KEYS[hintAction]);
        return hint.ready
          ? t("action.gestureReady", { action: actionLabel })
          : t("action.gesturePending", { gesture: t(BLUE_RING_GESTURE_LABEL_KEYS[hint.gesture]), action: actionLabel });
      })()
      : t(hint.gesture === "left"
        ? hint.ready ? "action.releaseNewSession" : "action.swipeNewSession"
        : hint.ready ? "action.releaseQuickSwitch" : "action.swipeQuickSwitch"))
    : "";
  const rowStyle: React.CSSProperties = { display: "block", width: "100%", border: 0, background: "transparent", color: "var(--text-primary)", textAlign: "left", padding: "4px 6px", borderRadius: 6, cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, lineHeight: "18px" };
  const ringStyle: React.CSSProperties = { width: 32, height: 32, marginRight: -4, flexShrink: 0, border: 0, background: "transparent", display: "flex", alignItems: "center", justifyContent: "center", cursor: "grab", touchAction: "none", transform: `translate(${Math.max(-64, Math.min(64, offset.x))}px, ${Math.max(-64, Math.min(0, offset.y))}px)`, transition: drag.current ? "none" : "transform 0.2s", position: "relative", zIndex: 10 };
  const gestureLabel = gesturesEnabled ? t("action.ringHint.custom") : t("action.ringHint");
  const recentSessions = open === "recent" ? groups.flatMap((group) => group.items.map((session) => ({ session, group })))
    .sort((a, b) => (Date.parse(b.session.updated_at || b.session.created_at) || 0) - (Date.parse(a.session.updated_at || a.session.created_at) || 0)) : [];
  const chevron = <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  const trigger = <button ref={buttonRef} type="button" className={isButton ? "session-entry-main" : "session-ring-trigger"} aria-label={isButton ? t("blueRing.action.newSession") : gestureLabel} title={isButton ? `${t("blueRing.action.newSession")} · ${gestureLabel}` : gestureLabel} aria-expanded={isButton ? undefined : !!open} aria-haspopup={isButton ? undefined : "dialog"}
    onPointerDown={(event) => {
      if (!event.isPrimary || event.button !== 0) return;
      suppressClick.current = false;
      drag.current = { id: event.pointerId, points: [{ x: event.clientX, y: event.clientY }] };
      setPath(drag.current.points);
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={(event) => {
      if (drag.current?.id !== event.pointerId || !drag.current.points.length) return;
      const points = drag.current.points;
      const previous = points[points.length - 1];
      if (Math.abs(event.clientX - previous.x) < 3 && Math.abs(event.clientY - previous.y) < 3) return;
      points.push({ x: event.clientX, y: event.clientY });
      setPath([...points]);
    }}
    onPointerUp={(event) => {
      if (drag.current?.id !== event.pointerId) return;
      const points = [...drag.current.points, { x: event.clientX, y: event.clientY }];
      const origin = points[0];
      suppressClick.current = points.some((point) => Math.hypot(point.x - origin.x, point.y - origin.y) > 8);
      reset();
      const match = ringPathGesture(points, true);
      if (match) runAction(actions[match.gesture]);
    }}
    onPointerCancel={reset} onLostPointerCapture={reset}
    onKeyDown={(event) => {
      if (event.key === "ArrowLeft") { event.preventDefault(); runAction(actions.left); }
      if (event.key === "ArrowUp") { event.preventDefault(); runAction(actions.up); }
      if (isButton && event.key === "ArrowDown") { event.preventDefault(); setOpen("actions"); }
    }}
    onClick={(event) => {
      if (isButton) {
        if (event.detail !== 0 && suppressClick.current) { suppressClick.current = false; event.preventDefault(); return; }
        runAction("newSession");
      } else if (event.detail === 0) setOpen((value) => value ? null : "switch");
    }}
    style={isButton ? undefined : ringStyle}>
    {isButton ? <><svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 3v14M3 10h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg><span>{t("blueRing.action.newSession")}</span></> : <span style={{ width: 14, height: 14, border: "2px solid #2563eb", borderRadius: "50%", boxShadow: "0 0 0 1px rgba(37,99,235,0.08)", pointerEvents: "none" }} />}
    {hintText ? <span style={{ position: "absolute", ...(isButton ? { left: 0, bottom: "calc(100% + 8px)" } : { right: "100%", top: "50%", transform: "translateY(-50%)", marginRight: 8 }), fontSize: 10, fontWeight: 600, color: hint?.ready ? "var(--accent-color)" : "var(--text-secondary)", background: "var(--panel-bg)", borderRadius: 4, padding: "2px 4px", whiteSpace: "nowrap", pointerEvents: "none", zIndex: 10 }}>{hintText}</span> : null}
  </button>;
  return <>
    {isButton ? <div className="session-entry" data-open={!!open}>
      {trigger}
      <button ref={menuButtonRef} type="button" className="session-entry-toggle" aria-label={t("action.sessionMenu.title")} title={t("action.sessionMenu.title")} aria-haspopup="dialog" aria-expanded={!!open} onClick={() => setOpen((value) => value ? null : "actions")} onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen("actions"); } }}>{chevron}</button>
    </div> : trigger}
    {open && createPortal(<div ref={panelRef} role="dialog" aria-label={t(open === "actions" ? "action.sessionMenu.title" : open === "recent" ? "action.sessionMenu.recent" : "action.quickSwitch")} tabIndex={-1} className={isButton ? "session-entry-panel mindfs-font-scale-region" : "mindfs-font-scale-region"}
      onKeyDown={(event) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
        if (!buttons.length) return;
        event.preventDefault();
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowDown" ? (index + 1) % buttons.length : (index <= 0 ? buttons.length : index) - 1;
        buttons[next].focus();
      }}
      style={{ position: "fixed", ...position, boxSizing: "border-box", zIndex: 1200, overflowY: "auto", padding: isButton ? "8px" : "6px 4px", background: "var(--menu-bg)", border: "1px solid var(--menu-border)", borderTop: isButton ? undefined : 0, borderRadius: 12, boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}>
      {open === "actions" ? <>
        <div className="session-entry-heading">{t("action.sessionMenu.title")}</div>
        <button className="session-entry-action" type="button" onClick={() => setOpen("switch")}>
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h15m-4-4 4 4-4 4M20 17H5m4-4-4 4 4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <span className="session-entry-action-label">{t("action.sessionMenu.quickSwitch")}<small>{t("action.quickSwitch")}</small></span>
          {actions.up === "quickSwitch" ? <small className="session-entry-shortcut">{t("blueRing.gesture.up")}</small> : <span className="session-entry-next">{chevron}</span>}
        </button>
        <button className="session-entry-action" type="button" onClick={() => setOpen("recent")}>
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 10a9 9 0 1 1 2 8M3 4v6h6M12 7v5l3 2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <span className="session-entry-action-label">{t("action.sessionMenu.recent")}</span><span className="session-entry-next">{chevron}</span>
        </button>
        {onOpenGestureSettings && <><div className="session-entry-separator" /><button className="session-entry-action" type="button" onClick={() => { setOpen(null); onOpenGestureSettings(); }}>
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 13V5a2 2 0 0 1 4 0v7-3a2 2 0 0 1 4 0v3-1a2 2 0 0 1 4 0v4c0 4-2 6-6 6h-1c-2 0-3-1-4-2l-5-6a2 2 0 0 1 3-2l1 2Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <span className="session-entry-action-label">{t("action.sessionMenu.gestures")}</span><span className="session-entry-next">{chevron}</span>
        </button></>}
      </> : <>
        {isButton && <div className="session-entry-list-heading"><button type="button" className="session-entry-back" aria-label={t("action.sessionMenu.title")} onClick={() => setOpen("actions")}>{chevron}</button><span>{t(open === "recent" ? "action.sessionMenu.recent" : "action.sessionMenu.quickSwitch")}</span></div>}
        {loading ? <div role="status" style={{ padding: "8px 6px" }}>{t("common.loading")}</div> : (open === "recent" ? recentSessions.length === 0 : groups.length === 0) ? <div style={{ padding: "8px 6px", color: "var(--text-secondary)" }}>{t("action.quickSwitchEmpty")}</div> : open === "recent" ? recentSessions.map(({ session, group }) => <button className="quick-switch-row session-entry-recent" type="button" key={`${group.rootId}:${session.key || session.session_key}`} title={session.name || session.key || session.session_key} aria-current={group.rootId === currentRootId && (session.key || session.session_key) === currentSessionKey ? "true" : undefined} style={rowStyle} onClick={() => { setOpen(null); onSelectSession({ ...session, root_id: group.rootId }); }}><span>{session.name || session.key || session.session_key}</span><small>{group.rootName || group.rootId}</small></button>) : groups.map((group, index) => <div key={group.rootId} style={{ padding: "2px 0", borderTop: index === 0 ? 0 : "1px solid var(--menu-border)" }}>
          <button className="quick-switch-row" type="button" title={group.rootName || group.rootId} style={{ ...rowStyle, fontWeight: 600, color: group.rootId === currentRootId ? "var(--accent-color)" : "var(--text-primary)" }} onClick={() => { setOpen(null); onSelectProject(group.rootId); }}>{group.rootName || group.rootId}</button>
          {group.items.map((session) => <button className="quick-switch-row" type="button" key={session.key || session.session_key} title={session.name || session.key || session.session_key} aria-current={group.rootId === currentRootId && (session.key || session.session_key) === currentSessionKey ? "true" : undefined} style={{ ...rowStyle, paddingLeft: 18, color: "var(--text-secondary)" }} onClick={() => { setOpen(null); onSelectSession({ ...session, root_id: group.rootId }); }}>{session.name || session.key || session.session_key}</button>)}
        </div>)}
      </>}
      <style>{`.quick-switch-row:hover, .quick-switch-row:focus-visible, .quick-switch-row[aria-current="true"] { background: ${isButton ? "color-mix(in srgb, var(--accent-color) 10%, transparent)" : "rgba(59,130,246,0.1)"} !important; }`}</style>
    </div>, document.body)}
  </>;
}

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { sessionService, type Session } from "../services/session";
import {
  effectiveFloatBallActions,
  FLOAT_BALL_ACTION_LABEL_KEYS,
  FLOAT_BALL_GESTURE_LABEL_KEYS,
  recentQuickSwitchGroups,
  ringPathGesture,
  type FloatBallAction,
  type FloatBallGestureConfig,
  type RingPathPoint,
} from "../services/quickSwitch";

export type SessionQuickActionsProps = {
  currentRootId?: string | null;
  currentSessionKey?: string;
  gestureConfig?: FloatBallGestureConfig;
  onNewSession: () => void;
  onSelectProject: (rootId: string) => void;
  onSelectSession: (session: Session) => void;
  onToggleFileSidebar?: () => void;
  onToggleSessionSidebar?: () => void;
  onOpenModelSelector?: () => void;
};

export function SessionQuickActions({ currentRootId, currentSessionKey, gestureConfig, onNewSession, onSelectProject, onSelectSession, onToggleFileSidebar, onToggleSessionSidebar, onOpenModelSelector }: SessionQuickActionsProps) {
  const { t } = useI18n();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; points: RingPathPoint[] } | null>(null);
  const [path, setPath] = useState<RingPathPoint[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [groups, setGroups] = useState<ReturnType<typeof recentQuickSwitchGroups>>([]);
  const [position, setPosition] = useState({ left: 8, bottom: 64, width: 272, maxHeight: 400 });

  useEffect(() => { setOpen(false); }, [currentRootId, currentSessionKey]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    void sessionService.fetchMultiRootSessions(3).then((items) => {
      if (active) { setGroups(recentQuickSwitchGroups(items)); setLoading(false); }
    });
    const place = () => {
      const rect = buttonRef.current?.closest('[data-onboarding="message-input"]')?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(272, window.innerWidth - 16);
      setPosition({ left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)), bottom: window.innerHeight - rect.top, width, maxHeight: Math.max(0, Math.min(440, rect.top - 16)) });
    };
    const outside = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node) && !buttonRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); buttonRef.current?.focus(); }
    };
    place();
    panelRef.current?.focus();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape, true);
    return () => {
      active = false;
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  const actions = effectiveFloatBallActions(gestureConfig);
  const gesturesEnabled = gestureConfig?.enabled === true;

  const reset = () => { drag.current = null; setPath([]); };
  const runAction = (action: FloatBallAction) => {
    switch (action) {
      case "newSession": setOpen(false); onNewSession(); break;
      case "quickSwitch": setOpen(true); break;
      case "toggleFileSidebar": onToggleFileSidebar?.(); break;
      case "toggleSessionSidebar": onToggleSessionSidebar?.(); break;
      case "modelSelector": onOpenModelSelector?.(); break;
      case "recentSession": {
        void sessionService.fetchMultiRootSessions(5).then((items) => {
          for (const group of recentQuickSwitchGroups(items)) {
            for (const session of group.items) {
              const key = session.key || session.session_key;
              if (key && key !== currentSessionKey) {
                setOpen(false);
                onSelectSession({ ...session, root_id: group.rootId });
                return;
              }
            }
          }
          setOpen(true);
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
  const hintAction: FloatBallAction | null = hint ? actions[hint.gesture] : null;
  const hintText = hint && hintAction && hintAction !== "none"
    ? (gesturesEnabled
      ? (() => {
        const actionLabel = t(FLOAT_BALL_ACTION_LABEL_KEYS[hintAction]);
        return hint.ready
          ? t("action.gestureReady", { action: actionLabel })
          : t("action.gesturePending", { gesture: t(FLOAT_BALL_GESTURE_LABEL_KEYS[hint.gesture]), action: actionLabel });
      })()
      : t(hint.gesture === "left"
        ? hint.ready ? "action.releaseNewSession" : "action.swipeNewSession"
        : hint.ready ? "action.releaseQuickSwitch" : "action.swipeQuickSwitch"))
    : "";
  const rowStyle: React.CSSProperties = { display: "block", width: "100%", border: 0, background: "transparent", color: "var(--text-primary)", textAlign: "left", padding: "4px 6px", borderRadius: 6, cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, lineHeight: "18px" };
  return <>
    <button ref={buttonRef} type="button" aria-label={gesturesEnabled ? t("action.ringHint.custom") : t("action.ringHint")} title={gesturesEnabled ? t("action.ringHint.custom") : t("action.ringHint")} aria-expanded={open} aria-haspopup="dialog"
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0) return;
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
        const points = drag.current.points;
        reset();
        const match = ringPathGesture(points, true);
        if (match) runAction(actions[match.gesture]);
      }}
      onPointerCancel={reset} onLostPointerCapture={reset}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") { event.preventDefault(); runAction(actions.left); }
        if (event.key === "ArrowUp") { event.preventDefault(); runAction(actions.up); }
      }}
      onClick={(event) => { if (event.detail === 0) setOpen((value) => !value); }}
      style={{ width: 32, height: 32, marginRight: -4, flexShrink: 0, border: 0, background: "transparent", display: "flex", alignItems: "center", justifyContent: "center", cursor: "grab", touchAction: "none", transform: `translate(${Math.max(-64, Math.min(64, offset.x))}px, ${Math.max(-64, Math.min(0, offset.y))}px)`, transition: drag.current ? "none" : "transform 0.2s", position: "relative", zIndex: 10 }}>
      <span style={{ width: 14, height: 14, border: "2px solid #2563eb", borderRadius: "50%", boxShadow: "0 0 0 1px rgba(37,99,235,0.08)", pointerEvents: "none" }} />
      {hintText ? <span style={{ position: "absolute", right: "100%", top: "50%", transform: "translateY(-50%)", marginRight: 8, fontSize: 10, fontWeight: 600, color: hint?.ready ? "var(--accent-color)" : "var(--text-secondary)", background: "var(--panel-bg)", borderRadius: 4, padding: "2px 4px", whiteSpace: "nowrap", pointerEvents: "none" }}>
        {hintText}
      </span> : null}
    </button>
    {open && createPortal(<div ref={panelRef} role="dialog" aria-label={t("action.quickSwitch")} tabIndex={-1} style={{ position: "fixed", ...position, boxSizing: "border-box", zIndex: 1200, overflowY: "auto", padding: "6px 4px", background: "var(--menu-bg)", border: "1px solid var(--menu-border)", borderTop: 0, borderRadius: 12, boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}>
      {loading ? <div role="status" style={{ padding: "8px 6px" }}>{t("common.loading")}</div> : groups.length === 0 ? <div style={{ padding: "8px 6px", color: "var(--text-secondary)" }}>{t("action.quickSwitchEmpty")}</div> : groups.map((group, index) => <div key={group.rootId} style={{ padding: "2px 0", borderTop: index === 0 ? 0 : "1px solid var(--menu-border)" }}>
        <button className="quick-switch-row" type="button" title={group.rootName || group.rootId} style={{ ...rowStyle, fontWeight: 600, color: group.rootId === currentRootId ? "var(--accent-color)" : "var(--text-primary)" }} onClick={() => { setOpen(false); onSelectProject(group.rootId); }}>{group.rootName || group.rootId}</button>
        {group.items.map((session) => <button className="quick-switch-row" type="button" key={session.key || session.session_key} title={session.name || session.key || session.session_key} aria-current={group.rootId === currentRootId && (session.key || session.session_key) === currentSessionKey ? "true" : undefined} style={{ ...rowStyle, paddingLeft: 18, color: "var(--text-secondary)" }} onClick={() => { setOpen(false); onSelectSession({ ...session, root_id: group.rootId }); }}>{session.name || session.key || session.session_key}</button>)}
      </div>)}
      <style>{`.quick-switch-row:hover, .quick-switch-row:focus-visible, .quick-switch-row[aria-current="true"] { background: rgba(59,130,246,0.1) !important; }`}</style>
    </div>, document.body)}
  </>;
}

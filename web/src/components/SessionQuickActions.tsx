import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { sessionService, type Session } from "../services/session";
import { recentQuickSwitchGroups, ringGesture } from "../services/quickSwitch";

export type SessionQuickActionsProps = {
  currentRootId?: string | null;
  currentSessionKey?: string;
  onNewSession: () => void;
  onSelectProject: (rootId: string) => void;
  onSelectSession: (session: Session) => void;
};

export function SessionQuickActions({ currentRootId, currentSessionKey, onNewSession, onSelectProject, onSelectSession }: SessionQuickActionsProps) {
  const { t } = useI18n();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [groups, setGroups] = useState<ReturnType<typeof recentQuickSwitchGroups>>([]);
  const [position, setPosition] = useState({ left: 8, bottom: 64, width: 340, maxHeight: 400 });

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
      const width = Math.min(340, window.innerWidth - 16);
      setPosition({ left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)), bottom: window.innerHeight - rect.top + 8, width, maxHeight: Math.max(0, Math.min(440, rect.top - 16)) });
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

  const reset = () => { drag.current = null; setOffset({ x: 0, y: 0 }); };
  const hintDirection = drag.current && offset.x < -10 && -offset.x > Math.abs(offset.y)
    ? "new"
    : drag.current && offset.y < -10 && -offset.y > Math.abs(offset.x) ? "switch" : null;
  const gestureReady = ringGesture(offset.x, offset.y) !== null;
  const rowStyle: React.CSSProperties = { display: "block", width: "100%", border: 0, background: "transparent", color: "var(--text-primary)", textAlign: "left", padding: "8px 12px", borderRadius: 6, cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 };
  return <>
    <button ref={buttonRef} type="button" aria-label={t("action.ringHint")} title={t("action.ringHint")} aria-expanded={open} aria-haspopup="dialog"
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0) return;
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (drag.current?.id !== event.pointerId) return;
        setOffset({ x: event.clientX - drag.current.x, y: event.clientY - drag.current.y });
      }}
      onPointerUp={(event) => {
        if (drag.current?.id !== event.pointerId) return;
        const action = ringGesture(event.clientX - drag.current.x, event.clientY - drag.current.y);
        reset();
        if (action === "new") { setOpen(false); onNewSession(); }
        if (action === "switch") setOpen(true);
      }}
      onPointerCancel={reset} onLostPointerCapture={reset}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") { event.preventDefault(); setOpen(false); onNewSession(); }
        if (event.key === "ArrowUp") { event.preventDefault(); setOpen(true); }
      }}
      onClick={(event) => { if (event.detail === 0) setOpen((value) => !value); }}
      style={{ width: 32, height: 32, marginRight: -4, flexShrink: 0, border: 0, background: "transparent", display: "flex", alignItems: "center", justifyContent: "center", cursor: "grab", touchAction: "none", transform: `translate(${Math.max(-64, Math.min(0, offset.x))}px, ${Math.max(-64, Math.min(0, offset.y))}px)`, transition: drag.current ? "none" : "transform 0.2s", position: "relative", zIndex: 10 }}>
      <span style={{ width: 14, height: 14, border: "2px solid #2563eb", borderRadius: "50%", boxShadow: "0 0 0 1px rgba(37,99,235,0.08)", pointerEvents: "none" }} />
      {hintDirection && <span style={{ position: "absolute", right: "100%", top: "50%", transform: "translateY(-50%)", marginRight: 8, fontSize: 10, fontWeight: 600, color: gestureReady ? "var(--accent-color)" : "var(--text-secondary)", background: "var(--panel-bg)", borderRadius: 4, padding: "2px 4px", whiteSpace: "nowrap", pointerEvents: "none" }}>
        {t(hintDirection === "new"
          ? gestureReady ? "action.releaseNewSession" : "action.swipeNewSession"
          : gestureReady ? "action.releaseQuickSwitch" : "action.swipeQuickSwitch")}
      </span>}
    </button>
    {open && createPortal(<div ref={panelRef} role="dialog" aria-label={t("action.quickSwitch")} tabIndex={-1} style={{ position: "fixed", ...position, boxSizing: "border-box", zIndex: 1200, overflowY: "auto", padding: 8, background: "var(--menu-bg)", border: "1px solid var(--menu-border)", borderTop: 0, borderRadius: 12, boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}>
      {loading ? <div role="status" style={{ padding: 12 }}>{t("common.loading")}</div> : groups.length === 0 ? <div style={{ padding: 12, color: "var(--text-secondary)" }}>{t("action.quickSwitchEmpty")}</div> : groups.map((group, index) => <div key={group.rootId} style={{ padding: "4px 0", borderTop: index === 0 ? 0 : "1px solid var(--menu-border)" }}>
        <button className="quick-switch-row" type="button" title={group.rootName || group.rootId} style={{ ...rowStyle, fontWeight: 600, color: group.rootId === currentRootId ? "var(--accent-color)" : "var(--text-primary)" }} onClick={() => { setOpen(false); onSelectProject(group.rootId); }}>{group.rootName || group.rootId}</button>
        {group.items.map((session) => <button className="quick-switch-row" type="button" key={session.key || session.session_key} title={session.name || session.key || session.session_key} aria-current={group.rootId === currentRootId && (session.key || session.session_key) === currentSessionKey ? "true" : undefined} style={{ ...rowStyle, paddingLeft: 24, color: "var(--text-secondary)" }} onClick={() => { setOpen(false); onSelectSession({ ...session, root_id: group.rootId }); }}>{session.name || session.key || session.session_key}</button>)}
      </div>)}
      <style>{`.quick-switch-row:hover, .quick-switch-row:focus-visible, .quick-switch-row[aria-current="true"] { background: rgba(59,130,246,0.1) !important; }`}</style>
    </div>, document.body)}
  </>;
}

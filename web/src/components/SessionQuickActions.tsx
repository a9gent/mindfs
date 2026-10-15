import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { sessionService, type Session } from "../services/session";
import { getAppearanceMode, setAppearanceMode } from "../services/appearance";
import { isMarkdownOutlineEnabled, setMarkdownOutlineEnabled } from "./markdownOutline";
import { nextRecentDir, type RecentDirEntry } from "../services/recentDirs";
import {
  effectiveBlueRingActions,
  nextAppearanceMode,
  BLUE_RING_ACTION_LABEL_KEYS,
  BLUE_RING_GESTURE_LABEL_KEYS,
  BLUE_RING_PATH_GESTURES,
  recentQuickSwitchGroups,
  ringPathGesture,
  type BlueRingAction,
  type BlueRingGesture,
  type BlueRingGestureConfig,
  type RingPathPoint,
} from "../services/quickSwitch";

export type SessionQuickActionsProps = {
  currentRootId?: string | null;
  currentSessionKey?: string;
  currentDirPath?: string | null;
  gestureConfig?: BlueRingGestureConfig;
  /** Added project directories for the dirSwitch cycler. */
  roots?: Array<{ id: string; name: string }>;
  onNewSession: () => void;
  onSelectProject: (rootId: string) => void;
  onSelectSession: (session: Session) => void;
  onToggleFileSidebar?: () => void;
  onToggleSessionSidebar?: () => void;
  onOpenModelSelector?: () => void;
  onToggleRecentAgent?: () => void;
  onPickAgent?: (agentName: string) => void;
  onOpenRecentDirectory?: (target: RecentDirEntry) => void;
  onToggleMultiProjectSessions?: () => void;
  onToggleEnterKeySends?: () => void;
  onCycleMainFontScale?: () => void;
  onToggleMainContentView?: () => void;
  onCycleKanbanTemplate?: () => void;
  onCreateTask?: (templateId?: string) => void;
  onOpenScheduledTasks?: () => void;
};

const DOUBLE_TAP_MS = 280;
const TAP_MOVE_PX = 6;

export function SessionQuickActions({
  currentRootId,
  currentSessionKey,
  currentDirPath,
  gestureConfig,
  roots,
  onNewSession,
  onSelectProject,
  onSelectSession,
  onToggleFileSidebar,
  onToggleSessionSidebar,
  onOpenModelSelector,
  onToggleRecentAgent,
  onPickAgent,
  onOpenRecentDirectory,
  onToggleMultiProjectSessions,
  onToggleEnterKeySends,
  onCycleMainFontScale,
  onToggleMainContentView,
  onCycleKanbanTemplate,
  onCreateTask,
  onOpenScheduledTasks,
}: SessionQuickActionsProps) {
  const { t } = useI18n();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; points: RingPathPoint[] } | null>(null);
  const tapState = useRef<{ lastTapAt: number; timer: number | null; moved: boolean }>({ lastTapAt: 0, timer: null, moved: false });
  const lastRecentDirRef = useRef<{ rootId: string | null; path: string | null } | null>(null);
  const [path, setPath] = useState<RingPathPoint[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [groups, setGroups] = useState<ReturnType<typeof recentQuickSwitchGroups>>([]);
  const [position, setPosition] = useState({ left: 8, bottom: 64, width: 272, maxHeight: 400 });

  useEffect(() => { setOpen(false); }, [currentRootId, currentSessionKey]);
  // 手动导航到别的目录后，轮切基准要跟着走，否则会从旧目标继续跳
  useEffect(() => {
    if (lastRecentDirRef.current && currentDirPath && lastRecentDirRef.current.path !== currentDirPath) {
      lastRecentDirRef.current = null;
    }
  }, [currentDirPath]);
  useEffect(() => () => {
    if (tapState.current.timer !== null) window.clearTimeout(tapState.current.timer);
  }, []);
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

  const actions = effectiveBlueRingActions(gestureConfig);
  const gesturesEnabled = gestureConfig?.enabled === true;

  const reset = () => { drag.current = null; setPath([]); };
  // 只撤销未触发的 tap 定时器；lastTapAt 不能动，否则第二次按下会把双击窗口抹掉
  const cancelPendingTap = () => {
    if (tapState.current.timer !== null) {
      window.clearTimeout(tapState.current.timer);
      tapState.current.timer = null;
    }
  };
  const runAction = (action: BlueRingAction, gesture?: BlueRingGesture) => {
    switch (action) {
      case "newSession": setOpen(false); onNewSession(); break;
      case "quickSwitch": setOpen((value) => !value); break;
      case "toggleFileSidebar": onToggleFileSidebar?.(); break;
      case "toggleSessionSidebar": onToggleSessionSidebar?.(); break;
      case "modelSelector": onOpenModelSelector?.(); break;
      case "agentToggle": setOpen(false); onToggleRecentAgent?.(); break;
      case "agentPick": {
        const pick = gesture ? gestureConfig?.agentPicks?.[gesture] : undefined;
        if (pick) { setOpen(false); onPickAgent?.(pick); }
        break;
      }
      case "dirSwitch": {
        const list = (roots || []).filter((item) => item.id);
        if (list.length < 2) break;
        const index = list.findIndex((item) => item.id === currentRootId);
        const next = list[(index + 1) % list.length] || list[0];
        setOpen(false);
        onSelectProject(next.id);
        break;
      }
      case "recentDirSwitch": {
        // selectedDir/currentRootId 都是异步更新的，连发手势若读 prop 会卡在同一项；
        // 用上次目标做基准让每次触发都推进一轮，ref 的失效完全交给
        // currentDirPath 变化的 effect（手动导航/换 root 后自动回正）。
        const base = lastRecentDirRef.current || { rootId: currentRootId || null, path: currentDirPath || null };
        const next = nextRecentDir(base.rootId, base.path, (roots || []).map((root) => root.id));
        if (!next) break;
        lastRecentDirRef.current = { rootId: next.rootId, path: next.path };
        setOpen(false);
        onOpenRecentDirectory?.(next);
        break;
      }
      case "toggleMultiProjectList": onToggleMultiProjectSessions?.(); break;
      case "toggleEnterSend": onToggleEnterKeySends?.(); break;
      case "fontCycle": onCycleMainFontScale?.(); break;
      case "themeCycle": setAppearanceMode(nextAppearanceMode(getAppearanceMode())); break;
      case "outlineToggle": setMarkdownOutlineEnabled(!isMarkdownOutlineEnabled()); break;
      case "toggleMainView": setOpen(false); onToggleMainContentView?.(); break;
      case "kanbanTemplateCycle": onCycleKanbanTemplate?.(); break;
      case "newTask": {
        const pick = gesture ? gestureConfig?.taskPicks?.[gesture] : undefined;
        setOpen(false);
        onCreateTask?.(pick);
        break;
      }
      case "openScheduledTasks": setOpen(false); onOpenScheduledTasks?.(); break;
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
  // 两段式进行中若该两段手势未绑定，回退显示第一段（上滑）的绑定，拖动中提示条不消失。
  // 两段式家族以 BLUE_RING_PATH_GESTURES 为准（upDown/upThen*/up*Then*），转向腿一超过
  // 10px 分类器就会切到两段式名字，漏一个名字提示条就会中途闪没。
  const hintGesture: BlueRingGesture | null = hint && !hint.ready && actions[hint.gesture] === "none"
    && BLUE_RING_PATH_GESTURES.includes(hint.gesture)
    ? "up"
    : hint?.gesture ?? null;
  const hintReady = hint?.ready ?? false;
  const hintAction: BlueRingAction | null = hintGesture ? actions[hintGesture] : null;
  const hintText = hintGesture && hintAction && hintAction !== "none"
    ? (gesturesEnabled
      ? (() => {
        const actionLabel = t(BLUE_RING_ACTION_LABEL_KEYS[hintAction]);
        return hintReady
          ? t("action.gestureReady", { action: actionLabel })
          : t("action.gesturePending", { gesture: t(BLUE_RING_GESTURE_LABEL_KEYS[hintGesture]), action: actionLabel });
      })()
      : t(hintGesture === "left"
        ? hintReady ? "action.releaseNewSession" : "action.swipeNewSession"
        : hintReady ? "action.releaseQuickSwitch" : "action.swipeQuickSwitch"))
    : "";
  const rowStyle: React.CSSProperties = { display: "block", width: "100%", border: 0, background: "transparent", color: "var(--text-primary)", textAlign: "left", padding: "4px 6px", borderRadius: 6, cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, lineHeight: "18px" };
  return <>
    <button ref={buttonRef} type="button" aria-label={gesturesEnabled ? t("action.ringHint.custom") : t("action.ringHint")} title={gesturesEnabled ? t("action.ringHint.custom") : t("action.ringHint")} aria-expanded={open} aria-haspopup="dialog"
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0) return;
        cancelPendingTap();
        tapState.current.moved = false;
        drag.current = { id: event.pointerId, points: [{ x: event.clientX, y: event.clientY }] };
        setPath(drag.current.points);
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (drag.current?.id !== event.pointerId || !drag.current.points.length) return;
        const points = drag.current.points;
        const previous = points[points.length - 1];
        if (Math.abs(event.clientX - previous.x) < 3 && Math.abs(event.clientY - previous.y) < 3) return;
        const origin = points[0];
        if (Math.abs(event.clientX - origin.x) >= TAP_MOVE_PX || Math.abs(event.clientY - origin.y) >= TAP_MOVE_PX) {
          tapState.current.moved = true;
        }
        points.push({ x: event.clientX, y: event.clientY });
        setPath([...points]);
      }}
      onPointerUp={(event) => {
        if (drag.current?.id !== event.pointerId) return;
        const points = [...drag.current.points, { x: event.clientX, y: event.clientY }];
        // 极快甩动可能一次 move 事件都没派发，这里补一次位移判定，
        // 防止同一次甩动既命中路径手势又被 onClick 当成 tap 连发。
        const origin = points[0];
        if (origin && (Math.abs(event.clientX - origin.x) >= TAP_MOVE_PX || Math.abs(event.clientY - origin.y) >= TAP_MOVE_PX)) {
          tapState.current.moved = true;
        }
        reset();
        const match = ringPathGesture(points, true);
        if (match) runAction(actions[match.gesture], match.gesture);
      }}
      onPointerCancel={reset} onLostPointerCapture={reset}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") { event.preventDefault(); runAction(actions.left, "left"); }
        if (event.key === "ArrowUp") { event.preventDefault(); runAction(actions.up, "up"); }
      }}
      onClick={(event) => {
        if (event.detail === 0) { setOpen((value) => !value); return; }
        // Mouse/touch click without a drag: tap / double-tap actions.
        if (tapState.current.moved) return;
        const now = Date.now();
        if (now - tapState.current.lastTapAt <= DOUBLE_TAP_MS) {
          cancelPendingTap();
          if (actions.doubleTap === "none") return; // 吸收连点，避免单击动作连发（面板闪开关）
          tapState.current.lastTapAt = 0;
          runAction(actions.doubleTap, "doubleTap");
          return;
        }
        tapState.current.lastTapAt = now;
        if (actions.doubleTap !== "none") {
          tapState.current.timer = window.setTimeout(() => {
            tapState.current.timer = null;
            tapState.current.lastTapAt = 0;
            runAction(actions.tap, "tap");
          }, DOUBLE_TAP_MS + 20);
        } else {
          runAction(actions.tap, "tap");
        }
      }}
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

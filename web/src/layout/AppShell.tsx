import React, { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import {
  classifySwipeIntent,
  clamp01,
  drawerSwipeStartSide,
  swipeProgress,
  swipeRelease,
  type SidebarSide,
  type SwipeDragMode,
} from "../services/edgeSwipe";

type AppShellProps = {
  sidebar: React.ReactNode;
  main: React.ReactNode;
  rightSidebar?: React.ReactNode;
  footer: React.ReactNode;
  drawer?: React.ReactNode;
  leftOpen?: boolean;
  rightOpen?: boolean;
  onCloseLeft?: () => void;
  onCloseRight?: () => void;
  onOpenLeft?: () => void;
  onOpenRight?: () => void;
  sidebarsSwapped?: boolean;
  fileSidebarFontScale?: number;
  mainFontScale?: number;
  sessionSidebarFontScale?: number;
};

const MOBILE_BREAKPOINT = 768;
const TABLET_BREAKPOINT = 1024;
const MOBILE_SIDEBAR_WIDTH = "min(85vw, 360px)";

function useResponsive() {
  const [isMobile, setIsMobile] = useState(false);
  const [isTablet, setIsTablet] = useState(false);
  useEffect(() => {
    const checkSize = () => {
      const width = window.innerWidth;
      setIsMobile(width < MOBILE_BREAKPOINT);
      setIsTablet(width >= MOBILE_BREAKPOINT && width < TABLET_BREAKPOINT);
    };
    checkSize();
    window.addEventListener("resize", checkSize);
    return () => window.removeEventListener("resize", checkSize);
  }, []);
  return { isMobile, isTablet };
}

const sidebarStyle: React.CSSProperties = {
  gridArea: "sidebar",
  borderRight: "1px solid var(--border-color)",
  overflow: "auto",
  background: "var(--mindfs-topbar-bg, var(--sidebar-bg))",
  display: "flex",
  flexDirection: "column",
  position: "relative",
  zIndex: 10,
  minWidth: 0,
};

const mainStyle: React.CSSProperties = {
  gridArea: "main",
  overflow: "hidden",
  padding: "0",
  background: "var(--mindfs-topbar-bg, var(--mobile-overlay-bg, var(--content-bg)))",
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  position: "relative",
  zIndex: 1,
  contain: "paint",
};

const rightStyle: React.CSSProperties = {
  gridArea: "right",
  borderLeft: "1px solid var(--border-color)",
  overflow: "auto",
  background: "var(--mindfs-topbar-bg, var(--sidebar-bg))",
  display: "flex",
  flexDirection: "column",
  position: "relative",
  zIndex: 10,
  minWidth: 0,
};

const footerStyle: React.CSSProperties = {
  gridArea: "footer",
  borderTop: "none",
  padding: "0",
  display: "flex",
  alignItems: "flex-end",
  justifyContent: "center",
  background: "var(--mindfs-topbar-bg, var(--mobile-overlay-bg, var(--content-bg)))",
  zIndex: 100,
  minWidth: 0,
};

type DrawerDrag = {
  side: SidebarSide;
  mode: SwipeDragMode;
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastT: number;
  velocity: number;
  active: boolean;
  el: HTMLElement;
};

function mobileSidebarPixelWidth(): number {
  if (typeof window === "undefined") {
    return 360;
  }
  return Math.min(window.innerWidth * 0.85, 360);
}

export function AppShell({
  sidebar,
  main,
  rightSidebar,
  footer,
  drawer,
  leftOpen = true,
  rightOpen = true,
  onCloseLeft,
  onCloseRight,
  onOpenLeft,
  onOpenRight,
  sidebarsSwapped = false,
  fileSidebarFontScale = 1,
  mainFontScale = 1,
  sessionSidebarFontScale = 1,
}: AppShellProps) {
  const { t } = useI18n();
  const { isMobile, isTablet } = useResponsive();
  const shellRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DrawerDrag | null>(null);
  const dragProgressRef = useRef(0);
  const suppressClickUntilRef = useRef(0);
  const [dragPreview, setDragPreview] = useState<{ side: SidebarSide; progress: number } | null>(null);

  // 拖拽中跨过 768px 断点（旋转/分屏）：桌面分支没有 pointer 处理器，
  // 不清场会让 dragRef 永久卡死、手势整体失效
  useEffect(() => {
    dragRef.current = null;
    dragProgressRef.current = 0;
    setDragPreview(null);
  }, [isMobile]);

  const sidebarWidth = isMobile ? "0px" : (isTablet ? "200px" : "260px");
  const rightWidth = isMobile ? "0px" : (rightSidebar ? (isTablet ? "240px" : "280px") : "0px");
  const mobileHeight = "var(--mindfs-viewport-height, 100dvh)";
  const physicalLeftOpen = sidebarsSwapped ? rightOpen : leftOpen;
  const physicalRightOpen = sidebarsSwapped ? leftOpen : rightOpen;
  const physicalLeftWidth = sidebarsSwapped ? rightWidth : sidebarWidth;
  const physicalRightWidth = sidebarsSwapped ? sidebarWidth : rightWidth;
  const physicalLeftContent = sidebarsSwapped ? rightSidebar : sidebar;
  const physicalRightContent = sidebarsSwapped ? sidebar : rightSidebar;
  const physicalLeftClose = sidebarsSwapped ? onCloseRight : onCloseLeft;
  const physicalLeftOpenHandler = sidebarsSwapped ? onOpenRight : onOpenLeft;
  const physicalRightClose = sidebarsSwapped ? onCloseLeft : onCloseRight;
  const physicalRightOpenHandler = sidebarsSwapped ? onOpenLeft : onOpenRight;
  const physicalLeftLabel = sidebarsSwapped ? t("sidebar.session") : t("sidebar.file");
  const physicalRightLabel = sidebarsSwapped ? t("sidebar.file") : t("sidebar.session");
  const physicalLeftFontScale = sidebarsSwapped ? sessionSidebarFontScale : fileSidebarFontScale;
  const physicalRightFontScale = sidebarsSwapped ? fileSidebarFontScale : sessionSidebarFontScale;
  const fontScaleStyle = (scale: number): React.CSSProperties => ({
    "--mindfs-font-scale": scale,
  } as React.CSSProperties);

  const drawerProgress = (side: SidebarSide): number => {
    if (dragPreview && dragPreview.side === side) {
      return dragPreview.progress;
    }
    return (side === "left" ? physicalLeftOpen : physicalRightOpen) ? 1 : 0;
  };

  const drawerTransform = (side: SidebarSide): string => {
    const progress = drawerProgress(side);
    const offset = side === "left" ? (progress - 1) * 100 : (1 - progress) * 100;
    return `translateX(${offset.toFixed(2)}%) translateZ(0)`;
  };

  const shellStyle: React.CSSProperties & {
    "--mindfs-actionbar-bottom-padding"?: string;
    "--mindfs-file-menu-width"?: string;
  } = {
    display: isMobile ? "flex" : "grid",
    flexDirection: isMobile ? "column" : undefined,
    gridTemplateColumns: isMobile ? undefined : `${physicalLeftOpen ? physicalLeftWidth : "0px"} 1fr ${physicalRightOpen ? physicalRightWidth : "0px"}`,
    gridTemplateRows: isMobile ? undefined : "1fr auto",
    gridTemplateAreas: isMobile ? undefined : `"sidebar main right" "sidebar footer right"`,
    minHeight: isMobile ? mobileHeight : "100vh",
    height: isMobile ? mobileHeight : "100dvh",
    background: isMobile
      ? "var(--mindfs-topbar-bg, var(--mindfs-system-bar-bg, var(--mobile-overlay-bg, var(--content-bg))))"
      : "var(--bg-gradient-composite, var(--bg-gradient-start, #f3f4f6))",
    color: "var(--text-primary)",
    position: "relative",
    width: isMobile ? "100%" : undefined,
    maxWidth: isMobile ? "100%" : undefined,
    paddingTop: isMobile ? "var(--mindfs-safe-area-top, env(safe-area-inset-top, 0px))" : undefined,
    overflow: "hidden",
    isolation: "isolate",
    boxSizing: "border-box",
    transition: "grid-template-columns 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
    "--mindfs-actionbar-bottom-padding": "calc(var(--mindfs-safe-area-bottom) + 12px)",
    "--mindfs-file-menu-width": isMobile ? "min(240px, calc(100vw - 16px))" : "220px",
  };

  const mobileSidebarStyle = (side: SidebarSide): React.CSSProperties => {
    const progress = drawerProgress(side);
    const dragging = !!dragPreview && dragPreview.side === side;
    return {
      position: "fixed",
      top: "var(--mindfs-safe-area-top, env(safe-area-inset-top, 0px))",
      bottom: 0,
      [side]: 0,
      width: MOBILE_SIDEBAR_WIDTH,
      zIndex: 2000,
      background: "var(--mindfs-topbar-bg, var(--mobile-sidebar-bg, var(--sidebar-bg)))",
      boxShadow: side === "left" ? "4px 0 24px rgba(0,0,0,0.15)" : "-4px 0 24px rgba(0,0,0,0.15)",
      transition: dragging
        ? "none"
        : "transform 0.28s cubic-bezier(0.32, 0.72, 0, 1), visibility 0.28s linear",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      borderTopRightRadius: side === "left" ? "14px" : undefined,
      borderBottomRightRadius: side === "left" ? "14px" : undefined,
      borderTopLeftRadius: side === "right" ? "14px" : undefined,
      borderBottomLeftRadius: side === "right" ? "14px" : undefined,
      willChange: "transform",
      backfaceVisibility: "hidden",
      transform: drawerTransform(side),
      // 关闭后移出命中测试与无障碍树；visibility 过渡保证展开瞬间恢复可见
      visibility: progress <= 0 && !dragging ? "hidden" : "visible",
      // touch-action 保持默认：竖向滚动与抽屉内横向滚动区（筛选 chips 等）继续
      // 走原生；横向手势由 touch 事件通道锁定意图后 preventDefault 接管，
      // 不依赖 touch-action——实测 auto/pan-y 在嵌套滚动结构下都会被浏览器抢发
      // pointercancel，touch 流才是抢不走的
      touchAction: "auto",
      pointerEvents: progress <= 0 && !dragging ? "none" : "auto",
    };
  };

  const overlayProgress = Math.max(drawerProgress("left"), drawerProgress("right"));
  const overlayDragging = !!dragPreview;
  const overlayStyle: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.3)",
    zIndex: 1500,
    opacity: clamp01(overlayProgress),
    pointerEvents: !overlayDragging && overlayProgress > 0.02 ? "auto" : "none",
    transition: overlayDragging ? "none" : "opacity 0.18s ease",
    willChange: "opacity",
    backfaceVisibility: "hidden",
    transform: "translateZ(0)",
  };

  const endDrag = (decision: SwipeDragMode | null, side: SidebarSide) => {
    dragProgressRef.current = 0;
    setDragPreview(null);
    suppressClickUntilRef.current = performance.now() + 250;
    if (decision === "open") {
      (side === "left" ? physicalLeftOpenHandler : physicalRightOpenHandler)?.();
    } else if (decision === "close") {
      (side === "left" ? physicalLeftClose : physicalRightClose)?.();
    }
  };

  const drawerPointerDown = (side: SidebarSide, fromEdge: boolean) => (e: React.PointerEvent<HTMLElement>) => {
    if (e.pointerType === "touch") {
      // 触屏走 touch 事件通道（下方 drawerTouch* 系列）：pointer 流会被浏览器的
      // 滚动接管以 pointercancel 杀死（touch-action 只能救部分 DOM 结构，
      // 实测 pan-y 抽屉嵌滚动列表照样被杀），而 pointercancel 后 touch 流仍完整，
      // 锁定横向后 preventDefault 即可让浏览器永远抢不走手势。
      return;
    }
    if (e.pointerType === "mouse" && e.button !== 0) {
      return;
    }
    const open = side === "left" ? physicalLeftOpen : physicalRightOpen;
    // Edge zones only open a closed drawer; the drawer body only closes an open one.
    if (fromEdge ? open : !open) {
      return;
    }
    if (dragRef.current && dragRef.current.active) {
      // 已成手势的拖拽只认一根手指；未激活的"预备态"允许新手指接管，
      // 防止触屏极少数吞事件场景把引擎卡死在武装态
      return;
    }
    dragRef.current = {
      side,
      mode: fromEdge ? "open" : "close",
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastT: performance.now(),
      velocity: 0,
      active: false,
      el: e.currentTarget,
    };
    // 接管预备态时若原武装来自 touch 通道（pointerId=-1），同步清掉它的
    // identifier，否则笔/鼠标先抬指后 touch 通道被悬空 id 永久锁死（审查 P1）
    if (touchDragIdRef.current !== null) {
      touchDragIdRef.current = null;
    }
    // 0 是合法进度（拖满关闭），不能用兜底值区分「没拖过」
    dragProgressRef.current = fromEdge ? 0 : 1;
    // 这里不能抢 setPointerCapture：capture 会把后续 compat click 重定向到
    // 容器，抽屉内按钮的点击与热区下的轻点都会失灵；等手势激活后再接管
  };

  // 拖拽推进：指针/触摸两条通道共用的速度估计与进度回写
  const updateDragFromPoint = (drag: DrawerDrag, x: number, y: number) => {
    const now = performance.now();
    const dt = now - drag.lastT;
    if (dt > 0) {
      const instant = (x - drag.lastX) / dt;
      drag.velocity = drag.velocity * 0.7 + instant * 0.3;
      drag.lastT = now;
      drag.lastX = x;
    }
    const progress = swipeProgress(drag.side, drag.mode, x - drag.startX, mobileSidebarPixelWidth());
    dragProgressRef.current = progress;
    setDragPreview({ side: drag.side, progress });
  };

  const drawerPointerMove = (e: { pointerId: number; clientX: number; clientY: number }) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) {
      return;
    }
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.active) {
      // 僵尸守卫（仅鼠标）：pointerup 被系统吞掉（如窗口失焦）后按钮已松开，
      // 继续留着会让下一次鼠标移动幽灵激活拖拽。
      // 触屏不能按 buttons 清场——不少安卓浏览器/WebView 的 touch move 不按规范
      // 上报 buttons（恒为 0），会把正常滑动误杀成"只能点不能滑"；
      // 触屏由 pointercancel 和 lostpointercapture 兜底，足够了。
      const pointerType = (e as { pointerType?: string }).pointerType;
      if (pointerType === "mouse" && (e as { buttons?: number }).buttons === 0) {
        dragRef.current = null;
        return;
      }
      const intent = classifySwipeIntent(dx, dy);
      if (intent === "vertical") {
        dragRef.current = null;
        return;
      }
      if (intent !== "horizontal") {
        return;
      }
      drag.active = true;
      try {
        drag.el.setPointerCapture(e.pointerId);
      } catch {
        // capture unsupported; window listeners still receive the stream
      }
    }
    updateDragFromPoint(drag, e.clientX, e.clientY);
  };

  const drawerPointerUp = (e: { pointerId: number; clientX: number; clientY: number }) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) {
      return;
    }
    dragRef.current = null;
    if (!drag.active) {
      // No overlay intercepts taps: leave the underlying control's native click alone.
      return;
    }
    const progress = dragProgressRef.current;
    const openDirection = drag.side === "left" ? 1 : -1;
    const velocity = drag.velocity * openDirection;
    endDrag(swipeRelease(progress, velocity, mobileSidebarPixelWidth()), drag.side);
  };

  const drawerPointerCancel = (e: { pointerId: number }) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) {
      return;
    }
    dragRef.current = null;
    if (drag.active) {
      // snap back to the state-derived position without toggling
      dragProgressRef.current = 0;
      suppressClickUntilRef.current = performance.now() + 250;
      setDragPreview(null);
    }
  };

  // ---------- 触屏通道（touch events） ----------
  // pointer 流会被浏览器滚动接管 pointercancel 杀死；pointercancel 之后 touch 流
  // 依然完整送达，所以触屏拖拽从 touchmove 驱动：意图锁定横向后 preventDefault，
  // 浏览器既不敢滚也不敢 cancel。竖向意图立刻放手（不 preventDefault），原生滚动照旧。
  const touchDragIdRef = useRef<number | null>(null);

  // 起点落在可横向滚动的元素里（筛选 chips、代码块）：横滑是它自己的原生滚动，
  // 抽屉引擎不抢
  const touchStartInHorizontalScroller = (target: EventTarget | null, stop: HTMLElement): boolean => {
    let el = target instanceof Element ? target : null;
    while (el && el !== stop && el !== document.body) {
      const styles = window.getComputedStyle(el);
      if ((styles.overflowX === "auto" || styles.overflowX === "scroll") && el.scrollWidth > el.clientWidth + 1) {
        return true;
      }
      el = el.parentElement;
    }
    return false;
  };

  const drawerTouchStart = (side: SidebarSide, fromEdge: boolean, e: TouchEvent, host: HTMLElement) => {
    // 自愈：任何路径留下的悬空 identifier（如混合设备上 pointer 通道接管过）
    // 只要 dragRef 已空，就不该挡住下一次触屏手势
    if (touchDragIdRef.current !== null && !dragRef.current) {
      touchDragIdRef.current = null;
    }
    if (touchDragIdRef.current !== null || dragRef.current) {
      return;
    }
    const open = side === "left" ? physicalLeftOpen : physicalRightOpen;
    // 边缘热区只在关闭态拉开；抽屉本体只在展开态收起
    if (fromEdge ? open : !open) {
      return;
    }
    const touch = e.changedTouches[0];
    if (!touch) {
      return;
    }
    if (touchStartInHorizontalScroller(e.target, host)) {
      return;
    }
    touchDragIdRef.current = touch.identifier;
    dragRef.current = {
      side,
      mode: fromEdge ? "open" : "close",
      pointerId: -1,
      startX: touch.clientX,
      startY: touch.clientY,
      lastX: touch.clientX,
      lastT: performance.now(),
      velocity: 0,
      active: false,
      el: host,
    };
    // 0 是合法进度（拖满关闭），不能用兜底值区分「没拖过」
    dragProgressRef.current = fromEdge ? 0 : 1;
  };

  const drawerTouchMove = (e: TouchEvent) => {
    const drag = dragRef.current;
    const touchId = touchDragIdRef.current;
    if (!drag || touchId === null) {
      return;
    }
    const touch = Array.from(e.changedTouches).find((t) => t.identifier === touchId);
    if (!touch) {
      return;
    }
    if (!drag.active) {
      const intent = classifySwipeIntent(touch.clientX - drag.startX, touch.clientY - drag.startY);
      if (intent === "vertical") {
        // 竖向：还给原生滚动，浏览器会发 pointercancel——touch 流不受影响，
        // 这里先自行清场即可
        dragRef.current = null;
        touchDragIdRef.current = null;
        return;
      }
      if (intent !== "horizontal") {
        return; // 8px 内未定意图，先不表态
      }
      drag.active = true;
    }
    // 意图已锁定横向：吃掉整条手势，浏览器不许滚动、不许接管
    if (e.cancelable) {
      e.preventDefault();
    }
    updateDragFromPoint(drag, touch.clientX, touch.clientY);
  };

  const drawerTouchEnd = (e: TouchEvent, canceled: boolean) => {
    const drag = dragRef.current;
    const touchId = touchDragIdRef.current;
    if (!drag || touchId === null) {
      return;
    }
    const touch = Array.from(e.changedTouches).find((t) => t.identifier === touchId);
    if (!touch) {
      return;
    }
    dragRef.current = null;
    touchDragIdRef.current = null;
    if (!drag.active) {
      // 未成手势的轻点：一切交给原生 click（抽屉内按钮、热区下控件都不受伤）
      return;
    }
    if (canceled) {
      dragProgressRef.current = 0;
      suppressClickUntilRef.current = performance.now() + 250;
      setDragPreview(null);
      return;
    }
    const progress = dragProgressRef.current;
    const openDirection = drag.side === "left" ? 1 : -1;
    const velocity = drag.velocity * openDirection;
    endDrag(swipeRelease(progress, velocity, mobileSidebarPixelWidth()), drag.side);
  };

  const mobileFooterStyle: React.CSSProperties = {
    ...footerStyle,
    flexShrink: 0,
  };

  // move/up/cancel 挂在 window 上：capture 未接管前 touch 隐式捕获把事件发到
  // 原始目标，元素级监听会漏掉指针滑出元素的流
  const pointerHandlersRef = useRef({ move: drawerPointerMove, up: drawerPointerUp, cancel: drawerPointerCancel });
  useEffect(() => {
    pointerHandlersRef.current = { move: drawerPointerMove, up: drawerPointerUp, cancel: drawerPointerCancel };
  });

  useEffect(() => {
    if (!isMobile) {
      return;
    }
    const onMove = (e: PointerEvent) => pointerHandlersRef.current.move(e);
    const onUp = (e: PointerEvent) => pointerHandlersRef.current.up(e);
    const onCancel = (e: PointerEvent) => pointerHandlersRef.current.cancel(e);
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    // lostpointercapture 不冒泡，必须用捕获阶段才能在 window 上收到
    window.addEventListener("lostpointercapture", onCancel, true);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("lostpointercapture", onCancel, true);
    };
  }, [isMobile]);

  // 触屏通道挂 document：touchstart/touchend 冒泡可达，touchmove 必须 non-passive
  // 才能 preventDefault（React 合成事件对 touchmove 是 passive 的，拦不住滚动）。
  // 处理器经 ref 间接调用，保证每次渲染用的都是最新 state（开合前提判定）。
  const drawerTouchStartFromEvent = (e: TouchEvent) => {
    const target = e.target instanceof Element ? e.target : null;
    const shell = shellRef.current;
    if (!target || !shell?.contains(target) || target.closest('[role="dialog"], [aria-modal="true"]')) {
      return;
    }
    const host = target.closest<HTMLElement>("[data-drawer-touch]");
    if (!host) {
      if (physicalLeftOpen || physicalRightOpen) return;
      const touch = e.changedTouches[0];
      const side = touch && drawerSwipeStartSide(touch.clientX, window.innerWidth);
      if (side && (side === "left" ? physicalLeftContent : physicalRightContent)) {
        drawerTouchStart(side, true, e, shell);
      }
      return;
    }
    const side = host.getAttribute("data-drawer-touch") as SidebarSide | null;
    if (side !== "left" && side !== "right") {
      return;
    }
    drawerTouchStart(side, false, e, host);
  };
  const touchHandlersRef = useRef({
    start: drawerTouchStartFromEvent,
    move: drawerTouchMove,
    end: drawerTouchEnd,
  });
  useEffect(() => {
    touchHandlersRef.current = { start: drawerTouchStartFromEvent, move: drawerTouchMove, end: drawerTouchEnd };
  });

  useEffect(() => {
    if (!isMobile) {
      return;
    }
    const touchDragIdReset = () => {
      touchDragIdRef.current = null;
    };
    const onStart = (e: TouchEvent) => touchHandlersRef.current.start(e);
    const onMove = (e: TouchEvent) => touchHandlersRef.current.move(e);
    const onEnd = (e: TouchEvent) => touchHandlersRef.current.end(e, false);
    const onCancel = (e: TouchEvent) => touchHandlersRef.current.end(e, true);
    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
    document.addEventListener("touchcancel", onCancel);
    // 断点切换/卸载时清掉挂起的手势，防止 touchDragId 卡死
    window.addEventListener("pagehide", touchDragIdReset);
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onCancel);
      window.removeEventListener("pagehide", touchDragIdReset);
      touchDragIdReset();
    };
  }, [isMobile]);

  return (
    <div
      ref={shellRef}
      style={shellStyle}
      data-onboarding="shell"
      onPointerDown={isMobile ? (e) => {
        const target = e.target instanceof Element ? e.target : null;
        if (!target || target.closest('[data-drawer-touch], [role="dialog"], [aria-modal="true"]')) return;
        if (physicalLeftOpen || physicalRightOpen) return;
        const side = drawerSwipeStartSide(e.clientX, window.innerWidth);
        if (side && (side === "left" ? physicalLeftContent : physicalRightContent)
          && !touchStartInHorizontalScroller(e.target, e.currentTarget)) {
          drawerPointerDown(side, true)(e);
        }
      } : undefined}
      onClickCapture={isMobile ? (e) => {
        if (performance.now() < suppressClickUntilRef.current) {
          e.preventDefault();
          e.stopPropagation();
        }
      } : undefined}
    >
      {isMobile ? (
        <div
          style={overlayStyle}
          onClick={() => {
            if (dragRef.current) {
              return;
            }
            onCloseLeft?.();
            onCloseRight?.();
          }}
        />
      ) : null}

      {physicalLeftContent ? (
        <aside
          className="mindfs-font-scale-region"
          data-mindfs-font-scale-region="sidebar"
          aria-hidden={isMobile && drawerProgress("left") <= 0 ? true : undefined}
          data-drawer-touch={isMobile ? "left" : undefined}
          onPointerDown={isMobile ? drawerPointerDown("left", false) : undefined}
          onClickCapture={
            isMobile
              ? (e) => {
                  if (performance.now() < suppressClickUntilRef.current) {
                    e.preventDefault();
                    e.stopPropagation();
                  }
                }
              : undefined
          }
          style={
            isMobile
              ? { ...mobileSidebarStyle("left"), ...fontScaleStyle(physicalLeftFontScale) }
              : {
                  ...sidebarStyle,
                  ...fontScaleStyle(physicalLeftFontScale),
                  overflow: physicalLeftOpen ? "auto" : "hidden",
                  pointerEvents: physicalLeftOpen ? "auto" : "none",
                }
          }
        >
          {physicalLeftContent}
        </aside>
      ) : null}

      <main
        className="mindfs-font-scale-region"
        data-mindfs-font-scale-region="main"
        style={
          isMobile
            ? {
                ...mainStyle,
                ...fontScaleStyle(mainFontScale),
                flex: 1,
                minHeight: 0,
                minWidth: 0,
              }
            : { ...mainStyle, ...fontScaleStyle(mainFontScale) }
        }
      >
        {main}
        {/* 将抽屉层放入主视图内部，确保绝对定位时能精准对齐主视图宽度 */}
        {drawer}
      </main>

      {physicalRightContent ? (
        <aside
          className="mindfs-font-scale-region"
          data-mindfs-font-scale-region="sidebar"
          aria-hidden={isMobile && drawerProgress("right") <= 0 ? true : undefined}
          data-drawer-touch={isMobile ? "right" : undefined}
          onPointerDown={isMobile ? drawerPointerDown("right", false) : undefined}
          onClickCapture={
            isMobile
              ? (e) => {
                  if (performance.now() < suppressClickUntilRef.current) {
                    e.preventDefault();
                    e.stopPropagation();
                  }
                }
              : undefined
          }
          style={
            isMobile
              ? { ...mobileSidebarStyle("right"), ...fontScaleStyle(physicalRightFontScale) }
              : {
                  ...rightStyle,
                  ...fontScaleStyle(physicalRightFontScale),
                  overflow: physicalRightOpen ? "auto" : "hidden",
                  pointerEvents: physicalRightOpen ? "auto" : "none",
                }
          }
        >
          {physicalRightContent}
        </aside>
      ) : null}

      {!isMobile ? (
        <>
          <button
            type="button"
            className={`mindfs-sidebar-resize-rail mindfs-sidebar-resize-rail--left${physicalLeftOpen ? " is-open" : " is-closed"}`}
            onClick={physicalLeftOpen ? physicalLeftClose : physicalLeftOpenHandler}
            aria-label={physicalLeftOpen ? t("sidebar.collapse", { label: physicalLeftLabel }) : t("sidebar.expand", { label: physicalLeftLabel })}
            title={physicalLeftOpen ? t("sidebar.collapse", { label: physicalLeftLabel }) : t("sidebar.expand", { label: physicalLeftLabel })}
            style={{
              left: physicalLeftOpen ? `calc(${physicalLeftWidth} - 6px)` : 0,
              cursor: physicalLeftOpen ? "w-resize" : "e-resize",
            }}
          />
          {physicalRightContent ? (
            <button
              type="button"
              className={`mindfs-sidebar-resize-rail mindfs-sidebar-resize-rail--right${physicalRightOpen ? " is-open" : " is-closed"}`}
              onClick={physicalRightOpen ? physicalRightClose : physicalRightOpenHandler}
              aria-label={physicalRightOpen ? t("sidebar.collapse", { label: physicalRightLabel }) : t("sidebar.expand", { label: physicalRightLabel })}
              title={physicalRightOpen ? t("sidebar.collapse", { label: physicalRightLabel }) : t("sidebar.expand", { label: physicalRightLabel })}
              style={{
                right: physicalRightOpen ? `calc(${physicalRightWidth} - 6px)` : 0,
                cursor: physicalRightOpen ? "e-resize" : "w-resize",
              }}
            />
          ) : null}
        </>
      ) : null}

      <footer
        className="mindfs-font-scale-region"
        data-mindfs-font-scale-region="main"
        style={
          isMobile
            ? { ...mobileFooterStyle, ...fontScaleStyle(mainFontScale) }
            : { ...footerStyle, ...fontScaleStyle(mainFontScale) }
        }
      >
        {footer}
      </footer>
    </div>
  );
}

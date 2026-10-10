import React, { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import {
  classifySwipeIntent,
  clamp01,
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
const EDGE_HOT_ZONE_PX = 16;

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
  const dragRef = useRef<DrawerDrag | null>(null);
  const suppressClickUntilRef = useRef(0);
  const [dragPreview, setDragPreview] = useState<{ side: SidebarSide; progress: number } | null>(null);

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
      transition: dragging ? "none" : "transform 0.28s cubic-bezier(0.32, 0.72, 0, 1)",
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
      touchAction: "pan-y",
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
    setDragPreview(null);
    suppressClickUntilRef.current = performance.now() + 250;
    if (decision === "open") {
      (side === "left" ? physicalLeftOpenHandler : physicalRightOpenHandler)?.();
    } else if (decision === "close") {
      (side === "left" ? physicalLeftClose : physicalRightClose)?.();
    }
  };

  const drawerPointerDown = (side: SidebarSide, fromEdge: boolean) => (e: React.PointerEvent<HTMLElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) {
      return;
    }
    const open = side === "left" ? physicalLeftOpen : physicalRightOpen;
    // Edge zones only open a closed drawer; the drawer body only closes an open one.
    if (fromEdge ? open : !open) {
      return;
    }
    if (dragRef.current) {
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
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // capture unsupported; move/up still fire on the element for touch
    }
  };

  const drawerPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) {
      return;
    }
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.active) {
      const intent = classifySwipeIntent(dx, dy);
      if (intent === "vertical") {
        dragRef.current = null;
        return;
      }
      if (intent !== "horizontal") {
        return;
      }
      drag.active = true;
    }
    const now = performance.now();
    const dt = now - drag.lastT;
    if (dt > 0) {
      const instant = (e.clientX - drag.lastX) / dt;
      drag.velocity = drag.velocity * 0.7 + instant * 0.3;
      drag.lastT = now;
      drag.lastX = e.clientX;
    }
    const progress = swipeProgress(drag.side, drag.mode, dx, mobileSidebarPixelWidth());
    setDragPreview({ side: drag.side, progress });
  };

  const drawerPointerUp = (e: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) {
      return;
    }
    dragRef.current = null;
    if (!drag.active) {
      return;
    }
    const progress = dragPreview && dragPreview.side === drag.side
      ? dragPreview.progress
      : (drag.mode === "open" ? 0 : 1);
    const openDirection = drag.side === "left" ? 1 : -1;
    const velocity = drag.velocity * openDirection;
    endDrag(swipeRelease(progress, velocity, mobileSidebarPixelWidth()), drag.side);
  };

  const drawerPointerCancel = (e: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) {
      return;
    }
    dragRef.current = null;
    if (drag.active) {
      // snap back to the state-derived position without toggling
      suppressClickUntilRef.current = performance.now() + 250;
      setDragPreview(null);
    }
  };

  const edgeHotZoneStyle = (side: SidebarSide): React.CSSProperties => ({
    position: "fixed",
    top: 0,
    bottom: 0,
    [side]: 0,
    width: EDGE_HOT_ZONE_PX,
    zIndex: 1900,
    touchAction: "none",
    background: "transparent",
    border: "none",
    padding: 0,
  });

  const mobileFooterStyle: React.CSSProperties = {
    ...footerStyle,
    flexShrink: 0,
  };

  const drawerHandlers = {
    onPointerMove: drawerPointerMove,
    onPointerUp: drawerPointerUp,
    onPointerCancel: drawerPointerCancel,
    onLostPointerCapture: drawerPointerCancel,
  };

  return (
    <div style={shellStyle} data-onboarding="shell">
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

      {isMobile && physicalLeftContent ? (
        <aside
          className="mindfs-font-scale-region"
          data-mindfs-font-scale-region="sidebar"
          aria-hidden={drawerProgress("left") <= 0 ? true : undefined}
          onPointerDown={drawerPointerDown("left", false)}
          onClickCapture={(e) => {
            if (performance.now() < suppressClickUntilRef.current) {
              e.preventDefault();
              e.stopPropagation();
            }
          }}
          style={{ ...mobileSidebarStyle("left"), ...fontScaleStyle(physicalLeftFontScale) }}
          {...drawerHandlers}
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

      {isMobile && physicalRightContent ? (
        <aside
          className="mindfs-font-scale-region"
          data-mindfs-font-scale-region="sidebar"
          aria-hidden={drawerProgress("right") <= 0 ? true : undefined}
          onPointerDown={drawerPointerDown("right", false)}
          onClickCapture={(e) => {
            if (performance.now() < suppressClickUntilRef.current) {
              e.preventDefault();
              e.stopPropagation();
            }
          }}
          style={{ ...mobileSidebarStyle("right"), ...fontScaleStyle(physicalRightFontScale) }}
          {...drawerHandlers}
        >
          {physicalRightContent}
        </aside>
      ) : null}

      {isMobile ? (
        <>
          <div
            aria-hidden
            style={edgeHotZoneStyle("left")}
            onPointerDown={drawerPointerDown("left", true)}
            {...drawerHandlers}
          />
          <div
            aria-hidden
            style={edgeHotZoneStyle("right")}
            onPointerDown={drawerPointerDown("right", true)}
            {...drawerHandlers}
          />
        </>
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

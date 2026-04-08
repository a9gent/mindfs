import React, { useState, useEffect } from "react";

type AppShellProps = {
  sidebar: React.ReactNode;
  main: React.ReactNode;
  rightSidebar?: React.ReactNode;
  footer: React.ReactNode;
  drawer?: React.ReactNode;
};

const MOBILE_BREAKPOINT = 768;
const TABLET_BREAKPOINT = 1024;

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
  background: "var(--sidebar-bg)",
  display: "flex",
  flexDirection: "column",
  position: "relative",
  zIndex: 10,
};

const mainStyle: React.CSSProperties = {
  gridArea: "main",
  overflow: "hidden",
  padding: "0",
  background: "var(--content-bg)",
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
  background: "var(--sidebar-bg)",
  display: "flex",
  flexDirection: "column",
  position: "relative",
  zIndex: 10,
};

const footerStyle: React.CSSProperties = {
  gridArea: "footer",
  borderTop: "none",
  padding: "0",
  display: "flex",
  alignItems: "flex-end",
  justifyContent: "center",
  background: "var(--content-bg)",
  zIndex: 100,
  minWidth: 0,
};

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
}: AppShellProps & { 
  leftOpen?: boolean; 
  rightOpen?: boolean;
  onCloseLeft?: () => void;
  onCloseRight?: () => void;
}) {
  const { isMobile, isTablet } = useResponsive();
  const [viewportRect, setViewportRect] = useState(() => getVisibleViewportRect());

  useEffect(() => {
    const updateViewportRect = () => {
      setViewportRect(getVisibleViewportRect());
    };
    updateViewportRect();
    window.addEventListener("resize", updateViewportRect);
    window.addEventListener("orientationchange", updateViewportRect);
    window.visualViewport?.addEventListener("resize", updateViewportRect);
    window.visualViewport?.addEventListener("scroll", updateViewportRect);
    return () => {
      window.removeEventListener("resize", updateViewportRect);
      window.removeEventListener("orientationchange", updateViewportRect);
      window.visualViewport?.removeEventListener("resize", updateViewportRect);
      window.visualViewport?.removeEventListener("scroll", updateViewportRect);
    };
  }, []);
  
  const sidebarWidth = isMobile ? "0px" : (isTablet ? "200px" : "260px");
  const rightWidth = isMobile ? "0px" : (rightSidebar ? (isTablet ? "240px" : "280px") : "0px");

  const shellStyle: React.CSSProperties = {
    display: isMobile ? "flex" : "grid",
    flexDirection: isMobile ? "column" : undefined,
    gridTemplateColumns: isMobile ? undefined : `${leftOpen ? sidebarWidth : "0px"} 1fr ${rightOpen ? rightWidth : "0px"}`,
    gridTemplateRows: isMobile ? undefined : "1fr auto",
    gridTemplateAreas: isMobile ? undefined : `"sidebar main right" "sidebar footer right"`,
    minHeight: isMobile ? `${viewportRect.height}px` : "100vh",
    height: isMobile ? `${viewportRect.height}px` : "100dvh",
    background: "var(--bg-gradient-start, #f3f4f6)",
    color: "var(--text-primary)",
    position: isMobile ? "fixed" : "relative",
    top: isMobile ? `${viewportRect.offsetTop}px` : undefined,
    left: isMobile ? 0 : undefined,
    right: isMobile ? 0 : undefined,
    width: isMobile ? "100vw" : undefined,
    overflow: "hidden",
    isolation: "isolate",
    boxSizing: "border-box",
    transition: "grid-template-columns 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
  };

  const mobileSidebarStyle = (side: 'left' | 'right'): React.CSSProperties => ({
    position: "fixed",
    top: 0,
    bottom: 0,
    [side]: 0,
    width: "75vw",
    zIndex: 2000,
    background: "var(--mobile-sidebar-bg, var(--sidebar-bg))",
    boxShadow: side === 'left' ? "4px 0 24px rgba(0,0,0,0.15)" : "-4px 0 24px rgba(0,0,0,0.15)",
    transition: "transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1)",
    display: "flex",
    flexDirection: "column",
    willChange: "transform",
    backfaceVisibility: "hidden",
    transform: `${side === 'left' ? (leftOpen ? "translateX(0)" : "translateX(-100%)") : (rightOpen ? "translateX(0)" : "translateX(100%)")} translateZ(0)`,
  });

  const overlayStyle: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.3)",
    zIndex: 1500,
    opacity: (isMobile && (leftOpen || rightOpen)) ? 1 : 0,
    pointerEvents: (isMobile && (leftOpen || rightOpen)) ? "auto" : "none",
    transition: "opacity 0.18s ease",
    willChange: "opacity",
    backfaceVisibility: "hidden",
    transform: "translateZ(0)",
  };

  return (
    <div style={shellStyle}>
      {isMobile && <div style={overlayStyle} onClick={() => { onCloseLeft?.(); onCloseRight?.(); }} />}

      <aside style={isMobile ? mobileSidebarStyle('left') : sidebarStyle}>
        {sidebar}
      </aside>

      <main
        style={
          isMobile
            ? {
                ...mainStyle,
                flex: 1,
                minHeight: 0,
                minWidth: 0,
              }
            : mainStyle
        }
      >
        {main}
        {/* 将抽屉层放入主视图内部，确保绝对定位时能精准对齐主视图宽度 */}
        {drawer}
      </main>

      <aside style={isMobile ? mobileSidebarStyle('right') : rightStyle}>
        {rightSidebar}
      </aside>

      <footer
        style={
          isMobile
            ? {
                ...footerStyle,
                flexShrink: 0,
              }
            : footerStyle
        }
      >
        {footer}
      </footer>
    </div>
  );
}

function getVisibleViewportRect(): { height: number; offsetTop: number } {
  const visualViewport = window.visualViewport;
  if (visualViewport) {
    return {
      height: Math.max(320, Math.round(visualViewport.height)),
      offsetTop: Math.max(0, Math.round(visualViewport.offsetTop)),
    };
  }
  return { height: window.innerHeight, offsetTop: 0 };
}

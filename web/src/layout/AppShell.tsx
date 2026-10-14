import React, { useState, useEffect } from "react";
import { useI18n } from "../i18n";
import { rootBadgeButtonStyle } from "../components/rootBadgeStyle";

type AppShellProps = {
  sidebar: React.ReactNode;
  main: React.ReactNode;
  mobileHeader?: {
    projectLabel: string | null;
    title: string;
    onProjectClick?: () => void;
  };
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

const mobileHeaderButtonStyle: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  width: 44, height: 44, padding: 0, border: 0, borderRadius: 6,
  background: "transparent", color: "var(--text-secondary)", cursor: "pointer",
  WebkitTapHighlightColor: "transparent",
};

export function AppShell({
  sidebar,
  main,
  mobileHeader,
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

  const mobileSidebarStyle = (side: 'left' | 'right'): React.CSSProperties => ({
    position: "fixed",
    top: "var(--mindfs-safe-area-top, env(safe-area-inset-top, 0px))",
    bottom: 0,
    [side]: 0,
    width: "75vw",
    zIndex: 2000,
    background: "var(--mindfs-topbar-bg, var(--mobile-sidebar-bg, var(--sidebar-bg)))",
    boxShadow: side === 'left' ? "4px 0 24px rgba(0,0,0,0.15)" : "-4px 0 24px rgba(0,0,0,0.15)",
    transition: "transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1)",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    borderTopRightRadius: side === 'left' ? "14px" : undefined,
    borderBottomRightRadius: side === 'left' ? "14px" : undefined,
    borderTopLeftRadius: side === 'right' ? "14px" : undefined,
    borderBottomLeftRadius: side === 'right' ? "14px" : undefined,
    willChange: "transform",
    backfaceVisibility: "hidden",
    transform: "translateX(0) translateZ(0)",
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

  const mobileFooterStyle: React.CSSProperties = {
    ...footerStyle,
    flexShrink: 0,
  };

  const mobileSidebarButton = (file: boolean) => (
    <button type="button" data-mobile-sidebar={file ? "file" : "session"} style={mobileHeaderButtonStyle}
      aria-label={t(file ? "sidebar.openFile" : "sidebar.openSession")}
      title={t(file ? "sidebar.openFile" : "sidebar.openSession")}
      onClick={() => { (file ? onCloseRight : onCloseLeft)?.(); (file ? onOpenLeft : onOpenRight)?.(); }}>
      {file ? (
        <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path fill="currentColor" d="M3 3h6v4H3zm12 7h6v4h-6zm0 7h6v4h-6zm-2-4H7v5h6v2H5V9h2v2h6z"
            style={{ transform: "scale(1.28)", transformOrigin: "12px 12px" }} />
        </svg>
      ) : (
        <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.8" strokeLinecap="round">
          <line x1="6" y1="4" x2="18" y2="4" />
          <line x1="6" y1="12" x2="18" y2="12" />
          <line x1="6" y1="20" x2="18" y2="20" />
        </svg>
      )}
    </button>
  );
  const ellipsis: React.CSSProperties = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

  return (
    <div style={shellStyle} data-onboarding="shell">
      {isMobile && <div style={overlayStyle} onClick={() => { onCloseLeft?.(); onCloseRight?.(); }} />}

      {(!isMobile || physicalLeftOpen) && physicalLeftContent ? (
        <aside
          className="mindfs-font-scale-region"
          data-mindfs-font-scale-region="sidebar"
          style={
            isMobile
              ? { ...mobileSidebarStyle('left'), ...fontScaleStyle(physicalLeftFontScale) }
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

      {isMobile && mobileHeader ? (
        <header className="mobile-workspace-header mindfs-font-scale-region" data-mindfs-font-scale-region="main" style={{
          ...fontScaleStyle(mainFontScale), flexShrink: 0,
          display: "grid", gridTemplateColumns: "44px minmax(0, 1fr) 44px", alignItems: "center",
          gap: 4, width: "100%", height: 52, minWidth: 0, boxSizing: "border-box", padding: "3px 6px",
          borderBottom: "1px solid var(--border-color)", background: "var(--mindfs-topbar-bg, var(--content-bg))", color: "var(--text-primary)",
        }}>
          {mobileSidebarButton(!sidebarsSwapped)}
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            {mobileHeader.projectLabel ? (
              <button type="button" onClick={mobileHeader.onProjectClick} disabled={!mobileHeader.onProjectClick} title={mobileHeader.projectLabel}
                style={{ ...mobileHeaderButtonStyle, flexShrink: 1, width: "auto", minWidth: 44, maxWidth: mobileHeader.title ? "44%" : "100%", cursor: mobileHeader.onProjectClick ? "pointer" : "default" }}>
                <span style={{ ...rootBadgeButtonStyle, ...ellipsis, padding: "6px 8px" }}>{mobileHeader.projectLabel}</span>
              </button>
            ) : null}
            {mobileHeader.title ? <h1 title={mobileHeader.title} style={{ ...ellipsis, flex: 1, margin: 0, fontSize: 16, fontWeight: 600, lineHeight: 1.3 }}>{mobileHeader.title}</h1> : null}
          </div>
          {mobileSidebarButton(sidebarsSwapped)}
          <style>{`
            .mobile-workspace-header button:focus-visible { outline: 2px solid var(--accent-color); outline-offset: -2px; }
            .mobile-workspace-header button:active { background: var(--root-badge-bg); }
          `}</style>
        </header>
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

      {(!isMobile || physicalRightOpen) && physicalRightContent ? (
        <aside
          className="mindfs-font-scale-region"
          data-mindfs-font-scale-region="sidebar"
          style={
            isMobile
              ? { ...mobileSidebarStyle('right'), ...fontScaleStyle(physicalRightFontScale) }
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

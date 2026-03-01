import React, { useState, useEffect, useCallback } from "react";

type AppShellProps = {
  sidebar: React.ReactNode;
  main: React.ReactNode;
  rightSidebar?: React.ReactNode;
  footer: React.ReactNode;
  floating?: React.ReactNode;
};

// Breakpoints
const MOBILE_BREAKPOINT = 768;
const TABLET_BREAKPOINT = 1024;

// Hook for responsive detection
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
  background: "var(--content-bg)", // 统一主视图背景
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  position: "relative",
  zIndex: 1,
};

const footerStyle: React.CSSProperties = {
  gridArea: "footer",
  borderTop: "none",
  padding: "0", // 移除内边距，由内部组件控制对齐
  display: "flex",
  alignItems: "flex-end",
  justifyContent: "center",
  background: "var(--content-bg)", // 与主视图保持同色
  zIndex: 100,
};

export function AppShell({
  sidebar,
  main,
  rightSidebar,
  footer,
  floating,
}: AppShellProps) {
  const { isMobile, isTablet } = useResponsive();
  const [mobileNav, setMobileNav] = useState<"files" | "main">("main");

  // Mobile layout
  if (isMobile) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100vh",
          background: "linear-gradient(120deg, #fdfbfb 0%, #ebedee 100%)",
          position: "relative",
        }}
      >
        {/* Mobile content */}
        <div style={{ flex: 1, overflow: "auto", position: "relative", display: "flex", flexDirection: "column" }}>
          {mobileNav === "files" && sidebar}
          {mobileNav === "main" && main}
          {floating}
        </div>

        {/* Mobile footer with action bar */}
        <div style={{ borderTop: "none" }}>{footer}</div>

        {/* Mobile bottom navigation */}
        <nav
          style={{
            display: "flex",
            borderTop: "1px solid var(--border-color)",
            background: "rgba(255,255,255,0.95)",
            paddingBottom: "env(safe-area-inset-bottom)",
          }}
        >
          <MobileNavButton
            icon="📁"
            label="Files"
            active={mobileNav === "files"}
            onClick={() => setMobileNav("files")}
          />
          <MobileNavButton
            icon="🏠"
            label="View"
            active={mobileNav === "main"}
            onClick={() => setMobileNav("main")}
          />
        </nav>
      </div>
    );
  }

  // Tablet layout - narrower sidebar
  const sidebarWidth = isTablet ? "200px" : "260px";
  const rightWidth = rightSidebar ? (isTablet ? "240px" : "280px") : "0px";

  const shellStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: `${sidebarWidth} 1fr ${rightWidth}`,
    gridTemplateRows: "1fr auto",
    gridTemplateAreas: `"sidebar main right" "sidebar footer right"`,
    height: "100vh",
    background: "var(--bg-gradient-start, #f3f4f6)",
    color: "var(--text-primary)",
    position: "relative",
    overflow: "hidden",
  };

  const rightStyle: React.CSSProperties = {
    gridArea: "right",
    borderLeft: "1px solid var(--border-color)",
    overflow: "auto",
    background: "var(--sidebar-bg)",
    backdropFilter: "blur(12px)",
    display: rightSidebar ? "flex" : "none",
    flexDirection: "column",
  };

  return (
    <div style={shellStyle}>
      <aside style={sidebarStyle}>{sidebar}</aside>
      <main style={mainStyle}>{main}</main>
      <aside style={rightStyle}>{rightSidebar}</aside>
      <footer style={footerStyle}>{footer}</footer>
      {floating}
    </div>
  );
}

// Mobile navigation button component
function MobileNavButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: string;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "4px",
        padding: "8px",
        border: "none",
        background: "transparent",
        color: active ? "var(--accent-color)" : "var(--text-secondary)",
        fontSize: "10px",
        cursor: "pointer",
      }}
    >
      <span style={{ fontSize: "20px" }}>{icon}</span>
      <span>{label}</span>
    </button>
  );
}

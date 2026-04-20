import React, { useEffect, useState } from "react";

type BottomSheetProps = {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  onExpand?: () => void;
};

export function BottomSheet({
  isOpen,
  onClose,
  children,
  footer,
  onExpand,
}: BottomSheetProps) {
  const [isAnimating, setIsAnimating] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", handleResize);
    if (isOpen) setIsAnimating(true);
    return () => window.removeEventListener("resize", handleResize);
  }, [isOpen]);

  if (!isOpen && !isAnimating) return null;

  const pcStyles: React.CSSProperties = {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    width: "100%",
    height: "75vh",
    borderRadius: "16px 16px 0 0",
    opacity: isOpen ? 1 : 0,
    pointerEvents: isOpen ? "auto" : "none",
    transform: isOpen ? "translateY(0)" : "translateY(20px)",
  };

  const mobileStyles: React.CSSProperties = {
    position: "fixed",
    left: 0,
    right: 0,
    bottom: 0,
    width: "100%",
    height: "75vh",
    borderTopLeftRadius: "20px",
    borderTopRightRadius: "20px",
    transform: isOpen ? "translateY(0)" : "translateY(100%)",
  };

  return (
    <>
      {/* Overlay: 点击抽屉外任意区域关闭（包含空白、文件区、会话列表区） */}
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: isMobile ? "rgba(0,0,0,0.3)" : "transparent",
          zIndex: 1000,
          opacity: isOpen ? 1 : 0,
          transition: "opacity 0.3s ease-out",
          pointerEvents: isOpen ? "auto" : "none",
        }}
        onClick={onClose}
      />

      {/* Drawer Panel */}
      <div
        style={{
          background: isDark ? "#111827" : "#ffffff",
          boxShadow: "0 -4px 24px rgba(0,0,0,0.08)",
          borderTop: "1px solid rgba(148, 163, 184, 0.22)",
          zIndex: 1001,
          display: "flex",
          flexDirection: "column",
          transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
          overflow: "hidden",
          border: "none",
          ...(isMobile ? mobileStyles : pcStyles),
        }}
        onTransitionEnd={() => {
          if (!isOpen) setIsAnimating(false);
        }}
      >
        {/* Handle Area (Compressed) */}
        <div
          style={{
            width: "100%",
            height: "8px",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            cursor: "ns-resize",
            flexShrink: 0,
          }}
          onClick={onExpand}
        >
          <div style={{ width: "64px", height: "3px", background: isDark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.28)", borderRadius: "999px" }} />
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflow: "auto", WebkitOverflowScrolling: "touch", minHeight: 0 }}>
          {children}
        </div>

        {/* Optional Footer */}
        {footer && (
          <div style={{ borderTop: "1px solid var(--border-color)", background: "rgba(255,255,255,0.5)" }}>
            {footer}
          </div>
        )}
      </div>
    </>
  );
}

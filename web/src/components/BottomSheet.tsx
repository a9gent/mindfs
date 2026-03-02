import React, { useEffect, useState } from "react";

type BottomSheetProps = {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  onFullScreen?: () => void;
};

export function BottomSheet({
  isOpen,
  onClose,
  children,
  footer,
  onFullScreen,
}: BottomSheetProps) {
  const [isAnimating, setIsAnimating] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    if (isOpen) setIsAnimating(true);
    return () => window.removeEventListener('resize', handleResize);
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

      {/* Sheet / Floating Panel */}
      <div
        style={{
          background: window.matchMedia("(prefers-color-scheme: dark)").matches ? "#111827" : "#ffffff",
          boxShadow: "0 -4px 24px rgba(0,0,0,0.08)",
          zIndex: 1001,
          display: "flex",
          flexDirection: "column",
          transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
          overflow: "hidden",
          border: "none",
          ...(isMobile ? mobileStyles : pcStyles)
        }}
        onTransitionEnd={() => {
          if (!isOpen) setIsAnimating(false);
        }}
      >
        {/* Handle Area (Compressed) */}
        <div 
          style={{ 
            width: "100%", height: "12px", display: "flex", justifyContent: "center", alignItems: "center", cursor: "ns-resize", flexShrink: 0 
          }}
          onClick={onFullScreen}
        >
          <div style={{ width: "32px", height: "3px", background: "rgba(0,0,0,0.1)", borderRadius: "2px" }} />
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflow: "auto" }}>
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

import React, { useEffect, useState } from "react";

type BottomSheetProps = {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  onFullScreen?: () => void;
};

export function BottomSheet({
  isOpen,
  onClose,
  title,
  children,
  footer,
  onFullScreen,
}: BottomSheetProps) {
  const [isAnimating, setIsAnimating] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setIsAnimating(true);
    }
  }, [isOpen]);

  if (!isOpen && !isAnimating) return null;

  return (
    <>
      {/* Overlay */}
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.3)",
          backdropFilter: "blur(2px)",
          zIndex: 1000,
          opacity: isOpen ? 1 : 0,
          transition: "opacity 0.3s ease-out",
          pointerEvents: isOpen ? "auto" : "none",
        }}
        onClick={onClose}
      />

      {/* Sheet */}
      <div
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          height: "60vh",
          background: "var(--content-bg, #fff)",
          borderTopLeftRadius: "20px",
          borderTopRightRadius: "20px",
          boxShadow: "0 -8px 32px rgba(0,0,0,0.1)",
          zIndex: 1001,
          display: "flex",
          flexDirection: "column",
          transform: isOpen ? "translateY(0)" : "translateY(100%)",
          transition: "transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
        }}
        onTransitionEnd={() => {
          if (!isOpen) setIsAnimating(false);
        }}
      >
        {/* Handle */}
        <div 
          style={{ 
            width: "100%", height: "24px", display: "flex", justifyContent: "center", alignItems: "center", cursor: "ns-resize" 
          }}
          onClick={onFullScreen}
        >
          <div style={{ width: "40px", height: "4px", background: "rgba(0,0,0,0.1)", borderRadius: "2px" }} />
        </div>

        {/* Header */}
        <div style={{ padding: "0 16px 12px", borderBottom: "1px solid var(--border-color)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 600 }}>{title || "AI Assistant"}</h3>
          <div style={{ display: "flex", gap: "12px" }}>
            {onFullScreen && (
              <button 
                onClick={onFullScreen}
                style={{ background: "none", border: "none", fontSize: "18px", cursor: "pointer", padding: "4px", opacity: 0.6 }}
                title="全屏"
              >
                ⛶
              </button>
            )}
            <button 
              onClick={onClose}
              style={{ background: "none", border: "none", fontSize: "18px", cursor: "pointer", padding: "4px", opacity: 0.6 }}
            >
              ✕
            </button>
          </div>
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

import React from "react";

type RightSidebarProps = {
  children?: React.ReactNode;
};

export function RightSidebar({ children }: RightSidebarProps) {
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div
        style={{
          height: "36px",
          padding: "0 16px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: "1px solid var(--border-color)",
          background: "transparent",
          position: "sticky",
          top: 0,
          zIndex: 2,
          backdropFilter: "blur(8px)",
          boxSizing: "border-box",
        }}
      >
        <div
          style={{
            fontSize: "11px",
            fontWeight: 600,
            color: "var(--text-secondary)",
            textTransform: "uppercase",
          }}
        >
          会话
        </div>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: "12px 12px 16px" }}>{children}</div>
    </div>
  );
}

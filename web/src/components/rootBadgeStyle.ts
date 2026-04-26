import type { CSSProperties } from "react";

export const rootBadgeStyle: CSSProperties = {
  display: "inline-block",
  fontSize: "13px",
  lineHeight: "1.2",
  fontWeight: 600,
  color: "var(--root-badge-text)",
  background: "var(--root-badge-bg)",
  borderRadius: "6px",
  padding: "1px 4px",
  boxSizing: "border-box",
  verticalAlign: "top",
};

export const rootBadgeButtonStyle: CSSProperties = {
  ...rootBadgeStyle,
  border: "none",
};

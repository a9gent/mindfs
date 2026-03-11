import React, { memo } from "react";

export const BinaryViewer = memo(function BinaryViewer() {
  return (
    <div
      style={{
        padding: "40px",
        textAlign: "center",
        color: "var(--text-secondary)",
      }}
    >
      Binary file preview is not available.
    </div>
  );
});

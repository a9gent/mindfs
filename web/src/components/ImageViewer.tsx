import React, { memo, useMemo } from "react";

type ImageViewerProps = {
  path: string;
  root?: string;
};

function ImageViewerInner({ path, root }: ImageViewerProps) {
  const url = useMemo(
    () =>
      root
        ? `/api/file?raw=1&root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`
        : `/api/file?raw=1&path=${encodeURIComponent(path)}`,
    [path, root]
  );
  return (
    <div
      style={{
        padding: "24px",
        display: "flex",
        flex: 1,
        minHeight: 0,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <img
        src={url}
        alt={path}
        style={{
          maxWidth: "100%",
          maxHeight: "100%",
          borderRadius: "12px",
          boxShadow: "0 12px 24px rgba(31, 37, 48, 0.1)",
        }}
      />
    </div>
  );
}

export const ImageViewer = memo(ImageViewerInner, (prev, next) => (
  prev.path === next.path && prev.root === next.root
));

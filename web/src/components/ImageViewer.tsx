import React, { memo, useEffect, useState } from "react";
import { fetchProofProtectedBlob } from "../services/file";

type ImageViewerProps = {
  path: string;
  root?: string;
};

function ImageViewerInner({ path, root }: ImageViewerProps) {
  const [url, setURL] = useState("");

  useEffect(() => {
    let cancelled = false;
    let objectURL = "";
    async function run() {
      if (!root) return;
      try {
        const blob = await fetchProofProtectedBlob({ rootId: root, path });
        if (cancelled) return;
        objectURL = URL.createObjectURL(blob);
        setURL(objectURL);
      } catch {
        if (!cancelled) {
          setURL("");
        }
      }
    }
    void run();
    return () => {
      cancelled = true;
      if (objectURL) {
        URL.revokeObjectURL(objectURL);
      }
    };
  }, [path, root]);
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
      {url ? (
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
      ) : (
        <div style={{ color: "var(--text-secondary)" }}>Loading image...</div>
      )}
    </div>
  );
}

export const ImageViewer = memo(ImageViewerInner, (prev, next) => (
  prev.path === next.path && prev.root === next.root
));

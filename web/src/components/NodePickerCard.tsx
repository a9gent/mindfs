import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { backendNodes } from "../services/nodes";
import { nodeDestinationURL, returnNodePageURL } from "../services/nodePage";
import type { LauncherNode } from "../services/storage";

export type NodePickerCardProps = {
  open: boolean;
  onClose: () => void;
  /** Protected (E2EE) API readiness — when false the card waits instead of fetching. */
  apiReady?: boolean;
};

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.4)",
  zIndex: 3000,
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  padding: "12vh 16px 16px",
};

const cardStyle: React.CSSProperties = {
  width: "min(92vw, 460px)",
  maxHeight: "min(70vh, 520px)",
  background: "var(--content-bg, #fff)",
  border: "1px solid var(--border-color)",
  borderRadius: "16px",
  boxShadow: "0 18px 48px rgba(0,0,0,0.25)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const listStyle: React.CSSProperties = {
  overflowY: "auto",
  overscrollBehavior: "contain",
  WebkitOverflowScrolling: "touch",
  padding: "6px 10px 12px",
  display: "flex",
  flexDirection: "column",
  gap: "6px",
};

const rowStyle: React.CSSProperties = {
  width: "100%",
  textAlign: "left",
  border: "1px solid var(--border-color)",
  borderRadius: "12px",
  background: "var(--menu-bg, transparent)",
  padding: "12px 14px",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  gap: "10px",
  color: "var(--text-primary)",
  fontSize: "14px",
};

export function NodePickerCard({ open, onClose, apiReady = true }: NodePickerCardProps) {
  const { t } = useI18n();
  const [nodes, setNodes] = useState<LauncherNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || !apiReady) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    backendNodes
      .load()
      .then((items) => {
        if (!cancelled) setNodes(items);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof Error && err.message === "api_not_ready"
              ? t("globalSearch.apiNotReady")
              : String(err instanceof Error ? err.message : err),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, apiReady]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const openNode = (node: LauncherNode) => {
    window.location.assign(nodeDestinationURL(node.url, returnNodePageURL()));
  };

  return createPortal(
    <div
      style={overlayStyle}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onTouchStart={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-label={t("fileTree.goHome")} style={cardStyle}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 16px 10px",
          }}
        >
          <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--text-primary)" }}>
            {t("fileTree.goHome")}
          </div>
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={onClose}
            style={{
              border: "none",
              background: "transparent",
              color: "var(--text-secondary)",
              cursor: "pointer",
              fontSize: "18px",
              lineHeight: 1,
              padding: "4px",
            }}
          >
            ✕
          </button>
        </div>
        <div style={listStyle}>
          {!apiReady ? (
            <div style={{ padding: "14px", textAlign: "center", color: "var(--text-secondary)", fontSize: "13px" }}>
              {t("globalSearch.apiNotReady")}
            </div>
          ) : loading ? (
            <div style={{ padding: "14px", textAlign: "center", color: "var(--text-secondary)", fontSize: "13px" }}>
              {t("common.loading")}
            </div>
          ) : error ? (
            <div style={{ padding: "14px", textAlign: "center", color: "var(--text-secondary)", fontSize: "13px" }}>
              {error}
            </div>
          ) : nodes.length === 0 ? (
            <div style={{ padding: "14px", textAlign: "center", color: "var(--text-secondary)", fontSize: "13px" }}>
              {t("globalSearch.noMatch")}
            </div>
          ) : (
            nodes.map((node) => (
              <button
                key={node.id}
                type="button"
                style={rowStyle}
                onClick={() => openNode(node)}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: "8px",
                    height: "8px",
                    borderRadius: "50%",
                    background: "var(--accent-color, #3b82f6)",
                    flex: "0 0 auto",
                  }}
                />
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {node.name}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

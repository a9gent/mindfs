import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";

export type DeleteSessionChoice = {
  sessionName: string;
  childCount: number;
  onKeepChildren: () => void;
  onCascade: () => void;
  onCancel: () => void;
};

/**
 * Three-way delete confirmation. It is opened from the server's answer, not
 * from a client-side child count: the loaded session list may hide children
 * (filters, search results, pagination), and a wrong "no children" guess
 * destroys an entire fork branch irreversibly.
 */
export function DeleteSessionDialog({ choice }: { choice: DeleteSessionChoice | null }) {
  const { t } = useI18n();
  const keepRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!choice) return;
    keepRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        choice.onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [choice]);

  if (!choice || typeof document === "undefined") return null;

  return createPortal(
    <div
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) choice.onCancel();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        zIndex: 4000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("sessionList.deleteWithChildrenTitle")}
        style={{
          width: "min(92vw, 420px)",
          borderRadius: "12px",
          border: "1px solid var(--border-color)",
          background: "var(--menu-bg)",
          padding: "16px",
          boxShadow: "0 12px 30px rgba(15, 23, 42, 0.2)",
        }}
      >
        <div style={{ fontSize: "13px", fontWeight: 600, color: "var(--text-primary)" }}>
          {t("sessionList.deleteWithChildrenTitle")}
        </div>
        {choice.sessionName ? (
          <div
            style={{
              fontSize: "11px",
              color: "var(--text-secondary)",
              marginTop: "4px",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={choice.sessionName}
          >
            {choice.sessionName}
          </div>
        ) : null}
        <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "8px", lineHeight: 1.6 }}>
          {t("sessionList.deleteWithChildrenBody", { count: choice.childCount })}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "14px" }}>
          <button
            ref={keepRef}
            type="button"
            onClick={choice.onKeepChildren}
            style={{ border: "none", borderRadius: "8px", padding: "8px 12px", fontSize: "12px", background: "var(--accent-color)", color: "#fff", cursor: "pointer" }}
          >
            {t("sessionList.deleteKeepChildren")}
          </button>
          <button
            type="button"
            onClick={choice.onCascade}
            style={{ border: "1px solid #dc2626", borderRadius: "8px", padding: "8px 12px", fontSize: "12px", background: "transparent", color: "#dc2626", cursor: "pointer" }}
          >
            {t("sessionList.deleteWithChildren")}
          </button>
          <button
            type="button"
            onClick={choice.onCancel}
            style={{ border: "1px solid var(--border-color)", borderRadius: "8px", padding: "8px 12px", fontSize: "12px", background: "transparent", color: "var(--text-primary)", cursor: "pointer" }}
          >
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

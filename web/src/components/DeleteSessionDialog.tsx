import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { sessionService } from "../services/session";

export function DeleteSessionDialog({ rootId, sessionKey, name, onClose, onConfirm }: {
  rootId: string;
  sessionKey: string;
  name?: string;
  onClose: () => void;
  onConfirm: (keepChildren: boolean) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const submitting = useRef(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [hasChildren, setHasChildren] = useState(false);
  const [keepChildren, setKeepChildren] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const session = await sessionService.getSession(rootId, sessionKey);
        if (!session) throw new Error("Session unavailable");
        const children = session.parent_session_key ? [] : await sessionService.fetchChildSessions(rootId, sessionKey, { limit: 1, throwOnError: true });
        if (!cancelled) { setHasChildren(children.length > 0); setStatus("ready"); }
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => { cancelled = true; };
  }, [rootId, sessionKey]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        if (!submitting.current) onClose();
      }
      if (event.key === "Tab") {
        const items = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)');
        if (!items?.length) return;
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", keydown, true);
    return () => { document.removeEventListener("keydown", keydown, true); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [onClose]);
  const buttonStyle: React.CSSProperties = { border: "1px solid var(--border-color)", borderRadius: 7, padding: "8px 14px", background: "transparent", color: "var(--text-primary)", fontSize: 12, cursor: "pointer" };
  return createPortal(<div onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}
    style={{ position: "fixed", inset: 0, zIndex: 11000, background: "rgba(15,23,42,.32)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
    <div ref={panel} role="alertdialog" aria-modal="true" aria-labelledby={id} aria-describedby={`${id}-description`} aria-busy={busy}
      style={{ width: 360, maxWidth: "100%", padding: 20, border: "1px solid var(--border-color)", borderRadius: 10, background: "var(--menu-bg)", color: "var(--text-primary)", boxShadow: "0 24px 60px rgba(15,23,42,.24)" }}>
      <h2 id={id} style={{ margin: "0 0 12px", fontSize: 16 }}>{t("session.deleteTitle")}</h2>
      <p id={`${id}-description`} style={{ margin: "0 0 16px", fontSize: 13, lineHeight: 1.6, overflowWrap: "anywhere" }}>
        {status === "loading" ? t("common.loading") : status === "error" ? t("session.deleteCheckFailed") : t("session.deleteConfirm", { name: name || sessionKey })}
      </p>
      {status === "ready" && hasChildren && <fieldset disabled={busy} style={{ margin: "0 0 18px", padding: 0, border: 0, display: "grid", gap: 10, fontSize: 13 }}>
        <legend style={{ marginBottom: 10, color: "var(--text-secondary)" }}>{t("session.deleteHasChildren")}</legend>
        {[false, true].map(keep => <label key={String(keep)} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input type="radio" name={id} checked={keepChildren === keep} onChange={() => setKeepChildren(keep)} />
          {t(keep ? "session.deleteOnlyParent" : "session.deleteAll")}
        </label>)}
        {keepChildren && <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>{t("session.deleteKeepChildrenHint")}</span>}
      </fieldset>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button type="button" disabled={busy} style={buttonStyle} onClick={onClose}>{t("common.cancel")}</button>
        <button type="button" disabled={busy || status !== "ready"} style={{ ...buttonStyle, background: "#dc2626", borderColor: "#dc2626", color: "#fff", opacity: busy || status !== "ready" ? .5 : 1 }}
          onClick={async () => {
            if (submitting.current) return;
            submitting.current = true; setBusy(true);
            try { if (await onConfirm(hasChildren && keepChildren)) onClose(); }
            finally { submitting.current = false; setBusy(false); }
          }}>{t("common.delete")}</button>
      </div>
    </div>
  </div>, document.body);
}

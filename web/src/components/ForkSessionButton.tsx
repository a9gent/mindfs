import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";

export function ForkSessionButton({ onFork, style, children }: {
  onFork: (independent: boolean) => void;
  style: React.CSSProperties;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = button.current?.getBoundingClientRect();
      const rect = panel.current?.getBoundingClientRect();
      if (!anchor || !rect) return;
      setPosition({
        top: Math.max(8, anchor.top >= rect.height + 8 ? anchor.top - rect.height - 6 : Math.min(anchor.bottom + 6, window.innerHeight - rect.height - 8)),
        left: Math.max(8, Math.min(anchor.left, window.innerWidth - rect.width - 8)),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector("button")?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        button.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);
  return <>
    <button ref={button} type="button" style={style} title={t("session.forkFromMessage")} aria-label={t("session.forkFromMessage")}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}>{children}</button>
    {open && createPortal(<div ref={panel} id={id} role="dialog" aria-label={t("session.forkFromMessage")}
      onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node) && event.relatedTarget !== button.current) setOpen(false); }}
      style={{ position: "fixed", ...position, zIndex: 10000, display: "flex", gap: 2, padding: 3, border: "1px solid var(--border-color)", borderRadius: 8, background: "var(--menu-bg)", boxShadow: "0 6px 20px rgba(15,23,42,.16)" }}>
      {[false, true].map(independent => <React.Fragment key={String(independent)}>
        {independent && <span aria-hidden="true" style={{ alignSelf: "center", width: 1, height: 12, flexShrink: 0, background: "var(--border-color)" }} />}
        <button type="button"
        onClick={() => { setOpen(false); button.current?.focus({ preventScroll: true }); onFork(independent); }}
        style={{ padding: "3px 6px", border: 0, borderRadius: 5, background: "var(--bg-secondary)", color: "var(--text-primary)", fontSize: 12, lineHeight: "16px", cursor: "pointer" }}>
        {t(independent ? "session.forkIndependent" : "session.forkNested")}
      </button></React.Fragment>)}
    </div>, document.body)}
  </>;
}

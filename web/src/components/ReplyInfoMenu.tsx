import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { setReplyInfoPreference, type ReplyInfoPreferences } from "../services/replyInfoPreferences";

export function ReplyInfoMenu({ preferences }: { preferences: ReplyInfoPreferences }) {
  const { t } = useI18n();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const button = buttonRef.current?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (!button || !panel) return;
      const top = button.top >= panel.height + 8
        ? button.top - panel.height - 6
        : Math.min(button.bottom + 6, window.innerHeight - panel.height - 8);
      const left = Math.max(8, Math.min(button.right - panel.width, window.innerWidth - panel.width - 8));
      setPosition(previous => previous.top === top && previous.left === left ? previous : { top: Math.max(8, top), left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    const observer = new ResizeObserver(place);
    if (buttonRef.current?.parentElement) observer.observe(buttonRef.current.parentElement);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      observer.disconnect();
    };
  }, [open, preferences]);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector("button")?.focus({ preventScroll: true });
    const onPointerDown = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node) && !buttonRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  return <>
    <button ref={buttonRef} type="button" aria-label={t("session.replyInfo.title")}
      aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup="dialog"
      onClick={() => setOpen(value => !value)}
      style={{ border: 0, background: "transparent", color: "var(--text-secondary)", padding: 0, width: 32, height: 32, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
      </svg>
    </button>
    {open && createPortal(<div id={id} ref={panelRef} role="dialog" aria-label={t("session.replyInfo.title")}
      onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node) && event.relatedTarget !== buttonRef.current) setOpen(false); }}
      style={{ position: "fixed", ...position, zIndex: 10000, width: 220, maxWidth: "calc(100vw - 16px)", maxHeight: "calc(100dvh - 16px)", overflowY: "auto", boxSizing: "border-box", padding: 8, borderRadius: 10, border: "1px solid var(--border-color)", background: "var(--menu-bg)", color: "var(--text-primary)", boxShadow: "0 12px 30px rgba(15, 23, 42, 0.14)", fontSize: 13 }}>
      {(Object.keys(preferences) as Array<keyof ReplyInfoPreferences>).map(key => <button key={key}
        type="button" role="checkbox" aria-checked={preferences[key]}
        onClick={() => setReplyInfoPreference(key, !preferences[key])}
        style={{
          width: "100%",
          border: "none",
          background: preferences[key] ? "var(--selection-bg)" : "transparent",
          color: preferences[key] ? "var(--accent-color)" : "var(--text-primary)",
          borderRadius: "8px",
          padding: "8px 10px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          textAlign: "left",
          cursor: "pointer",
          fontSize: "12px",
        }}>
        <span>{t(`session.replyInfo.${key}`)}</span>
        <span aria-hidden="true" style={{ fontSize: "11px", opacity: preferences[key] ? 1 : 0 }}>✓</span>
      </button>)}
    </div>, document.body)}
  </>;
}

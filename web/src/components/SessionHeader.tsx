import React, { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { copyText } from "../services/clipboard";
import { reportError } from "../services/error";
import { sessionService } from "../services/session";
import { rootBadgeButtonStyle } from "./rootBadgeStyle";
import { MoreMenuButton } from "./FileOperations";

export type SessionHeaderActions = {
  onRenameSession?: (name: string) => boolean | Promise<boolean>;
  onDeleteSession?: () => void;
  onDetachSession?: () => void;
  onHandoffPack?: () => void;
  onScheduledTask?: () => void;
};

type Props = SessionHeaderActions & {
  title: string;
  sessionKey: string;
  rootId?: string | null;
  pending?: boolean;
  chat?: boolean;
  onRootClick?: (root: string) => void;
};

const itemStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 9px", borderRadius: 7, border: 0, background: "transparent", color: "var(--text-primary)", cursor: "pointer", fontSize: 13, textAlign: "left", whiteSpace: "nowrap" };

export function SessionHeader({ title, sessionKey, rootId, pending, chat = true, onRootClick, onRenameSession, onDeleteSession, onDetachSession, onHandoffPack, onScheduledTask }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [copyingPath, setCopyingPath] = useState(false);
  const [copied, setCopied] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const closingRename = useRef(false);
  const composing = useRef(false);
  const copyInFlight = useRef(false);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing && event.keyCode !== 229) { setOpen(false); menu.current?.querySelector("button")?.focus(); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  useEffect(() => { if (renaming && !saving) { input.current?.focus(); input.current?.select(); } }, [renaming, saving]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const cancelRename = () => { closingRename.current = true; setRenaming(false); };
  const submitRename = async () => {
    if (submitting.current || closingRename.current || composing.current || !onRenameSession) return;
    const name = draft.trim();
    if (!name || name === title.trim()) { cancelRename(); return; }
    submitting.current = true;
    setSaving(true);
    try {
      if (await onRenameSession(name)) cancelRename();
      else { input.current?.focus(); input.current?.select(); }
    } catch (error) {
      reportError("session.rename_failed", error instanceof Error ? error.message : t("session.renameFailed"));
    } finally { submitting.current = false; setSaving(false); }
  };
  const copy = async (value: string) => {
    setOpen(false);
    try { await copyText(value); setCopied(true); }
    catch (error) { reportError("clipboard.write_failed", error instanceof Error ? error.message : t("session.copyFailed")); }
  };
  const copyPath = async () => {
    if (!rootId || copyInFlight.current) return;
    copyInFlight.current = true;
    setCopyingPath(true);
    try { const { path } = await sessionService.getSessionLogPath(rootId, sessionKey); await copy(path); }
    catch (error) { reportError("clipboard.write_failed", error instanceof Error ? error.message : t("session.copyFailed")); }
    finally { copyInFlight.current = false; setCopyingPath(false); }
  };
  const run = (action: () => void) => { setOpen(false); action(); };
  const icon = (paths: React.ReactNode) => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>{paths}</svg>;

  return <header style={{ height: 36, padding: "0 3px 0 16px", borderBottom: "1px solid var(--border-color)", display: "flex", alignItems: "center", gap: 8, background: "var(--mindfs-topbar-bg, transparent)", boxSizing: "border-box", zIndex: 10, flexShrink: 0 }}>
    <h1 style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 600, margin: 0, minWidth: 0, flex: "1 1 auto" }}>
      {rootId ? <button type="button" onClick={() => onRootClick?.(rootId)} style={{ ...rootBadgeButtonStyle, flexShrink: 0, cursor: onRootClick ? "pointer" : "default" }}>{rootId}</button> : null}
      {renaming ? <input ref={input} aria-label={t("sessionList.rename")} value={draft} disabled={saving} onChange={(event) => setDraft(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={(event) => {
          if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === "Enter") { event.preventDefault(); void submitRename(); }
          if (event.key === "Escape") { event.preventDefault(); cancelRename(); }
        }} onBlur={() => { void submitRename(); }}
        style={{ minWidth: 0, width: "100%", font: "inherit", padding: "2px 6px", border: "1px solid var(--accent-color, #3b82f6)", borderRadius: 4, background: "var(--content-bg)", color: "var(--text-primary)" }} />
        : <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>}
    </h1>
    <div ref={menu} style={{ position: "relative", flexShrink: 0, display: "flex", alignItems: "center" }}>
      <MoreMenuButton open={open} label={t("sessionList.menu")} onClick={() => setOpen(!open)} />
      {copied ? <span role="status" style={{ position: "absolute", right: 0, top: "100%", whiteSpace: "nowrap", padding: "4px 8px", borderRadius: 6, background: "var(--menu-bg)", color: "var(--text-primary)", fontSize: 12 }}>{t("session.copied")}</span> : null}
      {open ? <div style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, minWidth: 170, padding: 6, borderRadius: 10, border: "1px solid var(--border-color)", background: "var(--menu-bg)", boxShadow: "0 12px 30px rgba(15, 23, 42, 0.14)", zIndex: 20 }}>
        {onRenameSession ? <button type="button" style={itemStyle} onClick={() => { setOpen(false); closingRename.current = false; composing.current = false; setDraft(title); setRenaming(true); }}>{icon(<><path d="M12 20h9" /><path d="m16.5 3.5 3 3L7 19l-4 1 1-4z" /></>)}{t("sessionList.rename")}</button> : null}
        <button type="button" style={itemStyle} onClick={() => void copy(sessionKey)}>{icon(<><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>)}{t("sessionList.copyId")}</button>
        <button type="button" disabled={copyingPath || !rootId || pending} style={{ ...itemStyle, opacity: copyingPath || !rootId || pending ? 0.55 : 1 }} onClick={() => void copyPath()}>{icon(<><path d="M14 2H6v20h14V8zM14 2v6h6M8 13h8M8 17h8" /></>)}{t("sessionList.copyPath")}</button>
        {onHandoffPack ? <button type="button" disabled={!rootId || pending} style={{ ...itemStyle, opacity: !rootId || pending ? 0.55 : 1 }} onClick={() => run(onHandoffPack)}>{icon(<><path d="M15 3h6v18h-6M10 17l5-5-5-5M15 12H3" /></>)}{t("sessionList.handoffPack")}</button> : null}
        {onScheduledTask && chat && !pending ? <button type="button" style={itemStyle} onClick={() => run(onScheduledTask)}>{icon(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>)}{t("scheduled.title")}</button> : null}
        {onDetachSession ? <button type="button" style={itemStyle} onClick={() => run(onDetachSession)}>{icon(<path d="M14 3h7v7M21 3l-9 9M10 3H3v18h18v-7" />)}{t("session.detach")}</button> : null}
        {onDeleteSession ? <button type="button" style={{ ...itemStyle, color: "#dc2626" }} onClick={() => run(onDeleteSession)}>{icon(<><path d="M3 6h18M19 6l-1 14H6L5 6M9 6V4h6v2M10 11v6M14 11v6" /></>)}{t("common.delete")}</button> : null}
      </div> : null}
    </div>
  </header>;
}

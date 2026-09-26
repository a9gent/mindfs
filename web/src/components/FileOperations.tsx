import React, { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { protectedJSON, ProtectedAPIError } from "../services/api";
import { appURL } from "../services/base";
import { reportError } from "../services/error";
import { renderToolIcon } from "./stream/ToolCallCard";
import { LocalPanel, type LocalDirBrowserState } from "./ProjectAddPopover";

export function FileMenuIcon({ action }: { action: "download" | "edit" | "delete" | "rename" | "move" }) {
  let icon: React.ReactNode;
  if (action === "edit") {
    icon = renderToolIcon("edit");
  } else if (action === "delete") {
    icon = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4h6v2" />
    </svg>;
  } else if (action === "download") {
    icon = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path fill="currentColor" d="M16.59 9H15V4c0-.55-.45-1-1-1h-4c-.55 0-1 .45-1 1v5H7.41c-.89 0-1.34 1.08-.71 1.71l4.59 4.59c.39.39 1.02.39 1.41 0l4.59-4.59c.63-.63.19-1.71-.7-1.71M5 19c0 .55.45 1 1 1h12c.55 0 1-.45 1-1s-.45-1-1-1H6c-.55 0-1 .45-1 1" />
    </svg>;
  } else {
    icon = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {action === "rename" ? <><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" /></> : <><path d="M20 10V7a2 2 0 0 0-2-2h-6l-2-2H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7" /><path d="M14 16h8m-3-3 3 3-3 3" /></>}
    </svg>;
  }
  return <span aria-hidden="true" style={{ width: 18, height: 18, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{icon}</span>;
}

export const fileMenuItemStyle: React.CSSProperties = {
  width: "100%", border: "none", background: "transparent", color: "var(--text-primary)",
  borderRadius: 8, padding: "8px 10px", textAlign: "left", cursor: "pointer", fontSize: 12,
  display: "flex", alignItems: "center", gap: 8,
};

export function FileOperationItems({ root, path, onComplete, onMove }: {
  root: string; path: string; onComplete: () => void | Promise<void>; onMove: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const submit = async (action: "delete" | "rename") => {
    if (busyRef.current) return;
    let name: string | undefined;
    if (action === "rename") {
      const currentName = path.replace(/\\/g, "/").split("/").pop() || "";
      const input = window.prompt(t("fileOperation.namePrompt"), currentName);
      if (input === null) return;
      name = input.trim();
      if (!name || name === "." || name === ".." || /[/\\\x00]/.test(name)) {
        window.alert(t("directory.invalidFileName"));
        return;
      }
      if (name === currentName) return;
    } else if (!window.confirm(t("fileOperation.confirmDelete", { name: path }))) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      await protectedJSON(appURL("/api/file/operation"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root, path, action, name }),
      });
      await onComplete();
    } catch (err) {
      reportError("file.write_failed", err instanceof ProtectedAPIError && err.status === 409
        ? t("directory.fileExists")
        : err instanceof Error ? err.message : t("common.actionFailed", { action: t(`fileOperation.${action}`) }));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return <>
    {(["delete", "rename", "move"] as const).map(value => <button key={value} type="button" role="menuitem" disabled={busy} style={{ ...fileMenuItemStyle, color: value === "delete" ? "#dc2626" : undefined }} onClick={() => {
      if (value === "move") onMove();
      else void submit(value);
    }}><FileMenuIcon action={value} /><span>{t(`fileOperation.${value}`)}</span></button>)}
  </>;
}

export const menuOverlayStyle: React.CSSProperties = {
  position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 30,
};

export const moreMenuPopoverStyle: React.CSSProperties = {
  position: "absolute",
  top: "calc(100% + 6px)",
  right: 0,
  minWidth: "176px",
  padding: "6px",
  borderRadius: "10px",
  border: "1px solid var(--border-color)",
  background: "var(--menu-bg)",
  boxShadow: "0 12px 30px rgba(15, 23, 42, 0.14)",
  zIndex: 20,
};

export function MoreMenuButton({ open, label, onClick, onboarding }: {
  open: boolean;
  label: string;
  onClick: () => void;
  onboarding?: string;
}) {
  return <button
    type="button"
    data-onboarding={onboarding}
    onClick={onClick}
    aria-label={label}
    aria-haspopup="menu"
    aria-expanded={open}
    style={{
      width: "28px", height: "28px", borderRadius: "8px", border: "none",
      background: open ? "rgba(0, 0, 0, 0.06)" : "transparent",
      color: "var(--text-secondary)", display: "inline-flex", alignItems: "center",
      justifyContent: "center", cursor: "pointer", outline: "none",
    }}
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="5" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="12" cy="19" r="1.8" />
    </svg>
  </button>;
}

export function MoveFilePopover({ root, rootPath, path, onComplete }: {
  root: string; rootPath?: string; path: string; onComplete: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const request = useRef(0);
  const busy = useRef(false);
  const [dirs, setDirs] = useState<LocalDirBrowserState>({ path: "", items: [], loading: true, selectedPath: "", adding: false, error: "" });
  const browse = useCallback(async (target: string) => {
    if (busy.current) return;
    const id = ++request.current;
    setDirs(prev => ({ ...prev, loading: true, error: "" }));
    try {
      const result = await protectedJSON<Pick<LocalDirBrowserState, "path" | "parent" | "items" | "volumes">>(appURL("/api/local_dirs", new URLSearchParams({ path: target })));
      if (id === request.current) setDirs({ ...result, loading: false, selectedPath: "", adding: false, error: "" });
    } catch (err) {
      if (id === request.current) setDirs(prev => ({ ...prev, loading: false, error: err instanceof Error ? err.message : String(err) }));
    }
  }, []);
  useEffect(() => {
    const parent = path.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
    const initialPath = /^(?:\/|[A-Za-z]:)/.test(path)
      ? parent || "/"
      : `${(rootPath || "").replace(/[\\/]+$/, "")}/${parent}`;
    void browse(initialPath);
    return () => { request.current += 1; };
  }, [browse, path, rootPath]);
  const submit = async () => {
    if (busy.current || dirs.loading || dirs.error) return;
    busy.current = true;
    setDirs(prev => ({ ...prev, adding: true, error: "" }));
    try {
      await protectedJSON(appURL("/api/file/operation"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root, path, action: "move", destination: dirs.path }),
      });
      await onComplete();
    } catch (err) {
      setDirs(prev => ({ ...prev, error: err instanceof Error ? err.message : String(err) }));
    } finally {
      busy.current = false;
      setDirs(prev => ({ ...prev, adding: false }));
    }
  };
  return <LocalPanel localState={dirs} onLocalNavigate={target => void browse(target)} onLocalSelect={() => {}} onLocalAdd={() => void submit()} localActionLabel={t("fileOperation.moveHere")} localDisabledAddedRoot={false} localBrowseOnly />;
}

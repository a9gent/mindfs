import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { sessionService, type SessionSearchHit } from "../services/session";

export type GlobalSearchDialogProps = {
  open: boolean;
  onClose: () => void;
  onOpenHit: (rootId: string, sessionKey: string) => void;
  /** Protected (E2EE) API readiness — when false the dialog waits instead of erroring. */
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
  paddingTop: "12vh",
  padding: "12vh 16px 16px",
};

const dialogStyle: React.CSSProperties = {
  width: "min(92vw, 620px)",
  maxHeight: "min(76vh, 560px)",
  background: "var(--content-bg, #fff)",
  border: "1px solid var(--border-color)",
  borderRadius: "14px",
  boxShadow: "0 18px 48px rgba(0,0,0,0.25)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const inputStyle: React.CSSProperties = {
  border: "none",
  outline: "none",
  background: "transparent",
  color: "var(--text-primary)",
  fontSize: "15px",
  flex: 1,
  minWidth: 0,
  padding: "14px 4px",
};

const matchTypeLabelKeys = {
  name: "globalSearch.matchName",
  user: "globalSearch.matchUser",
  reply: "globalSearch.matchReply",
} as const;

function highlightSnippet(text: string, query: string): React.ReactNode {
  const trimmed = query.trim();
  if (!trimmed) {
    return text;
  }
  const lower = text.toLowerCase();
  const needle = trimmed.toLowerCase();
  const index = lower.indexOf(needle);
  if (index < 0) {
    return text;
  }
  return (
    <>
      {text.slice(0, index)}
      <mark style={{ background: "rgba(37,99,235,0.18)", color: "inherit", borderRadius: "2px", padding: "0 1px" }}>
        {text.slice(index, index + needle.length)}
      </mark>
      {text.slice(index + needle.length)}
    </>
  );
}

function formatRelativeTime(iso: string, locale: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) {
    return "";
  }
  const diff = Date.now() - time;
  const minutes = Math.floor(diff / 60000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (minutes < 1) return rtf.format(0, "minute");
  if (minutes < 60) return rtf.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  const days = Math.floor(hours / 24);
  if (days < 30) return rtf.format(-days, "day");
  return new Date(time).toLocaleDateString(locale);
}

export function GlobalSearchDialog({ open, onClose, onOpenHit, apiReady = true }: GlobalSearchDialogProps) {
  const { locale, t } = useI18n();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SessionSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [apiNotReady, setApiNotReady] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [globalScope, setGlobalScope] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setFailed(false);
      setApiNotReady(false);
      setActiveIndex(0);
      window.setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setFailed(false);
      setApiNotReady(false);
      setLoading(false);
      return;
    }
    if (!apiReady) {
      // E2EE 通道未就绪：保持等待态，ready 后 effect 因 apiReady 变化自动重跑
      setResults([]);
      setFailed(false);
      setApiNotReady(true);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      void sessionService
        .searchSessions("", trimmed, 50, { multiRoot: globalScope, rethrow: true })
        .then((hits) => {
          if (cancelled) return;
          setResults(hits);
          setFailed(false);
          setApiNotReady(false);
          setActiveIndex(0);
        })
        .catch((err) => {
          if (cancelled) return;
          console.error("[globalSearch] failed", err);
          setResults([]);
          if (err instanceof Error && err.message === "api_not_ready") {
            setApiNotReady(true);
            setFailed(false);
          } else {
            setApiNotReady(false);
            setFailed(true);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setLoading(false);
          }
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [apiReady, globalScope, open, query]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((prev) => Math.min(prev + 1, results.length - 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((prev) => Math.max(prev - 1, 0));
      } else if (event.key === "Enter") {
        event.preventDefault();
        const hit = results[Math.max(0, Math.min(activeIndex, results.length - 1))];
        if (hit) {
          onOpenHit(String(hit.root_id || ""), hit.key);
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [activeIndex, onClose, onOpenHit, open, results]);

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const scopeToggle = useCallback(() => setGlobalScope((prev) => !prev), []);

  const emptyState = useMemo(() => {
    if (loading) {
      return t("globalSearch.searching");
    }
    if (apiNotReady) {
      return t("globalSearch.apiNotReady");
    }
    if (failed) {
      return t("globalSearch.failed");
    }
    if (!query.trim()) {
      return t("globalSearch.hint");
    }
    return t("globalSearch.noMatch");
  }, [apiNotReady, failed, loading, query]);

  if (!open) {
    return null;
  }

  return createPortal(
    <div
      style={overlayStyle}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div role="dialog" aria-label={t("globalSearch.title")} style={dialogStyle} onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "0 14px", borderBottom: "1px solid var(--border-color)" }}>
          <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true" style={{ color: "var(--text-secondary)", flexShrink: 0 }}>
            <path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5A6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5S14 7.01 14 9.5S11.99 14 9.5 14" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("globalSearch.placeholder")}
            style={inputStyle}
          />
          <button
            type="button"
            onClick={scopeToggle}
            title={t("globalSearch.scopeToggle")}
            style={{
              border: "1px solid var(--border-color)",
              borderRadius: "999px",
              padding: "3px 10px",
              background: globalScope ? "var(--accent-color)" : "transparent",
              color: globalScope ? "#fff" : "var(--text-secondary)",
              fontSize: "11px",
              cursor: "pointer",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            {globalScope ? t("globalSearch.scopeGlobal") : t("globalSearch.scopeCurrent")}
          </button>
        </div>
        <div ref={listRef} style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "6px" }}>
          {results.length === 0 ? (
            <div style={{ padding: "26px 16px", textAlign: "center", fontSize: "12px", color: "var(--text-secondary)" }}>
              {emptyState}
            </div>
          ) : (
            results.map((hit, index) => {
              const active = index === activeIndex;
              return (
                <div
                  key={`${hit.root_id || ""}:${hit.key}:${hit.seq}`}
                  data-index={index}
                  role="option"
                  aria-selected={active}
                  tabIndex={-1}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => {
                    onOpenHit(String(hit.root_id || ""), hit.key);
                    onClose();
                  }}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "3px",
                    padding: "8px 10px",
                    borderRadius: "8px",
                    cursor: "pointer",
                    background: active ? "var(--hover-bg, rgba(0,0,0,0.05))" : "transparent",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "6px", minWidth: 0 }}>
                    <span
                      style={{
                        flexShrink: 0,
                        fontSize: "10px",
                        padding: "1px 6px",
                        borderRadius: "999px",
                        background: "rgba(37,99,235,0.12)",
                        color: "var(--accent-color, #2563eb)",
                      }}
                    >
                      {t(matchTypeLabelKeys[hit.match_type] || "globalSearch.matchName")}
                    </span>
                    <span style={{ fontSize: "13px", fontWeight: 500, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {highlightSnippet(hit.name || t("globalSearch.untitled"), query)}
                    </span>
                    <span style={{ marginLeft: "auto", flexShrink: 0, fontSize: "11px", color: "var(--text-secondary)" }}>
                      {formatRelativeTime(hit.updated_at || hit.created_at || "", locale)}
                    </span>
                  </div>
                  {hit.snippet ? (
                    <div style={{ fontSize: "11.5px", color: "var(--text-secondary)", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                      {highlightSnippet(hit.snippet, query)}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

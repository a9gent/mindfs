import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import {
  consumeCodexRateLimitReset,
  fetchCodexRateLimits,
  type CodexRateLimitStatus,
} from "../services/codexRateLimits";

const FOCUS_REFRESH_MAX_AGE_MS = 30 * 60 * 1000;

type Props = {
  agent: string;
  refreshToken?: number;
  onStatusChange?: (status: CodexRateLimitStatus | null) => void;
};

function remainingPercent(status: CodexRateLimitStatus | null): number | null {
  const used = status?.weekly?.used_percent;
  if (typeof used !== "number" || !Number.isFinite(used)) return null;
  return Math.max(0, Math.min(100, Math.round(100 - used)));
}

function formatResetTime(unixSeconds: number | undefined): string {
  if (!unixSeconds) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(unixSeconds * 1000));
}

function formatResetCountdown(unixSeconds: number | undefined, nowMs: number): string {
  if (!unixSeconds) return "";
  const remainingMinutes = Math.max(0, Math.ceil((unixSeconds * 1000 - nowMs) / 60_000));
  const days = Math.floor(remainingMinutes / (24 * 60));
  const hours = Math.floor((remainingMinutes % (24 * 60)) / 60);
  const minutes = remainingMinutes % 60;
  if (days > 0) return `${days}d·${hours}h`;
  if (hours > 0) return `${hours}h·${minutes}m`;
  return `${minutes}m`;
}

export function CodexRateLimitIndicator({ agent, refreshToken = 0, onStatusChange }: Props) {
  const { t } = useI18n();
  const [status, setStatus] = useState<CodexRateLimitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetOutcome, setResetOutcome] = useState("");
  const [error, setError] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const requestRef = useRef(0);
  const activeRequestsRef = useRef(0);
  const lastSuccessfulFetchAtRef = useRef(0);
  const idempotencyKeyRef = useRef("");

  const refresh = async () => {
    if (agent !== "codex") return;
    const request = ++requestRef.current;
    activeRequestsRef.current += 1;
    setLoading(true);
    setError("");
    try {
      const next = await fetchCodexRateLimits(agent);
      if (request !== requestRef.current) return;
      lastSuccessfulFetchAtRef.current = Date.now();
      setStatus(next);
      onStatusChange?.(next);
    } catch (err) {
      if (request !== requestRef.current) return;
      setError(String((err as Error)?.message || t("codexLimit.loadFailed")));
      setStatus(null);
      onStatusChange?.(null);
    } finally {
      activeRequestsRef.current = Math.max(0, activeRequestsRef.current - 1);
      if (request === requestRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (agent !== "codex") {
      requestRef.current += 1;
      lastSuccessfulFetchAtRef.current = 0;
      setStatus(null);
      setError("");
      setConfirmOpen(false);
      onStatusChange?.(null);
      return;
    }
    void refresh();
    // Keep the message_done-triggered refresh in addition to focus-based staleness checks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, refreshToken]);

  useEffect(() => {
    if (agent !== "codex") return;
    const onFocus = () => {
      const age = Date.now() - lastSuccessfulFetchAtRef.current;
      if (age < FOCUS_REFRESH_MAX_AGE_MS || activeRequestsRef.current > 0) return;
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
    // The listener is rebound when the selected agent changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent]);

  useEffect(() => {
    if (!confirmOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !resetting) setConfirmOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmOpen, resetting]);

  useEffect(() => {
    if (!status?.weekly?.resets_at) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [status?.weekly?.resets_at]);

  const remaining = remainingPercent(status);
  const resetCount = Math.max(0, status?.reset_credits?.available_count ?? 0);
  const resetTime = formatResetTime(status?.weekly?.resets_at);
  const resetCountdown = formatResetCountdown(status?.weekly?.resets_at, nowMs);
  const canReset = resetCount > 0 && !loading;
  const firstCredit = useMemo(
    () => status?.reset_credits?.credits?.find((credit) => credit.status === "available") || status?.reset_credits?.credits?.[0],
    [status],
  );

  if (agent !== "codex") return null;
  if (!status?.uses_chatgpt_plan) return null;

  const handleReset = async () => {
    if (!canReset || resetting) return;
    if (!idempotencyKeyRef.current) idempotencyKeyRef.current = crypto.randomUUID();
    setResetting(true);
    setError("");
    setResetOutcome("");
    try {
      const result = await consumeCodexRateLimitReset(
        idempotencyKeyRef.current,
        firstCredit?.id,
        agent,
      );
      setStatus(result.status);
      onStatusChange?.(result.status);
      setResetOutcome(result.outcome);
      idempotencyKeyRef.current = "";
      if (result.outcome === "reset" || result.outcome === "alreadyRedeemed") {
        setConfirmOpen(false);
      }
    } catch (err) {
      setError(String((err as Error)?.message || t("codexLimit.resetFailed")));
    } finally {
      setResetting(false);
    }
  };

  const modal = confirmOpen && typeof document !== "undefined" ? createPortal(
    <div
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !resetting) setConfirmOpen(false);
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10050,
        display: "grid",
        placeItems: "center",
        padding: "20px",
        background: "rgba(15, 23, 42, 0.44)",
        backdropFilter: "blur(5px)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="codex-reset-title"
        style={{
          width: "min(390px, calc(100vw - 32px))",
          borderRadius: "16px",
          border: "1px solid var(--panel-border)",
          background: "var(--panel-bg)",
          boxShadow: "0 24px 70px rgba(15, 23, 42, 0.28)",
          padding: "20px",
        }}
      >
        <div>
          <div style={{ minWidth: 0 }}>
            <h2 id="codex-reset-title" style={{ margin: 0, fontSize: "16px", lineHeight: 1.35, color: "var(--text-primary)" }}>{t("codexLimit.confirmTitle")}</h2>
            <p style={{ margin: "7px 0 0", fontSize: "13px", lineHeight: 1.6, color: "var(--text-secondary)" }}>
              {t("codexLimit.confirmDescription", { count: resetCount })}
            </p>
            {firstCredit?.description ? <p style={{ margin: "8px 0 0", fontSize: "12px", lineHeight: 1.5, color: "var(--text-secondary)" }}>{firstCredit.description}</p> : null}
          </div>
        </div>
        {resetOutcome === "nothingToReset" ? <div style={{ marginTop: "14px", padding: "9px 11px", borderRadius: "9px", background: "rgba(245, 158, 11, 0.10)", color: "#b45309", fontSize: "12px" }}>{t("codexLimit.nothingToReset")}</div> : null}
        {resetOutcome === "noCredit" ? <div style={{ marginTop: "14px", padding: "9px 11px", borderRadius: "9px", background: "rgba(220, 38, 38, 0.09)", color: "#dc2626", fontSize: "12px" }}>{t("codexLimit.noCredit")}</div> : null}
        {error ? <div style={{ marginTop: "14px", padding: "9px 11px", borderRadius: "9px", background: "rgba(220, 38, 38, 0.09)", color: "#dc2626", fontSize: "12px", overflowWrap: "anywhere" }}>{error}</div> : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "18px" }}>
          <button type="button" onClick={() => setConfirmOpen(false)} disabled={resetting} autoFocus style={{ height: "34px", padding: "0 14px", borderRadius: "9px", border: "1px solid var(--panel-border)", background: "transparent", color: "var(--text-primary)", cursor: resetting ? "not-allowed" : "pointer", fontWeight: 650 }}>{t("common.cancel")}</button>
          <button type="button" onClick={() => void handleReset()} disabled={resetting || !canReset} style={{ height: "34px", padding: "0 14px", borderRadius: "9px", border: "none", background: "#b45309", color: "#fff", cursor: resetting ? "wait" : "pointer", fontWeight: 750, opacity: resetting || !canReset ? 0.55 : 1 }}>{resetting ? t("codexLimit.resetting") : t("codexLimit.confirmAction")}</button>
        </div>
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <div style={{ display: "inline-flex", flex: "0 0 auto", alignItems: "center", gap: "5px", height: "24px", marginBottom: "4px" }}>
        <div title={resetTime ? t("codexLimit.weeklyTitleWithReset", { percent: remaining ?? "—", time: resetTime }) : t("codexLimit.weeklyTitle", { percent: remaining ?? "—" })} style={{ display: "inline-flex", alignItems: "center", height: "20px", padding: "0 8px", borderRadius: "999px", border: "1px solid rgba(37, 99, 235, 0.22)", background: "linear-gradient(rgba(37, 99, 235, 0.10), rgba(37, 99, 235, 0.10)), var(--mobile-overlay-bg)", color: "#2563eb", fontSize: "11px", fontWeight: 700, lineHeight: 1, whiteSpace: "nowrap" }}>
          {t("codexLimit.weekly")} {loading && remaining === null ? "··" : remaining === null ? "—" : `${remaining}%`}
        </div>
        <button type="button" disabled={!canReset} onClick={() => { setResetOutcome(""); setError(""); setConfirmOpen(true); }} title={canReset ? t("codexLimit.resetAvailable", { count: resetCount }) : error || t("codexLimit.resetUnavailable")} aria-label={canReset ? t("codexLimit.resetAvailable", { count: resetCount }) : t("codexLimit.resetUnavailable")} style={{ display: "inline-flex", alignItems: "center", height: "20px", padding: "0 8px", borderRadius: "999px", border: canReset ? "1px solid rgba(180, 83, 9, 0.24)" : "1px solid var(--border-color)", background: canReset ? "linear-gradient(rgba(245, 158, 11, 0.10), rgba(245, 158, 11, 0.10)), var(--mobile-overlay-bg)" : "linear-gradient(rgba(100, 116, 139, 0.08), rgba(100, 116, 139, 0.08)), var(--mobile-overlay-bg)", color: canReset ? "#b45309" : "var(--text-secondary)", fontSize: "11px", fontWeight: 700, lineHeight: 1, whiteSpace: "nowrap", cursor: canReset ? "pointer" : "default" }}>
          {t("codexLimit.reset")} {loading && !status ? "·" : resetCount}{resetCountdown ? ` · ${resetCountdown}` : ""}
        </button>
      </div>
      {modal}
    </>
  );
}

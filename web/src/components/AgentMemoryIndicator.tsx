import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { protectedAPIReady } from "../services/api";
import { bootstrapService } from "../services/bootstrap";
import {
  fetchAgentMemory,
  releaseAgentSessions,
  type AgentMemorySnapshot,
} from "../services/agentMemory";

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  const gib = value / (1024 ** 3);
  if (gib >= 1) return `${gib.toFixed(gib >= 10 ? 0 : 1)} GB`;
  const mib = value / (1024 ** 2);
  if (mib >= 1) return `${Math.round(mib)} MB`;
  return `${Math.round(value / 1024)} KB`;
}

type Props = {
  refreshToken?: number;
};

export function AgentMemoryIndicator({ refreshToken = 0 }: Props) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<AgentMemorySnapshot | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [releasing, setReleasing] = useState(false);
  const [error, setError] = useState("");
  const [releaseResult, setReleaseResult] = useState<{ released: number; failed: number } | null>(null);
  const [apiReady, setAPIReady] = useState(protectedAPIReady);
  const requestRef = useRef(0);

  const refresh = async () => {
    const request = ++requestRef.current;
    setLoading(true);
    setError("");
    try {
      const next = await fetchAgentMemory();
      if (request === requestRef.current) {
        setSnapshot(next);
      }
    } catch (err) {
      if (request === requestRef.current) {
        setError(String((err as Error)?.message || t("agentMemory.loadFailed")));
      }
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    return bootstrapService.subscribe(() => {
      setAPIReady(protectedAPIReady());
    });
  }, []);

  useEffect(() => {
    if (!apiReady) return;
    void refresh();
    return () => {
      requestRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiReady, refreshToken]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !releasing) setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, releasing]);

  const agents = useMemo(
    () => (snapshot?.agents || []).filter((item) => item.process_count > 0 || item.session_count > 0),
    [snapshot?.agents],
  );
  const sessionCount = agents.reduce((sum, item) => sum + Math.max(0, item.session_count || 0), 0);

  const handleOpen = () => {
    setOpen(true);
    setReleaseResult(null);
    void refresh();
  };

  const handleRelease = async () => {
    if (releasing || sessionCount <= 0) return;
    setReleasing(true);
    setError("");
    setReleaseResult(null);
    try {
      const result = await releaseAgentSessions();
      requestRef.current += 1;
      setSnapshot(result);
      setReleaseResult({ released: result.released_sessions, failed: result.failed_sessions });
    } catch (err) {
      setError(String((err as Error)?.message || t("agentMemory.releaseFailed")));
    } finally {
      setReleasing(false);
    }
  };

  const modal = open && typeof document !== "undefined" ? createPortal(
    <div
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !releasing) setOpen(false);
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
        aria-labelledby="agent-memory-title"
        style={{
          width: "min(520px, calc(100vw - 32px))",
          maxHeight: "min(680px, calc(100vh - 40px))",
          overflowY: "auto",
          borderRadius: "16px",
          border: "1px solid var(--panel-border)",
          background: "var(--panel-bg)",
          boxShadow: "0 24px 70px rgba(15, 23, 42, 0.28)",
          padding: "20px",
          boxSizing: "border-box",
        }}
      >
        <h2 id="agent-memory-title" style={{ margin: 0, fontSize: "16px", lineHeight: 1.35, color: "var(--text-primary)" }}>
          {t("agentMemory.title")}
        </h2>

        <div style={{ marginTop: "14px", border: "1px solid var(--border-color)", borderRadius: "10px", overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(62px, 1fr) 48px 76px 58px", gap: "4px", padding: "8px 10px", background: "color-mix(in srgb, var(--panel-bg) 70%, var(--border-color))", color: "var(--text-secondary)", fontSize: "11px", fontWeight: 700 }}>
            <span>{t("agentMemory.agent")}</span>
            <span style={{ textAlign: "right" }}>{t("agentMemory.processes")}</span>
            <span style={{ textAlign: "right" }}>{t("agentMemory.memory")}</span>
            <span style={{ textAlign: "right" }}>{t("agentMemory.sessions")}</span>
          </div>
          {loading && !snapshot ? (
            <div style={{ padding: "18px 10px", textAlign: "center", color: "var(--text-secondary)", fontSize: "12px" }}>{t("agentMemory.loading")}</div>
          ) : agents.length === 0 ? (
            <div style={{ padding: "18px 10px", textAlign: "center", color: "var(--text-secondary)", fontSize: "12px" }}>{t("agentMemory.noAgents")}</div>
          ) : agents.map((item, index) => (
            <div key={item.name} style={{ display: "grid", gridTemplateColumns: "minmax(62px, 1fr) 48px 76px 58px", gap: "4px", padding: "10px", borderTop: index === 0 ? "none" : "1px solid var(--border-color)", color: "var(--text-primary)", fontSize: "12px", alignItems: "center" }}>
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 650 }} title={item.name}>{item.name}</span>
              <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{item.process_count}</span>
              <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{formatBytes(item.memory_bytes)}</span>
              <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{item.session_count}</span>
            </div>
          ))}
        </div>

        <div style={{ marginTop: "14px", padding: "10px 12px", borderRadius: "10px", background: "color-mix(in srgb, var(--accent-color) 8%, transparent)", color: "var(--text-secondary)", fontSize: "12px", lineHeight: 1.6 }}>
          {sessionCount > 0 ? t("agentMemory.releaseHint") : t("agentMemory.noSessionsHint")}
        </div>
        {releaseResult !== null ? (
          <div style={{ marginTop: "10px", padding: "9px 11px", borderRadius: "9px", background: releaseResult.failed > 0 ? "rgba(245, 158, 11, 0.10)" : "rgba(22, 163, 74, 0.10)", color: releaseResult.failed > 0 ? "#b45309" : "#15803d", fontSize: "12px" }}>
            {releaseResult.failed > 0
              ? t("agentMemory.releasePartial", { released: releaseResult.released, failed: releaseResult.failed })
              : t("agentMemory.releaseDone", { count: releaseResult.released })}
          </div>
        ) : null}
        {error ? <div style={{ marginTop: "10px", padding: "9px 11px", borderRadius: "9px", background: "rgba(220, 38, 38, 0.09)", color: "#dc2626", fontSize: "12px", overflowWrap: "anywhere" }}>{error}</div> : null}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "18px" }}>
          <button type="button" onClick={() => setOpen(false)} disabled={releasing} style={{ height: "34px", padding: "0 14px", borderRadius: "9px", border: "1px solid var(--panel-border)", background: "transparent", color: "var(--text-primary)", cursor: releasing ? "not-allowed" : "pointer", fontWeight: 650 }}>{t("common.cancel")}</button>
          <button type="button" onClick={() => void handleRelease()} disabled={releasing || loading || sessionCount <= 0} style={{ height: "34px", padding: "0 14px", borderRadius: "9px", border: "none", background: "var(--accent-color)", color: "#fff", cursor: releasing ? "wait" : "pointer", fontWeight: 750, opacity: releasing || loading || sessionCount <= 0 ? 0.55 : 1 }}>
            {releasing ? t("agentMemory.releasing") : t("agentMemory.releaseNow")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        className="mindfs-agent-memory-badge"
        type="button"
        onClick={handleOpen}
        title={error || t("agentMemory.badgeTitle")}
        aria-label={t("agentMemory.badgeTitle")}
        style={{
          display: "inline-flex",
          alignItems: "center",
          height: "20px",
          padding: "0 8px",
          borderRadius: "999px",
          fontSize: "11px",
          fontWeight: 700,
          lineHeight: 1,
          whiteSpace: "nowrap",
          cursor: "pointer",
        }}
      >
        {t("agentMemory.badge")} {loading && !snapshot ? "··" : snapshot ? formatBytes(snapshot.total_memory_bytes) : "—"}
      </button>
      {modal}
    </>
  );
}

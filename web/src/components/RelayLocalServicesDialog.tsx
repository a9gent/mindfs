import React from "react";
import {
  deleteRelayLocalService,
  listRelayLocalServices,
  saveRelayLocalService,
  type RelayLocalService,
} from "../services/relayServices";
import { copyText } from "../services/clipboard";

type Props = {
  open: boolean;
  nodeId: string;
  relayBaseURL: string;
  noRelayer?: boolean;
  onCancel: () => void;
  onEditingChange: (editing: boolean) => void;
};

const emptyDraft: RelayLocalService = {
  slug: "",
  name: "",
  local_url: "http://127.0.0.1:",
  enabled: true,
};

export function RelayLocalServicesDialog({ open, nodeId, relayBaseURL, noRelayer = false, onCancel, onEditingChange }: Props) {
  const [services, setServices] = React.useState<RelayLocalService[]>([]);
  const [draft, setDraft] = React.useState<RelayLocalService | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [copiedServiceSlug, setCopiedServiceSlug] = React.useState("");
  const copyResetTimerRef = React.useRef<number | null>(null);

  const editDraft = React.useCallback((nextDraft: RelayLocalService | null) => {
    setDraft(nextDraft);
    onEditingChange(nextDraft !== null);
  }, [onEditingChange]);

  const load = React.useCallback(async () => {
    if (!open) return;
    if (noRelayer) {
      setServices([]);
      editDraft(null);
      setError("");
      return;
    }
    setBusy(true);
    setError("");
    try {
      setServices(await listRelayLocalServices());
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setBusy(false);
    }
  }, [editDraft, noRelayer, open]);

  React.useEffect(() => {
    if (!open) {
      editDraft(null);
    }
  }, [editDraft, open]);

  React.useEffect(() => () => {
    if (copyResetTimerRef.current !== null) {
      window.clearTimeout(copyResetTimerRef.current);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  if (!open) return null;

  const publicURL = (slug: string) => {
    if (!nodeId) {
      return "";
    }
    try {
      const base = new URL(relayBaseURL || window.location.origin);
      const serviceBaseHost = base.hostname.toLowerCase().startsWith("relay.")
        ? base.host.slice("relay.".length)
        : base.host;
      return `${base.protocol}//${slug}-${nodeId}-relay.${serviceBaseHost}/`;
    } catch {
      return "";
    }
  };

  const saveDraft = async () => {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      await saveRelayLocalService({
        ...draft,
        slug: draft.name.trim() || draft.slug,
        name: draft.name.trim() || draft.slug,
      });
      editDraft(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const updateEnabled = async (service: RelayLocalService, enabled: boolean) => {
    setBusy(true);
    setError("");
    try {
      await saveRelayLocalService({ ...service, enabled });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (service: RelayLocalService) => {
    if (!window.confirm(`删除 ${service.slug}？`)) return;
    setBusy(true);
    setError("");
    try {
      await deleteRelayLocalService(service.slug);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
    } finally {
      setBusy(false);
    }
  };

  const copyServiceURL = async (service: RelayLocalService, url: string) => {
    setError("");
    try {
      await copyText(url);
      setCopiedServiceSlug(service.slug);
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
      copyResetTimerRef.current = window.setTimeout(() => {
        setCopiedServiceSlug("");
        copyResetTimerRef.current = null;
      }, 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "复制失败");
    }
  };

  return (
      <section style={panelStyle}>
        {!draft ? (
          <header style={headerStyle}>
            <div style={titleStyle}>从公网访问本地节点</div>
            {!noRelayer ? (
              <button
                type="button"
                aria-label="新建"
                title="新建"
                onClick={() => editDraft(emptyDraft)}
                style={addButtonStyle(busy || !nodeId)}
                disabled={busy || !nodeId}
              >
                添加
              </button>
            ) : null}
          </header>
        ) : null}

        {error ? <div style={errorStyle}>{error}</div> : null}

        {noRelayer ? (
          <div style={emptyStyle}>Relay 已禁用，无法配置公网访问本地服务。</div>
        ) : draft ? (
          <div style={editorStyle}>
            <label style={labelStyle}>
              <span style={fieldHeaderStyle}>
                <span>名称</span>
                <span style={enableInlineStyle}>
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                  />
                  <span>启用</span>
                </span>
              </span>
              <input
                value={draft.name || draft.slug}
                onChange={(event) => setDraft({ ...draft, name: event.target.value, slug: event.target.value })}
                placeholder="小写字母、数字、-（不连续，不结尾）"
                style={inputStyle}
              />
            </label>
            <label style={labelStyle}>
              <span>本地服务地址</span>
              <input
                value={draft.local_url}
                onChange={(event) => setDraft({ ...draft, local_url: event.target.value })}
                placeholder="http://127.0.0.1:5173"
                style={inputStyle}
              />
            </label>
            <footer style={actionRowStyle}>
              <button type="button" onClick={onCancel} style={ghostButtonStyle(false)}>取消</button>
              <button type="button" onClick={saveDraft} style={primaryButtonStyle(busy)} disabled={busy}>保存</button>
            </footer>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {services.length === 0 && !busy ? <div style={emptyStyle}>还没有本地服务</div> : null}
            {services.map((service) => {
              const serviceURL = publicURL(service.slug);
              return (
                <article key={service.slug} style={itemStyle}>
                  <div style={itemHeaderStyle}>
                    <span style={serviceNameStyle}>{service.slug}</span>
                    <div style={itemActionStyle}>
                      <button
                        type="button"
                        title={service.enabled ? "停用" : "启用"}
                        aria-label={service.enabled ? "停用服务" : "启用服务"}
                        onClick={() => updateEnabled(service, !service.enabled)}
                        style={{
                          ...serviceIconButtonStyle,
                          color: service.enabled ? "#dc2626" : "var(--accent-color)",
                          opacity: busy ? 0.5 : 1,
                          cursor: busy ? "not-allowed" : "pointer",
                        }}
                        disabled={busy}
                      >
                        {service.enabled ? <StopIcon /> : <RunNowIcon />}
                      </button>
                      <button
                        type="button"
                        title="删除"
                        aria-label="删除服务"
                        onClick={() => remove(service)}
                        style={{ ...serviceIconButtonStyle, color: "#dc2626", opacity: busy ? 0.5 : 1, cursor: busy ? "not-allowed" : "pointer" }}
                        disabled={busy}
                      >
                        <DeleteIcon />
                      </button>
                    </div>
                  </div>
                  <div style={monoLineStyle}>{service.local_url}</div>
                  <div style={urlLineStyle}>
                    <span style={urlTextStyle}>{serviceURL || "当前未绑定relayer"}</span>
                    <button
                      type="button"
                      title={copiedServiceSlug === service.slug ? "已复制" : "复制"}
                      aria-label={copiedServiceSlug === service.slug ? "已复制公网地址" : "复制公网地址"}
                      onClick={() => void copyServiceURL(service, serviceURL)}
                      style={{ ...serviceIconButtonStyle, opacity: serviceURL ? 1 : 0.5, cursor: serviceURL ? "pointer" : "not-allowed" }}
                      disabled={!serviceURL}
                    >
                      {copiedServiceSlug === service.slug ? <CopiedIcon /> : <CopyIcon />}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
  );
}

function StopIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 1024 1024" aria-hidden="true">
      <path d="M0 0h1024v1024H0z" fill="none" />
      <path
        fill="currentColor"
        d="M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448s448-200.6 448-448S759.4 64 512 64m0 820c-205.4 0-372-166.6-372-372c0-89 31.3-170.8 83.5-234.8l523.3 523.3C682.8 852.7 601 884 512 884m288.5-137.2L277.2 223.5C341.2 171.3 423 140 512 140c205.4 0 372 166.6 372 372c0 89-31.3 170.8-83.5 234.8"
      />
    </svg>
  );
}

function RunNowIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M0 0h24v24H0z" fill="none" />
      <path fill="none" stroke="currentColor" strokeWidth="2" d="M20.409 9.353a2.998 2.998 0 0 1 0 5.294L7.597 21.614C5.534 22.737 3 21.277 3 18.968V5.033c0-2.31 2.534-3.769 4.597-2.648z" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4h6v2" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CopiedIcon() {
  return (
    <span aria-hidden="true" style={{ fontSize: "13px", fontWeight: 800, lineHeight: 1 }}>
      ✓
    </span>
  );
}

const panelStyle: React.CSSProperties = {
  width: "100%",
  maxHeight: "min(620px, calc(100vh - 58px))",
  overflow: "auto",
  borderRadius: "12px",
  background: "var(--menu-bg)",
  border: "1px solid var(--border-color)",
  boxShadow: "0 12px 30px rgba(15, 23, 42, 0.14)",
  padding: "10px",
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
  gap: "10px",
};

const headerStyle: React.CSSProperties = { display: "flex", justifyContent: "space-between", gap: "10px", alignItems: "center" };
const titleStyle: React.CSSProperties = { minWidth: 0, flex: 1, fontSize: "12px", fontWeight: 700, color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
const editorStyle: React.CSSProperties = { display: "grid", gap: "10px" };
const labelStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "6px", fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)" };
const fieldHeaderStyle: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" };
const enableInlineStyle: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: "4px", whiteSpace: "nowrap", color: "var(--text-secondary)" };
const inputStyle: React.CSSProperties = { width: "100%", borderRadius: "8px", border: "1px solid var(--border-color)", background: "transparent", color: "var(--text-primary)", fontSize: "12px", padding: "8px 10px", outline: "none", boxSizing: "border-box" };
const itemStyle: React.CSSProperties = { display: "grid", gap: "8px", padding: "8px 10px", borderRadius: "8px", border: "1px solid var(--border-color)", background: "transparent" };
const itemHeaderStyle: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" };
const itemActionStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: "4px", flexShrink: 0 };
const serviceNameStyle: React.CSSProperties = { minWidth: 0, color: "var(--text-primary)", fontSize: "12px", fontWeight: 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const monoLineStyle: React.CSSProperties = { marginTop: "4px", fontSize: "11px", color: "var(--text-secondary)", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
const urlLineStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: "6px", minWidth: 0 };
const urlTextStyle: React.CSSProperties = { ...monoLineStyle, marginTop: 0, minWidth: 0, flex: 1 };
const actionRowStyle: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" };
const emptyStyle: React.CSSProperties = { borderRadius: "8px", padding: "8px 10px", fontSize: "12px", color: "var(--text-secondary)", background: "rgba(148, 163, 184, 0.10)", lineHeight: 1.45, wordBreak: "break-word" };
const errorStyle: React.CSSProperties = { borderRadius: "8px", padding: "8px 10px", fontSize: "12px", color: "#dc2626", background: "rgba(148, 163, 184, 0.10)", lineHeight: 1.45, wordBreak: "break-word" };
const primaryButtonStyle = (disabled: boolean): React.CSSProperties => ({ border: "none", borderRadius: "8px", padding: "8px 10px", background: "var(--accent-color)", color: "#fff", fontSize: "12px", fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.6 : 1 });
const ghostButtonStyle = (disabled: boolean): React.CSSProperties => ({ border: "1px solid var(--border-color)", borderRadius: "8px", padding: "8px 10px", background: "transparent", color: "var(--text-secondary)", fontSize: "12px", fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.6 : 1 });
const addButtonStyle = (disabled: boolean): React.CSSProperties => ({ border: "none", borderRadius: "7px", padding: "4px 9px", background: "var(--accent-color)", color: "#fff", fontSize: "11px", fontWeight: 600, lineHeight: 1.2, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1, flexShrink: 0 });
const serviceIconButtonStyle: React.CSSProperties = { border: "none", background: "transparent", color: "var(--text-primary)", borderRadius: 6, width: 26, height: 26, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 };

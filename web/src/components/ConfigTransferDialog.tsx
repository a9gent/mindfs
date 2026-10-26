import React from "react";
import { useI18n, type MessageKey } from "../i18n";
import { exportUserConfig, importUserConfig } from "../services/configTransfer";
import {
  CONFIG_ARCHIVE_MAX_BYTES, CONFIG_CATEGORIES, importableConfigCategories,
  categoryDescription, categoryLabel, parseConfigArchive,
  type ConfigArchive, type ConfigCategory,
} from "../services/configTransferData";

const buttonStyle: React.CSSProperties = {
  border: "1px solid var(--border-color)", borderRadius: 8, padding: "8px 12px",
  background: "transparent", color: "var(--text-primary)", font: "inherit", cursor: "pointer",
};

export function ConfigTransferDialog({ onClose }: { onClose: () => void }) {
  const { t, formatDateTime } = useI18n();
  const [mode, setMode] = React.useState<"export" | "import">("export");
  const [selected, setSelected] = React.useState<Set<ConfigCategory>>(() => new Set(CONFIG_CATEGORIES.filter(c => c.defaultSelected).map(c => c.id)));
  const [archive, setArchive] = React.useState<ConfigArchive | null>(null);
  const [filename, setFilename] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [done, setDone] = React.useState<"export" | "import" | null>(null);
  const [restart, setRestart] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const dialogRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => previous?.focus();
  }, []);

  const available = mode === "export" ? CONFIG_CATEGORIES.map(c => c.id) : archive ? importableConfigCategories(archive) : [];
  const options = CONFIG_CATEGORIES.filter(c => available.includes(c.id));
  const chosen = options.filter(c => selected.has(c.id));
  const sensitive = chosen.some(c => "sensitive" in c && c.sensitive);
  const device = chosen.some(c => "device" in c && c.device);
  const restartRequired = mode === "import" && (done === "import" ? restart : selected.has("custom_agents"));

  const switchMode = (next: "export" | "import") => {
    setMode(next); setError(""); setDone(null);
    const ids = next === "import" ? (archive ? importableConfigCategories(archive) : []) : CONFIG_CATEGORIES.map(c => c.id);
    setSelected(new Set(CONFIG_CATEGORIES.filter(c => (next === "import" || c.defaultSelected) && ids.includes(c.id)).map(c => c.id)));
  };

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true); setError(""); setDone(null); setArchive(null); setFilename(""); setSelected(new Set());
    try {
      if (file.size > CONFIG_ARCHIVE_MAX_BYTES) throw new Error("configTransfer.tooLarge");
      let parsed: ConfigArchive;
      try { parsed = parseConfigArchive(await file.text()); }
      catch (err) {
        if (err instanceof Error && err.message.startsWith("configTransfer.")) throw err;
        throw new Error("configTransfer.invalidFile");
      }
      const ids = importableConfigCategories(parsed);
      if (!ids.length) throw new Error("configTransfer.emptyFile");
      setArchive(parsed); setFilename(file.name);
      setSelected(new Set(ids));
    } catch (err) { showError(err); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  };

  const showError = (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    setError(message.startsWith("configTransfer.") ? t(message as MessageKey) : message);
  };

  const run = async () => {
    if (!chosen.length || busy) return;
    setBusy(true); setError(""); setDone(null);
    try {
      const ids = chosen.map(c => c.id);
      if (mode === "export") await exportUserConfig(ids);
      else if (archive) {
        const result = await importUserConfig(archive, ids);
        setRestart(result.restart_required);
        if (result.native_sync_failed) setError(t("configTransfer.nativeSyncFailed"));
      }
      setDone(mode);
    } catch (err) { showError(err); }
    finally { setBusy(false); }
  };

  return (
      <div ref={dialogRef} role="dialog" aria-label={t("configTransfer.title")} tabIndex={-1}
        onKeyDown={event => {
          if (event.key === "Escape") { event.stopPropagation(); if (!busy) onClose(); }
        }}
        style={{ width: "100%", boxSizing: "border-box", maxHeight: "calc(100dvh - 96px)", display: "flex", flexDirection: "column", borderRadius: 12, border: "1px solid var(--border-color)", background: "var(--menu-bg)", color: "var(--text-primary)", boxShadow: "0 16px 36px rgba(15,23,42,.18)", fontSize: 13, outline: "none", overflow: "hidden" }}>
        <div style={{ display: "flex", gap: 6, padding: "6px 12px 0", flexShrink: 0 }} role="tablist" aria-label={t("configTransfer.title")}>
          {(["export", "import"] as const).map(item => <button key={item} type="button" role="tab" aria-selected={mode === item} aria-controls="config-transfer-panel" disabled={busy} onClick={() => switchMode(item)}
            style={{ ...buttonStyle, flex: 1, background: mode === item ? "var(--selection-bg)" : "transparent", color: mode === item ? "var(--accent-color)" : "var(--text-secondary)", fontWeight: 600 }}>{t(`configTransfer.${item}`)}</button>)}
        </div>
        <div id="config-transfer-panel" role="tabpanel" style={{ overflowY: "auto", overscrollBehavior: "contain", padding: "6px 12px", minHeight: 0 }}>
          {mode === "import" && <div style={{ marginBottom: 14 }}>
            <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={event => { void readFile(event.target.files?.[0]); }} />
            <button type="button" disabled={busy} style={buttonStyle} onClick={() => fileRef.current?.click()}>{t("configTransfer.chooseFile")}</button>
            {filename && <div style={{ marginTop: 8, overflowWrap: "anywhere", color: "var(--text-secondary)", fontSize: 12 }}>{filename}{archive && !Number.isNaN(Date.parse(archive.created_at)) ? ` · ${formatDateTime(archive.created_at)}` : ""}{archive?.platform ? ` · ${archive.platform}` : ""}</div>}
          </div>}
          {options.length > 0 && <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 8 }}>
              <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>{t("configTransfer.selected", { count: chosen.length, total: options.length })}</span>
              <button type="button" disabled={busy} style={{ ...buttonStyle, padding: "4px 8px", fontSize: 12 }} onClick={() => { setSelected(new Set(CONFIG_CATEGORIES.filter(c => (mode === "import" || c.defaultSelected) && available.includes(c.id)).map(c => c.id))); setDone(null); }}>{t("configTransfer.reset")}</button>
            </div>
            <fieldset disabled={busy || done === "import"} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
              {options.map(category => <label key={category.id} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "11px 0", borderBottom: "1px solid var(--border-color)", cursor: busy ? "wait" : "pointer" }}>
                <input type="checkbox" aria-label={t(categoryLabel(category.id))} aria-describedby={`config-description-${category.id}`} checked={selected.has(category.id)} style={{ margin: "3px 0 0", accentColor: "var(--accent-color)" }} onChange={event => {
                  const checked = event.target.checked;
                  setSelected(previous => { const next = new Set(previous); if (checked) next.add(category.id); else next.delete(category.id); return next; }); setDone(null);
                }} />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontWeight: 600 }}>{t(categoryLabel(category.id))}
                    {"sensitive" in category && category.sensitive && <span style={{ color: "var(--text-secondary)", border: "1px solid var(--border-color)", borderRadius: 4, padding: "1px 5px", fontSize: 10, fontWeight: 400 }}>{t("configTransfer.sensitive")}</span>}
                  </span>
                  <span id={`config-description-${category.id}`} style={{ display: "block", color: "var(--text-secondary)", fontSize: 12, lineHeight: 1.55, marginTop: 3 }}>{t(categoryDescription(category.id))}</span>
                </span>
              </label>)}
            </fieldset>
            {mode === "export" && (sensitive || device) && <div style={{ color: "var(--text-secondary)", fontSize: 12, lineHeight: 1.65, marginTop: 14 }}>
              {sensitive && <p style={{ margin: "6px 0", color: "var(--text-primary)" }}>{t("configTransfer.secretHint")}</p>}
              {device && <p style={{ margin: "6px 0" }}>{t("configTransfer.deviceHint")}</p>}
            </div>}
          </>}
          {error && <div role="alert" style={{ marginTop: 12, color: "var(--error-color, #dc2626)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{error}</div>}
          {restartRequired && <div role="status" style={{ marginTop: 8, color: "var(--error-color, #dc2626)" }}>{t("configTransfer.restartRequired")}</div>}
          {done === "export" && <div role="status" style={{ marginTop: 14, padding: 12, borderRadius: 8, background: "var(--selection-bg)", lineHeight: 1.6 }}>{t("configTransfer.exported")}</div>}
        </div>
        <footer style={{ padding: "6px 12px", borderTop: "1px solid var(--border-color)", display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", flexShrink: 0, gap: 8 }}>
          <button type="button" disabled={busy} style={buttonStyle} onClick={onClose}>{t("common.cancel")}</button>
          {done === "import" ? <button type="button" style={{ ...buttonStyle, background: "var(--accent-color)", color: "#fff" }} onClick={() => window.location.reload()}>{t("configTransfer.reload")}</button>
            : <button type="button" disabled={busy || !chosen.length || (mode === "import" && !archive)} onClick={() => { void run(); }}
              style={{ ...buttonStyle, background: "var(--accent-color)", color: "#fff", opacity: busy || !chosen.length ? .5 : 1 }}>{t(busy ? "configTransfer.busy" : mode === "export" ? "configTransfer.exportSelected" : "configTransfer.importSelected")}</button>}
        </footer>
      </div>
  );
}

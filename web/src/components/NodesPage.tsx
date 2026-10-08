import React, { useEffect, useState } from "react";
import { Login } from "./Login";
import { bootstrapService } from "../services/bootstrap";
import { backendNodes } from "../services/nodes";
import { nodeDestinationURL } from "../services/nodePage";
import { useI18n } from "../i18n";

export function NodesPage() {
  const { t } = useI18n();
  const [state, setState] = useState(() => bootstrapService.snapshot());
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const unsubscribe = bootstrapService.subscribe(setState);
    void bootstrapService.start().catch((err) => setError(String(err)));
    return unsubscribe;
  }, []);
  if (state.phase === "ready") {
    return <Login repository={backendNodes} onOpenNode={(url) => window.location.assign(nodeDestinationURL(url))} />;
  }
  return <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 24, background: "var(--mindfs-system-bar-bg)", color: "var(--text-primary)" }}>
    <form style={{ width: "min(460px, 100%)", display: "grid", gap: 16 }} onSubmit={async (event) => {
      event.preventDefault();
      if (busy) return;
      setBusy(true); setError("");
      try { await bootstrapService.submitPairingSecret(secret.trim()); }
      catch (err) { setError(String(err instanceof Error ? err.message : err)); }
      finally { setBusy(false); }
    }}>
      {state.phase === "needs_pairing" ? <>
        <label htmlFor="node-pairing">{t("e2ee.title")}</label>
        <input id="node-pairing" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder={t("e2ee.placeholder")} autoFocus required disabled={busy} />
        <button disabled={busy || !secret.trim()}>{t("e2ee.continue")}</button>
      </> : <p role="status">{state.error || t("common.loading")}</p>}
      {error ? <p role="alert">{error}</p> : null}
      {state.phase === "error" || error ? <button type="button" onClick={() => {
        setError(""); void bootstrapService.start().catch((err) => setError(String(err)));
      }}>{t("common.retry")}</button> : null}
    </form>
  </main>;
}

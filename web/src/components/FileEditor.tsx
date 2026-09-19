import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { fetchFile, type FilePayload } from "../services/file";
import { type FileEditSession, type FileEditStore } from "../services/fileEditing";
import { CodeTextEditor } from "./editor/CodeTextEditor";
import "./FileEditor.css";

type Props = {
  actionsTarget: HTMLElement | null;
  store: FileEditStore;
  editKey: string;
  session: FileEditSession;
  isVisible: boolean;
  onFileUpdated: (file: FilePayload) => void;
  onFileSaved: (file: FilePayload) => void;
  onExitError: (error: string) => void;
};

export function FileEditor({ actionsTarget, store, editKey, session, isVisible, onFileUpdated, onFileSaved, onExitError }: Props) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(false);
  const [saveSuccess, setSaveSuccess] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (successTimer.current !== null) clearTimeout(successTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!isVisible) setSaveSuccess(null);
  }, [isVisible]);
  const [confirmExit, setConfirmExit] = useState(false);
  const leaving = session.leaving;
  const dirty = session.text !== session.savedText;
  const busy = session.loading || session.saving || leaving;
  const loaded = !!session.revision;

  useEffect(() => {
    const node = dialog.current;
    if (confirmExit && isVisible && node && !node.open) node.showModal();
    else if (node?.open) node.close();
  }, [confirmExit, isVisible]);

  async function exit() {
    store.patch(editKey, { leaving: true });
    setConfirmExit(false);
    try {
      const file = await fetchFile({ rootId: session.rootId, path: session.path, readMode: "full", fresh: true, timeoutMs: 15000 });
      if (!file) throw new Error(t("fileEditor.reloadFailed"));
      onFileUpdated(file);
    } catch (error) {
      onExitError(`${t("fileEditor.reloadFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (store.get(editKey)?.view === session.view) store.close(editKey);
    }
  }

  async function save(andExit = false) {
    if (successTimer.current !== null) clearTimeout(successTimer.current);
    setSaveSuccess(null);
    const saved = await store.save(editKey);
    if (!saved) { setConfirmExit(false); return; }
    onFileSaved(saved);
    if (mounted.current && !andExit && saveButton.current) {
      const rect = saveButton.current.getBoundingClientRect();
      setSaveSuccess({ left: rect.left + rect.width / 2, top: Math.max(4, rect.top - 28) });
      successTimer.current = setTimeout(() => setSaveSuccess(null), 2000);
    }
    const latest = store.get(editKey);
    if (andExit && latest && latest.text === latest.savedText) await exit();
  }

  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (!isVisible) return;
    const handler = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      if (!event.isComposing && !busy && loaded && dirty && !confirmExit) void saveRef.current();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isVisible, busy, loaded, dirty, confirmExit]);

  const errorText = session.error === "file_edit_conflict" ? t("fileEditor.conflict")
    : session.error === "file_edit_too_large" ? t("fileEditor.tooLarge")
    : session.error === "file_not_editable" ? t("fileEditor.notEditable") : session.error;

  return (
    <section className="file-editor" aria-label={t("fileEditor.editor")}>
      {actionsTarget && createPortal(<>
        <button ref={saveButton} type="button" className={`file-editor-icon-button${dirty ? " is-dirty" : ""}`} title={session.saving ? t("fileEditor.saving") : t("fileEditor.save")} aria-label={t("fileEditor.save")} aria-busy={session.saving} disabled={busy || !loaded || !dirty} onClick={() => { void save(); }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z" /><path d="M7 3v6h10V3M7 21v-8h10v8" /></svg>
        </button>
        <button type="button" className="file-editor-icon-button" title={leaving ? t("fileEditor.reloading") : t("fileEditor.exit")} aria-label={t("fileEditor.exit")} disabled={busy} onClick={() => { if (dirty) setConfirmExit(true); else void exit(); }}>
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M0 0h24v24H0z" fill="none" />
            <path fill="currentColor" d="M6.5 3A3.5 3.5 0 0 0 3 6.5v11A3.5 3.5 0 0 0 6.5 21H15a1 1 0 1 0 0-2H6.5A1.5 1.5 0 0 1 5 17.5v-11A1.5 1.5 0 0 1 6.5 5H15a1 1 0 1 0 0-2zm11.207 4.293a1 1 0 1 0-1.414 1.414L18.586 11H9a1 1 0 1 0 0 2h9.586l-2.293 2.293a1 1 0 0 0 1.414 1.414l4-4a1 1 0 0 0 0-1.414z" />
          </svg>
        </button>
      </>, actionsTarget)}
      {saveSuccess && isVisible && createPortal(<span className="file-editor-save-success" role="status" aria-label={t("fileEditor.saved")} style={saveSuccess}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>
      </span>, document.body)}
      {session.loading && <div className="file-editor-loading" role="status">{t("fileEditor.loading")}</div>}
      {errorText && <div className="file-editor-error" role="alert">{errorText}</div>}
      {loaded && <CodeTextEditor store={store} editKey={editKey} session={session} isVisible={isVisible} />}
      <dialog ref={dialog} className="file-editor-dialog" aria-labelledby="file-editor-exit-title" aria-describedby="file-editor-exit-description" onCancel={(event) => { event.preventDefault(); if (!busy) setConfirmExit(false); }}>
        <h2 id="file-editor-exit-title">{t("fileEditor.confirmTitle")}</h2>
        <p id="file-editor-exit-description">{t("fileEditor.confirmDescription")}</p>
        <div className="file-editor-dialog-actions">
          <button type="button" autoFocus className="file-editor-button" disabled={busy} onClick={() => setConfirmExit(false)}>{t("fileEditor.continue")}</button>
          <button type="button" className="file-editor-button" disabled={busy} onClick={() => { void exit(); }}>{t("fileEditor.discard")}</button>
          <button type="button" className="file-editor-button primary" disabled={busy} onClick={() => { void save(true); }}>{session.saving ? t("fileEditor.saving") : t("fileEditor.saveExit")}</button>
        </div>
      </dialog>
    </section>
  );
}

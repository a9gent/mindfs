import React, { useLayoutEffect, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useI18n } from "../../i18n";
import type { FileEditSession, FileEditStore } from "../../services/fileEditing";
import { codeEditorAttributes, createCodeEditorState, editorContentAttributes, editorLanguage, editorReadOnly } from "./codeEditorState";
import { codeLanguageForPath } from "./codeEditorLanguage";

type Props = {
  store: FileEditStore;
  editKey: string;
  session: FileEditSession;
  isVisible: boolean;
};

export function CodeTextEditor({ store, editKey, session, isVisible }: Props) {
  const { t } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<EditorView | null>(null);
  const restoringScroll = useRef(true);
  const visibleRef = useRef(isVisible);
  if (isVisible && !visibleRef.current) restoringScroll.current = true;
  visibleRef.current = isVisible;
  const [languageFailed, setLanguageFailed] = useState(false);
  const label = t("fileEditor.content");
  const readOnly = session.leaving;

  useLayoutEffect(() => {
    if (!host.current) return;
    const current = store.get(editKey);
    if (!current) return;
    const memory = current.view;
    let disposed = false;
    const rememberScroll = (editor: EditorView) => {
      // Hidden workspace panes report zero scroll positions; keep their last visible snapshot.
      if (restoringScroll.current || !visibleRef.current || editor.scrollDOM.clientHeight === 0) return;
      memory.top = editor.scrollDOM.scrollTop;
      memory.left = editor.scrollDOM.scrollLeft;
      memory.scrollSnapshot = editor.scrollSnapshot();
    };
    const state = createCodeEditorState({
      text: current.text, label, readOnly: current.leaving,
      savedState: memory.editorState,
      start: memory.start, end: memory.end, direction: memory.direction,
    });
    const editor = new EditorView({
      state,
      parent: host.current,
      scrollTo: memory.scrollSnapshot,
      dispatchTransactions(transactions, view) {
        view.update(transactions);
        if (store.get(editKey)?.view !== memory) return;
        memory.editorState = view.state;
        const selection = view.state.selection.main;
        memory.start = selection.from;
        memory.end = selection.to;
        memory.direction = selection.anchor > selection.head ? "backward" : "forward";
        rememberScroll(view);
        if (transactions.some((transaction) => transaction.docChanged)) {
          // Do not feed this string back into CodeMirror: replacing its document would
          // interrupt IME composition and reset selection/history on each React render.
          store.patch(editKey, { text: view.state.doc.toString() });
        }
      },
    });
    editorRef.current = editor;
    memory.editorState = editor.state;
    const onScroll = () => rememberScroll(editor);
    editor.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
    setLanguageFailed(false);
    const language = codeLanguageForPath(current.path);
    if (language) {
      void language.load().then((support) => {
        if (!disposed) editor.dispatch({ effects: editorLanguage.reconfigure(support) });
      }).catch(() => {
        if (!disposed) setLanguageFailed(true);
      });
    }
    return () => {
      disposed = true;
      rememberScroll(editor);
      memory.editorState = editor.state;
      editor.scrollDOM.removeEventListener("scroll", onScroll);
      editor.destroy();
      editorRef.current = null;
    };
    // Only mounting a different editing session creates a view. Content changes,
    // save responses, translations and visibility must not recreate the editor.
  }, [store, editKey, session.view]);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.dispatch({ effects: [
      editorReadOnly.reconfigure(EditorState.readOnly.of(readOnly)),
      editorContentAttributes.reconfigure(codeEditorAttributes(label)),
    ] });
  }, [readOnly, label]);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor || !isVisible) return;
    restoringScroll.current = true;
    const snapshot = session.view.scrollSnapshot;
    editor.focus();
    if (snapshot) editor.dispatch({ effects: snapshot });
    editor.requestMeasure();
    // Initial layout and focusing can emit zero-position scroll events before
    // CodeMirror applies its snapshot. Do not replace that snapshot with those events.
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        restoringScroll.current = false;
        if (editorRef.current !== editor || editor.scrollDOM.clientHeight === 0) return;
        session.view.top = editor.scrollDOM.scrollTop;
        session.view.left = editor.scrollDOM.scrollLeft;
        session.view.scrollSnapshot = editor.scrollSnapshot();
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [isVisible, editKey, session.view]);

  return <>
    {languageFailed && <div className="file-editor-language-notice" role="status">{t("fileEditor.highlightFailed")}</div>}
    <div ref={host} className="file-code-editor" />
  </>;
}

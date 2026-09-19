import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import { drawSelection, dropCursor, EditorView, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

export const editorLanguage = new Compartment();
export const editorReadOnly = new Compartment();
export const editorContentAttributes = new Compartment();

const highlighting = HighlightStyle.define([
  { tag: tags.comment, color: "var(--file-code-comment)" },
  { tag: [tags.keyword, tags.modifier], color: "var(--file-code-keyword)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--file-code-string)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--file-code-number)" },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName], color: "var(--file-code-type)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "var(--file-code-function)" },
  { tag: [tags.propertyName, tags.attributeName], color: "var(--file-code-property)" },
  { tag: [tags.operator, tags.punctuation], color: "var(--text-secondary)" },
  { tag: tags.meta, color: "var(--file-code-keyword)" },
  { tag: tags.heading, color: "var(--file-code-keyword)", fontWeight: "600" },
  { tag: tags.link, color: "var(--file-code-function)", textDecoration: "underline" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.invalid, color: "var(--file-code-invalid)" },
]);

export function codeEditorAttributes(label: string) {
  return EditorView.contentAttributes.of({
    "aria-label": label,
    "aria-multiline": "true",
    spellcheck: "false",
    autocorrect: "off",
    autocapitalize: "off",
  });
}

export function createCodeEditorState(options: {
  text: string;
  label: string;
  readOnly: boolean;
  savedState?: EditorState;
  start?: number;
  end?: number;
  direction?: "forward" | "backward" | "none";
}): EditorState {
  const { text, label, readOnly, savedState } = options;
  if (savedState && savedState.doc.toString() === text) {
    // Reconfigure rather than recreate: undo/redo and all selections survive navigation.
    return savedState.update({ effects: [
      editorReadOnly.reconfigure(EditorState.readOnly.of(readOnly)),
      editorContentAttributes.reconfigure(codeEditorAttributes(label)),
    ] }).state;
  }
  const start = Math.max(0, Math.min(text.length, options.start || 0));
  const end = Math.max(0, Math.min(text.length, options.end ?? start));
  return EditorState.create({
    doc: text,
    selection: options.direction === "backward" ? EditorSelection.single(end, start) : EditorSelection.single(start, end),
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      EditorState.tabSize.of(4),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      bracketMatching(),
      indentOnInput(),
      syntaxHighlighting(highlighting),
      editorLanguage.of([]),
      editorReadOnly.of(EditorState.readOnly.of(readOnly)),
      editorContentAttributes.of(codeEditorAttributes(label)),
    ],
  });
}

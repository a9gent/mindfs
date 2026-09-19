import assert from "node:assert/strict";
import { EditorSelection, EditorState, Transaction } from "@codemirror/state";
import { undo, redo, undoDepth, redoDepth } from "@codemirror/commands";
import { language, syntaxTree } from "@codemirror/language";
import { createCodeEditorState, editorLanguage, editorReadOnly } from "../src/components/editor/codeEditorState.ts";
import { codeLanguageForPath } from "../src/components/editor/codeEditorLanguage.ts";

for (const [path, name] of [
  ["main.ts", "TypeScript"], ["app.TSX", "TSX"], ["index.jsx", "JSX"],
  ["C:\\project\\main.go", "Go"], ["script.py", "Python"], ["config.json", "JSON"],
  ["config.yaml", "YAML"], ["README.md", "Markdown"], ["main.rs", "Rust"],
  ["index.html", "HTML"], ["style.css", "CSS"], ["script.sh", "Shell"],
  [".zshrc", "Shell"], ["script.zsh", "Shell"], ["main.cpp", "C++"], ["Program.cs", "C#"],
]) assert.equal(codeLanguageForPath(path)?.name, name, path);
for (const path of ["notes.txt", "LICENSE", "file.unknown-format"]) assert.equal(codeLanguageForPath(path), null, path);

let state = createCodeEditorState({ text: "const initial = 1;\n", label: "File content", readOnly: false });
const target = { get state() { return state; }, dispatch(transaction) { state = transaction.state; } };
state = state.update({ changes: { from: 0, to: state.doc.length, insert: "const changed = 2;\n" }, annotations: Transaction.userEvent.of("input") }).state;
assert.equal(undoDepth(state), 1);
const beforeLanguage = state;
const support = await codeLanguageForPath("main.ts").load();
state = state.update({ effects: editorLanguage.reconfigure(support) }).state;
assert.ok(state.facet(language));
assert.match(syntaxTree(state).toString(), /VariableDeclaration/);
assert.equal(state.doc, beforeLanguage.doc, "loading a parser must not replace the document");
assert.equal(undoDepth(state), 1, "language loading must preserve undo history");
state = state.update({ selection: EditorSelection.create([EditorSelection.range(8, 2), EditorSelection.cursor(15)]) }).state;
const beforeUnmount = state;
state = createCodeEditorState({ text: state.doc.toString(), label: "文件内容", readOnly: false, savedState: state });
assert.equal(state.doc, beforeUnmount.doc);
assert.ok(state.selection.eq(beforeUnmount.selection), "all selections and directions survive remount");
assert.equal(undoDepth(state), 1);
assert.equal(undo(target), true);
assert.equal(state.doc.toString(), "const initial = 1;\n");
assert.equal(redoDepth(state), 1);
state = createCodeEditorState({ text: state.doc.toString(), label: "文件内容", readOnly: false, savedState: state });
assert.equal(redo(target), true, "redo also survives navigation");
assert.equal(state.doc.toString(), "const changed = 2;\n");
state = state.update({ effects: editorReadOnly.reconfigure(EditorState.readOnly.of(true)) }).state;
assert.equal(undo(target), false, "exit-in-progress cannot change content");
state = createCodeEditorState({ text: state.doc.toString(), label: "File content", readOnly: false, savedState: state });
assert.equal(undo(target), true);
assert.equal(state.doc.toString(), "const initial = 1;\n");

// A new edit session gets a fresh undo stack, even for the same path.
state = createCodeEditorState({ text: "reloaded", label: "File content", readOnly: false });
assert.equal(undoDepth(state), 0);
assert.equal(state.facet(language), null);
console.log("CodeMirror language and editing state tests passed");

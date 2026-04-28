import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createTextNode,
  $getRoot,
  $getSelection,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  EditorConfig,
  KEY_ENTER_COMMAND,
  LexicalEditor,
  NodeKey,
  SerializedTextNode,
  Spread,
  TextNode,
} from "lexical";

type TokenType = "file" | "skill";
type CandidateType = TokenType | "slash_command" | "prompt";
type ActiveTokenType = "file" | "slash" | "prompt";

type ActiveToken = {
  type: ActiveTokenType;
  query: string;
};

export type TokenEditorHandle = {
  focus: () => void;
  blur: () => void;
  getHeight: () => number;
  clear: () => void;
  insertCandidate: (type: CandidateType, value: string) => void;
};

type TokenEditorProps = {
  placeholder: string;
  disabled?: boolean;
  isDark?: boolean;
  rightInset?: number;
  bottomInset?: number;
  onChange: (payload: { serializedText: string; displayText: string; activeToken: ActiveToken | null }) => void;
  onFocusChange?: (focused: boolean) => void;
  onPointerDown?: () => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onPaste?: (event: React.ClipboardEvent<HTMLDivElement>) => void;
  onEnter?: (event: KeyboardEvent | null) => boolean;
  onCompositionStart?: () => void;
  onCompositionEnd?: () => void;
};

type SerializedTokenNode = Spread<
  {
    type: "token";
    tokenType: TokenType;
    tokenValue: string;
    label: string;
    version: 1;
  },
  SerializedTextNode
>;

class TokenNode extends TextNode {
  __tokenType: TokenType;
  __tokenValue: string;
  __label: string;

  static getType(): string {
    return "token";
  }

  static clone(node: TokenNode): TokenNode {
    return new TokenNode(node.__tokenType, node.__tokenValue, node.__label, node.__key);
  }

  static importJSON(serializedNode: SerializedTokenNode): TokenNode {
    return $createTokenNode(
      serializedNode.tokenType,
      serializedNode.tokenValue,
      serializedNode.label
    );
  }

  constructor(tokenType: TokenType, tokenValue: string, label: string, key?: NodeKey) {
    super(label, key);
    this.__tokenType = tokenType;
    this.__tokenValue = tokenValue;
    this.__label = label;
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    dom.contentEditable = "false";
    dom.style.display = "inline-flex";
    dom.style.alignItems = "center";
    dom.style.padding = "1px 6px";
    dom.style.margin = "0 1px";
    dom.style.borderRadius = "8px";
    dom.style.whiteSpace = "pre";
    if (this.__tokenType === "file") {
      dom.style.background = "var(--token-file-bg)";
      dom.style.color = "var(--token-file-text)";
    } else {
      dom.style.background = "var(--token-skill-bg)";
      dom.style.color = "var(--token-skill-text)";
    }
    return dom;
  }

  updateDOM(prevNode: TokenNode, dom: HTMLElement, config: EditorConfig): boolean {
    const updated = super.updateDOM(prevNode as unknown as this, dom, config);
    if (prevNode.__tokenType !== this.__tokenType) {
      if (this.__tokenType === "file") {
        dom.style.background = "var(--token-file-bg)";
        dom.style.color = "var(--token-file-text)";
      } else {
        dom.style.background = "var(--token-skill-bg)";
        dom.style.color = "var(--token-skill-text)";
      }
    }
    return updated;
  }

  exportJSON(): SerializedTokenNode {
    return {
      ...super.exportJSON(),
      type: "token",
      tokenType: this.__tokenType,
      tokenValue: this.__tokenValue,
      label: this.__label,
      version: 1,
    };
  }

  getTokenType(): TokenType {
    return this.__tokenType;
  }

  getTokenValue(): string {
    return this.__tokenValue;
  }

  getLabel(): string {
    return this.__label;
  }

  isTextEntity(): true {
    return true;
  }

  canInsertTextBefore(): boolean {
    return false;
  }

  canInsertTextAfter(): boolean {
    return false;
  }
}

function $createTokenNode(type: TokenType, value: string, label: string): TokenNode {
  return new TokenNode(type, value, label);
}

function $isTokenNode(node: unknown): node is TokenNode {
  return node instanceof TokenNode;
}

function createLabel(type: TokenType, value: string): string {
  if (type === "file") {
    const parts = value.replace(/\\/g, "/").split("/");
    return parts[parts.length - 1] || value;
  }
  return value;
}

function serializeEditor(): string {
  const parts: string[] = [];
  const visit = (node: any) => {
    if ($isTokenNode(node)) {
      parts.push(
        node.getTokenType() === "file"
          ? `[read file: ${node.getTokenValue()}]`
          : `[use skill: ${node.getTokenValue()}]`
      );
      return;
    }
    if ($isLineBreakNode(node)) {
      parts.push("\n");
      return;
    }
    if ($isTextNode(node)) {
      parts.push(node.getTextContent());
      return;
    }
    if (typeof node.getChildren === "function") {
      for (const child of node.getChildren()) {
        visit(child);
      }
    }
  };
  visit($getRoot());
  return parts.join("");
}

function getDisplayText(): string {
  return $getRoot().getTextContent();
}

function getActiveTokenFromSelection(): ActiveToken | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return null;
  }
  const anchorNode = selection.anchor.getNode();
  if (!$isTextNode(anchorNode) || $isTokenNode(anchorNode)) {
    return null;
  }
  const text = anchorNode.getTextContent();
  const offset = selection.anchor.offset;
  return parseActiveToken(text, offset);
}

function parseActiveToken(displayText: string, cursorPos: number): ActiveToken | null {
  const cursor = Math.max(0, Math.min(cursorPos, displayText.length));
  let start = cursor - 1;
  while (start >= 0) {
    const ch = displayText[start];
    if (ch === "@" || ch === "/" || ch === "#") {
      const prev = start > 0 ? displayText[start - 1] : "";
      const isBoundary =
        prev === "" ||
        /\s/.test(prev) ||
        prev === "(" ||
        prev === "[" ||
        prev === "{" ||
        prev === '"' ||
        prev === "'";
      if (!isBoundary) {
        return null;
      }
      let end = cursor;
      for (; end < displayText.length; end++) {
        const next = displayText[end];
        if (/\s/.test(next) || next === "[" || next === "]" || next === "\n") {
          break;
        }
      }
      return {
        type: ch === "@" ? "file" : ch === "/" ? "slash" : "prompt",
        query: displayText.slice(start + 1, end),
      };
    }
    if (/\s/.test(ch) || ch === "[" || ch === "]") {
      return null;
    }
    start--;
  }
  return null;
}

function expectedActiveTokenType(candidateType: CandidateType): ActiveTokenType {
  if (candidateType === "file") {
    return "file";
  }
  if (candidateType === "prompt") {
    return "prompt";
  }
  return "slash";
}

function triggerChar(tokenType: ActiveTokenType): "@" | "/" | "#" {
  if (tokenType === "file") {
    return "@";
  }
  if (tokenType === "prompt") {
    return "#";
  }
  return "/";
}

function EditorBridge({
  onChange,
  onReady,
  onEnter,
  onDeleteToken,
}: {
  onChange: TokenEditorProps["onChange"];
  onReady: (api: { editor: LexicalEditor; root: HTMLDivElement | null }) => void;
  onEnter?: (event: KeyboardEvent | null) => boolean;
  onDeleteToken: (forward: boolean) => boolean;
}) {
  const [editor] = useLexicalComposerContext();
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return editor.registerRootListener((rootElement) => {
      rootRef.current = rootElement as HTMLDivElement | null;
      onReady({ editor, root: rootRef.current });
    });
  }, [editor, onReady]);

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        onChange({
          serializedText: serializeEditor(),
          displayText: getDisplayText(),
          activeToken: getActiveTokenFromSelection(),
        });
      });
    });
  }, [editor, onChange]);

  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => onEnter?.(event) ?? false,
      COMMAND_PRIORITY_HIGH
    );
  }, [editor, onEnter]);

  useEffect(() => {
    return editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      () => onDeleteToken(false),
      COMMAND_PRIORITY_HIGH
    );
  }, [editor, onDeleteToken]);

  useEffect(() => {
    return editor.registerCommand(
      KEY_DELETE_COMMAND,
      () => onDeleteToken(true),
      COMMAND_PRIORITY_HIGH
    );
  }, [editor, onDeleteToken]);

  return null;
}

const TokenEditor = forwardRef<TokenEditorHandle, TokenEditorProps>(function TokenEditor(
  {
    placeholder,
    disabled = false,
    isDark = false,
    rightInset = 120,
    bottomInset = 12,
    onChange,
    onFocusChange,
    onPointerDown,
    onKeyDown,
    onPaste,
    onEnter,
    onCompositionStart,
    onCompositionEnd,
  },
  ref
) {
  const editorRef = useRef<LexicalEditor | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [isEmpty, setIsEmpty] = useState(true);
  const [isFocused, setIsFocused] = useState(false);
  const isSingleLine = bottomInset <= 12;

  const initialConfig = useMemo(
    () => ({
      namespace: "mindfs-token-editor",
      theme: {},
      onError(error: Error) {
        throw error;
      },
      nodes: [TokenNode],
    }),
    []
  );

  useImperativeHandle(ref, () => ({
    focus() {
      rootRef.current?.focus({ preventScroll: true });
    },
    blur() {
      rootRef.current?.blur();
    },
    getHeight() {
      return rootRef.current?.scrollHeight || 44;
    },
    clear() {
      editorRef.current?.update(() => {
        $getRoot().clear();
      });
    },
    insertCandidate(type: CandidateType, value: string) {
      const editor = editorRef.current;
      if (!editor) return;
      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          return;
        }
        const anchorNode = selection.anchor.getNode();
        if (!$isTextNode(anchorNode) || $isTokenNode(anchorNode)) {
          return;
        }
        const text = anchorNode.getTextContent();
        const offset = selection.anchor.offset;
        const token = parseActiveToken(text, offset);
        const expectedType = expectedActiveTokenType(type);
        if (!token || token.type !== expectedType) {
          return;
        }
        let start = offset - 1;
        while (start >= 0 && text[start] !== triggerChar(token.type)) {
          start--;
        }
        if (start < 0) {
          return;
        }
        let end = offset;
        while (end < text.length) {
          const ch = text[end];
          if (/\s/.test(ch) || ch === "[" || ch === "]" || ch === "\n") {
            break;
          }
          end++;
        }
        const prefix = text.slice(0, start);
        const suffix = text.slice(end);
        const replacementNodes = [];
        if (prefix) replacementNodes.push($createTextNode(prefix));
        if (type === "slash_command") {
          replacementNodes.push($createTextNode(`/${value}`));
        } else if (type === "prompt") {
          replacementNodes.push($createTextNode(value));
        } else {
          replacementNodes.push($createTokenNode(type, value, createLabel(type, value)));
        }
        const tailNode = $createTextNode(" ");
        replacementNodes.push(tailNode);
        if (suffix) replacementNodes.push($createTextNode(suffix));
        let current = replacementNodes[0];
        anchorNode.replace(current);
        for (let i = 1; i < replacementNodes.length; i++) {
          current.insertAfter(replacementNodes[i]);
          current = replacementNodes[i];
        }
        tailNode.select(1, 1);
      });
      rootRef.current?.focus({ preventScroll: true });
    },
  }));

  const handleChange = (payload: { serializedText: string; displayText: string; activeToken: ActiveToken | null }) => {
    setIsEmpty(payload.displayText.length === 0);
    onChange(payload);
  };

  const handleDeleteToken = (forward: boolean) => {
    const editor = editorRef.current;
    if (!editor) {
      return false;
    }
    let handled = false;
    editor.update(() => {
      const moveSelectionToTextEdge = (node: TextNode | null, atStart: boolean) => {
        if (!node) {
          $getRoot().selectEnd();
          return;
        }
        if (atStart) {
          node.select(0, 0);
          return;
        }
        const size = node.getTextContentSize();
        node.select(size, size);
      };

      const selection = $getSelection();
      if (!$isRangeSelection(selection)) {
        return;
      }
      if (!selection.isCollapsed()) {
        selection.removeText();
        handled = true;
        return;
      }
      const anchorNode = selection.anchor.getNode();
      const anchorOffset = selection.anchor.offset;
      if ($isTokenNode(anchorNode)) {
        const target = forward ? anchorNode.getNextSibling() : anchorNode.getPreviousSibling();
        anchorNode.remove();
        moveSelectionToTextEdge($isTextNode(target) ? target : null, forward);
        handled = true;
        return;
      }
      const textNode = $isTextNode(anchorNode) ? anchorNode : null;
      if (!textNode || $isTokenNode(textNode)) {
        return;
      }
      const sibling = forward
        ? anchorOffset === textNode.getTextContentSize()
          ? textNode.getNextSibling()
          : null
        : anchorOffset === 0
        ? textNode.getPreviousSibling()
        : null;
      if (!$isTokenNode(sibling)) {
        return;
      }
      const target = forward ? sibling.getNextSibling() : sibling.getPreviousSibling();
      sibling.remove();
      if ($isTextNode(target)) {
        moveSelectionToTextEdge(target, forward);
      } else {
        textNode.select(anchorOffset, anchorOffset);
      }
      handled = true;
    });
    return handled;
  };

  return (
    <div
      onMouseDown={onPointerDown}
      onTouchStart={onPointerDown}
      style={{
        position: "relative",
        width: "100%",
        minHeight: "44px",
        ["--token-file-bg" as any]: isDark ? "rgba(59,130,246,0.16)" : "rgba(59,130,246,0.10)",
        ["--token-file-text" as any]: isDark ? "#93c5fd" : "#1d4ed8",
        ["--token-skill-bg" as any]: isDark ? "rgba(139,92,246,0.18)" : "rgba(139,92,246,0.10)",
        ["--token-skill-text" as any]: isDark ? "#c4b5fd" : "#7c3aed",
      }}
    >
      <LexicalComposer initialConfig={initialConfig}>
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              className="token-editor-input"
              aria-placeholder={placeholder}
              placeholder={<span></span>}
              spellCheck={false}
              onFocus={() => {
                setIsFocused(true);
                onFocusChange?.(true);
              }}
              onBlur={() => {
                setIsFocused(false);
                onFocusChange?.(false);
              }}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              onCompositionStart={onCompositionStart}
              onCompositionEnd={onCompositionEnd}
              style={{
                width: "100%",
                minHeight: isSingleLine ? "44px" : "20px",
                height: isSingleLine ? "44px" : "auto",
                maxHeight: "240px",
                overflowY: "auto",
                padding: isSingleLine
                  ? `12px ${rightInset}px 12px 14px`
                  : `8px ${rightInset}px ${bottomInset}px 14px`,
                outline: "none",
                fontSize: "16px",
                lineHeight: "20px",
                boxSizing: "border-box",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                color: "var(--text-primary)",
                position: "relative",
                zIndex: 2,
                pointerEvents: disabled ? "none" : "auto",
              }}
            />
          }
          placeholder={
            isEmpty && !isFocused ? (
              <div
                style={{
                  position: "absolute",
                  left: "14px",
                  right: `${rightInset}px`,
                  top: "50%",
                  transform: "translateY(-50%)",
                  color: "var(--text-secondary)",
                  fontSize: "16px",
                  pointerEvents: "none",
                  zIndex: 1,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {placeholder}
              </div>
            ) : null
          }
          ErrorBoundary={({ children, onError: _onError }) => children}
        />
        <HistoryPlugin />
        <EditorBridge
          onChange={handleChange}
          onReady={({ editor, root }) => {
            editorRef.current = editor;
            rootRef.current = root;
          }}
          onEnter={onEnter}
          onDeleteToken={handleDeleteToken}
        />
      </LexicalComposer>
    </div>
  );
});

export default TokenEditor;

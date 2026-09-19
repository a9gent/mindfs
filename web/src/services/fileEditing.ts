import type { FilePayload } from "./file";

export const MAX_EDITABLE_FILE_BYTES = 1024 * 1024;
export type EditableFile = FilePayload & { revision: string };
export type EditorView = { start: number; end: number; direction: "forward" | "backward" | "none"; top: number; left: number };
export type FileEditSession = {
  rootId: string;
  path: string;
  text: string;
  savedText: string;
  source: string;
  file?: EditableFile;
  revision: string;
  loading: boolean;
  saving: boolean;
  leaving: boolean;
  error: string;
  view: EditorView;
};

export function fileEditKey(rootId: string, path: string): string {
  return JSON.stringify([rootId, path]);
}

export function editableText(source: string): string {
  return source.replace(/^\uFEFF/, "").replace(/\r\n|\r/g, "\n");
}

export function serializeEditedText(source: string, text: string): string {
  if (editableText(source) === text) return source;
  const newline = source.match(/\r\n|\r|\n/)?.[0] || "\n";
  return (source.startsWith("\uFEFF") ? "\uFEFF" : "") + text.replace(/\n/g, newline);
}

// Owned by App, never persisted. Viewer unmounts and navigation do not close sessions.
export class FileEditStore {
  private sessions = new Map<string, FileEditSession>();
  private listeners = new Set<() => void>();
  private io: {
    load: (rootId: string, path: string) => Promise<EditableFile>;
    save: (rootId: string, path: string, content: string, revision: string) => Promise<EditableFile>;
  };

  constructor(io: FileEditStore["io"]) { this.io = io; }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  get = (key: string): FileEditSession | undefined => this.sessions.get(key);
  has(rootId: string, path: string): boolean { return this.sessions.has(fileEditKey(rootId, path)); }
  private set(key: string, session: FileEditSession): void {
    this.sessions.set(key, session);
    this.listeners.forEach((listener) => listener());
  }
  patch(key: string, patch: Partial<FileEditSession>): void {
    const session = this.get(key);
    if (session) this.set(key, { ...session, ...patch });
  }
  close(key: string): void {
    this.sessions.delete(key);
    this.listeners.forEach((listener) => listener());
  }
  async open(rootId: string, path: string): Promise<void> {
    const key = fileEditKey(rootId, path);
    if (this.get(key)) return;
    const view: EditorView = { start: 0, end: 0, direction: "none", top: 0, left: 0 };
    this.set(key, { rootId, path, text: "", savedText: "", source: "", revision: "", loading: true, saving: false, leaving: false, error: "", view });
    try {
      const file = await this.io.load(rootId, path);
      if (this.get(key)?.view !== view) return;
      if (!file.revision || file.truncated || file.encoding !== "utf-8") throw new Error("file_not_editable");
      this.patch(key, { file, text: editableText(file.content), savedText: editableText(file.content), source: file.content, revision: file.revision, loading: false });
    } catch (error) {
      if (this.get(key)?.view === view) this.patch(key, { loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  async save(key: string): Promise<EditableFile | null> {
    const session = this.get(key);
    if (!session || session.loading || session.saving || session.leaving || !session.revision) return null;
    const content = serializeEditedText(session.source, session.text);
    if (new TextEncoder().encode(content).length > MAX_EDITABLE_FILE_BYTES) {
      this.patch(key, { error: "file_edit_too_large" });
      return null;
    }
    this.patch(key, { saving: true, error: "" });
    try {
      const file = await this.io.save(session.rootId, session.path, content, session.revision);
      if (this.get(key)?.view !== session.view) return null;
      this.patch(key, { file: { ...file, file_meta: file.file_meta ?? session.file?.file_meta }, savedText: session.text, source: file.content, revision: file.revision, saving: false });
      return file;
    } catch (error) {
      if (this.get(key)?.view === session.view) this.patch(key, { saving: false, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }
}

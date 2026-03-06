export type ClientContext = {
  current_root: string;
  current_path?: string;
  plugin_catalog?: string;
  selection?: {
    file_path: string;
    start: number;
    end: number;
    text: string;
  };
};

type ContextInput = {
  currentRoot: string;
  currentPath?: string | null;
  pluginCatalog?: string | null;
  selection?: {
    filePath: string;
    start: number;
    end: number;
    text: string;
  } | null;
};

export function buildClientContext(input: ContextInput): ClientContext {
  const ctx: ClientContext = {
    current_root: input.currentRoot,
  };
  if (input.currentPath) {
    ctx.current_path = input.currentPath;
  }
  if (input.pluginCatalog) {
    ctx.plugin_catalog = input.pluginCatalog;
  }
  if (input.selection) {
    ctx.selection = {
      file_path: input.selection.filePath,
      start: input.selection.start,
      end: input.selection.end,
      text: input.selection.text,
    };
  }
  return ctx;
}

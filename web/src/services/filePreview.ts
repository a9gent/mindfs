export const AUTO_FULL_MARKDOWN_BYTES = 2 * 1024 * 1024;
export const MAX_FULL_PREVIEW_BYTES = 128 * 1024 * 1024;

export function shouldAutoLoadMarkdown(file: {
  path: string;
  size: number;
  truncated: boolean;
  encoding: string;
}): boolean {
  return /\.(md|markdown)$/i.test(file.path)
    && file.encoding !== "binary"
    && file.truncated
    && file.size <= AUTO_FULL_MARKDOWN_BYTES;
}

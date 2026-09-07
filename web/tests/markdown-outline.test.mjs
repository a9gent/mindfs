import assert from "node:assert/strict";
import test from "node:test";
import { extractMarkdownOutline } from "../src/components/markdownOutline.ts";

test("extracts ATX and setext headings with levels and stable ids", () => {
  assert.deepEqual(extractMarkdownOutline(`# 开始\n\n## Install *now*\n\nDetails\n-------`), [
    { id: "markdown-heading-开始", level: 1, title: "开始", sourceLine: 1 },
    { id: "markdown-heading-install-now", level: 2, title: "Install now", sourceLine: 3 },
    { id: "markdown-heading-details", level: 2, title: "Details", sourceLine: 5 },
  ]);
});

test("deduplicates headings and ignores headings inside fenced code", () => {
  const content = `# Same\n\n~~~md\n# Hidden\n~~~\n\n# Same`;
  assert.deepEqual(extractMarkdownOutline(content).map(({ id, title }) => ({ id, title })), [
    { id: "markdown-heading-same", title: "Same" },
    { id: "markdown-heading-same-2", title: "Same" },
  ]);
});

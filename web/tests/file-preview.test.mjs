import assert from "node:assert/strict";
import { AUTO_FULL_MARKDOWN_BYTES, shouldAutoLoadMarkdown } from "../src/services/filePreview.ts";

const file = { path: "docs/long.md", size: AUTO_FULL_MARKDOWN_BYTES, truncated: true, encoding: "utf-8" };
assert.equal(shouldAutoLoadMarkdown(file), true);
assert.equal(shouldAutoLoadMarkdown({ ...file, path: "REPORT.MARKDOWN" }), true);
assert.equal(shouldAutoLoadMarkdown({ ...file, size: file.size + 1 }), false);
assert.equal(shouldAutoLoadMarkdown({ ...file, truncated: false }), false);
assert.equal(shouldAutoLoadMarkdown({ ...file, path: "data.txt" }), false);
assert.equal(shouldAutoLoadMarkdown({ ...file, encoding: "binary" }), false);

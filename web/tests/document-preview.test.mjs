import assert from "node:assert/strict";
import { getDocumentPreviewKind } from "../src/services/documentPreview.ts";

assert.equal(getDocumentPreviewKind(".PDF"), "pdf");
assert.equal(getDocumentPreviewKind(".docx"), "word");
assert.equal(getDocumentPreviewKind(".xlsx"), "excel");
assert.equal(getDocumentPreviewKind(".pptx"), "powerpoint");
assert.equal(getDocumentPreviewKind("", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "word");
assert.equal(getDocumentPreviewKind(".doc"), null);
assert.equal(getDocumentPreviewKind(".txt", "text/plain"), null);

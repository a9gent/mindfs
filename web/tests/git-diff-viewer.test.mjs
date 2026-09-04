import assert from "node:assert/strict";
import {
  buildDiffCodeRows,
  buildDiffLines,
  buildSideBySideRows,
  buildUnifiedRows,
  getInlineDiffSegments,
} from "../src/components/gitDiffModel.ts";

const insertedFieldDiff = [
  "@@ -1,5 +1,6 @@",
  " err := uc.SendMessage(msgCtx, usecase.SendMessageInput{",
  "-  Content:   job.User.Content,",
  "-  ClientCtx: job.ClientCtx,",
  "+  Content:       job.User.Content,",
  "+  UserTimestamp: job.User.Timestamp,",
  "+  ClientCtx:     job.ClientCtx,",
  " })",
].join("\n");

const rows = buildSideBySideRows(buildDiffLines(insertedFieldDiff));
const changedRows = rows.filter((row) => row.kind === "change");
const sideBySideContextRows = rows.filter((row) => row.kind === "ctx");

assert.equal(changedRows.length, 1);
assert.equal(changedRows[0].left, undefined);
assert.equal(changedRows[0].right?.text.trimStart().startsWith("UserTimestamp:"), true);
assert.equal(
  sideBySideContextRows.some((row) => row.right?.text.trimStart().startsWith("Content:")),
  true,
);
assert.equal(
  sideBySideContextRows.some((row) => row.right?.text.trimStart().startsWith("ClientCtx:")),
  true,
);

const unifiedRows = buildUnifiedRows(buildDiffLines(insertedFieldDiff));
const contentRows = unifiedRows.filter((row) => row.kind !== "hunk" && row.line.kind !== "ctx");

assert.deepEqual(
  contentRows.map((row) => row.line.text.trimStart().split(/\s+/)[0]),
  ["UserTimestamp:"],
);
assert.deepEqual(
  contentRows.map((row) => row.counterpart?.text.trimStart().split(/\s+/)[0] || ""),
  [""],
);

const agentReplyDiff = [
  "--- a/session.go",
  "+++ b/session.go",
  "-  Content:   job.User.Content,",
  "-  ClientCtx: job.ClientCtx,",
  "+  Content:       job.User.Content,",
  "+  UserTimestamp: job.User.Timestamp,",
  "+  ClientCtx:     job.ClientCtx,",
].join("\n");

const agentReplyRows = buildDiffCodeRows(agentReplyDiff);
const agentReplyChangedRows = agentReplyRows.filter((row) => row.kind === "add" || row.kind === "del");

assert.deepEqual(
  agentReplyChangedRows.map((row) => row.text.trimStart().split(/\s+/)[0]),
  ["UserTimestamp:"],
);

const markdownMarkerDiff = [
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1,4 +1,4 @@",
  "-- old list item",
  "+- new list item",
  "-+ old positive item",
  "++ new positive item",
  "--- old separator",
  "+-- new separator",
  "-++ old operator",
  "+++ new operator",
].join("\n");

const markdownMarkerLines = buildDiffLines(markdownMarkerDiff);

assert.deepEqual(
  markdownMarkerLines.filter((line) => line.kind !== "hunk").map(({ kind, text }) => ({ kind, text })),
  [
    { kind: "del", text: "- old list item" },
    { kind: "add", text: "- new list item" },
    { kind: "del", text: "+ old positive item" },
    { kind: "add", text: "+ new positive item" },
    { kind: "del", text: "-- old separator" },
    { kind: "add", text: "-- new separator" },
    { kind: "del", text: "++ old operator" },
    { kind: "add", text: "++ new operator" },
  ],
);

assert.deepEqual(
  buildDiffCodeRows(markdownMarkerDiff)
    .filter((row) => row.kind === "add" || row.kind === "del")
    .map(({ kind, text }) => ({ kind, text })),
  [
    { kind: "del", text: "- old list item" },
    { kind: "add", text: "- new list item" },
    { kind: "del", text: "+ old positive item" },
    { kind: "add", text: "+ new positive item" },
    { kind: "del", text: "-- old separator" },
    { kind: "add", text: "-- new separator" },
    { kind: "del", text: "++ old operator" },
    { kind: "add", text: "++ new operator" },
  ],
);

assert.deepEqual(
  buildDiffCodeRows(markdownMarkerDiff)
    .filter((row) => row.kind === "meta")
    .map((row) => row.text),
  [
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
  ],
);

const insertedArgument = getInlineDiffSegments(
  "streamHub.BroadcastSessionUserMessage(rootID, key, job.User.Content, job.ExcludeClientID)",
  "streamHub.BroadcastSessionUserMessageAt(rootID, key, job.User.Content, job.User.Timestamp, job.ExcludeClientID)",
);

assert.equal(
  insertedArgument.some((segment) => segment.kind === "add" && segment.text.includes("job.User.Timestamp")),
  true,
);
assert.equal(
  insertedArgument.some((segment) => segment.kind === "ctx" && segment.text.includes("job.User.Content")),
  true,
);

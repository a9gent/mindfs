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

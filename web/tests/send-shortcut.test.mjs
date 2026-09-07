import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const actionBar = readFileSync(new URL("../src/components/ActionBar.tsx", import.meta.url), "utf8");
const fileTree = readFileSync(new URL("../src/components/FileTree.tsx", import.meta.url), "utf8");
const shortcutService = readFileSync(new URL("../src/services/sendShortcut.ts", import.meta.url), "utf8");
const shortcutPopover = fileTree.slice(
  fileTree.indexOf("{sendShortcutOpen ? ("),
  fileTree.indexOf("{sessionNamingOpen ? ("),
);

assert.match(
  app,
  /useState<SendShortcut \| null>\(loadSendShortcut\)[\s\S]*?persistSendShortcut\(sendShortcut\)/,
  "the selected send shortcut should survive app reloads",
);
assert.match(
  fileTree,
  /fileTree\.sendShortcut[\s\S]*?formatSendShortcut\(sendShortcut\)[\s\S]*?sendShortcutOpen/,
  "the desktop sidebar menu should display and edit the saved shortcut",
);
assert.match(
  fileTree,
  /sendShortcutPopoverRef\.current\?\.contains\(event\.target as Node\)[\s\S]*?setSendShortcutOpen\(false\)/,
  "clicking outside the shortcut popover should dismiss it",
);
assert.doesNotMatch(shortcutPopover, /t\("common\.cancel"\)/, "the shortcut popover should not render a cancel button");
assert.ok(
  fileTree.indexOf('{t("fileTree.sendShortcut")}') > fileTree.indexOf("{showEnterKeySendOption ? ("),
  "the send shortcut item should be the final sidebar menu setting",
);
assert.match(
  shortcutService,
  /shortcut\.alt \|\| shortcut\.ctrl \|\| shortcut\.meta/,
  "send shortcuts should require a non-Shift modifier to avoid firing while typing",
);
assert.match(
  actionBar,
  /e\.key !== "Enter"[\s\S]*?matchesSendShortcut\(e\.nativeEvent, sendShortcut\)[\s\S]*?void handleSend\(\)/,
  "non-Enter shortcuts should send from the message editor",
);
assert.match(
  actionBar,
  /matchesSendShortcut\(event, sendShortcut\)[\s\S]*?void handleSend\(\)[\s\S]*?if \(event\?\.shiftKey\)/,
  "Enter-based shortcuts should be handled once and before the newline behavior",
);

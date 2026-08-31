import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const gitStatusPanel = readFileSync(
  new URL("../src/components/GitStatusPanel.tsx", import.meta.url),
  "utf8",
);

assert.match(
  gitStatusPanel,
  /if \(event\.key === "Enter"\) \{\s+if \(event\.nativeEvent\.isComposing\) \{\s+return;\s+\}\s+event\.preventDefault\(\);\s+void submitCommit\(\)/,
  "IME confirmation Enter must not submit a Git commit",
);

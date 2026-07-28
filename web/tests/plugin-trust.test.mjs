import assert from "node:assert/strict";
import {
  buildPluginTrustRecord,
  isPluginSnapshotTrusted,
} from "../src/plugins/trust.ts";

const baseSnapshot = {
  rootPath: "/tmp/mindfs-demo",
  plugins: [
    { path: ".mindfs/plugins/a.js", sha256: "aaa", size: 12 },
    { path: ".mindfs/plugins/b.js", sha256: "bbb", size: 34 },
  ],
};

const trusted = buildPluginTrustRecord(baseSnapshot, "2026-07-28T00:00:00.000Z");

assert.equal(
  isPluginSnapshotTrusted(baseSnapshot, trusted),
  true,
  "unchanged plugin snapshot should be trusted",
);

assert.equal(
  isPluginSnapshotTrusted(
    {
      ...baseSnapshot,
      plugins: [
        { path: ".mindfs/plugins/a.js", sha256: "changed", size: 12 },
        { path: ".mindfs/plugins/b.js", sha256: "bbb", size: 34 },
      ],
    },
    trusted,
  ),
  false,
  "changed plugin hash should invalidate trust",
);

assert.equal(
  isPluginSnapshotTrusted(
    {
      ...baseSnapshot,
      plugins: [
        { path: ".mindfs/plugins/a.js", sha256: "aaa", size: 12 },
        { path: ".mindfs/plugins/b.js", sha256: "bbb", size: 34 },
        { path: ".mindfs/plugins/c.js", sha256: "ccc", size: 56 },
      ],
    },
    trusted,
  ),
  false,
  "new plugin file should invalidate trust",
);

assert.equal(
  isPluginSnapshotTrusted(
    {
      ...baseSnapshot,
      plugins: [
        { path: ".mindfs/plugins/a.js", sha256: "aaa", size: 12 },
      ],
    },
    trusted,
  ),
  false,
  "removed plugin file should invalidate trust",
);

assert.equal(
  isPluginSnapshotTrusted(
    {
      rootPath: "/tmp/other-root",
      plugins: baseSnapshot.plugins,
    },
    trusted,
  ),
  false,
  "different root path should not reuse trust",
);

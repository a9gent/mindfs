import assert from "node:assert/strict";
import { normalizePathForRoot, shouldRedirectToRelayNodes } from "../src/services/fileNavigation.ts";

const root = "/Volumes/Extention/Users/csdc/project/mindfs";
const external = "/Volumes/Extention/Users/csdc/.codex/backups/astra-skills-20260912-212006/REPORT.md";
assert.equal(normalizePathForRoot(external, root), external);
assert.equal(normalizePathForRoot(external), external);
assert.equal(normalizePathForRoot(root + "/README.md", root), "README.md");
assert.equal(normalizePathForRoot("docs/README.md", root), "docs/README.md");
assert.equal(normalizePathForRoot(root + "-other/README.md", root), root + "-other/README.md");
assert.equal(normalizePathForRoot("C:\\other\\REPORT.md", "C:\\project"), "C:/other/REPORT.md");
assert.equal(normalizePathForRoot("C:\\project\\README.md", "C:\\project"), "README.md");
for (const status of [403, 404, 502, 503]) {
  assert.equal(await shouldRedirectToRelayNodes(status, "", async () => 200), false);
  assert.equal(await shouldRedirectToRelayNodes(status, "", async () => 503), false);
  assert.equal(await shouldRedirectToRelayNodes(status, "", async () => { throw new Error("offline"); }), false);
}
for (const status of [403, 404]) {
  for (const probeStatus of [403, 404]) {
    assert.equal(await shouldRedirectToRelayNodes(status, "", async () => probeStatus), true);
  }
}
for (const status of [502, 503]) {
  assert.equal(await shouldRedirectToRelayNodes(status, "", async () => { assert.fail("outage must not probe or redirect"); }), false);
}
for (const code of ["node_offline", "connector_unavailable"]) {
  assert.equal(await shouldRedirectToRelayNodes(503, code, async () => { assert.fail("outage must not probe or redirect"); }), false);
}
for (const code of ["node_not_found", "forbidden"]) {
  assert.equal(await shouldRedirectToRelayNodes(404, code, async () => { assert.fail("unnecessary probe"); }), true);
}
assert.equal(await shouldRedirectToRelayNodes(400, "", async () => { assert.fail("unnecessary probe"); }), false);

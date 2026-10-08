import assert from "node:assert/strict";
import { isNodePage, ownNodePageURL, validNodePageURL, rememberNodePage, returnNodePageURL, nodeDestinationURL } from "../src/services/nodePage.ts";

const data = new Map();
globalThis.localStorage = { getItem: (key) => data.get(key), setItem: (key, value) => data.set(key, value) };
const a = "https://a.example/nodes";
const b = "https://b.example/?root_id=demo#file";
assert.equal(returnNodePageURL(b), "https://b.example/nodes");
const target = nodeDestinationURL(b, a);
assert.equal(new URL(target).searchParams.get("root_id"), "demo");
assert.equal(new URL(target).hash, "#file");
assert.equal(new URL(target).searchParams.get("node_page"), a);
rememberNodePage(target);
assert.equal(returnNodePageURL(target), a);
assert.equal(returnNodePageURL(b), a); // Reload without parameter retains the originating list.
const relayA = "https://relay.example/n/a/nodes";
const relayB = "https://relay.example/n/b/";
rememberNodePage(nodeDestinationURL(relayB, relayA));
assert.equal(returnNodePageURL(relayB), relayA);
assert.equal(ownNodePageURL(relayB), "https://relay.example/n/b/nodes");
assert.equal(isNodePage(relayA), true);
assert.equal(isNodePage(relayB), false);
for (const bad of ["javascript:alert(1)", "https://user:pass@host/nodes", "https://host/random", "/nodes"]) {
  assert.equal(validNodePageURL(bad), "");
}
rememberNodePage("https://b.example/?node_page=javascript%3Aalert(1)");
assert.equal(returnNodePageURL(b), relayA);
data.clear();
assert.equal(returnNodePageURL(relayB), "https://relay.example/n/b/nodes");
globalThis.localStorage = { getItem() { throw Error("blocked"); }, setItem() { throw Error("blocked"); } };
rememberNodePage(target);
assert.equal(returnNodePageURL(target), a);
assert.equal(returnNodePageURL(b), "https://b.example/nodes");
console.log("node page navigation checks passed");

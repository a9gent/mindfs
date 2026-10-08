import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const sourcePath = path.resolve("src/services/e2ee.ts");
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

function setup(response) {
  const storage = new Map();
  let now = Date.now();
  let calls = 0;
  const sandbox = {
    exports: {},
    require(name) {
      assert.equal(name, "./base");
      return { appURL: (target) => `https://example.test${target}` };
    },
    window: {
      localStorage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
        removeItem: (key) => storage.delete(key),
      },
    },
    Date: class extends Date { static now() { return now; } },
    crypto: webcrypto,
    isSecureContext: true,
    TextEncoder,
    Uint8Array,
    ArrayBuffer,
    btoa,
    atob,
    fetch: async () => {
      calls++;
      return response.clone();
    },
  };
  vm.runInNewContext(compiled, sandbox, { filename: sourcePath });
  const { e2eeService: service, E2EERateLimitError: RateLimitError } = sandbox.exports;
  service.configure(true, "node-1");
  service.setClientId("client-1");
  service.setSecret("test-secret");
  return { service, RateLimitError, calls: () => calls, advance: (ms) => { now += ms; } };
}

for (const { name, headers, body, seconds } of [
  { name: "30-minute cooldown", headers: { "Retry-After": "1800" }, body: { retry_after: 1800 }, seconds: 1800 },
  { name: "Retry-After header", headers: { "Retry-After": "10" }, body: { retry_after: 5 }, seconds: 10 },
  { name: "JSON fallback for cross-origin clients", headers: {}, body: { retry_after: 5 }, seconds: 5 },
  { name: "proxy without retry details", headers: {}, body: {}, seconds: 30 },
]) {
  const ctx = setup(new Response(JSON.stringify({ error: "e2ee_rate_limited", ...body }), { status: 429, headers }));
  const isLimited = (wait) => (error) => error instanceof ctx.RateLimitError && error.retryAfterSeconds === wait;
  await assert.rejects(ctx.service.ensureSession(), isLimited(seconds), name);
  assert.equal(ctx.calls(), 1, name);
  assert.equal(ctx.service.getSecret(), "test-secret", "429 must not erase a correct saved secret");

  ctx.advance(1000);
  ctx.service.setSecret("corrected-secret");
  await assert.rejects(ctx.service.ensureSession(), isLimited(seconds - 1));
  assert.equal(ctx.calls(), 1, "repeated submissions must respect the cooldown locally");

  ctx.advance((seconds - 1) * 1000);
  await assert.rejects(ctx.service.ensureSession(), isLimited(seconds));
  assert.equal(ctx.calls(), 2, "retry is allowed when the cooldown expires");

  ctx.service.configure(true, "node-2");
  ctx.service.setSecret("another-secret");
  await assert.rejects(ctx.service.ensureSession(), isLimited(seconds));
  assert.equal(ctx.calls(), 3, "a different node must not inherit the previous node's cooldown");
}

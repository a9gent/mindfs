import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const compiled = ts.transpileModule(fs.readFileSync("src/services/bootstrap.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

class RateLimitError extends Error {
  constructor(seconds) {
    super("e2ee_rate_limited");
    this.retryAfterSeconds = seconds;
  }
}

function setup(outcomes, configured = false, { secretPresent = true } = {}) {
  let now = 0;
  let attempts = 0;
  let clearedSecrets = 0;
  let nextTimer = 0;
  const timers = new Map();
  const listeners = new Set();
  const e2ee = { configured, required: configured, nodeId: configured ? "node" : "", secretPresent, unlocked: false };
  const emit = () => listeners.forEach(listener => listener({ ...e2ee }));
  const status = () => new Response(JSON.stringify({ e2ee_required: true, e2ee_node_id: "node" }));
  const service = {
    snapshot: () => ({ ...e2ee }),
    subscribe(listener) { listeners.add(listener); listener({ ...e2ee }); },
    configure(required, nodeId) { Object.assign(e2ee, { configured: true, required, nodeId }); emit(); },
    setSecret(secret) { e2ee.secretPresent = !!secret; this.clearSession(); },
    isRequired: () => e2ee.required,
    hasSecret: () => e2ee.secretPresent,
    async ensureSession() {
      if (e2ee.unlocked) return;
      attempts++;
      const outcome = outcomes.shift();
      if (outcome instanceof Error) throw outcome;
      e2ee.unlocked = true;
      emit();
    },
    async protectedFetch() { await this.ensureSession(); return status(); },
    parseProtectedJSONResponse: response => response.json(),
    clearSession() { e2ee.unlocked = false; emit(); },
    clearSecret() { clearedSecrets++; e2ee.secretPresent = false; this.clearSession(); },
  };
  const sandbox = {
    exports: {}, Error,
    require: name => name === "./base" ? { appPath: p => p } : { e2eeService: service, E2EERateLimitError: RateLimitError },
    fetch: async () => status(),
    Date: class extends Date { static now() { return now; } },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
  };
  vm.runInNewContext(compiled, sandbox);
  return {
    bootstrap: sandbox.exports.bootstrapService,
    attempts: () => attempts,
    clearedSecrets: () => clearedSecrets,
    timers,
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > target) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
        await new Promise(setImmediate);
      }
      now = target;
    },
  };
}

// Both the initial handshake and a protected status refresh can receive 429.
for (const configured of [false, true]) {
  const ctx = setup([new RateLimitError(5), true], configured);
  const first = await ctx.bootstrap.start();
  assert.equal(first.phase, "pairing_cooldown");
  assert.equal(first.retryAfterSeconds, 5);
  assert.equal(first.e2ee.secretPresent, true);
  assert.equal(ctx.bootstrap.canUseProtectedAPI(), false);
  await ctx.advance(4000);
  assert.equal(ctx.bootstrap.snapshot().retryAfterSeconds, 1);
  await ctx.bootstrap.start();
  assert.equal(ctx.attempts(), 1, "repeated start must not bypass the cooldown");
  await ctx.advance(1000);
  assert.equal(ctx.attempts(), 2, "retry must use the saved secret without user input");
  assert.equal(ctx.bootstrap.snapshot().phase, "ready");
  assert.equal(ctx.bootstrap.snapshot().retryAfterSeconds, 0);
  assert.equal(ctx.clearedSecrets(), 0);
  assert.equal(ctx.timers.size, 0);
}

const repeated = setup([new RateLimitError(2), new RateLimitError(3), true]);
await repeated.bootstrap.start();
await repeated.advance(2000);
assert.equal(repeated.bootstrap.snapshot().phase, "pairing_cooldown");
assert.equal(repeated.bootstrap.snapshot().retryAfterSeconds, 3);
await repeated.advance(2000);
assert.equal(repeated.attempts(), 2);
await repeated.advance(1000);
assert.equal(repeated.bootstrap.snapshot().phase, "ready");
assert.equal(repeated.attempts(), 3);
assert.equal(repeated.timers.size, 0);

const invalid = setup([new RateLimitError(1), new Error("e2ee_proof_invalid")]);
await invalid.bootstrap.start();
await invalid.advance(1000);
assert.equal(invalid.bootstrap.snapshot().phase, "needs_pairing", "a rejected saved secret still requires user input");
assert.equal(invalid.bootstrap.snapshot().e2ee.secretPresent, false);
assert.equal(invalid.timers.size, 0);

// A code entered by the user needs the same cooldown lifecycle as a saved code.
const manual = setup([new RateLimitError(5), true], true, { secretPresent: false });
assert.equal((await manual.bootstrap.start()).phase, "needs_pairing");
const submitted = await manual.bootstrap.submitPairingSecret("valid-secret");
assert.equal(submitted.phase, "pairing_cooldown");
assert.equal(submitted.retryAfterSeconds, 5);
assert.equal(submitted.e2ee.secretPresent, true);
assert.equal(manual.bootstrap.canUseProtectedAPI(), false);
await manual.advance(4000);
assert.equal(manual.bootstrap.snapshot().retryAfterSeconds, 1);
await manual.bootstrap.start();
assert.equal(manual.attempts(), 1, "manual pairing must wait for the cooldown");
await manual.advance(1000);
assert.equal(manual.attempts(), 2, "manual pairing must retry without another submission");
assert.equal(manual.bootstrap.snapshot().phase, "ready");
assert.equal(manual.bootstrap.snapshot().retryAfterSeconds, 0);
assert.equal(manual.clearedSecrets(), 0);
assert.equal(manual.timers.size, 0);

const manualRepeated = setup([new RateLimitError(2), new RateLimitError(3), true], true, { secretPresent: false });
await manualRepeated.bootstrap.start();
await manualRepeated.bootstrap.submitPairingSecret("valid-secret");
await manualRepeated.advance(2000);
assert.equal(manualRepeated.bootstrap.snapshot().phase, "pairing_cooldown");
assert.equal(manualRepeated.bootstrap.snapshot().retryAfterSeconds, 3);
await manualRepeated.advance(2000);
assert.equal(manualRepeated.attempts(), 2);
await manualRepeated.advance(1000);
assert.equal(manualRepeated.bootstrap.snapshot().phase, "ready");
assert.equal(manualRepeated.attempts(), 3);
assert.equal(manualRepeated.timers.size, 0);

const manualInvalid = setup([new RateLimitError(1), new Error("e2ee_proof_invalid")], true, { secretPresent: false });
await manualInvalid.bootstrap.start();
await manualInvalid.bootstrap.submitPairingSecret("wrong-secret");
assert.equal(manualInvalid.clearedSecrets(), 0, "rate limiting must preserve the entered code");
await manualInvalid.advance(1000);
assert.equal(manualInvalid.bootstrap.snapshot().phase, "needs_pairing");
assert.equal(manualInvalid.bootstrap.snapshot().e2ee.secretPresent, false);
assert.equal(manualInvalid.clearedSecrets(), 1, "an invalid proof must clear the code after retry");
assert.equal(manualInvalid.timers.size, 0);

const manualRejected = setup([new Error("e2ee_proof_invalid")], true, { secretPresent: false });
await manualRejected.bootstrap.start();
await assert.rejects(manualRejected.bootstrap.submitPairingSecret("wrong-secret"), /e2ee_proof_invalid/);
assert.equal(manualRejected.bootstrap.snapshot().phase, "needs_pairing");
assert.equal(manualRejected.bootstrap.snapshot().e2ee.secretPresent, false);
assert.equal(manualRejected.timers.size, 0);

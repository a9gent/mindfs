import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { chromium } from "playwright-core";
import { createServer } from "vite";

let server, browser;
before(async () => {
  const paths = process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
    : ["/opt/google/chrome/chrome", "/usr/bin/chromium", "/usr/bin/google-chrome"];
  let executablePath;
  for (const path of paths) { try { await access(path); executablePath = path; break; } catch {} }
  assert.ok(executablePath, "Requires an installed Chromium browser");
  server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)), server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  browser = await chromium.launch({ executablePath, headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

for (const terminal of ["session.done", "session.error", "session.truncated"]) {
  test(`first visit to background session stays idle after ${terminal}`, async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${server.resolvedUrls.local[0]}tests/background-session-stream.html`);
      await page.waitForFunction(() => window.backgroundStreamCheck);
      await page.evaluate(terminal => {
        const check = window.backgroundStreamCheck;
        check.emit("session.stream", "background");
        check.emit("session.stream", "background", "thought_chunk");
        check.emit(terminal, "background");
        check.select("background");
      }, terminal);
      await page.waitForFunction(() => document.querySelector("output")?.dataset.session === "background");
      assert.equal(await page.locator("output").getAttribute("data-streaming"), "false");
      assert.equal(await page.evaluate(() => window.backgroundStreamCheck.active("background")), false);

      // A subsequent turn must still stream normally in this same session.
      await page.evaluate(() => window.backgroundStreamCheck.emit("session.stream", "background"));
      await page.waitForFunction(() => document.querySelector("output")?.dataset.streaming === "true");
      await page.evaluate(() => window.backgroundStreamCheck.emit("session.done", "background"));
      await page.waitForFunction(() => document.querySelector("output")?.dataset.streaming === "false");
    } finally { await page.close(); }
  });
}

test("first visit to a still-running background session replays its stream", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${server.resolvedUrls.local[0]}tests/background-session-stream.html`);
    await page.waitForFunction(() => window.backgroundStreamCheck);
    await page.evaluate(() => {
      const check = window.backgroundStreamCheck;
      check.emit("session.stream", "background");
      check.emit("session.done", "foreground");
      check.select("background");
    });
    await page.waitForFunction(() => document.querySelector("output")?.dataset.streaming === "true");
  } finally { await page.close(); }
});

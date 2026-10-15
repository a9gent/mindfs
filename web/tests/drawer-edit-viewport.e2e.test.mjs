import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { chromium } from "playwright-core";
import { createServer } from "vite";

let server;
let browser;
before(async () => {
  const candidates = process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
    : ["/opt/google/chrome/chrome", "/usr/bin/chromium", "/usr/bin/google-chrome"];
  let executablePath;
  for (const candidate of candidates) {
    try { await access(candidate); executablePath = candidate; break; } catch {}
  }
  assert.ok(executablePath, "This E2E requires an installed Chromium browser");
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  browser = await chromium.launch({ executablePath, headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function geometry(page) {
  return page.evaluate(() => {
    const editor = document.querySelector("textarea");
    const panel = editor.closest('[style*="z-index: 1001"]');
    const rect = (node) => {
      const { top, bottom, height } = node.getBoundingClientRect();
      return { top, bottom, height };
    };
    return {
      editor: rect(editor), panel: rect(panel), main: rect(document.querySelector("main")),
      focused: document.activeElement === editor, content: editor.value,
    };
  });
}

test("IME overlay keeps the drawer and last user inline editor inside the resized main view", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
  try {
    await page.goto(`${server.resolvedUrls.local[0]}tests/session-edit.html?drawer`);
    await page.getByRole("button", { name: "编辑消息", exact: true }).click();
    await page.locator("textarea").fill("Edited message draft");
    await page.waitForTimeout(400);
    const initial = await geometry(page);
    assert.ok(Math.abs(initial.panel.height - 844 * 0.75) < 1, JSON.stringify(initial));
    // Native overlay IME updates the app's available-height variable without
    // shrinking innerHeight/vh. Replay that contract, including dismissal.
    for (const height of [400, 500, 844]) {
      await page.evaluate((height) => {
        document.documentElement.style.setProperty("--mindfs-viewport-height", `${height}px`);
        window.dispatchEvent(new Event("mindfs:safe-area-updated"));
      }, height);
      await page.waitForTimeout(400); // BottomSheet's 300ms layout transition.
      const state = await geometry(page);
      assert.ok(state.panel.top >= state.main.top, JSON.stringify(state));
      assert.ok(Math.abs(state.panel.height - Math.min(844 * 0.75, state.main.height)) < 1, JSON.stringify(state));
      assert.ok(state.editor.top >= state.panel.top && state.editor.bottom <= state.panel.bottom, JSON.stringify(state));
      assert.equal(state.focused, true);
      assert.equal(state.content, "Edited message draft");
    }
    // Also cover a WebView that resizes the layout viewport for its IME.
    await page.setViewportSize({ width: 390, height: 400 });
    await page.evaluate(() => {
      document.documentElement.style.removeProperty("--mindfs-viewport-height");
      window.dispatchEvent(new Event("mindfs:safe-area-updated"));
    });
    await page.waitForTimeout(400);
    const state = await geometry(page);
    assert.ok(state.panel.top >= 0 && state.editor.top >= state.panel.top && state.editor.bottom <= state.panel.bottom, JSON.stringify(state));
  } finally { await page.close(); }
});

test("desktop drawer retains its 75vh height", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 844 } });
  try {
    await page.goto(`${server.resolvedUrls.local[0]}tests/session-edit.html?drawer`);
    await page.getByRole("button", { name: "编辑消息", exact: true }).click();
    await page.waitForTimeout(400);
    const state = await geometry(page);
    assert.ok(Math.abs(state.panel.height - 844 * 0.75) < 1, JSON.stringify(state));
  } finally { await page.close(); }
});

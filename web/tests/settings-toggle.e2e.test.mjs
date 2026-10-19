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
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    : [
        "/opt/google/chrome/chrome",
        "/usr/bin/chromium",
        "/usr/bin/google-chrome",
        process.env.HOME + "/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome",
        process.env.HOME + "/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
      ];
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

const base = () => server.resolvedUrls.local[0];

async function mount(page, query = "") {
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto(`${base()}tests/settings-toggle.html${query}`);
  await page.waitForTimeout(700);
}

async function openMenu(page) {
  await page.getByRole("button", { name: "打开文件树菜单" }).click();
  await page.waitForTimeout(150);
}

async function tapReal(page, locator) {
  // Simulate a finger tap: touch down/up at the element center, then the browser
  // synthesizes a click. Playwright's .click() on hasTouch pages already does this.
  await locator.click({ delay: 40 });
  await page.waitForTimeout(300);
}

test("A. enter-to-send flips in plain sidebar", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await mount(page);
    await openMenu(page);
    await tapReal(page, page.getByRole("button", { name: "回车键发送", exact: false }));
    const s = await page.evaluate(() => window.settingsToggle.state());
    assert.equal(s.enterSends, true, JSON.stringify(s));
  } finally { await page.close(); }
});

test("B. enter-to-send flips inside mobile drawer shell", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await mount(page, "?shell");
    await openMenu(page);
    await tapReal(page, page.getByRole("button", { name: "回车键发送", exact: false }));
    const s = await page.evaluate(() => window.settingsToggle.state());
    assert.equal(s.enterSends, true, JSON.stringify(s));
  } finally { await page.close(); }
});

test("C. blue-ring enable checkbox flips (plain)", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await mount(page);
    await openMenu(page);
    await tapReal(page, page.getByRole("button", { name: /蓝环手势/ }));
    const box = page.locator('label:has-text("启用手势快捷操作") input[type=checkbox]');
    await box.click();
    await page.waitForTimeout(300);
    const s = await page.evaluate(() => window.settingsToggle.state());
    assert.equal(s.ringEnabled, true, JSON.stringify(s));
  } finally { await page.close(); }
});

test("D. blue-ring enable checkbox flips (drawer shell)", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await mount(page, "?shell");
    await openMenu(page);
    await tapReal(page, page.getByRole("button", { name: /蓝环手势/ }));
    const box = page.locator('label:has-text("启用手势快捷操作") input[type=checkbox]');
    await box.click();
    await page.waitForTimeout(300);
    const s = await page.evaluate(() => window.settingsToggle.state());
    assert.equal(s.ringEnabled, true, JSON.stringify(s));
  } finally { await page.close(); }
});

import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { chromium } from "playwright-core";
import { createServer } from "vite";

let server, browser;
before(async () => {
  const candidates = [
    "/opt/google/chrome/chrome", "/usr/bin/chromium", "/usr/bin/google-chrome",
    process.env.HOME + "/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome",
    process.env.HOME + "/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
  ];
  let executablePath;
  for (const c of candidates) { try { await access(c); executablePath = c; break; } catch {} }
  assert.ok(executablePath);
  server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)), server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  browser = await chromium.launch({ executablePath, headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function driftTap(cdp, box, dx, dy) {
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: cy }] });
  for (let i = 1; i <= 4; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: cx + (dx * i) / 4, y: cy + (dy * i) / 4 }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function scan(page, query, label) {
  const cdp = await page.context().newCDPSession(page);
  await page.goto(`${server.resolvedUrls.local[0]}tests/settings-toggle.html${query}`);
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "打开文件树菜单" }).click();
  await page.waitForTimeout(200);
  const btn = page.getByRole("button", { name: /回车键发送/ }).first();
  const results = [];
  for (let dx = 0; dx <= 30; dx += 1) {
    const box = await btn.boundingBox();
    const before = (await page.evaluate(() => window.settingsToggle.state())).menuLog.length;
    await driftTap(cdp, box, dx, 1);
    await page.waitForTimeout(220);
    const after = (await page.evaluate(() => window.settingsToggle.state())).menuLog.length;
    results.push(after > before ? "ok" : "EATEN");
  }
  const firstEaten = results.indexOf("EATEN");
  console.log(`[${label}] dx=0..30: ${results.join(" ")}`);
  console.log(`[${label}] first eaten at dx=${firstEaten === -1 ? "none" : firstEaten}`);
  return results;
}

test("fixture: locate swallow boundary (plain vs drawer shell)", async () => {
  const p1 = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await scan(p1, "", "plain");
  await p1.close();
  const p2 = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await scan(p2, "?shell", "drawer");
  await p2.close();
});

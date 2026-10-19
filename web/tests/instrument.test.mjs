import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "playwright-core";

const APP_URL = process.env.MIND_APP_URL || "http://127.0.0.1:7331/";

async function findChrome() {
  const candidates = [
    "/opt/google/chrome/chrome", "/usr/bin/chromium", "/usr/bin/google-chrome",
    process.env.HOME + "/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome",
    process.env.HOME + "/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
  ];
  for (const c of candidates) { try { await access(c); return c; } catch {} }
  return null;
}

test("INSTRUMENT: do clicks reach the enter toggle on drifting taps?", async () => {
  const executablePath = await findChrome();
  const browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const cdp = await page.context().newCDPSession(page);
  try {
    await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    await page.getByRole("button", { name: "打开文件侧栏" }).tap();
    await page.waitForTimeout(700);
    await page.getByRole("button", { name: "打开文件树菜单" }).tap();
    await page.waitForTimeout(350);

    // Instrument the enter toggle: count native events that reach it.
    await page.evaluate(() => {
      window.__probe = { pointerdown: 0, touchstart: 0, click: 0, clickPrevented: 0 };
      const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("回车键发送"));
      window.__btn = btn;
      btn.addEventListener("pointerdown", () => window.__probe.pointerdown++, true);
      btn.addEventListener("touchstart", () => window.__probe.touchstart++, true);
      btn.addEventListener("click", (e) => { window.__probe.click++; if (e.defaultPrevented) window.__probe.clickPrevented++; }, true);
    });

    for (const dx of [0, 8, 12, 16]) {
      await page.evaluate(() => { window.__probe = { pointerdown: 0, touchstart: 0, click: 0, clickPrevented: 0 }; localStorage.setItem("mindfs-mobile-enter-key-sends", "0"); });
      await page.waitForTimeout(200);
      const box = await page.evaluate(() => { const r = window.__btn.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: cy }] });
      for (let i = 1; i <= 4; i++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: cx + (dx * i) / 4, y: cy + 1 }] });
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(450);
      const probe = await page.evaluate(() => window.__probe);
      const ls = await page.evaluate(() => localStorage.getItem("mindfs-mobile-enter-key-sends"));
      console.log(`dx=${String(dx).padStart(2)} events=${JSON.stringify(probe)} ls=${ls}`);
    }
  } finally { await browser.close(); }
});

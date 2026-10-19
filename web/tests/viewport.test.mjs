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

test("VIEWPORT: are the toggles reachable on short phones?", async () => {
  const executablePath = await findChrome();
  const browser = await chromium.launch({ executablePath, headless: true });
  const sizes = [
    { w: 390, h: 844, name: "iPhone 12/13" },
    { w: 375, h: 667, name: "iPhone SE" },
    { w: 360, h: 640, name: "Android small" },
    { w: 412, h: 915, name: "Pixel 7" },
    { w: 320, h: 568, name: "iPhone 5" },
  ];
  try {
    for (const { w, h, name } of sizes) {
      const page = await browser.newPage({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true });
      await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(3000);
      await page.evaluate(() => { localStorage.setItem("mindfs-mobile-enter-key-sends", "0"); localStorage.setItem("mindfs-float-ball-gestures", JSON.stringify({ enabled: false, actions: {} })); });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(3000);
      await page.getByRole("button", { name: "打开文件侧栏" }).tap();
      await page.waitForTimeout(700);
      await page.getByRole("button", { name: "打开文件树菜单" }).tap();
      await page.waitForTimeout(400);

      const enter = page.getByRole("button", { name: /回车键发送/ }).first();
      const ring = page.getByRole("button", { name: /蓝环手势/ }).first();
      const info = await page.evaluate(() => {
        const aside = document.querySelector('aside[data-drawer-touch="left"]');
        const asideRect = aside?.getBoundingClientRect();
        const find = (t) => [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes(t));
        const eb = find("回车键发送"), rb = find("输入框蓝环手势");
        const r = (el) => { if (!el) return null; const x = el.getBoundingClientRect(); return { top: Math.round(x.top), bottom: Math.round(x.bottom), h: Math.round(x.height) }; };
        return {
          viewportH: window.innerHeight,
          aside: asideRect ? { top: Math.round(asideRect.top), bottom: Math.round(asideRect.bottom), h: Math.round(asideRect.height) } : null,
          asideOverflow: aside ? getComputedStyle(aside).overflow : null,
          enter: r(eb), ring: r(rb),
          enterInViewport: eb ? (eb.getBoundingClientRect().bottom <= window.innerHeight && eb.getBoundingClientRect().top >= 0) : null,
          ringInViewport: rb ? (rb.getBoundingClientRect().bottom <= window.innerHeight && rb.getBoundingClientRect().top >= 0) : null,
        };
      });
      // Try tapping enter toggle
      let flipped = "n/a";
      try {
        await enter.tap({ timeout: 3000 });
        await page.waitForTimeout(400);
        flipped = await page.evaluate(() => localStorage.getItem("mindfs-mobile-enter-key-sends"));
      } catch (e) { flipped = "TAP-FAILED: " + String(e.message).slice(0, 40); }
      console.log(`[${name} ${w}x${h}]`, JSON.stringify(info), "-> enter flipped:", flipped);
      await page.close();
    }
  } finally { await browser.close(); }
});

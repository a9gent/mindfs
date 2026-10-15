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

const state = (page) => page.evaluate(() => ({
  enter: localStorage.getItem("mindfs-mobile-enter-key-sends"),
  ring: JSON.parse(localStorage.getItem("mindfs-float-ball-gestures") || "{}").enabled,
  drawerOpen: !!document.querySelector('aside[data-drawer-touch]') && getComputedStyle(document.querySelector('aside[data-drawer-touch]')).visibility === "visible",
}));

async function driftTap(cdp, page, box, dx, dy) {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: cy }] });
  for (let i = 1; i <= 4; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: cx + (dx * i) / 4, y: cy + (dy * i) / 4 }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(500);
}

async function setup(page) {
  await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.evaluate(() => { localStorage.removeItem("mindfs-mobile-enter-key-sends"); localStorage.setItem("mindfs-float-ball-gestures", JSON.stringify({ enabled: false, actions: {} })); });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: "打开文件侧栏" }).tap();
  await page.waitForTimeout(700);
  await page.getByRole("button", { name: "打开文件树菜单" }).tap();
  await page.waitForTimeout(350);
}

test("DRIFT MATRIX on real app", async () => {
  const executablePath = await findChrome();
  const browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const cdp = await page.context().newCDPSession(page);
  try {
    console.log("--- enter-key toggle, horizontal drift ---");
    for (const dx of [-24, -16, -12, 13, 14, 15, 16, 20]) {
      await setup(page);
      const box = await page.getByRole("button", { name: /回车键发送/ }).first().boundingBox();
      const before = await state(page);
      await driftTap(cdp, page, box, dx, 1);
      const after = await state(page);
      console.log(`dx=${String(dx).padStart(4)} enter ${before.enter}=>${after.enter} drawerOpen ${before.drawerOpen}->${after.drawerOpen} ${before.enter !== after.enter ? "CHANGED" : "SWALLOWED"}`);
    }

    console.log("--- blue-ring checkbox, horizontal drift ---");
    for (const dx of [0, 16, 24, -16]) {
      await setup(page);
      await page.getByRole("button", { name: /蓝环手势/ }).first().tap();
      await page.waitForTimeout(400);
      const box = await page.locator('label:has-text("启用手势快捷操作") input[type=checkbox]').first().boundingBox();
      const before = await state(page);
      await driftTap(cdp, page, box, dx, 1);
      const after = await state(page);
      console.log(`dx=${String(dx).padStart(4)} ring ${before.ring}=>${after.ring} drawerOpen ${before.drawerOpen}->${after.drawerOpen} ${before.ring !== after.ring ? "CHANGED" : "SWALLOWED"}`);
    }
  } finally { await browser.close(); }
});

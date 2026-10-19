import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "playwright-core";

const APP_URL = process.env.MIND_APP_URL || "http://127.0.0.1:7331/";
const OUT = "/tmp/mindfs-shots";

async function findChrome() {
  const candidates = [
    "/opt/google/chrome/chrome", "/usr/bin/chromium", "/usr/bin/google-chrome",
    process.env.HOME + "/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome",
    process.env.HOME + "/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
  ];
  for (const c of candidates) { try { await access(c); return c; } catch {} }
  return null;
}

const snap = (page) => page.evaluate(() => {
  const box = document.querySelector('label:has(input[type=checkbox]) input[type=checkbox]');
  const boxLabel = box ? (box.closest("label")?.textContent || "").trim().slice(0, 30) : null;
  const enterBtn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("回车键发送"));
  return {
    lsEnter: localStorage.getItem("mindfs-mobile-enter-key-sends"),
    lsRing: JSON.parse(localStorage.getItem("mindfs-float-ball-gestures") || "{}").enabled,
    domCheckboxChecked: box ? box.checked : null,
    domCheckboxLabel: boxLabel,
    domEnterBtnText: enterBtn ? (enterBtn.textContent || "").trim().slice(0, 30) : null,
    domEnterBtnHasCheck: enterBtn ? /✓/.test(enterBtn.textContent || "") : null,
  };
});

test("FORENSIC: real app tap sequence with screenshots", async () => {
  const executablePath = await findChrome();
  const browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  try {
    await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3500);
    console.log("0 initial:", JSON.stringify(await snap(page)));

    // Path the user described: floating ball -> gesture settings
    const ball = page.locator('button[aria-haspopup="dialog"]');
    console.log("ball count:", await ball.count());
    if (await ball.count()) {
      await ball.first().tap();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT}/1-ball-open.png` });
      console.log("1 ball tapped");
      // look for a gesture-settings entry in the opened panel
      const labels = await page.locator("button").evaluateAll((els) => els.map((e) => (e.textContent || "").trim()).filter(Boolean).slice(0, 40));
      console.log("panel buttons:", JSON.stringify(labels));
    }

    await page.getByRole("button", { name: "打开文件侧栏" }).tap();
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT}/2-sidebar.png` });
    await page.getByRole("button", { name: "打开文件树菜单" }).tap();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/3-menu.png` });
    console.log("3 menu open:", JSON.stringify(await snap(page)));

    const toggle = page.getByRole("button", { name: /回车键发送/ });
    await toggle.first().tap();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/4-after-enter-tap.png` });
    console.log("4 after enter tap:", JSON.stringify(await snap(page)));

    const ring = page.getByRole("button", { name: /蓝环手势/ });
    await ring.first().tap();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/5-ring-popover.png` });
    console.log("5 ring popover:", JSON.stringify(await snap(page)));

    const box = page.locator('label:has-text("启用手势快捷操作") input[type=checkbox]');
    await box.first().tap();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/6-after-ring-tap.png` });
    console.log("6 after ring tap:", JSON.stringify(await snap(page)));
  } finally { await browser.close(); }
});

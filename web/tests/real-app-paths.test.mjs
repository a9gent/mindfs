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

const snap = (page) => page.evaluate(() => {
  const box = document.querySelector('label:has(input[type=checkbox]) input[type=checkbox]');
  const enterBtn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("回车键发送"));
  return {
    lsEnter: localStorage.getItem("mindfs-mobile-enter-key-sends"),
    lsRing: JSON.parse(localStorage.getItem("mindfs-float-ball-gestures") || "{}").enabled,
    cbChecked: box ? box.checked : null,
    enterText: enterBtn ? (enterBtn.textContent || "").trim() : null,
  };
});

test("PATH: floating ball -> gesture settings", async () => {
  const executablePath = await findChrome();
  const browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  try {
    await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    await page.evaluate(() => { localStorage.setItem("mindfs-float-ball-gestures", JSON.stringify({ enabled: false, actions: {} })); localStorage.setItem("mindfs-mobile-enter-key-sends", "0"); });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    console.log("initial:", JSON.stringify(await snap(page)));

    // Open the floating ball panel
    const ball = page.locator('button[aria-haspopup="dialog"]').first();
    await ball.tap();
    await page.waitForTimeout(500);
    console.log("ball panel open");

    // The gesture-settings entry lives inside the panel; find it by its action label
    const entry = page.getByText("打开悬浮球手势设置");
    console.log("settings entry count:", await entry.count());
    if (await entry.count()) {
      await entry.first().tap();
      await page.waitForTimeout(800);
      console.log("after tapping settings entry:", JSON.stringify(await snap(page)));
      const box = page.locator('label:has-text("启用手势快捷操作") input[type=checkbox]');
      console.log("checkbox count:", await box.count(), "visible:", await box.first().isVisible().catch(() => "err"));
      if (await box.count()) {
        await box.first().tap();
        await page.waitForTimeout(600);
        console.log("after checkbox tap:", JSON.stringify(await snap(page)));
      }
    } else {
      const labels = await page.locator("button, [role=menuitem]").evaluateAll((els) => els.map((e) => (e.textContent || "").trim()).filter(Boolean));
      console.log("panel items:", JSON.stringify(labels.slice(0, 40)));
    }
  } finally { await browser.close(); }
});

test("REPEAT: toggle enter + ring five times each", async () => {
  const executablePath = await findChrome();
  const browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  try {
    await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    await page.evaluate(() => { localStorage.setItem("mindfs-float-ball-gestures", JSON.stringify({ enabled: false, actions: {} })); localStorage.setItem("mindfs-mobile-enter-key-sends", "0"); });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    await page.getByRole("button", { name: "打开文件侧栏" }).tap();
    await page.waitForTimeout(700);
    await page.getByRole("button", { name: "打开文件树菜单" }).tap();
    await page.waitForTimeout(350);

    for (let i = 0; i < 5; i++) {
      await page.getByRole("button", { name: /回车键发送/ }).first().tap();
      await page.waitForTimeout(350);
      const s = await snap(page);
      console.log(`enter tap#${i + 1}: ls=${s.lsEnter} text=${JSON.stringify(s.enterText)}`);
    }

    await page.getByRole("button", { name: /蓝环手势/ }).first().tap();
    await page.waitForTimeout(400);
    for (let i = 0; i < 5; i++) {
      await page.locator('label:has-text("启用手势快捷操作") input[type=checkbox]').first().tap();
      await page.waitForTimeout(350);
      const s = await snap(page);
      console.log(`ring tap#${i + 1}: ls=${s.lsRing} cb=${s.cbChecked}`);
    }
  } finally { await browser.close(); }
});

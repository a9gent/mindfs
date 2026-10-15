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

test("RACE: repeated 10px-drift taps on enter toggle inside drawer", async () => {
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

    await page.evaluate(() => {
      window.__log = [];
      const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("回车键发送"));
      window.__btn = btn;
      const t0 = performance.now();
      btn.addEventListener("touchstart", () => window.__log.push(["ts", performance.now() - t0]), true);
      btn.addEventListener("click", (e) => window.__log.push(["click", performance.now() - t0, e.defaultPrevented]), true);
    });

    for (const dx of [10, 12]) {
      let flips = 0;
      const N = 12;
      for (let i = 0; i < N; i++) {
        await page.evaluate(() => { localStorage.setItem("mindfs-mobile-enter-key-sends", "0"); window.__log = []; });
        await page.waitForTimeout(150);
        const box = await page.evaluate(() => { const r = window.__btn.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
        const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: cy }] });
        for (let k = 1; k <= 4; k++) {
          await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: cx + (dx * k) / 4, y: cy + 1 }] });
        }
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await page.waitForTimeout(500);
        const ls = await page.evaluate(() => localStorage.getItem("mindfs-mobile-enter-key-sends"));
        if (ls === "1") flips++;
      }
      console.log(`dx=${dx}: flipped ${flips}/${N}`);
    }

    // Show the event timeline for a single drifting tap
    await page.evaluate(() => { localStorage.setItem("mindfs-mobile-enter-key-sends", "0"); window.__log = []; });
    await page.waitForTimeout(150);
    const box = await page.evaluate(() => { const r = window.__btn.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: cy }] });
    for (let k = 1; k <= 4; k++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: cx + (10 * k) / 4, y: cy + 1 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(600);
    console.log("timeline:", JSON.stringify(await page.evaluate(() => window.__log)));
    console.log("final ls:", await page.evaluate(() => localStorage.getItem("mindfs-mobile-enter-key-sends")));
  } finally { await browser.close(); }
});

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

async function rawTap(cdp, x, y) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await new Promise((r) => setTimeout(r, 450));
}

test("HIT-TEST: raw taps (no auto-scroll) on short vs tall phones", async () => {
  const executablePath = await findChrome();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    for (const [w, h, tag] of [[390, 844, "tall-844"], [375, 667, "short-667"], [360, 640, "short-640"]]) {
      const page = await browser.newPage({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true });
      const cdp = await page.context().newCDPSession(page);
      await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(3000);
      await page.evaluate(() => { localStorage.setItem("mindfs-mobile-enter-key-sends", "0"); });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(3000);
      await rawTap(cdp, w - 100, 30); // roughly the "open file sidebar" button? do it by role instead
      await page.close();

      const page2 = await browser.newPage({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true });
      const cdp2 = await page2.context().newCDPSession(page2);
      await page2.goto(APP_URL, { waitUntil: "domcontentloaded" });
      await page2.waitForTimeout(3000);
      await page2.getByRole("button", { name: "打开文件侧栏" }).tap();
      await page2.waitForTimeout(700);
      await page2.getByRole("button", { name: "打开文件树菜单" }).tap();
      await page2.waitForTimeout(400);

      const geo = await page2.evaluate(() => {
        const find = (t) => [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes(t));
        const el = find("回车键发送");
        if (!el) return { found: false };
        const r = el.getBoundingClientRect();
        const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
        const hit = document.elementFromPoint(cx, cy);
        return {
          found: true,
          rect: { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) },
          viewportH: window.innerHeight,
          center: { x: Math.round(cx), y: Math.round(cy) },
          hitTag: hit ? hit.tagName : null,
          hitText: hit ? (hit.textContent || "").trim().slice(0, 20) : null,
          hitIsButtonOrChild: hit ? (hit === el || el.contains(hit)) : false,
        };
      });
      let flipped = "n/a";
      if (geo.found && geo.hitIsButtonOrChild) {
        await rawTap(cdp2, geo.center.x, geo.center.y);
        flipped = await page2.evaluate(() => localStorage.getItem("mindfs-mobile-enter-key-sends"));
      } else if (geo.found) {
        flipped = "HIT-BLOCKED by " + geo.hitTag + " " + JSON.stringify(geo.hitText);
      }
      console.log(`[${tag}] ${JSON.stringify(geo)} -> flipped=${flipped}`);
      await page2.close();
    }
  } finally { await browser.close(); }
});

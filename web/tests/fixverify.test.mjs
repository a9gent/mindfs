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

async function run(page, cdp, w, h, injectFix) {
  await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.evaluate(() => localStorage.setItem("mindfs-mobile-enter-key-sends", "0"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: "打开文件侧栏" }).tap();
  await page.waitForTimeout(700);
  await page.getByRole("button", { name: "打开文件树菜单" }).tap();
  await page.waitForTimeout(400);

  if (injectFix) {
    await page.evaluate(() => {
      const menuBtn = document.querySelector('[data-onboarding="sidebar-menu"]');
      const pop = menuBtn?.parentElement?.querySelector('div[style*="absolute"]');
      if (pop) { pop.style.maxHeight = "calc(100dvh - 46px)"; pop.style.overflowY = "auto"; }
    });
    await page.waitForTimeout(200);
  }

  // Geometry + reachability of the enter toggle
  const geo = await page.evaluate(() => {
    const find = (t) => [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes(t));
    const el = find("回车键发送");
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    return { found: true, top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight, belowFold: r.top >= window.innerHeight };
  });

  // Scroll the popover to the bottom, then hit-test
  const hit = await page.evaluate(() => {
    const menuBtn = document.querySelector('[data-onboarding="sidebar-menu"]');
    const pop = menuBtn?.parentElement?.querySelector('div[style*="absolute"]');
    if (pop) pop.scrollTop = pop.scrollHeight;
    const find = (t) => [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes(t));
    const el = find("回车键发送");
    if (!el) return { ok: false };
    const r = el.getBoundingClientRect();
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    if (cy < 0 || cy >= window.innerHeight) return { ok: false, reason: "still below fold after scroll", cy: Math.round(cy) };
    const t = document.elementFromPoint(cx, cy);
    return { ok: true, x: Math.round(cx), y: Math.round(cy), hitIsBtn: t === el || el.contains(t), hitTag: t?.tagName };
  });

  let flipped = "n/a";
  if (hit.ok && hit.hitIsBtn) {
    await rawTap(cdp, hit.x, hit.y);
    flipped = await page.evaluate(() => localStorage.getItem("mindfs-mobile-enter-key-sends"));
  } else {
    flipped = "UNREACHABLE " + JSON.stringify(hit);
  }
  return { geo, hit, flipped };
}

test("FIX VERIFY: inject maxHeight, then tap on short phone", async () => {
  const executablePath = await findChrome();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    for (const inject of [false, true]) {
      const page = await browser.newPage({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
      const cdp = await page.context().newCDPSession(page);
      const res = await run(page, cdp, 375, 667, inject);
      console.log(`injectFix=${inject}:`, JSON.stringify(res));
      await page.close();
    }
  } finally { await browser.close(); }
});

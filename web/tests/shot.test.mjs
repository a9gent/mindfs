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

test("SHOT: menu geometry at two heights", async () => {
  const executablePath = await findChrome();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    for (const [w, h, tag] of [[390, 844, "tall"], [375, 667, "short"]]) {
      const page = await browser.newPage({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true });
      await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(3000);
      await page.getByRole("button", { name: "打开文件侧栏" }).tap();
      await page.waitForTimeout(700);
      await page.getByRole("button", { name: "打开文件树菜单" }).tap();
      await page.waitForTimeout(400);
      const geo = await page.evaluate(() => {
        const menuBtn = document.querySelector('[data-onboarding="sidebar-menu"]');
        const menu = menuBtn?.parentElement?.querySelector('div[style*="absolute"]');
        const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), h: Math.round(b.height) }; };
        const find = (t) => [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes(t));
        return {
          viewport: { w: window.innerWidth, h: window.innerHeight },
          menuBtn: r(menuBtn),
          menuBox: r(menu),
          enter: r(find("回车键发送")),
          ring: r(find("输入框蓝环手势")),
        };
      });
      console.log(`[${tag} ${w}x${h}]`, JSON.stringify(geo));
      await page.screenshot({ path: `${OUT}/menu-${tag}.png`, fullPage: false });
      // Scroll the drawer content to the very bottom and re-measure
      await page.evaluate(() => {
        const aside = document.querySelector('aside[data-drawer-touch="left"]');
        const scrollers = aside ? [...aside.querySelectorAll("*")].filter((el) => el.scrollHeight > el.clientHeight + 2) : [];
        scrollers.forEach((el) => { el.scrollTop = el.scrollHeight; });
      });
      await page.waitForTimeout(400);
      const after = await page.evaluate(() => {
        const find = (t) => [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes(t));
        const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom) }; };
        return { enter: r(find("回车键发送")), ring: r(find("输入框蓝环手势")) };
      });
      console.log(`[${tag}] after scrolling drawer:`, JSON.stringify(after));
      await page.screenshot({ path: `${OUT}/menu-${tag}-scrolled.png` });
      await page.close();
    }
  } finally { await browser.close(); }
});

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

test("DIAG: popover geometry + scrollability after cap", async () => {
  const executablePath = await findChrome();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    for (const [w, h, tag] of [[390, 844, "tall-844"], [375, 667, "short-667"], [360, 640, "short-640"]]) {
      const page = await browser.newPage({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true });
      await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2500);
      const loaded = await page.evaluate(() => [...document.querySelectorAll("script[src]")].map((s) => s.getAttribute("src")).join(","));
      await page.getByRole("button", { name: "打开文件侧栏" }).tap();
      await page.waitForTimeout(700);
      await page.getByRole("button", { name: "打开文件树菜单" }).tap();
      await page.waitForTimeout(400);
      const info = await page.evaluate(() => {
        const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("回车键发送"));
        if (!btn) return { found: false };
        const r = btn.getBoundingClientRect();
        // walk up to the popover: nearest ancestor whose computed overflowY is auto/scroll
        let pop = null;
        for (let el = btn.parentElement; el; el = el.parentElement) {
          const cs = getComputedStyle(el);
          if (cs.overflowY === "auto" || cs.overflowY === "scroll") { pop = el; break; }
        }
        const pr = pop ? pop.getBoundingClientRect() : null;
        const pcs = pop ? getComputedStyle(pop) : null;
        return {
          found: true,
          item: { top: Math.round(r.top), bottom: Math.round(r.bottom) },
          viewportH: window.innerHeight,
          popFound: !!pop,
          popRect: pr ? { top: Math.round(pr.top), bottom: Math.round(pr.bottom), h: Math.round(pr.height) } : null,
          popMaxHeight: pcs ? pcs.maxHeight : null,
          popOverflowY: pcs ? pcs.overflowY : null,
          popScrollable: pop ? pop.scrollHeight > pop.clientHeight : false,
          popScrollHeight: pop ? pop.scrollHeight : null,
          popClientHeight: pop ? pop.clientHeight : null,
        };
      });
      console.log(`[${tag}] scripts=${loaded}`);
      console.log(`[${tag}] ${JSON.stringify(info)}`);
      await page.close();
    }
  } finally { await browser.close(); }
});

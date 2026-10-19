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

test("DIAG: project-add popover + nested volume dropdown", async () => {
  const executablePath = await findChrome();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    for (const [w, h, tag] of [[375, 667, "short-667"], [360, 568, "short-568"]]) {
      const page = await browser.newPage({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true });
      await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2500);
      await page.getByRole("button", { name: "打开文件侧栏" }).tap();
      await page.waitForTimeout(700);
      await page.getByRole("button", { name: "打开文件树菜单" }).tap();
      await page.waitForTimeout(400);

      // "新建项目" opens the project-add flow.
      const addBtn = page.getByRole("button", { name: /新建项目|添加项目/ }).first();
      if (!(await addBtn.count())) { console.log(`[${tag}] project-add trigger not found`); await page.close(); continue; }
      await addBtn.tap();
      await page.waitForTimeout(600);

      const before = await page.evaluate(() => {
        const pops = [...document.querySelectorAll("div")].filter((d) => {
          const cs = getComputedStyle(d);
          return cs.position === "absolute" && cs.overflowY === "auto" && d.querySelectorAll("button").length >= 2;
        });
        let best = null;
        for (const d of pops) { const r = d.getBoundingClientRect(); if (r.width < 200 || r.height < 60) continue; if (!best || r.height < best.r.height) best = { d, r }; }
        if (!best) return { found: false };
        return {
          found: true,
          popRect: { top: Math.round(best.r.top), bottom: Math.round(best.r.bottom), h: Math.round(best.r.height) },
          scrollable: best.d.scrollHeight > best.d.clientHeight,
          scrollHeight: best.d.scrollHeight,
          clientHeight: best.d.clientHeight,
          viewportH: window.innerHeight,
        };
      });
      console.log(`[${tag}] popover=${JSON.stringify(before)}`);

      const volBtn = page.getByRole("button", { name: "选择卷" }).first();
      if (await volBtn.count()) {
        await volBtn.tap();
        await page.waitForTimeout(400);
        const vol = await page.evaluate(() => {
          const btns = [...document.querySelectorAll("button")];
          // volume entries are the short ones inside a small absolute menu
          const menus = [...document.querySelectorAll("div")].filter((d) => {
            const cs = getComputedStyle(d);
            const r = d.getBoundingClientRect();
            return cs.position === "absolute" && r.width > 60 && r.width < 200 && r.height > 20 && d.querySelectorAll("button").length >= 1;
          });
          if (!menus.length) return { open: false };
          const m = menus[0];
          const mr = m.getBoundingClientRect();
          const first = m.querySelector("button");
          const fr = first.getBoundingClientRect();
          const hit = document.elementFromPoint(fr.x + fr.width / 2, fr.y + fr.height / 2);
          return {
            open: true,
            menuRect: { top: Math.round(mr.top), bottom: Math.round(mr.bottom) },
            firstInViewport: fr.top >= 0 && fr.bottom <= window.innerHeight,
            firstHittable: hit ? (hit === first || first.contains(hit)) : false,
          };
        });
        console.log(`[${tag}] volumeMenu=${JSON.stringify(vol)}`);
      } else {
        console.log(`[${tag}] volume trigger not found`);
      }
      await page.close();
    }
  } finally { await browser.close(); }
});

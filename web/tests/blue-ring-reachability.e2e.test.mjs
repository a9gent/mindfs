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

// Same clipping class, second surface: the blue-ring settings popover holds the
// "启用手势快捷操作" checkbox plus a long gesture list. On short phones the
// checkbox used to sit below the fold and be unreachable.
test("REGRESSION: blue-ring enable checkbox reachable on short phones", async () => {
  const executablePath = await findChrome();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    for (const [w, h, tag] of [[375, 667, "short-667"], [320, 568, "short-568"]]) {
      const page = await browser.newPage({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true });
      await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2500);
      await page.evaluate(() => localStorage.removeItem("mindfs-float-ball-gestures"));
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2500);

      await page.getByRole("button", { name: "打开文件侧栏" }).tap();
      await page.waitForTimeout(700);
      await page.getByRole("button", { name: "打开文件树菜单" }).tap();
      await page.waitForTimeout(400);
      await page.getByRole("button", { name: /输入框蓝环手势/ }).tap();
      await page.waitForTimeout(400);

      const geo = await page.evaluate(() => {
        const label = [...document.querySelectorAll("label")].find((l) => (l.textContent || "").includes("启用手势快捷操作"));
        const box = label?.querySelector('input[type="checkbox"]');
        if (!box) return { found: false };
        let pop = null;
        for (let el = box.parentElement; el; el = el.parentElement) {
          const cs = getComputedStyle(el);
          if (cs.overflowY === "auto" || cs.overflowY === "scroll") { pop = el; break; }
        }
        if (pop) pop.scrollTop = 0;
        const r = box.getBoundingClientRect();
        const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
        const hit = document.elementFromPoint(cx, cy);
        return {
          found: true,
          viewportH: window.innerHeight,
          rect: { top: Math.round(r.top), bottom: Math.round(r.bottom) },
          hitIsTarget: hit ? (hit === box || box.contains(hit)) : false,
          popScrollable: pop ? pop.scrollHeight > pop.clientHeight : false,
        };
      });
      assert.equal(geo.found, true, `[${tag}] blue-ring checkbox missing`);
      assert.equal(geo.hitIsTarget, true, `[${tag}] checkbox not hittable: ${JSON.stringify(geo)}`);

      await page.locator('input[type="checkbox"]').first().click({ force: true });
      await page.waitForTimeout(400);
      const stored = await page.evaluate(() => localStorage.getItem("mindfs-float-ball-gestures"));
      assert.ok(stored && JSON.parse(stored).enabled === true, `[${tag}] enable did not persist: ${stored}`);
      console.log(`[${tag}] ${JSON.stringify(geo)} -> stored=${stored}`);
      await page.close();
    }
  } finally { await browser.close(); }
});

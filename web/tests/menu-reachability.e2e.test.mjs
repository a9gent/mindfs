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
  await new Promise((r) => setTimeout(r, 500));
}

// Regression: on short phones the file-tree menu popover used to run past the
// viewport bottom and get clipped by the drawer's overflow:hidden, leaving the
// lower entries (blue-ring gestures, enter-to-send) unreachable — a raw tap at
// the element centre hit nothing. The popover must now cap to the viewport,
// scroll internally, and let those entries be tapped.
test("REGRESSION: lower menu entries reachable on short phones", async () => {
  const executablePath = await findChrome();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    for (const [w, h, tag] of [[375, 667, "short-667"], [360, 640, "short-640"], [320, 568, "short-568"], [390, 844, "tall-844"]]) {
      const page = await browser.newPage({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true });
      const cdp = await page.context().newCDPSession(page);
      await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2500);
      await page.evaluate(() => localStorage.setItem("mindfs-mobile-enter-key-sends", "0"));
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2500);

      await page.getByRole("button", { name: "打开文件侧栏" }).tap();
      await page.waitForTimeout(700);
      await page.getByRole("button", { name: "打开文件树菜单" }).tap();
      await page.waitForTimeout(400);

      // Scroll the popover to its bottom, then hit-test the target entry.
      const geo = await page.evaluate(() => {
        const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("回车键发送"));
        if (!btn) return { found: false };
        let pop = null;
        for (let el = btn.parentElement; el; el = el.parentElement) {
          const cs = getComputedStyle(el);
          if (cs.overflowY === "auto" || cs.overflowY === "scroll") { pop = el; break; }
        }
        if (pop) pop.scrollTop = pop.scrollHeight;
        const r = btn.getBoundingClientRect();
        const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
        const hit = document.elementFromPoint(cx, cy);
        return {
          found: true,
          rect: { top: Math.round(r.top), bottom: Math.round(r.bottom) },
          viewportH: window.innerHeight,
          center: { x: Math.round(cx), y: Math.round(cy) },
          inViewport: r.top >= 0 && r.bottom <= window.innerHeight,
          hitIsTarget: hit ? (hit === btn || btn.contains(hit)) : false,
          hitTag: hit ? hit.tagName : null,
        };
      });

      assert.equal(geo.found, true, `[${tag}] 回车键发送 entry missing`);
      assert.equal(geo.inViewport, true, `[${tag}] entry outside viewport after scroll: ${JSON.stringify(geo)}`);
      assert.equal(geo.hitIsTarget, true, `[${tag}] entry not hittable: ${JSON.stringify(geo)}`);

      await rawTap(cdp, geo.center.x, geo.center.y);
      const flipped = await page.evaluate(() => localStorage.getItem("mindfs-mobile-enter-key-sends"));
      assert.equal(flipped, "1", `[${tag}] raw tap did not toggle enter-to-send`);
      console.log(`[${tag}] ${JSON.stringify(geo)} -> flipped=${flipped}`);
      await page.close();
    }
  } finally { await browser.close(); }
});

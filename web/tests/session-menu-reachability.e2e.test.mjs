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

async function measureOpenMenu(page) {
  return page.evaluate(() => {
    const candidates = [...document.querySelectorAll("div")].filter((d) => {
      const cs = getComputedStyle(d);
      return cs.position === "absolute" && cs.overflowY === "auto" && d.querySelectorAll("button").length >= 4;
    });
    let best = null;
    for (const d of candidates) {
      const r = d.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (!best || r.height < best.r.height) best = { d, r };
    }
    if (!best) return { found: false };
    const buttons = [...best.d.querySelectorAll("button")];
    const last = buttons[buttons.length - 1];
    const lr = last.getBoundingClientRect();
    const cy = lr.y + lr.height / 2;
    const cx = lr.x + lr.width / 2;
    const hit = cy >= 0 && cy < window.innerHeight ? document.elementFromPoint(cx, cy) : null;
    return {
      found: true,
      viewportH: window.innerHeight,
      popTop: Math.round(best.r.top),
      popBottom: Math.round(best.r.bottom),
      itemCount: buttons.length,
      lastText: (last.textContent || "").trim().slice(0, 12),
      lastTop: Math.round(lr.top),
      lastBottom: Math.round(lr.bottom),
      lastInViewport: lr.top >= 0 && lr.bottom <= window.innerHeight,
      lastHittable: hit ? (hit === last || last.contains(hit)) : false,
    };
  });
}

// The per-session context menu is anchored to a list row. A row low in the
// drawer used to open the menu past the viewport bottom, clipped by the
// drawer's overflow:hidden — the trailing entries ("删除" etc.) were untappable.
// It must now flip above the anchor (or cap) so every entry stays reachable.
test("REGRESSION: session-row menu entries reachable on short phones", async () => {
  const executablePath = await findChrome();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    for (const [w, h, tag] of [[375, 667, "short-667"], [360, 640, "short-640"]]) {
      const page = await browser.newPage({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true });
      await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2500);
      await page.getByRole("button", { name: "打开会话侧栏" }).tap();
      await page.waitForTimeout(800);

      const triggers = await page.getByRole("button", { name: "会话菜单" }).all();
      assert.ok(triggers.length >= 2, `[${tag}] expected session rows, got ${triggers.length}`);

      // Topmost row: plenty of room below, menu should stay below the anchor.
      await triggers[0].tap();
      await page.waitForTimeout(400);
      const topMenu = await measureOpenMenu(page);
      assert.equal(topMenu.found, true, `[${tag}] top-row menu not found`);
      assert.equal(topMenu.lastHittable, true, `[${tag}] top-row last entry unreachable: ${JSON.stringify(topMenu)}`);
      assert.ok(topMenu.popTop > 0, `[${tag}] top-row menu flipped above viewport: ${JSON.stringify(topMenu)}`);
      console.log(`[${tag}] top-row ${JSON.stringify(topMenu)}`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);

      // Bottom-most row: the regression case — menu must flip above the anchor.
      await triggers[triggers.length - 1].tap();
      await page.waitForTimeout(400);
      const lowMenu = await measureOpenMenu(page);
      assert.equal(lowMenu.found, true, `[${tag}] low-row menu not found`);
      assert.equal(lowMenu.lastInViewport, true, `[${tag}] low-row last entry below fold: ${JSON.stringify(lowMenu)}`);
      assert.equal(lowMenu.lastHittable, true, `[${tag}] low-row last entry unreachable: ${JSON.stringify(lowMenu)}`);
      console.log(`[${tag}] low-row ${JSON.stringify(lowMenu)}`);
      await page.close();
    }
  } finally { await browser.close(); }
});

import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { chromium } from "playwright-core";
import { createServer } from "vite";

let server, browser;
before(async () => {
  const candidates = [
    "/opt/google/chrome/chrome", "/usr/bin/chromium", "/usr/bin/google-chrome",
    process.env.HOME + "/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome",
    process.env.HOME + "/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
  ];
  let executablePath;
  for (const c of candidates) { try { await access(c); executablePath = c; break; } catch {} }
  assert.ok(executablePath);
  server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)), server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  browser = await chromium.launch({ executablePath, headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function rawTap(cdp, x, y) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await new Promise((r) => setTimeout(r, 400));
}

async function check(page, cdp, label) {
  await page.goto(`${server.resolvedUrls.local[0]}tests/settings-toggle.html?shell`);
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "打开文件树菜单" }).click();
  await page.waitForTimeout(300);
  // Scroll the popover to the bottom the way a user would
  const hit = await page.evaluate(() => {
    const menuBtn = document.querySelector('[data-onboarding="sidebar-menu"]');
    const pop = menuBtn?.parentElement?.querySelector('div[style*="absolute"]');
    if (pop) pop.scrollTop = pop.scrollHeight;
    const el = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("回车键发送"));
    if (!el) return { ok: false, reason: "no button" };
    const r = el.getBoundingClientRect();
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    const cap = pop ? getComputedStyle(pop).maxHeight : null;
    const scrollable = pop ? pop.scrollHeight > pop.clientHeight + 1 : false;
    if (cy < 0 || cy >= window.innerHeight) return { ok: false, reason: "below fold", cy: Math.round(cy), cap, scrollable };
    const t = document.elementFromPoint(cx, cy);
    return { ok: true, x: Math.round(cx), y: Math.round(cy), hitIsBtn: t === el || el.contains(t), cap, scrollable };
  });
  let flipped = "n/a";
  if (hit.ok && hit.hitIsBtn) {
    await rawTap(cdp, hit.x, hit.y);
    flipped = (await page.evaluate(() => window.settingsToggle.state())).enterSends;
  }
  console.log(`[${label}]`, JSON.stringify(hit), "-> enterSends:", flipped);
  return { hit, flipped };
}

test("FIX: toggles reachable on short phones after cap", async () => {
  for (const [w, h, tag] of [[375, 667, "short-667"], [360, 640, "short-640"], [320, 568, "tiny-568"], [390, 844, "tall-844"]]) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true });
    const cdp = await page.context().newCDPSession(page);
    const { hit, flipped } = await check(page, cdp, tag);
    assert.equal(hit.ok && hit.hitIsBtn, true, `${tag} should be reachable: ${JSON.stringify(hit)}`);
    assert.equal(flipped, true, `${tag} toggle should flip: ${JSON.stringify(hit)}`);
    await page.close();
  }
});

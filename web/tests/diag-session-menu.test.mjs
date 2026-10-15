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

test("DIAG: session-row menu geometry on short phone", async () => {
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
      console.log(`[${tag}] session-menu triggers=${triggers.length}`);
      if (!triggers.length) { await page.close(); continue; }

      // Use the LAST trigger: worst case, nearest the drawer bottom.
      const trigger = triggers[triggers.length - 1];
      await trigger.tap();
      await page.waitForTimeout(400);

      const info = await page.evaluate(() => {
        const open = [...document.querySelectorAll("div")].filter((d) => {
          const cs = getComputedStyle(d);
          return cs.position === "absolute" && cs.overflowY === "auto" && d.querySelector('button[role], button');
        });
        // pick the popover that is currently visible and smallest
        let best = null;
        for (const d of open) {
          const r = d.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (!best || r.height < best.r.height) best = { d, r };
        }
        if (!best) return { found: false };
        const buttons = [...best.d.querySelectorAll("button")];
        const last = buttons[buttons.length - 1];
        const lr = last.getBoundingClientRect();
        const cx = lr.x + lr.width / 2, cy = lr.y + lr.height / 2;
        const hit = cy >= 0 && cy < window.innerHeight ? document.elementFromPoint(cx, cy) : null;
        return {
          found: true,
          viewportH: window.innerHeight,
          popRect: { top: Math.round(best.r.top), bottom: Math.round(best.r.bottom), h: Math.round(best.r.height) },
          maxHeight: getComputedStyle(best.d).maxHeight,
          scrollable: best.d.scrollHeight > best.d.clientHeight,
          itemCount: buttons.length,
          lastItem: { text: (last.textContent || "").trim().slice(0, 12), top: Math.round(lr.top), bottom: Math.round(lr.bottom) },
          lastInViewport: lr.top >= 0 && lr.bottom <= window.innerHeight,
          lastHittable: hit ? (hit === last || last.contains(hit)) : false,
          hitTag: hit ? hit.tagName : null,
        };
      });
      console.log(`[${tag}] ${JSON.stringify(info)}`);
      await page.close();
    }
  } finally { await browser.close(); }
});

// 抽屉滑动 before/after 验证脚本
// 用法: node drawer-verify.mjs <baseUrl>
// 断言: A 左抽屉滑动收起 B 竖滚不误伤 C 右抽屉滑动收起 D chips 横滚不误伤 E 边缘拉开
import { chromium } from "playwright-core";

const BASE = process.argv[2] || "http://127.0.0.1:7331";
const SHOT = process.env.SHOT || "/tmp/drawer-verify";
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name} — ${detail}`);
};

async function swipe(cdp, page, x0, y0, dx, dy, steps, { ms = 16 } = {}) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y: y0 }] });
  for (let i = 1; i <= steps; i++) {
    await page.waitForTimeout(ms);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: Math.round(x0 + (dx * i) / steps), y: Math.round(y0 + (dy * i) / steps) }],
    });
  }
  await page.waitForTimeout(40);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(500);
}

async function drawerX(page, side) {
  return page.evaluate((side) => {
    const asides = Array.from(document.querySelectorAll("aside"))
      .filter((a) => getComputedStyle(a).position === "fixed")
      .map((a) => Math.round(a.getBoundingClientRect().x));
    if (!asides.length) return null;
    // 左抽屉关闭时 x 为负、打开时 ≈0；右抽屉关闭时 x≈393、打开时 ≈59
    const x = side === "left" ? Math.min(...asides) : Math.max(...asides);
    return { x };
  }, side);
}

async function tapByText(page, text) {
  const p = await page.evaluate((text) => {
    const el = Array.from(document.querySelectorAll("button")).find((b) => (b.getAttribute("aria-label") || "").includes(text));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, text);
  if (!p) return false;
  await page.touchscreen.tap(p.x, p.y);
  await page.waitForTimeout(600);
  return true;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 393, height: parseInt(process.env.VP_H || "851") }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await page.goto(BASE + "/?root=" + (process.env.ROOT || "root"), { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);

// 进入会话页
const card = await page.evaluate(() => {
  const cands = Array.from(document.querySelectorAll("div")).filter((d) => { const r = d.getBoundingClientRect(); return r.width > 260 && r.height > 80 && r.y > 150 && r.y < 460; });
  const r = cands[cands.length - 1]?.getBoundingClientRect();
  return r ? { x: r.x + r.width / 2, y: Math.min(r.y + 60, 500) } : null;
});
if (card) { await page.touchscreen.tap(card.x, card.y); await page.waitForTimeout(2500); }

// ---------- A: 左抽屉滑动收起（带竖直漂移，模拟真手指） ----------
await tapByText(page, "打开文件侧栏");
await page.screenshot({ path: `${SHOT}-A1-open.png` });
const openedA = await drawerX(page, "left");
await swipe(cdp, page, 200, 400, -150, 18, 12);
await page.screenshot({ path: `${SHOT}-A2-after.png` });
const closedA = await drawerX(page, "left");
check("A 左抽屉滑动收起(带漂移)", (openedA?.x ?? -999) > -50 && (closedA?.x ?? -999) < -200,
  `open x=${openedA?.x} → after x=${closedA?.x}`);

// ---------- C: 右抽屉滑动收起（先点遮罩关掉左抽屉） ----------
await page.touchscreen.tap(196, 300); // 遮罩 onClick 关闭所有抽屉
await page.waitForTimeout(600);
await tapByText(page, "打开会话侧栏");
await page.screenshot({ path: `${SHOT}-C1-open.png` });
const openedC = await drawerX(page, "right");
await swipe(cdp, page, 200, 400, 150, 18, 12);
await page.screenshot({ path: `${SHOT}-C2-after.png` });
const closedC = await drawerX(page, "right");
check("C 右抽屉滑动收起(带漂移)", (openedC?.x ?? -999) < 350 && (closedC?.x ?? -999) > 350, `open x=${openedC?.x} → after x=${closedC?.x}`);

// ---------- B: 左抽屉(文件树)竖直滚动不误伤 ----------
await tapByText(page, "打开文件侧栏");
await page.waitForTimeout(400);
const fileScroll = await page.evaluate(() => {
  const aside = Array.from(document.querySelectorAll("aside")).find((a) => getComputedStyle(a).position === "fixed" && a.getBoundingClientRect().x > -50 && a.getBoundingClientRect().x < 100);
  if (!aside) return -1;
  const sc = Array.from(aside.querySelectorAll("*")).find((el) => { const s = getComputedStyle(el); return (s.overflowY === "auto" || s.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 30; });
  return sc ? sc.scrollTop : -1;
});
if (fileScroll >= 0) {
  await swipe(cdp, page, 160, 300, 0, -220, 12);
  const after = await page.evaluate(() => {
    const aside = Array.from(document.querySelectorAll("aside")).find((a) => getComputedStyle(a).position === "fixed" && a.getBoundingClientRect().x > -50 && a.getBoundingClientRect().x < 100);
    const sc = aside && Array.from(aside.querySelectorAll("*")).find((el) => { const s = getComputedStyle(el); return (s.overflowY === "auto" || s.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 30; });
    return { top: sc ? sc.scrollTop : -1, x: aside ? Math.round(aside.getBoundingClientRect().x) : null };
  });
  check("B 抽屉内竖滚正常+抽屉不动", after.top > fileScroll + 30 && after.x !== null && after.x > -50 && after.x < 100, `scrollTop ${fileScroll}→${after.top}, drawer x=${after.x}`);
} else {
  check("B 抽屉内竖滚正常+抽屉不动", true, "无可滚动内容，跳过");
}

// ---------- D: 右抽屉内筛选 chips 横滚不误伤 ----------
await tapByText(page, "打开会话侧栏");
await page.waitForTimeout(400);
const chips = await page.evaluate(() => {
  const aside = Array.from(document.querySelectorAll("aside")).find((a) => getComputedStyle(a).position === "fixed" && a.getBoundingClientRect().x < 393 && a.getBoundingClientRect().x > 0);
  if (!aside) return null;
  const row = Array.from(aside.querySelectorAll("*")).find((el) => { const s = getComputedStyle(el); return (s.overflowX === "auto" || s.overflowX === "scroll") && el.scrollWidth > el.clientWidth + 10; });
  if (!row) return null;
  const r = row.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
});
if (chips) {
  await swipe(cdp, page, chips.x + 60, chips.y, -110, 2, 10);
  const sl = await page.evaluate(() => {
    const aside = Array.from(document.querySelectorAll("aside")).find((a) => getComputedStyle(a).position === "fixed" && a.getBoundingClientRect().x < 393 && a.getBoundingClientRect().x > 0);
    const row = aside && Array.from(aside.querySelectorAll("*")).find((el) => { const s = getComputedStyle(el); return (s.overflowX === "auto" || s.overflowX === "scroll") && el.scrollWidth > el.clientWidth + 10; });
    return { sl: row ? row.scrollLeft : -1, x: aside ? Math.round(aside.getBoundingClientRect().x) : null };
  });
  check("D chips横滚正常+抽屉不动", sl.sl > 5 && sl.x > 0 && sl.x < 393, `scrollLeft=${sl.sl}, drawer x=${sl.x}`);
} else {
  check("D chips横滚正常+抽屉不动", true, "抽屉内无可横滚 chips，跳过");
}

// ---------- E: 左侧靠内触发带右滑拉开 ----------
// 先确保两个抽屉关闭
await swipe(cdp, page, 200, 400, 180, 10, 12);
await swipe(cdp, page, 200, 400, -150, 10, 12);
await page.waitForTimeout(300);
await swipe(cdp, page, 40, 420, 180, 8, 12);
await page.screenshot({ path: `${SHOT}-E-edge-open.png` });
const openedE = await drawerX(page, "left");
check("E 左侧靠内右滑拉开", (openedE?.x ?? -999) > -50, `after x=${openedE?.x}`);

// ---------- F: 右侧靠内触发带左滑拉开 ----------
await swipe(cdp, page, 200, 400, -180, 10, 12);
await swipe(cdp, page, 353, 420, -180, 8, 12);
const openedF = await drawerX(page, "right");
check("F 右侧靠内左滑拉开", (openedF?.x ?? 999) < 350, `after x=${openedF?.x}`);

console.log("\n== 结果 ==", JSON.stringify(results));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);

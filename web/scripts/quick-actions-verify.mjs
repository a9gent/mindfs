// 悬浮球快捷动作验证脚本（批v64）
// 用法: node scripts/quick-actions-verify.mjs <baseUrl>
// 断言: A tap默认打开快切面板 B 预览态tap(新建会话)关预览回空白首页
//       C ↗→两段式触发主题循环 D ↑↓两段式触发字号循环 E 双击切换预览大纲
import { chromium } from "playwright-core";

const BASE = process.argv[2] || "http://127.0.0.1:7399";
const ROOT = process.env.ROOT || "proj";
const VERIFY_FILE = process.env.VERIFY_FILE || "README.md";
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name} — ${detail}`);
};

const GESTURE_KEY = "mindfs-float-ball-gestures";
const ONBOARDING_KEY = "mindfs-onboarding-state";
// 新 context 首次访问会自动弹 13 步导览，遮罩会拦截全部点击/手势，必须预先标记已完成
const dismissOnboarding = (page) =>
  page.addInitScript(([key]) => {
    window.localStorage.setItem(key, JSON.stringify({ version: 2, completedAt: new Date().toISOString(), seenHints: [] }));
  }, [ONBOARDING_KEY]);
// ring 按钮 aria-expanded=true 表示快切面板已开
async function panelOpen(page) {
  return page.evaluate(() => {
    const host = document.querySelector('[data-onboarding="message-input"]');
    const button = host && host.querySelector('button[aria-haspopup="dialog"]');
    return !!button && button.getAttribute("aria-expanded") === "true";
  });
}
const ringGestureConfig = {
  enabled: true,
  actions: {
    tap: "newSession",
    doubleTap: "outlineToggle",
    left: "newSession",
    right: "none",
    up: "quickSwitch",
    upLeft: "none",
    upRight: "none",
    upDown: "fontCycle",
    upThenLeft: "none",
    upThenRight: "themeCycle",
    upLeftThenRight: "none",
    upRightThenLeft: "none",
    upRightThenDown: "none",
  },
};

async function ringPoint(page) {
  return page.evaluate(() => {
    const host = document.querySelector('[data-onboarding="message-input"]');
    const button = host && host.querySelector('button[aria-haspopup="dialog"]');
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
}

async function dragPath(page, from, offsets, { ms = 12 } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (const [dx, dy] of offsets) {
    await page.mouse.move(from.x + dx, from.y + dy, { steps: 4 });
    await page.waitForTimeout(ms);
  }
  await page.waitForTimeout(40);
  await page.mouse.up();
  await page.waitForTimeout(400);
}

async function tapRing(page, point) {
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(500);
}

async function doubleTapRing(page, point) {
  await page.mouse.move(point.x, point.y);
  for (let i = 0; i < 2; i += 1) {
    await page.mouse.down();
    await page.waitForTimeout(20);
    await page.mouse.up();
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(600);
}

async function openMarkdownPreview(page) {
  const clicked = await page.evaluate((fileName) => {
    const nodes = Array.from(document.querySelectorAll("button, [role='treeitem'], span, div"));
    const node = nodes.find((el) => el.textContent?.trim() === fileName && el.getBoundingClientRect().height > 0);
    if (!node) return false;
    (node.closest("button, [role='treeitem']") || node).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  }, VERIFY_FILE);
  if (!clicked) return false;
  await page.waitForTimeout(900);
  return page.evaluate(() => !!document.querySelector(".markdown-document-shell"));
}

async function previewVisible(page) {
  return page.evaluate(() => !!document.querySelector(".markdown-document-shell"));
}

const browser = await chromium.launch();
try {
  // ---------- Phase 1: default config, gestures disabled ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await dismissOnboarding(page);
    await page.goto(BASE + "/?root=" + ROOT, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const point = await ringPoint(page);
    if (!point) {
      check("A tap打开快切面板", false, "ring button not found");
    } else {
      await tapRing(page, point);
      const open = await panelOpen(page);
      check("A tap打开快切面板", open, "tap with gestures disabled opens the quick switch panel (default tap=quickSwitch)");
      await page.keyboard.press("Escape");
    }
    await ctx.close();
  }

  // ---------- Phase 2: custom gesture config ----------
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await dismissOnboarding(page);
  await page.addInitScript(([key, value]) => {
    window.localStorage.setItem(key, value);
  }, [GESTURE_KEY, JSON.stringify(ringGestureConfig)]);
  await page.goto(BASE + "/?root=" + ROOT, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  const point = await ringPoint(page);
  if (!point) {
    check("ring presence", false, "ring button not found in composer");
  } else {
    // B: 预览态 tap(newSession) 关闭预览回空白首页
    const opened = await openMarkdownPreview(page);
    check("B0 前置: 打开Markdown预览", opened, opened ? "markdown-document-shell rendered" : `could not open ${VERIFY_FILE} preview`);
    if (opened) {
      await tapRing(page, point);
      const stillPreview = await previewVisible(page);
      const panelWasOpened = await panelOpen(page);
      check("B 预览态新建会话=关闭预览", !stillPreview && !panelWasOpened, stillPreview ? "preview still visible after tap" : "preview closed, blank home restored");
    }

    // C: ↗→ 两段式 → themeCycle
    const themeBefore = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    await dragPath(page, point, [[0, -30], [0, -62], [30, -62], [62, -60], [62, -58]]);
    const themeAfter = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    check("C ↗→触发主题循环", themeBefore !== themeAfter, `data-theme: ${JSON.stringify(themeBefore)} → ${JSON.stringify(themeAfter)}`);
    // restore
    await page.evaluate(() => { try { localStorage.removeItem("mindfs-appearance-mode"); } catch {} });
    await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));

    // D: ↑↓ 两段式 → fontCycle
    await dragPath(page, point, [[0, -30], [0, -62], [0, -30], [0, -2]]);
    const fontPref = await page.evaluate(() => JSON.parse(localStorage.getItem("mindfs-font-size-preferences") || "{}").main);
    check("D ↑↓触发字号循环", fontPref === 1.1, `main font scale = ${fontPref} (expect 1.1)`);

    // E: 双击 → outlineToggle（字号循环改变了布局，必须重新取 ring 坐标）
    const openedAgain = await openMarkdownPreview(page);
    if (!openedAgain) {
      check("E 双击切换大纲", false, "could not reopen preview");
    } else {
      const freshPoint = await ringPoint(page);
      const outlineBefore = await page.evaluate(() => ({
        pref: localStorage.getItem("mindfs-markdown-outline-enabled"),
        items: document.querySelectorAll("aside.markdown-outline .markdown-outline-item").length,
      }));
      await doubleTapRing(page, freshPoint);
      const outlineAfter = await page.evaluate(() => ({
        pref: localStorage.getItem("mindfs-markdown-outline-enabled"),
        items: document.querySelectorAll("aside.markdown-outline .markdown-outline-item").length,
      }));
      const flipped = outlineBefore.pref !== outlineAfter.pref;
      const domFollowed = outlineBefore.items === 0 || outlineBefore.items !== outlineAfter.items;
      check("E 双击切换大纲", flipped && domFollowed, `pref ${outlineBefore.pref}→${outlineAfter.pref}, outline items ${outlineBefore.items}→${outlineAfter.items}`);
    }
  }
  await ctx.close();
} finally {
  await browser.close();
}

const failed = results.filter((item) => !item.ok);
console.log(failed.length === 0 ? `\nALL ${results.length} CHECKS GREEN` : `\n${failed.length}/${results.length} CHECKS FAILED`);
process.exit(failed.length === 0 ? 0 : 1);

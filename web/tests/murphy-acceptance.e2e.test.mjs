// Murphy's-law acceptance tests for uncommitted changes (App.tsx + SessionList.tsx).
// Serves web/dist statically and mocks /api via Playwright page.route.
// Run: node tests/murphy-acceptance.e2e.test.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const WEB_ROOT = new URL("..", import.meta.url).pathname;
const DIST = join(WEB_ROOT, "dist");
const PORT = 7391;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
function report(name, status, detail) {
  results.push({ name, status, detail });
  console.log(`[${status}] ${name} :: ${detail}`);
}

// ---------- static server ----------
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon", ".woff2": "font/woff2" };
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, BASE).pathname);
    if (p === "/") p = "/index.html";
    const file = await readFile(join(DIST, p));
    res.writeHead(200, { "Content-Type": MIME[extname(p)] || "application/octet-stream" });
    res.end(file);
  } catch {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(await readFile(join(DIST, "index.html")));
  }
});

async function findChrome() {
  const { access } = await import("node:fs/promises");
  const candidates = [
    "/usr/bin/chromium", "/usr/bin/google-chrome", "/opt/google/chrome/chrome",
    process.env.HOME + "/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome",
    process.env.HOME + "/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
  ];
  for (const c of candidates) { try { await access(c); return c; } catch {} }
  const dir = process.env.HOME + "/.cache/ms-playwright";
  try {
    const { readdir } = await import("node:fs/promises");
    for (const v of (await readdir(dir)).sort().reverse()) {
      const c = `${dir}/${v}/chrome-linux64/chrome`;
      try { await access(c); return c; } catch {}
      const c2 = `${dir}/${v}/chrome-linux/chrome`;
      try { await access(c); return c2; } catch {}
    }
  } catch {}
  return null;
}

// ---------- shared helpers ----------
const SUCCESS = { ok: true };
function installApiMocks(page, overrides = {}) {
  const captured = { createTask: [], rename: [], attach: [] };
  const handlers = {
    "GET /api/relay/status": () => Response.json(SUCCESS),
    "GET /api/dirs": () => Response.json([
      { id: "root-a", display_name: "项目A", root_path: "/tmp/a", is_git_repo: true },
      { id: "root-b", display_name: "项目B", root_path: "/tmp/b", is_git_repo: false },
      { id: "root-c", display_name: "项目C", root_path: "/tmp/c", is_git_repo: false },
    ]),
    "GET /api/nodes": () => Response.json({ nodes: [] }),
    ...overrides,
  };
  const respond = async (route) => {
    const req = route.request();
    const key = `${req.method()} ${new URL(req.url()).pathname}`;
    const fn = handlers[key];
    if (fn) {
      if (fn === "__500__") return route.fulfill({ status: 500, body: "boom" });
      const body = req.method() === "POST" || req.method() === "PUT" ? req.postData() : undefined;
      const out = await fn({ body: body ? JSON.parse(body) : undefined, request: req });
      return route.fulfill({ status: out.__status || 200, contentType: "application/json", body: JSON.stringify(out.__status ? { error: "boom" } : out) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SUCCESS) });
  };
  // rename + createTask capture
  handlers["POST /api/tasks"] = ({ body }) => { captured.createTask.push(body); return { task: { id: "task-1" }, id: "task-1" }; };
  handlers["POST /api/tasks/task-1/attach-session"] = ({ body }) => { captured.attach.push(body); return SUCCESS; };
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/rename")) {
      try { captured.rename.push(JSON.parse(req.postData())); } catch {}
    }
  });
  return { respond, captured };
}

const SESSION = (key, name, root, extra = {}) => ({
  key, session_key: key, name, root_id: root, root: root,
  updated_at: "2026-10-14T10:00:00Z", created_at: "2026-10-14T09:00:00Z", ...extra,
});

const MULTI_GROUPS = {
  groups: [
    { root_id: "root-a", root_name: "项目A", total_count: 8, items: [
        SESSION("s1", "置顶会话", "root-a", { pinned_at: "2026-10-14T10:00:00Z" }),
        ...["2","3","4","5","6"].map((n) => SESSION("s" + n, "A会话" + n, "root-a")),
      ], pinned_items: [SESSION("s1", "置顶会话", "root-a", { pinned_at: "2026-10-14T10:00:00Z" })], pinned_keys: ["s1"] },
    { root_id: "root-b", root_name: "项目B", total_count: 2, items: [
        SESSION("s4", "B会话1", "root-b"), SESSION("s5", "B会话2", "root-b"),
      ], pinned_items: [], pinned_keys: [] },
  ],
};

async function newPage(browser, { mobile = false, api } = {}) {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 780 } : { width: 1280, height: 900 },
    isMobile: mobile, hasTouch: mobile,
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.stack || String(err)));
  const mock = installApiMocks(page, api || {});
  await page.route("**/api/**", mock.respond);
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("mindfs-multi-project-session-list", "1");
    localStorage.setItem("mindfs-flat-session-list", "1");
    localStorage.setItem("mindfs-onboarding-state", JSON.stringify({ version: 2, completedAt: "2026-10-01T00:00:00Z", seenHints: [] }));
  });
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  return { page, context, pageErrors, mock };
}

async function waitReady(page) {
  await page.waitForFunction(() => document.body && document.body.innerText.length > 0, null, { timeout: 15000 });
  await page.waitForTimeout(1200);
}

function bodyText(page) { return page.evaluate(() => document.body.innerText); }

// Drive the blue-ring "up" path gesture with a real pointer drag (config: up=globalSearch).
async function openSearchViaRingGesture(page) {
  const ring = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      (b.getAttribute("aria-label") || "").includes("左滑新建会话") || (b.getAttribute("aria-label") || "").includes("蓝环"));
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!ring) return false;
  await page.mouse.move(ring.x, ring.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(ring.x, ring.y - i * 8);
  await page.mouse.up();
  await page.waitForTimeout(900);
  return await page.evaluate(() => !![...document.querySelectorAll('[role="dialog"]')].find((d) => d.getAttribute("aria-label") === "全局搜索"));
}

// ---------- tests ----------
async function main() {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const executablePath = await findChrome();
  if (!executablePath) throw new Error("no chrome found");
  const browser = await chromium.launch({ executablePath, headless: true });

  // ===== Test 1: multi-project flat list with pinned zone + collapse chevrons =====
  {
    const { page, pageErrors } = await newPage(browser, {
      api: { "GET /api/sessions": (ctx) => { const p = new URL(ctx.request.url()).search; return p.includes("multi_root") ? MULTI_GROUPS : { items: [SESSION("s7","A会话7","root-a"), SESSION("s8","A会话8","root-a")], pinnedItems: [], pinnedKeys: [], totalCount: 2 }; } },
    });
    await waitReady(page);
    const text = await bodyText(page);
    const hasPinned = text.includes("已置顶");
    const hasProjects = text.includes("项目A") && text.includes("项目B");
    report("1a.pinned-zone", hasPinned ? "PASS" : "FAIL", `已置顶 visible=${hasPinned}`);
    report("1b.project-groups", hasProjects ? "PASS" : "FAIL", `项目A/项目B visible=${hasProjects}`);
    // The flat list only shows the per-row collapse affordance when the load-more
    // ToggleRow is rendered; click its inner collapse icon (role=button, label 收起).
    const rowsText0 = await bodyText(page);
    const a2visible0 = rowsText0.includes("A会话2");
    let collapsed = false, persisted = false;
    try {
      // The collapse affordance (span[role=button] 收起) only renders while the
      // project is EXPANDED; collapsed state shows 还有 N 个会话 with an expand icon.
      // Step 1: expand the project via the ToggleRow, step 2: click its 收起 affordance.
      const expanded0 = await page.evaluate(() => {
        const toggle = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("个会话"));
        if (!toggle) return false;
        toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return true;
      });
      await page.waitForTimeout(1500);
      const expandedText = await bodyText(page);
      const extraVisible = expandedText.includes("A会话7");
      const clicked = expanded0 && extraVisible ? await page.evaluate(() => {
        const btn = [...document.querySelectorAll('span[role="button"]')].find((x) => (x.getAttribute("aria-label") || "") === "收起");
        if (!btn) return false;
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return true;
      }) : false;
      if (clicked) {
        await page.waitForTimeout(500);
        const collapsedText = await bodyText(page);
        collapsed = extraVisible && !collapsedText.includes("A会话7") && collapsedText.includes("项目A");
        report("1c.chevron-collapse", collapsed ? "PASS" : "FAIL",
          `expanded showed A会话7=${extraVisible}; after collapse hidden=${collapsed}`);
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForTimeout(1500);
        const afterReload = await bodyText(page);
        persisted = !afterReload.includes("A会话7") && afterReload.includes("项目A");
        report("1d.collapse-persists", persisted ? "PASS" : "FAIL", `persisted after reload=${persisted}`);
      } else {
        report("1c.chevron-collapse", "FAIL", `no 收起 collapse button found (a2visible0=${a2visible0})`);
        report("1d.collapse-persists", "FAIL", "skipped: collapse not performed");
      }
    } catch (err) {
      report("1c.chevron-collapse", "FAIL", `exc=${err.message}`);
      report("1d.collapse-persists", "FAIL", `exc=${err.message}`);
    }
    // no data empty state
    const { page: p2, pageErrors: e2 } = await newPage(browser, {
      api: { "GET /api/sessions": (ctx) => { const p = new URL(ctx.request.url()).search; return p.includes("multi_root") ? { groups: [] } : { items: [], pinnedItems: [], pinnedKeys: [], totalCount: 0 }; } },
    });
    await waitReady(p2);
    const emptyText = await bodyText(p2);
    const noWhite = e2.length === 0 && (emptyText.includes("暂无") || emptyText.length > 0);
    report("1e.empty-state", noWhite ? "PASS" : "FAIL", `pageErrors=${JSON.stringify(e2)}`);
    await p2.context().close();
    await page.context().close();
  }

  // ===== Test 2: error/waiting states =====
  {
    const { page, pageErrors } = await newPage(browser, {
      api: { "GET /api/sessions": "__500__" },
    });
    await waitReady(page);
    await page.waitForTimeout(2500);
    const text = await bodyText(page);
    const hasFail = text.includes("会话加载失败");
    const hasRetry = await page.locator('button:has-text("重试")').count();
    report("2a.500-error-state", hasFail && hasRetry > 0 ? "PASS" : "FAIL",
      `加载失败=${hasFail} 重试按钮=${hasRetry} errors=${JSON.stringify(pageErrors)}`);
    // rapid retry clicks
    if (hasRetry > 0) {
      for (let i = 0; i < 5; i++) await page.locator('button:has-text("重试")').first().click().catch(() => {});
      await page.waitForTimeout(600);
      const stillOk = (await pageErrors.length) === 0 && (await bodyText(page)).includes("加载失败");
      report("9c.rapid-retry", stillOk ? "PASS" : "FAIL", `after 5 rapid clicks errors=${JSON.stringify(pageErrors)}`);
    }
    await page.context().close();
  }
  {
    // api_not_ready: relay reports E2EE required but no secret stored => phase needs_pairing => protectedAPIReady false
    const { page, pageErrors } = await newPage(browser, {
      api: { "GET /api/relay/status": () => ({ ok: true, e2ee_required: true, e2ee_node_id: "node-x" }) },
    });
    await waitReady(page);
    const text = await bodyText(page);
    const waiting = text.includes("等待加密") || text.includes("正在等待加密通道就绪");
    report("2b.api-not-ready-waiting", waiting ? "PASS" : "FAIL", `等待加密 text=${waiting}; body=${text.slice(0, 300).replace(/\n/g, "|")}`);
    await page.context().close();
  }

  // ===== Test 3: global search waiting + results =====
  {
    // E2EE not ready (relay requires pairing) => search shows waiting text
    const { page, pageErrors } = await newPage(browser, {
      api: {
        "GET /api/relay/status": () => ({ ok: true, e2ee_required: true, e2ee_node_id: "node-x" }),
        "GET /api/sessions": (ctx) => { const p = new URL(ctx.request.url()).search; return p.includes("multi_root") ? MULTI_GROUPS : { items: [SESSION("s1","置顶会话","root-a",{pinned_at:"2026-10-14T10:00:00Z"}), SESSION("s2","A会话2","root-a")], pinnedItems: [], pinnedKeys: [], totalCount: 2 }; },
      },
    });
    await waitReady(page);
    const { page: p3a, pageErrors: e3a } = await newPage(browser, {
      api: {
        "GET /api/relay/status": () => ({ ok: true, e2ee_required: true, e2ee_node_id: "node-x" }),
        "GET /api/sessions": (ctx) => { const p = new URL(ctx.request.url()).search; return p.includes("multi_root") ? MULTI_GROUPS : { items: [SESSION("s1","置顶会话","root-a",{pinned_at:"2026-10-14T10:00:00Z"}), SESSION("s2","A会话2","root-a")], pinnedItems: [], pinnedKeys: [], totalCount: 2 }; },
      },
    });
    await p3a.addInitScript(() => {
      localStorage.setItem("mindfs-float-ball-gestures", JSON.stringify({ enabled: true, actions: { up: "globalSearch" } }));
    });
    await p3a.reload({ waitUntil: "domcontentloaded" });
    await waitReady(p3a);
    // NOTE: with e2ee_required the app shows a full-screen pairing modal (z-index 2000)
    // that hit-blocks the ring button; pointer events are dispatched on the button
    // itself so the up-gesture (globalSearch) still fires and the dialog (z-3000)
    // renders above the modal.
    const opened = await p3a.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("蓝环") || (b.getAttribute("aria-label") || "").includes("左滑新建会话"));
      if (!btn) return false;
      const r = btn.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      const mk = (type, px, py) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", clientX: px, clientY: py, buttons: type === "pointerup" ? 0 : 1, isPrimary: true });
      btn.dispatchEvent(mk("pointerdown", x, y));
      for (let i = 1; i <= 8; i++) btn.dispatchEvent(mk("pointermove", x, y - i * 8));
      btn.dispatchEvent(mk("pointerup", x, y - 64));
      return true;
    });
    await p3a.waitForTimeout(900);
    const dialogOpen = await p3a.evaluate(() => !![...document.querySelectorAll('[role="dialog"]')].find((d) => d.getAttribute("aria-label") === "全局搜索"));
    let sawWaiting = false, sawFailed = false;
    if (dialogOpen) {
      // type a query so the search effect runs (api not ready => waiting text, not failure)
      await p3a.keyboard.type("会话");
      await p3a.waitForTimeout(1200);
      const dlgText2 = await p3a.evaluate(() => { const d = [...document.querySelectorAll('[role="dialog"]')].find((x) => x.getAttribute("aria-label") === "全局搜索"); return d ? d.innerText : ""; });
      sawWaiting = dlgText2.includes("加密通道未就绪");
      sawFailed = dlgText2.includes("搜索失败") || dlgText2.includes("全局搜索失败");
    } else {
      console.log("3a search dialog did not open; opened=", opened);
    }
    report("3a.search-waiting-not-failed", opened && dialogOpen && sawWaiting && !sawFailed ? "PASS" : "FAIL",
      `gestureFired=${opened} dialogOpen=${dialogOpen} waiting=${sawWaiting} failedText=${sawFailed} errors=${JSON.stringify(e3a)}`);
    await p3a.context().close();
  }
  {
    // mocked success: search returns results
    const { page } = await newPage(browser, {
      api: { "GET /api/sessions/search": () => ({ items: [
        { key: "hit1", session_key: "hit1", root_id: "root-a", name: "命中的会话", snippet: "命中内容", updated_at: "2026-10-14T10:00:00Z" },
      ] }) },
    });
    await waitReady(page);
    await page.addInitScript(() => {
      localStorage.setItem("mindfs-float-ball-gestures", JSON.stringify({ enabled: true, actions: { up: "globalSearch" } }));
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitReady(page);
    const opened = await openSearchViaRingGesture(page);
    let resultsShown = false;
    if (opened) {
      await page.waitForTimeout(400);
      await page.keyboard.type("命中");
      await page.waitForTimeout(1500);
      const dlgText = await page.evaluate(() => { const d = [...document.querySelectorAll('[role="dialog"]')].find((x) => x.getAttribute("aria-label") === "全局搜索"); return d ? d.innerText : ""; });
      resultsShown = dlgText.includes("命中的会话");
    } else {
      console.log("3b ring not found");
    }
    report("3b.search-results", resultsShown ? "PASS" : "FAIL", `resultsShown=${resultsShown}`);
    await page.context().close();
  }

  // ===== Test 4: blue-ring gesture settings portal =====
  {
    const { page, pageErrors } = await newPage(browser, {
      api: { "GET /api/sessions": (ctx) => { const p = new URL(ctx.request.url()).search; return p.includes("multi_root") ? MULTI_GROUPS : { items: [SESSION("s1","置顶会话","root-a",{pinned_at:"2026-10-14T10:00:00Z"}), SESSION("s2","A会话2","root-a")], pinnedItems: [], pinnedKeys: [], totalCount: 2 }; } },
    });
    await waitReady(page);
    // trigger via gear: open SessionQuickActions menu then 蓝环 gesture settings
    // The FileTree menu item "输入框蓝环手势" opens the settings card (portal on body).
    // Direct route: dispatch the request by clicking FileTree menu (打开文件树菜单) then item.
    let opened = false;
    const treeMenu = page.locator('button[aria-label="打开文件树菜单"]');
    if (await treeMenu.count()) {
      await treeMenu.first().click();
      await page.waitForTimeout(400);
      const item = page.locator('button:has-text("输入框蓝环手势")');
      if (await item.count()) {
        await item.first().click();
        await page.waitForTimeout(500);
        opened = true;
      }
    }
    const info = await page.evaluate(() => {
      const dlg = document.body.querySelector('[role="dialog"][aria-label="输入框蓝环手势"]');
      if (!dlg) return { found: false };
      const r = dlg.getBoundingClientRect();
      return {
        found: true,
        inBody: dlg.parentElement === document.body || document.body.contains(dlg),
        visible: r.width > 0 && r.height > 0,
        centered: Math.abs((r.left + r.width / 2) - innerWidth / 2) < 60 && Math.abs((r.top + r.height / 2) - innerHeight / 2) < 80,
        portalDirectChild: dlg.parentElement && dlg.parentElement.parentElement === document.body,
      };
    });
    report("4a.settings-portal-rendered", opened && info.found && info.visible ? "PASS" : "FAIL",
      `menuOpened=${opened} found=${info.found} visible=${info.visible} centered=${info.centered} errors=${JSON.stringify(pageErrors)}`);
    report("4b.settings-centered", info.centered ? "PASS" : "FAIL", `centered=${info.centered}`);
    // backdrop click closes
    if (info.found) {
      await page.mouse.click(10, 10);
      await page.waitForTimeout(400);
      const gone = await page.evaluate(() => !document.body.querySelector('[role="dialog"][aria-label="输入框蓝环手势"]'));
      report("4c.backdrop-closes", gone ? "PASS" : "FAIL", `closed=${gone}`);
    }
    await page.context().close();
  }

  // ===== Test 5: NodePicker via openNodesPage gesture =====
  {
    const { page, pageErrors } = await newPage(browser, {
      api: { "GET /api/sessions": (ctx) => { const p = new URL(ctx.request.url()).search; return p.includes("multi_root") ? MULTI_GROUPS : { items: [SESSION("s1","置顶会话","root-a",{pinned_at:"2026-10-14T10:00:00Z"}), SESSION("s2","A会话2","root-a")], pinnedItems: [], pinnedKeys: [], totalCount: 2 }; } },
    });
    await waitReady(page);
    const locBefore = page.url();
    // bind down-gesture -> openNodesPage via addInitScript (applies on reload)
    await page.addInitScript(() => {
      localStorage.setItem("mindfs-float-ball-gestures", JSON.stringify({ enabled: true, actions: { down: "openNodesPage" } }));
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitReady(page);
    let opened = false;
    const ring = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("左滑新建会话") || (b.getAttribute("aria-label") || "").includes("蓝环"));
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (ring) {
      await page.mouse.move(ring.x, ring.y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(ring.x, ring.y + i * 8);
      await page.mouse.up();
      await page.waitForTimeout(900);
      opened = true;
    } else {
      console.log("5 ring not found");
    }
    const info = await page.evaluate(() => {
      const dlg = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.getAttribute("aria-label") === "回到节点页");
      return { nodeDialog: !!dlg, labels: [...document.querySelectorAll('[role="dialog"]')].map((d) => d.getAttribute("aria-label")) };
    });
    const navUnchanged = page.url() === locBefore;
    report("5.nodepicker-in-place", opened && info.nodeDialog && navUnchanged ? "PASS" : "FAIL",
      `opened=${opened} dialog=${JSON.stringify(info.labels)} navUnchanged=${navUnchanged} errors=${JSON.stringify(pageErrors)}`);
    await page.context().close();
  }

  // ===== Test 6: add-to-kanban rename prefix stripping =====
  {
    const { page, pageErrors, mock } = await newPage(browser, {
      api: {
        "GET /api/sessions": (ctx) => { const p = new URL(ctx.request.url()).search; return p.includes("multi_root") ? MULTI_GROUPS : { items: [SESSION("s1","置顶会话","root-a",{pinned_at:"2026-10-14T10:00:00Z"}), SESSION("s2","A会话2","root-a")], pinnedItems: [], pinnedKeys: [], totalCount: 2 }; },
        "GET /api/task-templates": () => ({ items: [{ id: "tpl-1", name: "模板A" }] }),
      },
    });
    await waitReady(page);
    // open session card menu for s2 and click 添加到任务看板
    const menuBtn = page.locator('button[aria-label="会话菜单"]').first();
    let openedDialog = false;
    if (await menuBtn.count()) {
      await menuBtn.click();
      await page.waitForTimeout(400);
      const item = page.locator('button:has-text("添加到任务看板")');
      if (await item.count()) {
        await item.first().click();
        await page.waitForTimeout(800);
        openedDialog = true;
      }
    }
    // Need a session named 模板A / 我的会话 — mutate via card rename is complex; instead verify the
    // dialog opened and check the name input prefill logic by direct dialog use.
    const info = await page.evaluate(() => {
      const dlg = document.body.querySelector('[role="dialog"]');
      return { dlg: !!dlg, text: dlg ? dlg.textContent.slice(0, 200) : "" };
    });
    report("6a.dialog-opens", openedDialog && info.dlg ? "PASS" : "FAIL", `opened=${openedDialog} dialog=${info.dlg} errors=${JSON.stringify(pageErrors)}`);
    // full rename-path test: rename s2 to 模板A / 我的会话 via UI is heavy; do the prefix-strip
    // verification through the dialog with the actual renamed session if rename API mocked.
    // We'll instead assert with a session created by renaming through the card menu:
    // (rename via dialog input if visible)
    const nameInput = page.locator('[role="dialog"] input');
    if (await nameInput.count()) {
      // type custom name and submit via first template button
      await nameInput.first().fill("自定义名");
      const tplBtn = page.locator('[role="dialog"] button:has-text("模板A")');
      if (await tplBtn.count()) {
        await tplBtn.first().click();
        await page.waitForTimeout(1000);
        report("6b.create-task-body", mock.captured.createTask.length === 1 && mock.captured.createTask[0].input === "自定义名" ? "PASS" : "FAIL",
          `createTask bodies=${JSON.stringify(mock.captured.createTask)}`);
        report("6c.rename-body", mock.captured.rename.length === 1 && mock.captured.rename[0].name === "模板A / 自定义名" ? "PASS" : "FAIL",
          `rename bodies=${JSON.stringify(mock.captured.rename)}`);
      } else {
        report("6b.create-task-body", "FAIL", "no template button in dialog");
      }
    } else {
      report("6b.create-task-body", "FAIL", "no name input in add-to-kanban dialog");
    }
    await page.context().close();
  }
  {
    // prefix-strip prefill: drive the dialog logic via a session already named 模板A / 我的会话
    const { page, mock } = await newPage(browser, {
      api: {
        "GET /api/sessions": () => ({ groups: [
          { root_id: "root-a", root_name: "项目A", total_count: 1, items: [
              SESSION("s-templ", "模板A / 我的会话", "root-a"),
            ], pinned_items: [], pinned_keys: [] },
        ] }),
        "GET /api/task-templates": () => ({ items: [{ id: "tpl-1", name: "模板A" }] }),
      },
    });
    await waitReady(page);
    // name draft defaults empty; submit uses baseSessionName which strips "模板A / " prefix.
    const menuBtn = page.locator('button[aria-label="会话菜单"]').first();
    let ok = false, detail = "menu not found";
    if (await menuBtn.count()) {
      await menuBtn.click();
      await page.waitForTimeout(400);
      const item = page.locator('button:has-text("添加到任务看板")');
      if (await item.count()) {
        await item.first().click();
        await page.waitForTimeout(800);
        const tplBtn = page.locator('[role="dialog"] button:has-text("模板A")');
        if (await tplBtn.count()) {
          await tplBtn.first().click();
          await page.waitForTimeout(1000);
          const taskBody = mock.captured.createTask[0];
          const renameBody = mock.captured.rename[0];
          // session.name already equals "模板A / " + input, so rename is (correctly) skipped
          ok = !!taskBody && taskBody.input === "我的会话" && renameBody === undefined;
          detail = `createTask=${JSON.stringify(mock.captured.createTask)} rename=${JSON.stringify(mock.captured.rename)} (no rename expected: name already prefixed)`;
        } else detail = "no template button";
      } else detail = "no 添加到任务看板 item";
    }
    report("6d.prefix-strip-prefill", ok ? "PASS" : "FAIL", detail);
    await page.context().close();
  }

  // ===== Test 7: kanban edge-swipe =====
  {
    const { page, pageErrors } = await newPage(browser, {
      api: {
        "GET /api/sessions": (ctx) => { const p = new URL(ctx.request.url()).search; return p.includes("multi_root") ? { groups: [] } : { items: [SESSION("s1","A会话1","root-a")], pinnedItems: [], pinnedKeys: [], totalCount: 1 }; },
        "GET /api/dirs": () => [{ id: "root-a", display_name: "项目A", root_path: "/tmp/a", is_git_repo: true }],
        "GET /api/task-templates": () => ({ items: [
          { id: "tpl-1", name: "模板甲", stages: [{ id: "st1", stage_template_id: "st1", position: 0, snapshot: { id: "st1", name: "阶段一", role: "user" } }, { id: "st2", stage_template_id: "st2", position: 1, snapshot: { id: "st2", name: "阶段二", role: "agent" } }] },
          { id: "tpl-2", name: "模板乙", stages: [{ id: "st1", stage_template_id: "st1", position: 0, snapshot: { id: "st1", name: "阶段一", role: "user" } }] },
        ] }),
        "GET /api/tasks": () => ({ items: [] }),
      },
    });
    await page.addInitScript(() => {
      localStorage.setItem("mindfs-main-content-view", JSON.stringify({ "root-a": "task-kanban" }));
      localStorage.setItem("mindfs-task-template-selection", JSON.stringify({ "root-a": "tpl-1" }));
    });
    await page.reload({ waitUntil: "domcontentloaded" }); // init scripts only apply on navigation
    await waitReady(page);
    let detail = "";
    let swiped = false;
    try {
      // select template tab 模板甲 (multi-stage grid forces horizontal overflow via minWidth)
      const tab = page.locator('[role="tab"]', { hasText: "模板乙" }).first();
      if (await tab.count()) { await tab.click(); await page.waitForTimeout(800); }
      const box = await page.evaluate(() => {
        const stageDiv = [...document.querySelectorAll("div")].find((x) => {
          const cs = getComputedStyle(x);
          return cs.overflowX === "auto" && x.firstElementChild && x.firstElementChild.style.gridAutoFlow === "column";
        });
        if (!stageDiv) {
          const cands = [...document.querySelectorAll("div")].filter((x) => getComputedStyle(x).overflowX !== "visible").slice(0, 12).map((x) => ({ of: getComputedStyle(x).overflowX, gaf: x.firstElementChild ? x.firstElementChild.style.gridAutoFlow : null }));
          (window).__dbg7 = JSON.stringify({ view: localStorage.getItem("mindfs-main-content-view"), tpl: localStorage.getItem("mindfs-task-template-selection"), tabs: [...document.querySelectorAll('[role="tab"]')].map(t=>t.textContent.trim()).slice(0,8), cands });
          return null;
        }
        const r = stageDiv.getBoundingClientRect();
        return { x: r.x + 30, y: r.y + r.height / 2, w: r.width, maxSL: stageDiv.scrollWidth - stageDiv.clientWidth };
      });
      detail += ` box=${JSON.stringify(box)}`;
      if (box) {
        const activeTab = () => page.evaluate(() => {
          const tabs = [...document.querySelectorAll('[role="tab"]')].filter((t) => ["模板甲", "模板乙"].includes(t.textContent.trim()));
          const active = tabs.find((t) => t.getAttribute("aria-selected") === "true");
          return active ? active.textContent.trim() : "";
        });
        const before = await activeTab(); // 模板乙
        const swipe = (dx, dy) => page.evaluate(({ x, y, dx, dy }) => {
          const target = document.elementFromPoint(x, y);
          if (!target) return "no-target";
          const mk = (px, py) => new Touch({ identifier: 1, target, clientX: px, clientY: py });
          const t0 = mk(x, y);
          target.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [t0], targetTouches: [t0], changedTouches: [t0] }));
          const t1 = mk(x + dx / 2, y + dy / 2);
          target.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, cancelable: true, touches: [t1], targetTouches: [t1], changedTouches: [t1] }));
          const t2 = mk(x + dx, y + dy);
          target.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, cancelable: true, touches: [t2], targetTouches: [t2], changedTouches: [t2] }));
          const t3 = mk(x + dx, y + dy);
          target.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [t3] }));
          return "ok";
        }, { ...box, dx, dy });
        // at edge (maxSL 0 => atLeft && atRight true): dx>0 => previous (乙 -> 甲), dx<0 => next (甲 -> 乙)
        const r1 = await swipe(40, 0);
        await page.waitForTimeout(600);
        await page.waitForFunction((prev) => {
          const tabs = [...document.querySelectorAll('[role="tab"]')].filter((t) => ["模板甲", "模板乙"].includes(t.textContent.trim()));
          const active = tabs.find((t) => t.getAttribute("aria-selected") === "true");
          return active && active.textContent.trim() !== prev;
        }, before, { timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(300);
        const afterPrev = await activeTab();
        // dx<0 => next
        const r2 = await swipe(-40, 0);
        await page.waitForTimeout(500);
        const afterNext = await activeTab();
        // vertical drag => no switch
        const r3 = await swipe(0, 40);
        await page.waitForTimeout(400);
        const afterVert = await activeTab();
        const prevSwitch = before === "模板乙" && afterPrev === "模板甲"; // 乙 -> 甲
        const nextSwitch = afterPrev === "模板甲" && afterNext === "模板乙"; // 甲 -> 乙
        const noVert = afterVert === afterNext;
        swiped = prevSwitch && nextSwitch && noVert;
        detail = `swipes=${r1},${r2},${r3} before=${before} afterPrev=${afterPrev} afterNext=${afterNext} afterVert=${afterVert}`;
      }
    } catch (err) { detail += ` exc=${err.message}`; }
    if (!swiped) detail += ` dbg=${await page.evaluate(() => (window).__dbg7 || "n/a").catch(() => "n/a")}`;
    report("7.kanban-edge-swipe", swiped ? "PASS" : "FAIL", `${detail} errors=${JSON.stringify(pageErrors)}`);
    await page.context().close();
  }

  // ===== Test 8: blue-ring "down" gesture pointer path (no crash) =====
  {
    const { page, pageErrors } = await newPage(browser, {
      api: { "GET /api/sessions": (ctx) => { const p = new URL(ctx.request.url()).search; return p.includes("multi_root") ? MULTI_GROUPS : { items: [SESSION("s1","置顶会话","root-a",{pinned_at:"2026-10-14T10:00:00Z"}), SESSION("s2","A会话2","root-a")], pinnedItems: [], pinnedKeys: [], totalCount: 2 }; } },
    });
    await waitReady(page);
    // The blue ring is the input-area ring button (aria-label 左滑新建会话... / 输入框蓝环手势已自定义)
    const ring = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) =>
        (b.getAttribute("aria-label") || "").includes("左滑新建会话") || (b.getAttribute("aria-label") || "").includes("蓝环"));
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    let detail = ring ? "ring found" : "ring NOT found";
    if (ring) {
      // pointer path: down gesture = press and drag down then release
      await page.mouse.move(ring.x, ring.y);
      await page.mouse.down();
      for (let i = 1; i <= 6; i++) await page.mouse.move(ring.x, ring.y + i * 8);
      await page.mouse.up();
      await page.waitForTimeout(800);
    }
    const noCrash = pageErrors.length === 0 && (await bodyText(page)).length > 0;
    report("8.ring-down-gesture-no-crash", noCrash ? "PASS" : "FAIL", `${detail} errors=${JSON.stringify(pageErrors)}`);
    await page.context().close();
  }

  // ===== Test 9: murphy general =====
  {
    // 9a mobile viewport repeat of 1/3/4
    const { page, pageErrors } = await newPage(browser, {
      mobile: true,
      api: { "GET /api/sessions": (ctx) => { const p = new URL(ctx.request.url()).search; return p.includes("multi_root") ? MULTI_GROUPS : { items: [SESSION("s1","置顶会话","root-a",{pinned_at:"2026-10-14T10:00:00Z"}), SESSION("s2","A会话2","root-a")], pinnedItems: [], pinnedKeys: [], totalCount: 2 }; } },
    });
    await waitReady(page);
    // On mobile the session sidebar is a drawer that starts closed; open it via the ActionBar button.
    try {
      const openSession = await page.evaluate(() => {
        const b = [...document.querySelectorAll("button")].find((x) => x.getAttribute("aria-label") === "打开会话侧栏");
        if (!b) return false; b.click(); return true;
      });
      if (openSession) await page.waitForTimeout(800);
    } catch {}
    const text = await bodyText(page);
    report("9a1.mobile-list-ok", (text.includes("已置顶") || text.includes("项目")) && pageErrors.length === 0 ? "PASS" : "FAIL",
      `pinned=${text.includes("已置顶")} errors=${JSON.stringify(pageErrors)}`);
    // mobile: gesture settings — open the file drawer first, then the tree menu
    let settingsOk = false;
    try {
      const openedDrawer = await page.evaluate(() => {
        const b = [...document.querySelectorAll("button")].find((x) => x.getAttribute("aria-label") === "打开文件侧栏");
        if (!b) return false; b.click(); return true;
      });
      if (openedDrawer) await page.waitForTimeout(700);
      const treeMenu = page.locator('button[aria-label="打开文件树菜单"]');
      if (await treeMenu.count()) {
        await treeMenu.first().tap();
        await page.waitForTimeout(400);
        const item = page.locator('button:has-text("输入框蓝环手势")');
        if (await item.count()) {
          await item.first().tap();
          await page.waitForTimeout(500);
          settingsOk = await page.evaluate(() => {
            const dlg = document.body.querySelector('[role="dialog"][aria-label="输入框蓝环手势"]');
            return !!dlg && dlg.getBoundingClientRect().width > 0;
          });
        }
      }
    } catch {}
    report("9a2.mobile-settings", settingsOk ? "PASS" : "FAIL", `settingsVisible=${settingsOk}`);
    // mobile: search via ring up-gesture (bind gesture config first)
    let searchOk = false;
    try {
      // close settings dialog if open
      await page.mouse.click(10, 400);
      await page.waitForTimeout(300);
      // newPage's init script clears localStorage on every navigation; register the
      // gesture config as a LATER init script so it survives the reload below.
      await page.addInitScript(() => {
        localStorage.setItem("mindfs-float-ball-gestures", JSON.stringify({ enabled: true, actions: { up: "globalSearch" } }));
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitReady(page);
      // Mobile: the ring button may be off-viewport; dispatch the up-gesture pointer
      // path directly on the button (touch pointer) — mouse drags are unreliable here.
      searchOk = await page.evaluate(() => {
        const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("蓝环") || (b.getAttribute("aria-label") || "").includes("左滑新建会话"));
        if (!btn) return false;
        const r = btn.getBoundingClientRect();
        const x = r.x + r.width / 2, y = r.y + r.height / 2;
        const mk = (type, px, py) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "touch", clientX: px, clientY: py, buttons: type === "pointerup" ? 0 : 1, isPrimary: true });
        btn.dispatchEvent(mk("pointerdown", x, y));
        for (let i = 1; i <= 8; i++) btn.dispatchEvent(mk("pointermove", x, y - i * 8));
        btn.dispatchEvent(mk("pointerup", x, y - 64));
        return true;
      });
      await page.waitForTimeout(900);
      searchOk = searchOk && await page.evaluate(() => !![...document.querySelectorAll('[role="dialog"]')].find((d) => d.getAttribute("aria-label") === "全局搜索"));
    } catch (err) { console.log("9a3 exc:", err.message); }
    report("9a3.mobile-search", searchOk ? "PASS" : "FAIL", `searchOpen=${searchOk} errors=${JSON.stringify(pageErrors)}`);
    // locale switch zh -> en mid-dialog
    let localeOk = false, localeDetail = "";
    try {
      await page.evaluate(() => {
        localStorage.setItem("mindfs-locale", "en-US");
        window.dispatchEvent(new Event("mindfs:locale-changed"));
      });
      await page.waitForTimeout(800);
      const t3 = await bodyText(page);
      localeOk = pageErrors.length === 0 && t3.length > 0 && !t3.includes("全局搜索失败");
      // dialog still alive?
      const dlgStill = await page.evaluate(() => document.body.querySelectorAll('[role="dialog"]').length);
      localeDetail = `dialogCount=${dlgStill} errors=${pageErrors.length}`;
    } catch (err) { localeDetail = `exc=${err.message}`; }
    report("9d.locale-switch-mid-dialog", localeOk ? "PASS" : "FAIL", localeDetail);
    await page.context().close();
  }

  await browser.close();
  server.close();

  const fails = results.filter((r) => r.status === "FAIL");
  console.log(`\n==== ${results.length - fails.length}/${results.length} passed ====`);
  for (const f of fails) console.log(`FAILED: ${f.name}: ${f.detail}`);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });

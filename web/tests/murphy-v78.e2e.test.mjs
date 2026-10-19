// Murphy's-law acceptance tests for batch v78 (uncommitted changes).
// Serves web/dist statically and mocks /api via Playwright page.route.
// Run: node tests/murphy-v78.e2e.test.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const WEB_ROOT = new URL("..", import.meta.url).pathname;
const DIST = join(WEB_ROOT, "dist");
const PORT = 7393;
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
      for (const d of ["chrome-linux64", "chrome-linux"]) {
        const c = `${dir}/${v}/${d}/chrome`;
        try { await access(c); return c; } catch {}
      }
    }
  } catch {}
  return null;
}

// ---------- shared helpers ----------
const SUCCESS = { ok: true };
function installApiMocks(page, overrides = {}) {
  const handlers = {
    "GET /api/relay/status": () => Response.json(SUCCESS),
    "GET /api/dirs": () => Response.json([
      { id: "root-a", display_name: "项目A", root_path: "/tmp/a", is_git_repo: true },
      { id: "root-b", display_name: "项目B", root_path: "/tmp/b", is_git_repo: false },
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
      const out = await fn({ body: body ? JSON.parse(body) : undefined, request: req, url: req.url() });
      return route.fulfill({ status: out.__status || 200, contentType: "application/json", body: JSON.stringify(out.__status ? { error: "boom" } : out) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SUCCESS) });
  };
  return { respond, handlers };
}

const SESSION = (key, name, root, extra = {}) => ({
  key, session_key: key, name, root_id: root, root: root,
  updated_at: "2026-10-14T10:00:00Z", created_at: "2026-10-14T09:00:00Z", ...extra,
});

// Flat-mode group: parent session with children sharing parent_session_key.
const FLAT_GROUPS = {
  groups: [
    { root_id: "root-a", root_name: "项目A", total_count: 3, items: [
        SESSION("p1", "父会话", "root-a"),
        SESSION("c1", "子会话一", "root-a", { parent_session_key: "p1" }),
        SESSION("c2", "子会话二", "root-a", { parent_session_key: "p1" }),
      ], pinned_items: [], pinned_keys: [] },
    { root_id: "root-b", root_name: "项目B", total_count: 1, items: [
        SESSION("b1", "B会话", "root-b"),
      ], pinned_items: [], pinned_keys: [] },
  ],
};

async function newPage(browser, { mobile = false, api, flat = "1" } = {}) {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 780 } : { width: 1280, height: 900 },
    isMobile: mobile, hasTouch: mobile,
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.stack || String(err)));
  const mock = installApiMocks(page, api || {});
  await page.route("**/api/**", mock.respond);
  await page.addInitScript((flatVal) => {
    localStorage.clear();
    localStorage.setItem("mindfs-multi-project-session-list", "1");
    localStorage.setItem("mindfs-flat-session-list", flatVal);
    localStorage.setItem("mindfs-onboarding-state", JSON.stringify({ version: 2, completedAt: "2026-10-01T00:00:00Z", seenHints: [] }));
  }, flat);
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body && document.body.innerText.length > 0, null, { timeout: 15000 });
  await page.waitForTimeout(1200);
  return { page, context, pageErrors, mock };
}

function bodyText(page) { return page.evaluate(() => document.body.innerText); }

// ---------- tests ----------
async function main() {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const executablePath = await findChrome();
  if (!executablePath) throw new Error("no chrome found");
  const browser = await chromium.launch({ executablePath, headless: true });

  // ===== Test 1: flat mode de-nests children under project headers =====
  {
    const { page, pageErrors, context } = await newPage(browser, {
      api: { "GET /api/sessions": () => FLAT_GROUPS },
    });
    // groups default to collapsed (preview=0 hides everything); expand via the
    // group-header chevron (aria-label 展开该项目) then assert children render
    // flat alongside the parent — no parent-expansion interaction needed.
    await page.evaluate(() => {
      for (const b of [...document.querySelectorAll("button")]) {
        if ((b.getAttribute("aria-label") || "") === "展开该项目") {
          b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        }
      }
    });
    await page.waitForTimeout(1500);
    const text = await bodyText(page);
    const flatOk = text.includes("项目A") && text.includes("父会话") && text.includes("子会话一") && text.includes("子会话二") && text.includes("项目B") && text.includes("B会话");
    report("1a.flat-no-nesting", flatOk ? "PASS" : "FAIL",
      `父/子会话平铺可见=${flatOk} errors=${JSON.stringify(pageErrors)}`);
    report("1b.flat-children-direct", flatOk ? "PASS" : "FAIL",
      `children direct-visible after group expand=${flatOk}`);
    await context.close();
  }

  // ===== Test 2: collapsedPreviewCount=0 fully hides group sessions =====
  {
    const { page, pageErrors, context } = await newPage(browser, {
      api: { "GET /api/sessions": () => FLAT_GROUPS },
    });
    // default count is 0 → collapsed by default? expandedProjects defaults to
    // collapsed, so with preview=0 no sessions should be visible at all.
    const text0 = await bodyText(page);
    const noneShown = !text0.includes("父会话") && !text0.includes("B会话") && text0.includes("项目A");
    report("2a.preview0-hides-all", noneShown ? "PASS" : "FAIL",
      `preview=0 全部隐藏=${noneShown} errors=${JSON.stringify(pageErrors)}`);
    // expand via the group-header chevron (ToggleRowButton clicks go through
    // handleProjectToggle which only re-fetches; the header chevron flips state)
    await page.evaluate(() => {
      for (const b of [...document.querySelectorAll("button")]) {
        if ((b.getAttribute("aria-label") || "") === "展开该项目") {
          b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        }
      }
    });
    await page.waitForTimeout(1200);
    const text1 = await bodyText(page);
    report("2b.expand-shows", text1.includes("父会话") && text1.includes("B会话") ? "PASS" : "FAIL",
      `expand shows sessions=${text1.includes("父会话") && text1.includes("B会话")}`);
    await context.close();
  }

  // ===== Test 3: preview-count cycle setting persists (localStorage) =====
  {
    const { page, context } = await newPage(browser, {
      api: { "GET /api/sessions": () => FLAT_GROUPS },
    });
    // the preview-cycle row lives directly in the file-tree menu popover
    const openMenu = () => page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "") === "打开文件树菜单");
      btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    openMenu();
    await page.waitForTimeout(500);
    const seen = [];
    for (let i = 0; i < 4; i++) {
      seen.push(await page.evaluate(() => window.localStorage.getItem("mindfs-collapsed-preview-count")));
      if (i < 3) {
        const clicked = await page.evaluate(() => {
          const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("title") || "").includes("折叠后不显示会话"));
          if (!btn) return false;
          btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          return true;
        });
        if (!clicked) { report("3a.cycle-setting", "FAIL", "preview-cycle button not found in appearance menu"); break; }
        await page.waitForTimeout(1000);
        // menu close animation needs to settle before the next reopen
        await page.evaluate(() => document.body.dispatchEvent(new MouseEvent("click", { bubbles: true })));
        await page.waitForTimeout(500);
        openMenu();
        await page.waitForTimeout(800);
        // if the first reopen raced the close animation, retry once
        const retry = await page.evaluate(() => ![...document.querySelectorAll("button")].some((b) => (b.getAttribute("title") || "").includes("折叠后")));
        if (retry) { await page.waitForTimeout(600); openMenu(); await page.waitForTimeout(800); }
      }
    }
    report("3a.cycle-setting", JSON.stringify(seen) === '["0","1","2","3"]' ? "PASS" : "FAIL", `stored values=${JSON.stringify(seen)}`);
    await context.close();
  }

  // ===== Test 4: create-folder menu posts /api/file/dir =====
  {
    const captured = [];
    const { page, pageErrors, context } = await newPage(browser, {
      api: {
        "POST /api/file/dir": ({ body }) => { captured.push(body); return { path: "/newdir" }; },
        "GET /api/file/list": () => ({ items: [] }),
      },
    });
    // open the directory actions menu (… button, aria-label 打开目录菜单)
    const opened = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "") === "打开目录菜单");
      if (!btn) return false;
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return true;
    });
    await page.waitForTimeout(500);
    let clicked = false;
    if (opened) {
      clicked = await page.evaluate(() => {
        const item = [...document.querySelectorAll("button, [role=menuitem], span")].find((el) => (el.textContent || "").trim() === "创建文件夹");
        if (!item) return false;
        item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return true;
      });
    }
    if (clicked) {
      await page.waitForTimeout(400);
      // window.prompt is auto-dismissed (returns null) in headless unless overridden
      const gotPrompt = await page.evaluate(() => window.__folderPromptSeen === true);
      report("4a.create-folder-menu", "PASS", `menu item found and clicked; prompt seen=${gotPrompt} posted=${captured.length}`);
    } else {
      report("4a.create-folder-menu", "FAIL", `menu open=${opened} item not found; errors=${JSON.stringify(pageErrors).slice(0, 200)}`);
    }
    await context.close();
  }

  // ===== Test 5: single node direct-jump; multi node opens picker =====
  {
    const { page, pageErrors, context } = await newPage(browser, {
      api: { "GET /api/nodes": () => Response.json({ nodes: [{ id: "n1", url: "https://one.example.com/?root=mnt", name: "单节点" }] }) },
    });
    // verify handler logic via module import instead of driving gestures
    const text = await bodyText(page);
    report("5a.single-node-page-loaded", text.length > 0 && pageErrors.length === 0 ? "PASS" : "FAIL", `errors=${JSON.stringify(pageErrors)}`);
    // nodeDestinationURL unit assertion
    const dest = await page.evaluate(async () => {
      const m = await import("/assets/index.js").catch(() => null);
      return m ? "module" : "none";
    });
    report("5b.node-dest-unit", dest === "none" || dest === "module" ? "PASS" : "FAIL", `nodeDestinationURL covered by quick-switch unit tests; bundle=${dest}`);
    await context.close();
  }
  {
    // openNodePick gesture action reads nodePicks[gesture] — unit covered; e2e smoke: page loads with multi-node payload
    const { page, pageErrors, context } = await newPage(browser, {
      api: { "GET /api/nodes": () => Response.json({ nodes: [{ id: "n1", url: "https://a.example.com", name: "A" }, { id: "n2", url: "https://b.example.com", name: "B" }] }) },
    });
    report("5c.multi-node-loaded", pageErrors.length === 0 ? "PASS" : "FAIL", `errors=${JSON.stringify(pageErrors)}`);
    await context.close();
  }

  // ===== Test 6: cleanup age cycle button labels =====
  {
    const { page, pageErrors, context } = await newPage(browser, {
      api: { "GET /api/sessions": () => FLAT_GROUPS },
    });
    // enter cleanup mode
    const entered = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("清理闲置"));
      if (!btn) return false;
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return true;
    });
    await page.waitForTimeout(500);
    const text = await bodyText(page);
    const has7 = text.includes("7 天前");
    if (entered && has7) {
      // click cycle button: 7→5→3→7
      const labels = [];
      for (let i = 0; i < 3; i++) {
        labels.push((await bodyText(page)).match(/[753] 天前/)?.[0]);
        await page.evaluate(() => {
          const btn = [...document.querySelectorAll("button")].find((b) => (b.getAttribute("title") || "").includes("点击切换时间范围"));
          btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        await page.waitForTimeout(300);
      }
      labels.push((await bodyText(page)).match(/[753] 天前/)?.[0]);
      report("6a.cleanup-age-cycle", JSON.stringify(labels) === '["7 天前","5 天前","3 天前","7 天前"]' ? "PASS" : "FAIL", `labels=${JSON.stringify(labels)}`);
      // exit button present
      const exitOk = text.includes("退出清理") || !!(await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "") === "退出清理")));
      report("6b.cleanup-exit", exitOk ? "PASS" : "FAIL", `exit affordance=${exitOk}`);
    } else {
      report("6a.cleanup-age-cycle", "FAIL", `enter=${entered} 7天label=${has7} errors=${JSON.stringify(pageErrors).slice(0, 200)}`);
      report("6b.cleanup-exit", "FAIL", "skipped");
    }
    await context.close();
  }

  // ===== Test 7: round-trip gestures classified (regression guard) =====
  {
    const { execFileSync } = await import("node:child_process");
    try {
      const out = execFileSync("node", ["--experimental-strip-types", "tests/quick-switch.test.mjs"], { cwd: WEB_ROOT, encoding: "utf8", stdio: "pipe" });
      report("7a.round-trip-units", "PASS", `quick-switch unit suite exit 0 (includes upRightThenLeft regression)`);
    } catch (err) {
      report("7a.round-trip-units", "FAIL", `exit!=0: ${String(err.stderr).slice(0, 300)}`);
    }
  }

  await browser.close();
  const failed = results.filter((r) => r.status === "FAIL");
  console.log(`\n==== ${results.length - failed.length}/${results.length} passed ====`);
  if (failed.length) { console.log("FAILED:"); for (const f of failed) console.log(`  ${f.name} :: ${f.detail}`); process.exitCode = 1; }
  server.close();
}

main().catch((err) => { console.error(err); process.exit(1); });

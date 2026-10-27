import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { chromium } from "playwright-core";
import { createServer } from "vite";

let server, browser;
before(async () => {
  const paths = process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
    : ["/opt/google/chrome/chrome", "/usr/bin/chromium", "/usr/bin/google-chrome"];
  let executablePath;
  for (const path of paths) { try { await access(path); executablePath = path; break; } catch {} }
  assert.ok(executablePath, "Requires an installed Chromium browser");
  server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)), server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  browser = await chromium.launch({ executablePath, headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

for (const width of [390, 1280]) test(`grouped pagination counts main sessions with many children (${width}px)`, async () => {
  const page = await browser.newPage({ viewport: { width, height: 844 }, locale: "zh-CN" });
  page.setDefaultTimeout(5000);
  const requests = [];
  await page.route("**/api/**", route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/sessions") {
      requests.push(url);
      const start = requests.length === 1 ? 6 : 10;
      const end = requests.length === 1 ? 10 : 15;
      return route.fulfill({ json: {
        total_count: 15 - start,
        items: Array.from({ length: end - start }, (_, offset) => {
          const i = start + offset;
          return { key: `main-${i}`, session_key: `main-${i}`, name: `Main ${i}`,
            updated_at: new Date(Date.UTC(2026, 9, 27 - i)).toISOString() };
        }),
      } });
    }
    return route.fulfill({ json: [] });
  });
  try {
    await page.goto(`${server.resolvedUrls.local[0]}tests/project-session-view.html?pagination=1`);
    await page.getByRole("button", { name: "Main 5", exact: true }).waitFor();
    const remaining = page.getByRole("button", { name: "还有 9 个会话", exact: true });
    await remaining.click();
    await page.getByRole("button", { name: "Main 9", exact: true }).waitFor();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].searchParams.get("before_time"), "2026-10-22T00:00:00.000Z");
    await page.getByRole("button", { name: /^还有 5 个会话/ }).click();
    await page.getByRole("button", { name: "Main 14", exact: true }).waitFor();
    assert.equal(requests.length, 2);
    assert.equal(requests[1].searchParams.get("before_time"), "2026-10-18T00:00:00.000Z");
    assert.ok(requests.every(url => url.searchParams.get("top_level") === "1" && url.searchParams.get("include_children") === "1"));
    await page.getByRole("button", { name: "收起", exact: true }).click();
    await remaining.waitFor();
    assert.equal(await page.getByRole("button", { name: "Main 14", exact: true }).count(), 0);
    assert.equal(requests.length, 2, "Collapsing a fully loaded project must not fetch again");
  } finally { await page.close(); }
});

for (const width of [390, 1280]) for (const view of ["single", "grouped", "flat"]) test(`detach child from ${view} session list (${width}px)`, async () => {
  const page = await browser.newPage({ viewport: { width, height: 844 }, locale: "zh-CN" });
  page.setDefaultTimeout(10000);
  const requests = [];
  let fail = true;
  await page.addInitScript(view => { if (view === "flat") localStorage.setItem("mindfs-project-session-view", "flat"); }, view);
  await page.route("**/api/**", route => {
    if (route.request().url().includes("/child/detach")) {
      requests.push({ url: route.request().url(), method: route.request().method() });
      return fail ? route.fulfill({ status: 500, json: { error: "failed" } }) : route.fulfill({ json: { key: "child", parent_session_key: "", parent_tool_call_id: "" } });
    }
    return route.fulfill({ json: [] });
  });
  try {
    await page.goto(`${server.resolvedUrls.local[0]}tests/project-session-view.html${view === "single" ? "?single=1" : ""}`);
    const child = page.getByRole("button", { name: "Child session", exact: true }).locator("../..");
    const parent = page.getByRole("button", { name: "B newest", exact: true }).locator("../..");
    await parent.getByRole("button", { name: "会话菜单", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "分离为独立会话", exact: true }).count(), 0);
    await parent.getByRole("button", { name: "会话菜单", exact: true }).click();
    await child.getByRole("button", { name: "会话菜单", exact: true }).click();
    await page.getByRole("button", { name: "分离为独立会话", exact: true }).click();
    await page.getByText("detach failed", { exact: true }).waitFor();
    await child.getByRole("button", { name: "会话菜单", exact: true }).click();
    fail = false;
    await page.getByRole("button", { name: "分离为独立会话", exact: true }).click();
    await page.getByText("detached", { exact: true }).waitFor();
    await child.getByRole("button", { name: "会话菜单", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "分离为独立会话", exact: true }).count(), 0);
    assert.equal(requests.length, 2);
    assert.ok(requests.every(request => request.method === "POST" && new URL(request.url).searchParams.get("root") === "b"));
  } finally { await page.close(); }
});

for (const width of [390, 1280]) test(`project view switching, global ordering and pagination (${width}px)`, async () => {
  const page = await browser.newPage({ viewport: { width, height: 844 }, locale: "zh-CN" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", (route) => route.fulfill({ json: [] }));
  const openViewSettings = async () => {
    await page.locator('[data-onboarding="sidebar-menu"]').click();
    await page.getByRole("button", { name: "会话与输入", exact: true }).click();
  };
  try {
    await page.goto(`${server.resolvedUrls.local[0]}tests/project-session-view.html`);
    assert.equal(await page.getByRole("button", { name: "分组", exact: true }).count(), 0);
    await openViewSettings();
    await page.getByRole("button", { name: "多项目会话列表 分组", exact: true }).click();
    await page.getByRole("button", { name: "多项目会话列表 平铺", exact: true }).waitFor();
    await page.locator('[data-onboarding="sidebar-menu"]').click();
    const rows = page.locator("[data-session-key]");
    assert.deepEqual(await rows.evaluateAll((nodes) => nodes.map((node) => `${node.dataset.sessionRoot}:${node.dataset.sessionKey}`)),
      ["a:pinned", "b:same", "a:same", "b:child", "a:fallback"]);
    assert.equal(await page.getByRole("button", { name: /^Project [AB]$/ }).count(), 0);
    await page.getByRole("button", { name: "A recent", exact: true }).click();
    assert.equal(await page.locator("output").textContent(), "a:same");
    await page.getByRole("button", { name: "加载更多", exact: true }).click();
    await page.getByRole("button", { name: "Loaded session", exact: true }).waitFor();
    assert.deepEqual(await rows.evaluateAll((nodes) => nodes.map((node) => node.dataset.sessionKey)),
      ["pinned", "same", "same", "child", "fallback", "older"]);
    assert.equal(await page.getByRole("button", { name: "加载更多", exact: true }).count(), 0);
    const pinRow = rows.filter({ has: page.getByRole("button", { name: "Loaded session", exact: true }) });
    await pinRow.getByRole("button", { name: "会话菜单", exact: true }).click();
    await pinRow.getByRole("button", { name: "置顶", exact: true }).click();
    assert.deepEqual(await rows.evaluateAll((nodes) => nodes.map((node) => `${node.dataset.sessionRoot}:${node.dataset.sessionKey}`)),
      ["a:older", "a:pinned", "b:same", "a:same", "b:child", "a:fallback"]);
    await pinRow.getByRole("button", { name: "会话菜单", exact: true }).click();
    await pinRow.getByRole("button", { name: "取消置顶", exact: true }).click();
    assert.deepEqual(await rows.evaluateAll((nodes) => nodes.map((node) => `${node.dataset.sessionRoot}:${node.dataset.sessionKey}`)),
      ["a:pinned", "b:same", "a:same", "b:child", "a:fallback", "a:older"]);
    await page.reload();
    await rows.first().waitFor();
    await openViewSettings();
    await page.getByRole("button", { name: "多项目会话列表 平铺", exact: true }).click();
    await page.getByRole("button", { name: "多项目会话列表 关闭", exact: true }).click();
    await page.getByRole("button", { name: "多项目会话列表 分组", exact: true }).waitFor();
    await page.locator('[data-onboarding="sidebar-menu"]').click();
    assert.equal(await rows.count(), 0);
    assert.equal(await page.getByRole("button", { name: "Project A", exact: true }).count(), 1);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

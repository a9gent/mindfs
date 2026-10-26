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

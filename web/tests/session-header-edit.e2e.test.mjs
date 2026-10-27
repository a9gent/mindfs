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

async function fixture(mobile = false) {
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 844 }, locale: "zh-CN" });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (value) => { window.fixtureCopied = value; } } });
    const original = document.execCommand.bind(document);
    document.execCommand = (command, ...args) => {
      if (command === "copy") { window.fixtureCopied = document.activeElement?.value; return true; }
      return original(command, ...args);
    };
  });
  await page.goto(`${server.resolvedUrls.local[0]}tests/session-edit.html`);
  return { page, errors };
}

for (const mobile of [false, true]) test(`header menu actions and rename (${mobile ? "mobile" : "desktop"})`, async () => {
  const { page, errors } = await fixture(mobile);
  try {
    const menu = page.getByRole("button", { name: "会话菜单", exact: true });
    const action = async (name) => { await menu.click(); await page.getByRole("button", { name, exact: true }).click(); };
    await action("复制会话 ID");
    await page.waitForFunction(() => window.fixtureCopied === "edit-check");
    await action("复制会话路径");
    await page.waitForFunction(() => window.fixtureCopied === "/fixture/session.log");
    await action("重命名");
    const rename = page.getByRole("textbox", { name: "重命名", exact: true });
    await rename.fill("Renamed session");
    await rename.press("Enter");
    await page.getByRole("heading", { name: /Renamed session/ }).waitFor();
    assert.equal((await page.evaluate(() => window.editCheck.headerActions)).filter(([op]) => op === "rename").length, 1);
    await action("重命名"); await rename.fill("Cancelled"); await rename.press("Escape");
    assert.equal(await rename.count(), 0);
    await page.evaluate(() => { window.editCheck.renameFail = true; });
    await action("重命名"); await rename.fill("Failed rename"); await rename.press("Enter");
    await page.waitForFunction(() => window.editCheck.headerActions.filter(([op]) => op === "rename").length === 2);
    assert.equal(await rename.isVisible(), true);
    await rename.press("Escape");
    await action("会话接力包");
    await action("定时任务");
    await action("删除");
    assert.deepEqual((await page.evaluate(() => window.editCheck.headerActions)).slice(-3), [["handoff"], ["scheduled"], ["delete"]]);
    await menu.click(); await page.keyboard.press("Escape");
    assert.equal(await menu.getAttribute("aria-expanded"), "false");
    await page.evaluate(() => window.editCheck.empty());
    await menu.waitFor({ state: "detached" });
    await page.evaluate(() => window.editCheck.restore());
    await menu.waitFor();
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const mobile of [false, true]) test(`detach appears only for child sessions in header (${mobile ? "mobile" : "desktop"})`, async () => {
  const { page, errors } = await fixture(mobile);
  try {
    const menu = page.getByRole("button", { name: "会话菜单", exact: true });
    const detach = page.getByRole("button", { name: "分离为独立会话", exact: true });
    await menu.click(); assert.equal(await detach.count(), 0);
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.editCheck.child());
    await menu.click(); await detach.click();
    assert.deepEqual(await page.evaluate(() => window.editCheck.headerActions), [["detach"]]);
    await menu.click(); assert.equal(await detach.count(), 0);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

for (const mobile of [false, true]) test(`fork choices and delete confirmation (${mobile ? "mobile" : "desktop"})`, async () => {
  const { page, errors } = await fixture(mobile);
  try {
    const fork = page.getByRole("button", { name: "从此消息 fork", exact: true }).last();
    await fork.click();
    const popup = page.getByRole("dialog", { name: "从此消息 fork" });
    await popup.waitFor();
    assert.equal((await page.evaluate(() => window.editCheck.headerActions)).length, 0);
    const rect = await popup.boundingBox();
    assert.ok(rect.width < 200 && rect.height <= 30);
    assert.ok(rect.x >= 0 && rect.x + rect.width <= (mobile ? 390 : 1280));
    await page.keyboard.press("Escape"); await popup.waitFor({ state: "detached" });
    await fork.click(); await page.getByRole("button", { name: "子会话", exact: true }).click();
    await fork.click(); await page.getByRole("button", { name: "独立会话", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.editCheck.headerActions), [["fork", 4, false], ["fork", 4, true]]);
    await fork.click(); await page.getByRole("heading", { name: /Edit check/ }).click();
    await popup.waitFor({ state: "detached" });

    const dialog = page.getByRole("alertdialog");
    const openDelete = async (kind) => { await page.evaluate(kind => window.editCheck.openDelete(kind), kind); await dialog.waitFor(); };
    await openDelete("parent");
    await page.getByRole("radio", { name: "全部删除", exact: true }).waitFor();
    await page.getByRole("radio", { name: "只删主会话", exact: true }).check();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal((await page.evaluate(() => window.editCheck.headerActions)).length, 2);
    await openDelete("parent");
    await dialog.getByRole("button", { name: "删除", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await openDelete("parent");
    await page.getByRole("radio", { name: "只删主会话", exact: true }).check();
    await dialog.getByRole("button", { name: "删除", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    for (const kind of ["child", "single"]) {
      await openDelete(kind);
      await dialog.getByRole("button", { name: "删除", exact: true }).click();
      assert.equal(await dialog.getByRole("radio").count(), 0);
      await dialog.waitFor({ state: "detached" });
    }
    assert.deepEqual((await page.evaluate(() => window.editCheck.headerActions)).slice(2), [["confirmDelete", false], ["confirmDelete", true], ["confirmDelete", false], ["confirmDelete", false]]);
    await openDelete("error");
    await dialog.getByText("无法检查会话信息，请关闭后重试。").waitFor();
    assert.equal(await dialog.getByRole("button", { name: "删除", exact: true }).isDisabled(), true);
    await page.keyboard.press("Escape"); await dialog.waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("message editing shortcuts preserve IME, cancellation and prevent duplicate submits", async () => {
  const { page, errors } = await fixture();
  try {
    await page.getByRole("button", { name: "编辑消息", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "编辑消息", exact: true });
    await editor.fill("Changed"); await editor.press("Shift+Enter");
    assert.equal(await editor.inputValue(), "Changed\n");
    assert.equal(await page.evaluate(() => window.editCheck.requests.length), 0);
    await editor.evaluate((node) => {
      node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
      node.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true }));
      node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true }));
    });
    assert.equal(await editor.isVisible(), true);
    assert.equal(await page.evaluate(() => window.editCheck.requests.length), 0);
    await editor.press("Escape"); assert.equal(await editor.count(), 0);
    await page.getByRole("button", { name: "编辑消息", exact: true }).click();
    await editor.fill("   "); await editor.press("Enter");
    assert.equal(await page.evaluate(() => window.editCheck.requests.length), 0);
    await editor.fill("New content");
    await page.evaluate(() => { window.editCheck.deferEdit = true; });
    await editor.evaluate((node) => { for (let i = 0; i < 2; i++) node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    await page.waitForFunction(() => window.editCheck.requests.length === 1);
    assert.equal(await editor.isDisabled(), true);
    await page.evaluate(() => window.editCheck.releaseEdit());
    await editor.waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => window.editCheck.requests.length), 1);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("failed edit retains draft and supports retry", async () => {
  const { page } = await fixture();
  try {
    await page.getByRole("button", { name: "编辑消息", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "编辑消息", exact: true });
    await editor.fill("Retry this");
    await page.evaluate(() => { window.editCheck.fail = true; });
    await editor.press("Enter"); await page.getByRole("alert").waitFor();
    assert.equal(await editor.inputValue(), "Retry this");
    await page.evaluate(() => { window.editCheck.fail = false; });
    await editor.press("Enter"); await editor.waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => window.editCheck.requests.length), 2);
  } finally { await page.close(); }
});

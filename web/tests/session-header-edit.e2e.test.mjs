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

import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { chromium } from "playwright-core";
import { createServer } from "vite";

const browserPaths =
  process.platform === "darwin"
    ? [
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ]
    : [
        "/opt/google/chrome/chrome",
        "/usr/bin/chromium",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
      ];

const fixtureRoot = fileURLToPath(new URL("./lexical-ime", import.meta.url));

let server;
let browser;
let browserPath;

before(async () => {
  for (const candidate of browserPaths) {
    try {
      await access(candidate);
      browserPath = candidate;
      break;
    } catch {
      // 按平台选择已安装的 Chromium；不下载测试浏览器。
    }
  }
  assert.ok(browserPath, "This E2E requires an installed Chromium browser");
  server = await createServer({
    configFile: false,
    root: fixtureRoot,
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  browser = await chromium.launch({
    executablePath: browserPath,
    headless: true,
    ...(process.platform === "linux" ? { args: ["--no-sandbox"] } : {}),
  });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

async function openProbe() {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.locator(".token-editor-input").focus();
  const cdp = await page.context().newCDPSession(page);
  const state = () => page.evaluate(() => window.__lexicalImeProbe);
  return { page, cdp, state, pageErrors };
}

async function commitRawImeText(cdp, text) {
  // 讯飞先结束空组合、再 insertText 提交英文；旧版 Lexical 会延迟删除已重新写入的空框节点。
  // 此处复现真实事件顺序，验证 Lexical 在回收空节点前重新检查节点内容（上游 #8701）。
  await cdp.send("Input.imeSetComposition", {
    text,
    selectionStart: text.length,
    selectionEnd: text.length,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
  await cdp.send("Input.insertText", { text });
}

test("空框的讯飞式空 compositionend 后提交英文不会丢失或发送", async () => {
  const { page, cdp, state, pageErrors } = await openProbe();
  try {
    await commitRawImeText(cdp, "hello");
    await page.waitForTimeout(80); // 覆盖 Lexical 延迟 20ms 的空节点回收。
    let result = await state();
    assert.deepEqual(pageErrors, []);
    assert.ok(result.events.includes("compositionend:::"), JSON.stringify(result.events));
    assert.ok(
      result.events.includes("beforeinput:hello:insertText:false"),
      JSON.stringify(result.events),
    );
    assert.equal(result.text, "hello", JSON.stringify(result.events));
    assert.equal(result.submitCount, 0);
    await page.waitForTimeout(200); // 越过 120ms 的 IME Enter 守卫窗口。
    await page.keyboard.press("Enter");
    result = await state();
    assert.equal(result.submitCount, 1);
    assert.equal(result.text, "hello");
  } finally {
    await page.close();
  }
});

test("已有正文的组合提交不重复，真正取消组合仍保持空框", async () => {
  const first = await openProbe();
  try {
    await first.cdp.send("Input.insertText", { text: "prefix" });
    await commitRawImeText(first.cdp, "hello");
    await first.page.waitForTimeout(80);
    assert.equal((await first.state()).text, "prefixhello");
    assert.equal((await first.state()).submitCount, 0);
    assert.deepEqual(first.pageErrors, []);
  } finally {
    await first.page.close();
  }

  const cancelled = await openProbe();
  try {
    await cancelled.cdp.send("Input.imeSetComposition", {
      text: "ni",
      selectionStart: 2,
      selectionEnd: 2,
    });
    await cancelled.cdp.send("Input.imeSetComposition", {
      text: "",
      selectionStart: 0,
      selectionEnd: 0,
    });
    await cancelled.page.waitForTimeout(80);
    assert.equal((await cancelled.state()).text, "");
    assert.equal((await cancelled.state()).submitCount, 0);
    assert.deepEqual(cancelled.pageErrors, []);
  } finally {
    await cancelled.page.close();
  }
});

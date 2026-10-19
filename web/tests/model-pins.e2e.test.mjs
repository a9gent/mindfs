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

for (const mobile of [false, true]) test(`model pinning preserves selection, search and Agent isolation (${mobile ? "mobile" : "desktop"})`, async () => {
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 844 }, locale: "zh-CN" });
  const pins = { codex: ["model-2"], claude: [] };
  page.setDefaultTimeout(10000);
  let failSave = false;
  let agentsReads = 0;
  let pinReads = 0;
  await page.route("**/api/agents", async (route) => {
    agentsReads++;
    const models = Array.from({ length: 12 }, (_, i) => ({ id: `model-${i}`, name: `Model ${i}`, description: `Description ${i}` }));
    return route.fulfill({ json: ["codex", "claude"].map((name) => ({ name, installed: true, available: true, models, pinned_models: pins[name] })) });
  });
  await page.route("**/api/preferences/model-pins*", async (route) => {
    const request = route.request();
    if (request.method() === "PUT") {
      if (failSave) return route.fulfill({ status: 500, json: { error: "save failed" } });
      const { agent, model, pinned } = request.postDataJSON();
      pins[agent] = [...pins[agent].filter((id) => id !== model), ...(pinned ? [model] : [])];
      return route.fulfill({ json: { models: pins[agent] } });
    }
    pinReads++;
    return route.fulfill({ status: 405, json: {} });
  });
  try {
    await page.goto(`${server.resolvedUrls.local[0]}tests/model-pins.html`);
    const trigger = page.locator("main button").first();
    await trigger.click();
    const pin = (i, pinned = false) => page.getByRole("button", { name: `${pinned ? "取消置顶" : "置顶模型"}：Model ${i}`, exact: true });
    await pin(2, true).waitFor();
    const modelNames = () => page.getByRole("button").filter({ hasText: /^Model \d+Description \d+$/ }).allTextContents();
    assert.match((await modelNames())[0], /^Model 2/);
    await pin(1).click();
    await pin(1, true).waitFor();
    assert.equal(await page.getByTestId("selection").textContent(), "");
    assert.match((await modelNames())[0], /^Model 1/); // stable original order within pins
    await page.getByPlaceholder("搜索模型...").fill("Model 2");
    assert.equal((await modelNames()).length, 1);
    await page.getByPlaceholder("搜索模型...").fill("");
    await pin(1, true).click();
    await pin(1).waitFor();
    assert.match((await modelNames())[0], /^Model 2/);
    failSave = true;
    await pin(0).click();
    await page.getByRole("alert").waitFor();
    assert.equal(await pin(0).getAttribute("aria-pressed"), "false");
    assert.equal(await page.getByTestId("selection").textContent(), "");
    failSave = false;
    await trigger.click();
    await trigger.click();
    await pin(2, true).waitFor(); // retained in memory without another request
    await page.getByRole("button", { name: "展开 claude 模型列表", exact: true }).click();
    await pin(2).waitFor();
    assert.match((await modelNames())[0], /^Model 0/);
    await page.getByRole("button", { name: "Model 0 Description 0", exact: true }).click();
    assert.equal(await page.getByTestId("selection").textContent(), "claude:model-0");
    assert.equal(agentsReads, 1);
    assert.equal(pinReads, 0, "opening model menus must not fetch pins");
    const cacheCheck = await page.evaluate(async () => {
      const prefs = await import("/src/services/preferences.ts");
      const { appPath } = await import("/src/services/base.ts");
      const beforeSave = prefs.getModelPinsRevision();
      await prefs.setModelPinned("codex", "model-3", true);
      prefs.hydrateModelPins([{ name: "codex", pinned_models: [] }], appPath("/"), beforeSave);
      const staleResponsePreservedPin = prefs.getModelPins("codex").includes("model-3");
      prefs.hydrateModelPins([{ name: "codex", pinned_models: [] }], appPath("/"), prefs.getModelPinsRevision());
      return { staleResponsePreservedPin, refreshed: prefs.getModelPins("codex") };
    });
    assert.equal(cacheCheck.staleResponsePreservedPin, true);
    assert.deepEqual(cacheCheck.refreshed, []);
  } finally { await page.close(); }
});

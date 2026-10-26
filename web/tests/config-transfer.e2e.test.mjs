import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
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

const baseArchive = { format: "mindfs-user-config", version: 1, created_at: "2026-10-26T00:00:00Z", platform: "darwin", sections: {} };

for (const mobile of [false, true]) test(`configuration transfer selection and import (${mobile ? "mobile" : "desktop"})`, async () => {
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, locale: "zh-CN" });
  page.setDefaultTimeout(10000);
  let exportRequest;
  const imports = [];
  let failImport = true;
  await page.route("**/api/config/export", route => {
    exportRequest = route.request().postDataJSON();
    return route.fulfill({ json: { ...baseArchive, sections: Object.fromEntries(exportRequest.categories.map(c => [c, c === "api_keys" ? { p: "explicit-secret" } : {}])) } });
  });
  await page.route("**/api/config/import", route => {
    imports.push(route.request().postDataJSON());
    return route.fulfill(failImport ? { status: 400, json: { error: "Import rejected" } } : { json: { restart_required: true } });
  });
  try {
    await page.goto(`${server.resolvedUrls.local[0]}tests/config-transfer.html`);
    await page.getByRole("dialog").waitFor();
    assert.equal(await page.getByRole("heading", { name: "配置导出与导入" }).count(), 0);
    assert.equal(await page.getByText("从原设备导出，在新设备恢复所选配置", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).count(), 1);
    await page.mouse.click(page.viewportSize().width - 10, 20);
    await page.getByRole("dialog").waitFor({ state: "visible" });
    await page.evaluate(() => {
      localStorage.setItem("mindfs_token", "never-export-me");
      localStorage.setItem("mindfs-appearance-mode", "meadow");
    });
    const checkbox = name => page.getByRole("checkbox", { name, exact: false });
    assert.equal(await page.getByRole("checkbox").count(), 15);
    assert.equal(await page.getByRole("checkbox", { checked: true }).count(), 7);
    assert.equal(await checkbox("API Key").isChecked(), false);
    const downloadEvent = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出所选配置", exact: true }).click();
    const download = await downloadEvent;
    const text = await readFile(await download.path(), "utf8");
    const exported = JSON.parse(text);
    assert.equal(exported.browser.appearance["mindfs-appearance-mode"], "meadow");
    assert.equal(text.includes("never-export-me"), false);
    assert.equal(exportRequest.categories.includes("api_keys"), false);
    assert.equal(exportRequest.categories.includes("custom_agents"), false);
    await checkbox("API Key").check();
    const explicitEvent = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出所选配置", exact: true }).click();
    const explicit = JSON.parse(await readFile(await (await explicitEvent).path(), "utf8"));
    assert.equal(explicit.sections.api_keys.p, "explicit-secret");

    await page.getByRole("tab", { name: "导入配置", exact: true }).click();
    const archive = {
      ...baseArchive,
      sections: { projects: { dirs: [{ id: "repo", name: "Repo", root_path: "/missing/repo" }], order: ["repo"] }, api_keys: { p: "secret" }, custom_agents: { agents: [{ name: "custom", command: "custom-agent", protocol: "acp" }] } },
      browser: { appearance: { "mindfs-appearance-mode": "moss" } },
    };
    const upload = content => page.locator('input[type="file"]').setInputFiles({ name: "settings.json", mimeType: "application/json", buffer: Buffer.from(content) });
    await upload(JSON.stringify(archive));
    await checkbox("界面偏好").waitFor();
    assert.equal(imports.length, 0, "choosing a file must not import anything");
    assert.equal(await page.getByRole("checkbox").count(), 3);
    assert.equal(await checkbox("项目列表与偏好").count(), 0);
    assert.equal(await page.getByRole("textbox").count(), 0, "project path editing is removed");
    assert.equal(await page.getByText("新设备项目路径（目录需已存在）", { exact: true }).count(), 0);
    assert.equal(await page.getByText(/导入将替换所选类别/).count(), 0);
    assert.equal(await page.getByText(/所选内容可能包含 API Key/).count(), 0);
    assert.equal(await page.getByRole("status").textContent(), "需要重启 MindFS");
    assert.equal(await page.getByRole("checkbox", { checked: true }).count(), 3, "every category present in the imported file is selected by default");
    await checkbox("API Key").uncheck();
    await page.getByRole("button", { name: "恢复默认选择", exact: true }).click();
    assert.equal(await page.getByRole("checkbox", { checked: true }).count(), 3);
    await page.getByRole("tab", { name: "导出配置", exact: true }).click();
    assert.equal(await checkbox("API Key").isChecked(), false, "export keeps its original defaults");
    await page.getByRole("tab", { name: "导入配置", exact: true }).click();
    assert.equal(await page.getByRole("checkbox", { checked: true }).count(), 3);
    await checkbox("API Key").uncheck();
    await page.getByRole("button", { name: "导入所选配置", exact: true }).click();
    await page.getByRole("alert").waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem("mindfs-appearance-mode")), "meadow", "failed server import must restore browser settings");
    assert.deepEqual(imports[0].categories, ["custom_agents"]);
    assert.equal(imports[0].archive.sections.projects, undefined, "missing old project directories must not block import");
    assert.equal(imports[0].archive.browser, undefined);
    assert.equal(imports[0].archive.sections.api_keys, undefined, "unselected secrets must not be sent to the destination");
    failImport = false;
    await page.getByRole("button", { name: "导入所选配置", exact: true }).click();
    await page.getByRole("button", { name: "刷新页面", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem("mindfs-appearance-mode")), "moss");
    assert.match(await page.getByRole("status").textContent(), /重启 MindFS/);
    const bounds = await page.getByRole("dialog").boundingBox();
    const sidebar = await page.getByTestId("sidebar").boundingBox();
    assert.ok(bounds.x >= sidebar.x && bounds.x + bounds.width <= sidebar.x + sidebar.width, "settings stay within the sidebar");
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= page.viewportSize().width && bounds.height <= page.viewportSize().height);
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("tab", { name: "导入配置", exact: true }).click();
    await upload(JSON.stringify({ ...baseArchive, sections: { projects: archive.sections.projects }, browser: archive.browser }));
    await checkbox("界面偏好").waitFor();
    assert.equal(await page.getByRole("checkbox", { checked: true }).count(), 1);
    assert.equal(await page.getByRole("status").count(), 0, "ordinary preferences do not show a restart hint");
    const previousImports = imports.length;
    await page.getByRole("button", { name: "导入所选配置", exact: true }).click();
    await page.getByRole("button", { name: "刷新页面", exact: true }).waitFor();
    assert.equal(imports.length, previousImports, "project-only server data is never sent");
    assert.equal(await page.getByRole("status").count(), 0);
    await upload(JSON.stringify({ ...baseArchive, sections: { projects: archive.sections.projects } }));
    await page.getByRole("alert").waitFor();
    assert.equal(await page.getByRole("button", { name: "导入所选配置", exact: true }).isDisabled(), true);
    await upload("not JSON");
    await page.getByRole("alert").waitFor();
    assert.equal(await page.getByRole("button", { name: "导入所选配置", exact: true }).isDisabled(), true);
  } finally { await page.close(); }
});

import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { chromium } from "playwright-core";
import { createServer } from "vite";

let server, browser;
before(async () => {
  const candidates = process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
    : ["/opt/google/chrome/chrome", "/usr/bin/chromium", "/usr/bin/google-chrome"];
  let executablePath;
  for (const path of candidates) { try { await access(path); executablePath = path; break; } catch {} }
  assert.ok(executablePath, "Requires an installed Chromium browser");
  server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)), server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  browser = await chromium.launch({ executablePath, headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

for (const mobile of [false, true]) test(`sidebar categories preserve settings and actions (${mobile ? "mobile" : "desktop"})`, async () => {
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 680 } : { width: 1280, height: 900 }, locale: "zh-CN" });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    const json = path.endsWith("idle-session-resource-release") ? { hours: 72 }
      : path.endsWith("new-project-meta-location") ? { location: "project" }
      : path.includes("web-push") ? { enabled: false, supported: false }
      : [];
    return route.fulfill({ json });
  });
  const menu = () => page.getByRole("group", { name: "侧栏菜单", exact: true });
  const group = name => page.getByRole("group", { name, exact: true });
  const openMenu = () => page.locator('[data-onboarding="sidebar-menu"]').click();
  const openCategory = async name => {
    const trigger = menu().getByRole("button", { name, exact: true });
    assert.equal(await trigger.locator(":scope > svg").count(), 2, "category keeps its icon and expand arrow");
    await trigger.click();
    assert.deepEqual(await group(name).getByRole("button").evaluateAll(buttons => buttons
      .filter(button => button.textContent.trim() && button.firstElementChild?.tagName.toLowerCase() === "svg")
      .map(button => button.textContent.trim())), [], "expanded menu items have no leading icons");
  };
  const firstLabels = scope => scope.locator(":scope > button, :scope > div[data-menu-category] > button:first-child").evaluateAll(buttons => buttons.map(button => button.querySelector("span")?.textContent));
  try {
    await page.goto(`${server.resolvedUrls.local[0]}tests/sidebar-menu.html`);
    await openMenu();
    assert.deepEqual(await firstLabels(menu()), ["添加项目", "项目与文件", "Agent 管理", "会话与输入", "界面显示", "连接与通知", "配置导出与导入", "使用引导"]);
    assert.equal(await menu().getByRole("button", { expanded: true }).count(), 0);

    await openCategory("项目与文件");
    assert.deepEqual(await firstLabels(group("项目与文件")), ["全局排序", "显示隐藏文件", "双栏 diff 视图", "新项目数据位置"]);
    const hidden = group("项目与文件").getByRole("button", { name: "显示隐藏文件" });
    await hidden.click();
    assert.equal(await hidden.getAttribute("aria-pressed"), "true");
    await group("项目与文件").getByRole("button", { name: "双栏 diff 视图" }).click();
    assert.equal(await group("项目与文件").getByRole("button", { name: "双栏 diff 视图" }).getAttribute("aria-pressed"), "true");
    await group("项目与文件").getByRole("button", { name: /^全局排序/ }).click();
    assert.equal(await group("项目与文件").locator('button[data-menu-order="10"]').count(), 7);

    await openCategory("Agent 管理");
    assert.equal(await group("项目与文件").count(), 0, "opening another category collapses the previous category");
    assert.deepEqual(await firstLabels(group("Agent 管理")), ["添加配置", "切换配置并重启", "安装和更新"]);
    await openCategory("会话与输入");
    assert.equal(await group("Agent 管理").count(), 0);
    assert.deepEqual(await firstLabels(group("会话与输入")), ["会话自动命名", "空闲会话释放", "多项目会话列表", "输入框蓝环手势", "回车键发送", "发送快捷键"]);
    const multiProject = () => group("会话与输入").getByRole("button", { name: /^多项目会话列表 / });
    assert.equal(await multiProject().textContent(), "多项目会话列表关闭");
    for (const state of ["分组", "平铺", "关闭", "分组"]) {
      await multiProject().click();
      assert.equal(await multiProject().textContent(), `多项目会话列表${state}`);
      assert.equal(await multiProject().getAttribute("aria-pressed"), state === "关闭" ? "false" : "true");
      assert.equal(await multiProject().getAttribute("aria-expanded"), null);
      assert.equal(await group("会话与输入").getByRole("button", { name: /^会话展示模式/ }).count(), 0);
    }
    for (const name of ["回车键发送"]) {
      const button = group("会话与输入").getByRole("button", { name, exact: true });
      await button.click();
      assert.equal(await button.getAttribute("aria-pressed"), "true");
    }

    await openCategory("界面显示");
    assert.deepEqual(await firstLabels(group("界面显示")), ["外观", "字体大小", "语言", "交换左右侧边栏"]);
    await group("界面显示").getByRole("button", { name: /^外观/ }).click();
    assert.ok(await group("界面显示").getByRole("button").count() > 4);
    await group("界面显示").getByRole("button", { name: /^字体大小/ }).click();
    await group("界面显示").getByRole("button", { name: "增大主视图字体", exact: true }).click();
    assert.equal(await group("界面显示").getByText("110%", { exact: true }).count(), 1);
    await group("界面显示").getByRole("button", { name: "交换左右侧边栏", exact: true }).click();
    assert.equal(await group("界面显示").getByRole("button", { name: "交换左右侧边栏", exact: true }).getAttribute("aria-pressed"), "true");
    await openCategory("项目与文件");
    assert.equal(await group("项目与文件").locator('button[data-menu-order="10"]').count(), 1, "nested choices are reset on category changes");
    assert.equal(await group("项目与文件").getByRole("button", { name: "显示隐藏文件" }).getAttribute("aria-pressed"), "true");
    await openCategory("连接与通知");
    await group("连接与通知").getByText("公网访问本地服务", { exact: true }).waitFor();
    assert.equal(await group("连接与通知").getByText("开启通知", { exact: true }).count(), 1);

    // A short screen must scroll inside the menu and keep the direct actions reachable.
    await page.setViewportSize({ width: mobile ? 390 : 1280, height: 360 });
    await openCategory("会话与输入");
    const bounds = await menu().boundingBox();
    assert.ok(bounds.y + bounds.height <= 360, "menu must stay inside the viewport");
    assert.equal(await menu().evaluate(node => node.scrollHeight > node.clientHeight), true);
    await menu().getByRole("button", { name: "配置导出与导入", exact: true }).click();
    assert.equal(await menu().count(), 0);
    const dialog = page.getByRole("dialog", { name: "配置导出与导入" });
    await dialog.waitFor();
    const sidebar = await page.getByTestId("sidebar").boundingBox();
    const panel = await dialog.boundingBox();
    assert.ok(panel.x >= sidebar.x && panel.x + panel.width <= sidebar.x + sidebar.width);
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await page.setViewportSize({ width: mobile ? 390 : 1280, height: 680 });
    await openMenu();
    assert.equal(await menu().getByRole("button", { expanded: true }).count(), 0);
    await menu().getByRole("button", { name: "添加项目", exact: true }).click();
    assert.equal(await page.getByTestId("action").textContent(), "add-project");
    await openMenu();
    await menu().getByRole("button", { name: "使用引导", exact: true }).click();
    assert.equal(await page.getByTestId("action").textContent(), "guide");
    await page.evaluate(() => localStorage.setItem("mindfs-locale", "en-US"));
    await page.reload();
    await openMenu();
    for (const name of ["Projects & files", "Agent management", "Sessions & input", "Appearance & layout", "Connections & notifications"]) {
      const englishMenu = page.getByRole("group", { name: "Sidebar menu", exact: true });
      await englishMenu.getByRole("button", { name, exact: true }).click();
      assert.equal(await englishMenu.evaluate(node => node.scrollWidth <= node.clientWidth), true, `${name} should fit the menu width`);
    }
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

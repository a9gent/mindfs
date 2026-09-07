import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const fileTree = readFileSync(new URL("../src/components/FileTree.tsx", import.meta.url), "utf8");
const appShell = readFileSync(new URL("../src/layout/AppShell.tsx", import.meta.url), "utf8");
const fontSizeService = readFileSync(new URL("../src/services/fontSize.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");

for (const region of ["fileSidebar", "main", "sessionSidebar"]) {
  assert.match(fileTree, new RegExp(`region: "${region}"`), `${region} should have its own menu control`);
  assert.match(fontSizeService, new RegExp(`${region}: 1`), `${region} should default to 100%`);
}

assert.match(
  app,
  /useState<FontSizePreferences>\(loadFontSizePreferences\)[\s\S]*?persistFontSizePreferences\(fontSizePreferences\)/,
  "font size preferences should survive app reloads",
);
assert.match(
  appShell,
  /physicalLeftFontScale = sidebarsSwapped \? sessionSidebarFontScale : fileSidebarFontScale[\s\S]*?physicalRightFontScale = sidebarsSwapped \? fileSidebarFontScale : sessionSidebarFontScale/,
  "font sizes should follow logical sidebars when their physical positions are swapped",
);
assert.match(
  styles,
  /font-size: calc\(13px \* var\(--mindfs-font-scale, 1\)\) !important/,
  "region scaling should change text size without scaling icons or layout",
);
assert.match(fontSizeService, /FONT_SIZE_MIN = 0\.8[\s\S]*?FONT_SIZE_MAX = 1\.4[\s\S]*?FONT_SIZE_STEP = 0\.1/);

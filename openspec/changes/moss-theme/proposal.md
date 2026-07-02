## Why

MindFS 目前仅有浅色和深色两种外观模式，缺少护眼主题选项。用户长时间使用编辑器时，蓝光和高对比度容易导致视觉疲劳。增加一个偏绿色调的护眼主题「苔痕绿影」，能有效降低蓝光刺激，提供更舒适的阅读体验。

## What Changes

- 在 CSS 中新增 `:root[data-theme="moss"]` 主题变量，使用柔和绿色系调色板（低饱和度草绿/鼠尾绿/暖灰绿），降低蓝光比例，实现护眼效果。
- 扩展 `AppearanceMode` 类型，新增 `"moss"` 字面量，确保类型系统覆盖该模式。
- 更新外观选择 UI，增加「苔痕绿影」选项。
- 处理 ActionBar 中 `isDark` 推导逻辑，将 moss 主题归类为 light（浅色基调），保证输入区域样式正确。
- `themeColors` 映射新增 moss 主题色，`theme-color` meta 标签同步更新。

## Capabilities

### Modified Capabilities
- `appearance-theme`: 外观模式从 `"dark" | "light" | "system"` 扩展为 `"dark" | "light" | "system" | "moss"`
- `appearance-ui`: 外观菜单新增「苔痕绿影」选项
- `appearance-css`: CSS 变量表新增 moss 主题块

## Impact

- `web/src/services/appearance.ts` — 类型、集合、有效模式推导、主题色映射
- `web/src/index.css` — 新增 `:root[data-theme="moss"]` 完整变量块 + 代码块样式
- `web/src/components/FileTree.tsx` — APPEARANCE_OPTIONS 新增选项
- `web/src/components/ActionBar.tsx` — isDark 推导兼容 moss

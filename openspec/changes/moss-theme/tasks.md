## 实现任务

- [x] Task 1: CSS 变量 - 苔痕绿影主题
  - 在 `web/src/index.css` 新增 `:root[data-theme="moss"]` 主题变量块，定义柔和绿色系背景、文本、边框、面板、强调色、选择态、launcher 与代码块 token。
  - 新增 `:root[data-theme="moss"] pre[class*="language-"]` 与 `code[class*="language-"]` 覆盖样式。

- [x] Task 2: Appearance 类型扩展
  - 在 `web/src/services/appearance.ts` 中将 `AppearanceMode` 扩展为 `"dark" | "light" | "system" | "moss"`。
  - 将 `appearanceModes`、`themeColors`、`getEffectiveAppearanceMode` 与 `syncThemeColor` 纳入 moss 支持。

- [x] Task 3: UI 新增选项
  - 在 `web/src/components/FileTree.tsx` 的 `APPEARANCE_OPTIONS` 中新增 `{ value: "moss", label: "苔痕绿影" }`。

- [x] Task 4: ActionBar 兼容
  - 验证 `web/src/components/ActionBar.tsx` 使用 `getEffectiveAppearanceMode() === "dark"` 推导深色状态，moss 已按浅色基调处理，无需额外代码修改。

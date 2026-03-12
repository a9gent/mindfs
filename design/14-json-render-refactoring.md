# 14. 局部应用 JSON-Render 重构方案

## 背景与问题
目前前端的实现尝试将整个 App 结构（包括 Shell、Sidebar、RightSidebar 等）转化为一棵巨大的 `json-render` JSON 树（见 `defaultTree.ts`）。
这一实现存在以下问题：
1. **严重偏离规范**：为了实现交互，在构建 JSON 树时塞入了大量的 React 闭包函数（如 `onClick={() => { ... }}`），使得 JSON 不再是纯粹的、可序列化的配置结构。
2. **性能低下**：文件状态变更、会话消息追加等任何局部状态变更，都会导致一棵巨大的全局 JSON 树被反复重建。
3. **过度设计**：核心诉求其实只是“**仅主视图（Main View）需要支持动态定制，两侧边栏和默认视图保持固定**”，完全没必要把静态不变的外壳放入 JSON 解析引擎。

## 重构目标
将 `json-render` 的使用范围限制在**按需定制的主视图 (Main View)** 内，回归标准 React 混合局部动态渲染的模式。

## 架构调整方案

### 1. 废弃全局 `defaultTree.ts` 模式
取消将全局布局抽象为 `UITree` 的做法，让 `App.tsx` 回归标准的 React 声明式写法，直接组装静态外壳组件。

### 2. 重构 `App.tsx` 视图路由逻辑
`App.tsx` 根据当前的状态变量（如 `file`, `selectedSession`, `viewTree`）来决定 `<AppShell>` 的 `main` 区域到底渲染什么。只有当后端/AI下发了定制视图（`viewTree`）时，才挂载 `<JSONUIProvider>`。

**伪代码示例：**
```tsx
return (
  <AppShell
    sidebar={
      <FileTree 
        entries={rootEntries} 
        onSelectFile={handleOpenFile} // 标准 React 回调，直接操作 State
      />
    }
    rightSidebar={
      <SessionList 
        sessions={sessions} 
        onSelect={handleSelectSession} 
      />
    }
    main={
      // 核心路由逻辑：只在 Main 区域进行动态切换
      file ? (
        <FileViewer file={file} />
      ) : showSessionInMain ? (
        <SessionViewer session={selectedSession} />
      ) : viewTree ? (
        // [核心]：只有定制化界面，才受 json-render 驱动
        <JSONUIProvider registry={registry} initialData={{}} actionHandlers={actionHandlers}>
          <Renderer tree={viewTree} registry={registry} />
        </JSONUIProvider>
      ) : (
        <DefaultListView entries={mainEntries} />
      )
    }
  />
);
```

### 3. 精简 `registry.tsx` 组件库
目前的组件库混杂了布局组件和功能组件。重构后，不需要将 `Shell`, `Sidebar`, `Main` 注册给 JSON 解析器。
`registry` 里只需要注册**允许 AI 或后端在“主视图”中使用的组件**，例如 `Container`, `AssociationView`, `Button`, `MarkdownViewer` 等。极大降低组件库的耦合。

### 3.1 插件浮层组件的移动端兼容性约束
本次 `txt-novel` 插件的“章节目录”问题暴露出一个额外约束：`json-render` 本身负责的是 JSON 到组件树的映射，真正的兼容性风险集中在 `@json-render/shadcn` 这类基于 Radix Portal 的浮层组件实现上，而不是 JSON 渲染机制本身。

具体表现：
1. `Dialog` 底层依赖 `fixed + transform + portal` 的桌面式居中弹层。
2. QQ、Chrome、荣耀自带浏览器等移动端内核对这类定位组合的计算不一致，容易出现弹框跑到左上角、右下角、只显示局部等问题。
3. 单纯依赖全局 CSS 去重写 `dialog-content` 的定位规则不稳定，经常是修好一个浏览器、另一个浏览器又异常。

因此在重构后的 `registry` 设计中，需要把“移动端浮层策略”视为组件层职责，而不是插件个例：
1. **移动端 `Dialog` 默认降级为 `Drawer`**。桌面端保留 `Dialog`，移动端统一走底部抽屉式交互。
2. **插件主题样式必须同时覆盖 `dialog-content` 和 `drawer-content`**，避免移动端切换实现后出现透明、边框丢失、阴影缺失等表现不一致。
3. **`Popover` / `DropdownMenu` / `Select` 等 Portal 浮层只做尺寸和滚动约束，不强改定位**，减少浏览器兼容性抖动。

这个约束说明：`registry.tsx` 不只是“把组件暴露给 JSON 使用”，还承担了“按端能力选择稳定实现”的职责。后续如果继续扩展 `@json-render/shadcn` 组件，应优先在 registry 层做响应式包装，而不是在插件 CSS 中做浏览器定向修补。

### 3.2 对 `6bc57a7` 这次移动端适配提交的补充复盘
`6bc57a7 (adapt for mobile browser: plugin component, input bar)` 做了一次重要但不完全的移动端适配，值得单独记录：

1. **它解决的是插件组件“可用性”问题**。该提交在 `web/src/index.css` 中为插件视图补充了移动端样式约束，包括：
   - `Dialog` / `Drawer` / `Popover` / `DropdownMenu` / `Select` 的尺寸限制
   - `Tabs` / `ToggleGroup` / 表格等横向滚动处理
   - 输入框字号、按钮最小点击面积、分页换行等触屏友好性调整
2. **它同时暴露了插件浮层“实现策略”问题**。提交中对 `dialog-content` 使用了全局 CSS 重写，试图通过移动端强制居中规则修复弹框体验：
   - `top: 50dvh`
   - `left: 50vw`
   - `transform: translate(-50%, -50%)`
   - `max-height: min(80dvh, 32rem)`
3. **这套写法在主流移动浏览器上并不稳定**。QQ、Chrome、荣耀自带浏览器对 `dvh/vw + fixed + transform + portal` 的组合处理不一致，最终表现为：
   - 弹框跑到左上角或右下角
   - 只显示弹框局部
   - 同一套 CSS 在不同浏览器上互相打架
4. **因此，这次问题不是提交方向错误，而是修复层级选错了**：
   - 该提交对 `Tabs`、表格、按钮、输入框、横向滚动等普通插件组件的适配思路是正确的
   - 但 `Dialog` 这类 Portal 浮层不应继续依赖 CSS 层强改定位，而应在 registry / 组件层切换为更稳定的移动端实现

这意味着后续对插件组件的移动端治理应分成两类：
1. **普通组件**：继续沿用 `6bc57a7` 的 CSS 尺寸、滚动、触控优化思路。
2. **Portal 浮层组件**：从 `6bc57a7` 的“CSS 定位修补”升级为“组件层响应式降级”，例如移动端 `Dialog -> Drawer`。

从结果看，`6bc57a7` 可以视为“插件组件移动端适配的第一阶段”，它完成了基础可用性改造；而本次 `txt-novel` 目录问题则补齐了第二阶段结论：**浮层类组件必须在 registry 层做移动端实现分流，不能只靠 CSS 兜底。**

### 4. 彻底分离 Action 与 Props
*   **静态外壳（文件树、会话列表等）**：直接使用标准 React 闭包回调，直接操作 `App.tsx` 中的 State。
*   **定制化主视图 (`viewTree`)**：里面不再容忍任何 JS 函数，严格使用可序列化的 Action 定义（例如 `{"action": "open_file", "params": {"path": "..."}}`）。通过局部的 `<JSONUIProvider>` 中的 `actionHandlers` 来拦截并执行。

## 收益
*   **规范化**：`viewTree` 变为 100% 纯粹的可序列化 JSON，完全符合规范，可以直接在网络间传输给大模型。
*   **性能提升**：外壳交互回归 React 本源，极大降低不必要的 JSON Tree Diff 计算开销。
*   **边界清晰**：静态结构归 React，动态渲染归 JSON，职责分明。

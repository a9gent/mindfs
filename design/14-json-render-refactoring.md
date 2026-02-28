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

### 4. 彻底分离 Action 与 Props
*   **静态外壳（文件树、会话列表等）**：直接使用标准 React 闭包回调，直接操作 `App.tsx` 中的 State。
*   **定制化主视图 (`viewTree`)**：里面不再容忍任何 JS 函数，严格使用可序列化的 Action 定义（例如 `{"action": "open_file", "params": {"path": "..."}}`）。通过局部的 `<JSONUIProvider>` 中的 `actionHandlers` 来拦截并执行。

## 收益
*   **规范化**：`viewTree` 变为 100% 纯粹的可序列化 JSON，完全符合规范，可以直接在网络间传输给大模型。
*   **性能提升**：外壳交互回归 React 本源，极大降低不必要的 JSON Tree Diff 计算开销。
*   **边界清晰**：静态结构归 React，动态渲染归 JSON，职责分明。

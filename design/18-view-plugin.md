# 18. 视图插件系统

对应代码：`web/src/plugins/`

---

## 背景

当前视图路由（design/05）只能给文件匹配**静态 UITree JSON**，无法根据文件内容动态生成视图。
典型场景：打开任意 `.txt` 小说 → 自动提取章节目录 → 渲染可交互的章节列表。

核心矛盾：每本小说的章节标题不同，静态 JSON 无法表达"读取内容 → 提取结构 → 生成视图"这条管线。

## 设计目标

1. 一个插件 = 一个 JS 文件，包含匹配规则 + 处理函数
2. 按文件类型自动匹配，打开文件即生效，无需逐个交互
3. LLM 可通过一轮对话生成完整插件，写入 `.mindfs/plugins/` 后永久生效
4. 复用现有 json-render 渲染层（Registry + Renderer），不重复造轮子

---

## 目录结构

```
.mindfs/
└── plugins/
    ├── txt-novel.js          # 小说章节目录
    ├── csv-viewer.js         # CSV 表格视图
    └── json-tree.js          # JSON 树形浏览器
```

**文件夹即注册表**，前端先读取 `.mindfs/plugins/` 目录列表，再逐个加载 `.js` 插件文件，无需额外配置文件。

---

## 插件文件格式

一个插件导出一个对象，包含五个字段（`theme` 与 `fileLoadMode` 为必填）：

```js
// .mindfs/plugins/txt-novel.js
// 插件使用 CJS 格式，加载器通过 new Function('module','exports', code) 执行
module.exports = {
  // 1. 元信息
  name: "TXT 小说阅读器",

  // 2. 匹配规则（复用现有 MatchRule 语义）
  match: { ext: ".txt" },

  // 3. 文件加载模式（必填）
  fileLoadMode: "full", // "full" | "incremental"

  // 4. 主题令牌（必填，14 个字段）
  theme: {
    overlayBg: "rgba(0,0,0,0.56)",
    surfaceBg: "#ffffff",
    surfaceBgElevated: "#ffffff",
    text: "#0f172a",
    textMuted: "#475569",
    border: "rgba(15,23,42,0.12)",
    primary: "#2563eb",
    primaryText: "#ffffff",
    radius: "10px",
    shadow: "0 10px 30px rgba(2,6,23,.18)",
    focusRing: "rgba(37,99,235,.4)",
    danger: "#dc2626",
    warning: "#d97706",
    success: "#16a34a"
  },

  // 5. 处理函数：file → { data, tree }（纯函数，无副作用）
  process(file) {
    const chapters = [];
    file.content.split('\n').forEach((line, i) => {
      if (/^第.{1,10}[章回节]/.test(line.trim())) {
        chapters.push({ title: line.trim(), offset: i });
      }
    });

    return {
      // 结构化数据（供后续 agent 上下文注入使用，本期不实现）
      data: { chapters },

      // UITree JSON → 交给 Renderer 渲染
      tree: {
        root: "nav",
        elements: {
          nav: {
            type: "Stack",
            props: { gap: 1 },
            children: chapters.map((_, i) => `ch-${i}`)
          },
          ...Object.fromEntries(chapters.map((ch, i) => [
            `ch-${i}`,
            {
              type: "Button",
              props: { label: ch.title, variant: "ghost" },
              on: {
                press: {
                  action: "navigate",
                  params: { query: { chapter: i } }
                }
              }
            }
          ]))
        }
      }
    };
  }
};
```

### process 函数签名

```typescript
interface PluginInput {
  name: string;        // 文件名
  path: string;        // 文件路径
  content: string;     // 文件文本内容（UTF-8）
  ext: string;         // 扩展名
  mime: string;        // MIME 类型
  size: number;        // 文件大小（字节）
  truncated: boolean;  // 内容是否被截断
  next_cursor?: number; // 增量读取时下一段 cursor（字节）
  query?: Record<string, string>; // URL 中 vp_ 参数（去前缀后）
}

interface PluginOutput {
  data?: Record<string, unknown>;   // 结构化数据（预留）
  tree: UITree;                      // 视图树
}

type ProcessFn = (file: PluginInput) => PluginOutput;
```

**process 是纯函数**：无副作用，不访问网络、DOM、文件系统。所有 I/O 由框架在调用 process 之前完成。

### fileLoadMode 读取策略

插件通过 `fileLoadMode` 声明内容加载方式，框架在调用 `process` 前准备好 `file.content`：

| `fileLoadMode` | 框架行为 | `file.content` | 适用场景 |
|-----------|---------|----------------|---------|
| `"full"` | 调用 `/api/file?...&read=full` | 全量（后端负责完整读取与解码） | 章节目录、全文搜索、全局排序/分页 |
| `"incremental"` | 调用 `/api/file?...&read=incremental&cursor=...` | 一段内容（可截断） | 超大文本流式/窗口式读取 |

`incremental` 模式下，插件翻页/继续读取应使用：
- 当前分片的 `file.next_cursor`
- `navigate.params.cursor = file.next_cursor`

### match 规则

复用现有视图路由的 `MatchRule`（design/05），支持：

| 字段 | 示例 | 说明 |
|------|------|------|
| `ext` | `".txt"`, `".csv,.tsv"` | 扩展名，逗号分隔多个 |
| `path` | `"novels/**/*.txt"` | glob 路径匹配 |
| `mime` | `"text/*"` | MIME 类型，支持通配 |
| `name` | `"README*"` | 文件名 glob |
| `any` | `[{ext:".txt"}, {ext:".md"}]` | OR 组合 |
| `all` | `[{ext:".txt"}, {path:"novels/**"}]` | AND 组合 |

---

## 执行流程

```
用户打开文件
    │
    ▼
前端收到 FilePayload（name, path, content, ext, mime, size）
    │
    ▼
PluginManager.match(file) → 找到匹配插件？
    │                              │
    │ 无匹配                        │ 有匹配（按加载顺序取第一个）
    ▼                              ▼
FileViewer 正常渲染         plugin.process(file)
（CodeViewer / MarkdownViewer）     │
                                   ▼
                            返回 { data, tree }
                                   │
                                   ▼
                            Renderer 渲染 tree
                            （右上角显示插件名 + 切换入口）
```

---

## 前端 PluginManager

```typescript
interface ViewPlugin {
  name: string;
  match: MatchRule;
  process: (file: PluginInput) => PluginOutput;
}

class PluginManager {
  private plugins: ViewPlugin[] = [];

  // 启动时扫描 .mindfs/plugins/*.js 并加载
  async load(rootId: string): Promise<void>;

  // 根据文件信息查找匹配插件
  match(file: PluginInput): ViewPlugin | null;

  // 执行插件处理
  run(plugin: ViewPlugin, file: PluginInput): PluginOutput;

  // 插件列表（供 UI 显示）
  list(): ViewPlugin[];
}
```

### 加载方式

两步加载流程：

1. 请求 `.mindfs/plugins/` 目录的文件列表（`/api/tree` 接口）
2. 逐个请求文件内容并加载（`/api/file` 接口）

```typescript
async function loadPlugin(code: string): Promise<ViewPlugin> {
  const module = { exports: {} };
  const fn = new Function('module', 'exports', code);
  fn(module, module.exports);
  return module.exports.default ?? module.exports;
}

async function loadAllPlugins(rootId: string): Promise<ViewPlugin[]> {
  // 1. 获取插件目录文件列表
  const tree = await fetch(`/api/tree?root=${rootId}&dir=.mindfs/plugins`).then(r => r.json());
  const pluginFiles = tree.entries?.filter((n: any) => n.name.endsWith('.js')) ?? [];

  // 2. 逐个加载插件文件
  const plugins: ViewPlugin[] = [];
  for (const f of pluginFiles) {
    try {
      const resp = await fetch(`/api/file?root=${rootId}&path=${f.path}`);
      const { content } = await resp.json();
      plugins.push(await loadPlugin(content));
    } catch (e) {
      console.warn(`插件加载失败: ${f.name}`, e);
    }
  }
  return plugins;
}
```

### 安全边界

- 插件通过 `new Function('module','exports', code)` 在前端运行时加载。
- 插件运行在浏览器主线程，属于**受信任本地代码执行模型**（由用户/agent 写入本地后加载）。
- 当前版本**没有硬隔离沙盒**（无 Worker 超时中断、无 SES/Realm）。
- 插件与主应用共享同一 JS 环境，因此必须将其视为“可执行代码”，不是“纯数据”。

### 插件运行环境

- 模块格式：仅支持 CommonJS `module.exports = {...}`。
- 框架注入：插件只通过 `process(file)` 入参拿数据，不注入额外运行时 API。
- 交互能力：通过 UITree 事件 `action` 调用框架 action handler（如 `navigate`）。
- 文件访问：插件本身不直接请求后端 API；文件读取由框架先完成，再传入 `file`。

### Plugin Theme（强约束）

`theme` 为必填，必须包含以下 14 个 token：

- `overlayBg`
- `surfaceBg`
- `surfaceBgElevated`
- `text`
- `textMuted`
- `border`
- `primary`
- `primaryText`
- `radius`
- `shadow`
- `focusRing`
- `danger`
- `warning`
- `success`

生效机制：

- 框架将 token 映射为 CSS 变量 `--vp-*` 注入插件容器。
- 对于 Dialog/Popover 等 Portal 弹层，框架在插件渲染激活时给 `body` 打标记并注入同一组 `--vp-*`。
- 仅在 `body[data-plugin-theme="1"]` 作用域下覆盖弹层样式，避免污染主应用 UI。

约束：

- 插件不得修改框架 CSS/TS 源码。
- 插件不得输出全局 CSS 覆盖。
- 样式定制必须通过 `theme` token 完成。

---

## App.tsx 集成

在现有视图路由逻辑中增加插件分支：

```tsx
main={
  selectedSession && interactionMode !== "drawer" ? (
    <SessionViewer ... />
  ) : file ? (
    pluginResult ? (
      // 插件产出视图 → json-render 渲染
      <Renderer tree={pluginResult.tree} />
    ) : (
      // 无匹配插件 → 原有 FileViewer
      <FileViewer file={file} ... />
    )
  ) : (
    <DefaultListView ... />
  )
}
```

判断逻辑：
```typescript
const pluginResult = useMemo(() => {
  if (!file) return null;
  const plugin = pluginManager.match(file);
  if (!plugin) return null;
  return pluginManager.run(plugin, file);
}, [file]);
```

---

## 动态交互方案

插件通过 URL query 参数实现动态交互（如分页、排序、筛选），保持插件纯函数特性的同时支持状态持久化和分享。

### URL 结构

参考后端 API 设计，使用 query 参数传递所有状态：

```
/?root={rootId}&file={path}&vp_{pluginParams}
```

示例：
```
/                                          # 首页（默认 root）
/?root=abc123                              # 指定 root
/?root=abc123&file=data.csv                # 打开文件
/?root=abc123&file=data.csv&vp_page=2      # 文件 + 插件状态
/?root=abc123&file=data.csv&vp_sortBy=name&vp_order=asc  # 多个插件参数
/?root=abc123&file=novel.txt&vp_chapter=5  # 小说第5章
```

**设计原则**：
- 与后端 API 风格一致（`/api/file?root=...&path=...`）
- 所有状态在 query 中，便于解析和管理
- `root` 和 `file` 为框架保留参数
- **插件参数使用 `vp_` 前缀**（view plugin），完全隔离框架参数和插件参数，避免冲突
- 框架自动去除 `vp_` 前缀后传给插件，插件代码中直接使用 `file.query.page`（不是 `vp_page`）

### 插件 API 扩展

`process` 函数接收 query 参数：

```typescript
interface PluginInput {
  name: string;
  path: string;
  content: string;
  ext: string;
  mime: string;
  size: number;
  truncated: boolean;
  next_cursor?: number;
  query?: Record<string, string>;  // URL 中 vp_ 去前缀后的参数
}

// 插件实现
module.exports = {
  name: "CSV 查看器",
  match: { ext: ".csv" },
  fileLoadMode: "full",
  theme: { /* 14 token 省略 */ },

  process(file) {
    // 从 query 读取状态
    const page = parseInt(file.query.page || '1');
    const sortBy = file.query.sortBy || 'default';

    // 根据状态生成视图
    const rows = parseCSV(file.content)
      .sort((a, b) => sortBy === 'name' ? a.name.localeCompare(b.name) : 0)
      .slice((page - 1) * 100, page * 100);

    return {
      tree: {
        root: "container",
        elements: {
          container: {
            type: "Stack",
            children: ["table", "pagination"]
          },
          table: { /* 表格 */ },
          pagination: {
            type: "Button",
            props: { label: "下一页" },
            on: {
              press: {
                action: "navigate",
                params: {
                  query: { page: page + 1 }  // 更新 query
                }
              }
            }
          }
        }
      }
    };
  }
};
```

### 事件 Action 定义

框架提供 `navigate` action，由 Renderer 的 action handler 执行：

```typescript
interface NavigateAction {
  action: "navigate";
  params: {
    path?: string;               // 可选：跳转到其他文件
    query?: Record<string, any>; // 插件参数（框架自动 merge+replaceState）
  };
}
```

**默认行为**（框架固定，插件无需关心）：
- 始终 merge：保留现有插件参数，只更新 query 中指定的键
- 始终 replaceState：不产生浏览器历史记录
- `vp_` 前缀由框架自动添加/去除，插件完全无感

**执行机制**：

```typescript
// Renderer 中注册 navigate action handler
function handleNavigate(params: NavigateAction['params']) {
  const currentParams = new URLSearchParams(location.search);
  const newParams = new URLSearchParams();

  // 1. 保留框架参数（root 不变）
  const root = currentParams.get('root') || '';
  const file = params.path || currentParams.get('file') || '';
  if (root) newParams.set('root', root);
  if (file) newParams.set('file', file);

  // 2. 合并插件参数（保留现有 vp_*，覆盖指定键）
  currentParams.forEach((value, key) => {
    if (key.startsWith('vp_')) newParams.set(key, value);
  });
  if (params.query) {
    Object.entries(params.query).forEach(([key, value]) => {
      newParams.set(`vp_${key}`, String(value));
    });
  }

  // 3. replaceState + 触发 React 路由更新
  history.replaceState(null, '', `/?${newParams.toString()}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

actionRegistry.register('navigate', handleNavigate);
```

**错误处理**：
- 参数缺失：使用当前 URL 的值
- 无效参数：忽略，保持当前值
- 执行失败：不改变 URL，在控制台输出警告

// 在 Renderer 的 action registry 中注册
actionRegistry.register('navigate', handleNavigate);
```

**错误处理**：
- 参数缺失：使用当前 URL 的值
- 无效参数：忽略，保持当前值
- 执行失败：不改变 URL，在控制台输出警告

使用示例：

```js
// 更新参数（框架默认合并并 replaceState）
on: {
  press: {
    action: "navigate",
    params: { query: { page: 2 } }
  }
}

// 跳转到其他文件
on: {
  press: {
    action: "navigate",
    params: { path: "other.csv", query: { page: 1 } }
  }
}
```

### 应用启动流程

```
1. 用户访问 /?root=abc&file=data.csv&vp_page=2
   │
2. React Router 解析 URL query
   │
3. 并行请求：
   ├─ /api/tree?root=abc（左侧目录树）
   ├─ /api/sessions（右侧列表）
   └─ /api/file?root=abc&path=data.csv（文件内容）
   │
4. 匹配插件 → csv-viewer
   │
5. 调用 process(file)，file.query = { page: "2" }
   │
6. 渲染完整界面（侧边栏 + 插件视图）
```

### 路由监听

```typescript
// App.tsx
function App() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const root = params.get('root') || '';
  const filePath = params.get('file') || '';
  const pluginQuery = parsePluginQuery(location.search);

  const file = useFetchFile(root, filePath);
  const plugin = pluginManager.match(file);

  const pluginResult = useMemo(() => {
    if (!plugin || !file) return null;
    return plugin.process({ ...file, query: pluginQuery });
  }, [plugin, file, pluginQuery]);  // query 变化时重新计算

  return (
    <Layout>
      <Sidebar tree={tree} />
      <Main>
        {pluginResult ? (
          <Renderer tree={pluginResult.tree} />
        ) : (
          <FileViewer file={file} />
        )}
      </Main>
    </Layout>
  );
}
```

### 性能优化

框架区分两种 URL 变化，避免不必要的文件请求：

**1. 仅插件参数变化（不重新请求文件）**

```
/?root=abc&file=data.csv&vp_page=1
  ↓ navigate({ query: { page: 2 } })
/?root=abc&file=data.csv&vp_page=2

行为：
- 不请求 /api/file
- 用新 query 重新调用 process(file)，file.query = { page: "2" }
- useMemo 检测到 query 变化，触发重新计算
```

**2. root 或 file 参数变化（重新请求文件）**

```
/?root=abc&file=data.csv&vp_page=1
  ↓ navigate({ path: "other.csv" })
/?root=abc&file=other.csv

行为：
- 请求 /api/file?root=abc&path=other.csv
- 加载新文件后，调用 process(newFile, {})
- useFetchFile 检测到 filePath 变化，触发请求
```

**实现要点**：

```typescript
// 解析框架参数（触发文件请求）
function parseFrameworkParams(search: string) {
  const params = new URLSearchParams(search);
  return {
    root: params.get('root') || '',
    file: params.get('file') || ''
  };
}

// 解析插件参数（触发插件重新计算）
function parsePluginQuery(search: string) {
  const params = new URLSearchParams(search);
  const query: Record<string, string> = {};
  params.forEach((value, key) => {
    if (key.startsWith('vp_')) {
      query[key.slice(3)] = value;  // 去除 vp_ 前缀
    }
  });
  return query;
}

// 文件请求 hook
function useFetchFile(root: string, path: string) {
  const [file, setFile] = useState(null);

  useEffect(() => {
    if (!root || !path) return;
    fetch(`/api/file?root=${root}&path=${path}`)
      .then(r => r.json())
      .then(data => setFile(data.file));
  }, [root, path]);  // 只依赖 root 和 path

  return file;
}
```

**性能收益**：
- 翻页、排序等操作不会重复请求文件（节省网络请求）
- 大文件场景下，用户体验更流畅（无加载闪烁）
- 插件状态变化响应更快（<10ms vs 100ms+）

### 优势

1. **可分享**：URL 包含完整状态，复制链接即可分享
2. **可刷新**：刷新页面保持当前状态
3. **可后退**：浏览器后退/前进可用（配合 replace 控制）
4. **纯函数**：插件无副作用，状态由 URL 管理
5. **无需持久化**：URL 即状态，无需 localStorage

---

## 与现有系统的关系

| 模块 | 变化 | 说明 |
|------|------|------|
| **Registry** (组件注册表) | 不变 | 插件复用已注册的 UI 组件 |
| **Renderer** | 不变 | 插件输出 UITree，Renderer 负责渲染 |
| **viewCatalog** (系统提示) | 演进 | 从"教 LLM 写 UITree"扩展为"教 LLM 写插件" |
| **FileViewer** | 降级为 fallback | 无匹配插件时才使用 |
| **路由系统** | 新增 | 支持 `/?root={rootId}&file={path}&{query}` 格式 |
| **Action 系统** | 扩展 | 新增 `navigate` action 处理 URL 变化 |

---

## LLM 生成插件

用户在 view plugin 模式下对话，LLM 生成完整插件文件并写入 `.mindfs/plugins/` 目录。

### 系统提示词

前端在 view plugin 模式下，将以下提示词注入 agent 上下文。  
其中 `${componentCatalog}` 由前端运行时注入，为当前可用组件的 catalog 提示词文本。
提示词需与当前实现保持一致：`fileLoadMode` 和 `theme` 为必填，禁止生成全局 CSS 覆盖。

```
你现在处于视图插件开发模式。用户会描述需求，你需要生成一个视图插件并写入 .mindfs/plugins/ 目录。

## 插件规范

插件使用 CommonJS 格式，导出一个对象：

module.exports = {
  name: "插件名称",
  match: { ext: ".txt" },  // 匹配规则
  fileLoadMode: "full",    // "full" | "incremental"
  theme: {
    overlayBg: "rgba(0,0,0,0.56)",
    surfaceBg: "#ffffff",
    surfaceBgElevated: "#ffffff",
    text: "#0f172a",
    textMuted: "#475569",
    border: "rgba(15,23,42,0.12)",
    primary: "#2563eb",
    primaryText: "#ffffff",
    radius: "10px",
    shadow: "0 10px 30px rgba(2,6,23,.18)",
    focusRing: "rgba(37,99,235,.4)",
    danger: "#dc2626",
    warning: "#d97706",
    success: "#16a34a"
  },
  process(file) {
    // file: { name, path, content, ext, mime, size, truncated, next_cursor, query }
    // query: URL 中 vp_ 去前缀后的插件参数
    // 返回: { data?, tree }

    // 从 query 读取状态
    const page = parseInt(file.query.page || '1');

    return {
      tree: {
        root: "root",
        elements: {
          root: {
            type: "Button",
            props: { label: "下一页" },
            on: {
              press: {
                action: "navigate",
                params: {
                  query: { page: page + 1 }  // 更新 URL query
                }
              }
            }
          }
        }
      }
    };
  }
};

## 可用组件

${componentCatalog}

## 匹配规则

- ext: ".txt" 或 ".csv,.tsv" (逗号分隔多个)
- path: "novels/**/*.txt" (glob 模式)
- mime: "text/*" (支持通配)
- name: "README*" (文件名 glob)
- any: [{ext:".txt"}, {ext:".md"}] (OR)
- all: [{ext:".txt"}, {path:"novels/**"}] (AND)

## 输出要求

1. 使用当前 agent 可用的文件写入工具，将插件写入 .mindfs/plugins/<name>.js
2. 文件名使用小写字母和连字符，如 txt-novel.js
3. process 函数必须是纯函数，不访问外部状态
4. tree 必须符合 UITree 格式，root 指向根元素 ID
5. 事件绑定使用顶层 on 字段，不要放在 props 中
6. 必须输出完整 theme（14 个 token），且不得要求修改框架源码/全局 CSS

## 动态交互

插件通过 navigate action 实现动态交互（翻页、排序、筛选等）：

```js
// 读取 URL 参数
const page = parseInt(file.query.page || '1');
const sortBy = file.query.sortBy || 'default';

// 更新 URL 参数
on: {
  press: {
    action: "navigate",
    params: {
      query: { page: page + 1 }  // 更新参数
    }
  }
}
```

常见场景：
- 翻页：`query: { page: page + 1 }`
- 排序：`query: { sortBy: "name" }`
- 跳转文件：`path: "other.csv", query: { page: 1 }`

## 示例

用户："帮我做一个 CSV 表格查看器"

你应该：
1. 分析需求：匹配 .csv 文件，解析为表格
2. 选择组件：Table 组件
3. 生成插件代码
4. 写入 .mindfs/plugins/csv-viewer.js
```

### 交互流程

```
用户输入需求
    │
    ▼
Agent 分析需求 + 选择组件
    │
    ▼
生成插件代码（CJS 格式）
    │
    ▼
Write 工具写入 .mindfs/plugins/<name>.js
    │
    ▼
提示用户刷新页面加载插件
```

---

## 示例插件

### CSV 表格查看器

```js
module.exports = {
  name: "CSV 表格",
  match: { ext: ".csv" },

  process(file) {
    const lines = file.content.split('\n').filter(l => l.trim());
    const headers = lines[0].split(',').map(h => h.trim());
    const rows = lines.slice(1).map(l => l.split(',').map(c => c.trim()));

    return {
      data: { headers, rowCount: rows.length },
      tree: {
        root: "table",
        elements: {
          table: {
            type: "Table",
            props: {
              columns: headers,
              rows
            },
            children: []
          }
        }
      }
    };
  }
};
```

### JSON 树形浏览器

```js
module.exports = {
  name: "JSON 浏览器",
  match: { ext: ".json" },

  process(file) {
    const data = JSON.parse(file.content);
    const keys = Object.keys(data);

    return {
      data: { keys, type: Array.isArray(data) ? "array" : "object" },
      tree: {
        root: "root",
        elements: {
          root: {
            type: "Accordion",
            props: {
              type: "multiple",
              items: keys.map(k => ({
                title: `${k} (${typeof data[k]})`,
                content: JSON.stringify(data[k], null, 2)
              }))
            }
          }
        }
      }
    };
  }
};
```

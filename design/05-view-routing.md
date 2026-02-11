# 视图路由系统

对应代码：`server/internal/router/`

---

## 目录结构

```
.mindfs/
├── view-router.json            # 路由配置
├── view-preference.json        # 用户选择偏好
└── views/                      # 视图文件（扁平存放）
    ├── file-list.json          # 系统默认: 文件列表
    ├── markdown.json           # 系统默认: Markdown
    ├── novels-reader.json      # 路径规则: novels/**
    ├── code-viewer.json        # 路径规则: code/** 或 *.ts/*.js
    └── root.json               # 根目录视图
```

---

## view-router.json 路由配置

```json
{
  "version": "1.0",
  "routes": [
    {
      "id": "novels-reader",
      "name": "小说阅读器",
      "match": { "path": "novels/**" },
      "view": "novels-reader.json",
      "priority": 10
    },
    {
      "id": "code-viewer",
      "name": "代码编辑器",
      "match": {
        "any": [
          { "path": "code/**" },
          { "ext": [".ts", ".js", ".go", ".py"] }
        ]
      },
      "view": "code-viewer.json",
      "priority": 10
    },
    {
      "id": "markdown-viewer",
      "name": "Markdown 文档",
      "match": { "ext": [".md"] },
      "view": "markdown.json",
      "priority": 5
    },
    {
      "id": "file-list",
      "name": "文件列表",
      "match": { "all": true },
      "view": "file-list.json",
      "priority": 0
    }
  ],
  "root_view": "root.json"
}
```

---

## 匹配规则类型

```typescript
type MatchRule =
  | { path: string }                      // glob 匹配: "novels/**"
  | { ext: string[] }                     // 扩展名: [".md", ".txt"]
  | { mime: string[] }                    // MIME 类型: ["image/*"]
  | { name: string }                      // 文件名: "README.md"
  | { meta: Record<string, unknown> }     // 元数据匹配
  | { any: MatchRule[] }                  // OR
  | { all: MatchRule[] | true }           // AND 或 fallback
```

---

## view-preference.json

```json
{
  "last_selected": {
    "novels/erta/readme.md": "markdown-viewer",
    "novels/erta": "novels-reader"
  }
}
```

---

## 路由解析逻辑

```typescript
function resolveView(path: string): { current: View, alternatives: View[] } {
  // 1. 找出所有匹配的路由规则
  const matched = routes
    .filter(r => matches(path, r.match))
    .sort((a, b) => b.priority - a.priority);

  // 2. 用户上次选择 > priority 默认
  const lastSelected = status.last_selected[path];
  const current = lastSelected
    ? matched.find(v => v.id === lastSelected) ?? matched[0]
    : matched[0];

  // 3. 其他匹配作为备选
  const alternatives = matched.filter(v => v.id !== current.id);

  return { current, alternatives };
}
```

---

## 多视图切换 UI

**视图选择下拉框**（参考模式+Agent 下拉框设计）:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [●] Connected  [小说阅读器 ▼]  [输入消息...]              [对话 · Claude ▼] [发送] │
└──────────────────────────────────────────────────────────────────────────────┘
                        │
        ┌───────────────┴───────────────────┐
        │  匹配的视图                        │
        │ ─────────────────────────────────│
        │  ● 小说阅读器                     │
        │  ○ Markdown 文档                  │
        │  ○ 文件列表                       │
        └───────────────────────────────────┘
```

**单个匹配时简化显示**:
```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [●] Connected  [代码编辑器]  [输入消息...]                [对话 · Claude ▼] [发送] │
└──────────────────────────────────────────────────────────────────────────────┘
```

**无自定义视图时**:
```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [●] Connected  [文件列表 ▼]  [输入消息...]              [对话 · Claude ▼] [发送] │
└──────────────────────────────────────────────────────────────────────────────┘
```
- 仅显示视图名称
- 需要生成自定义视图时，切换到"生成视图"模式

**用户切换自动记住**: 下次打开同一文件/目录，默认使用上次选择的视图。

---

## 视图数据模型

```typescript
// 组件 Catalog (视图模式)
interface ComponentCatalog {
  version: string;
  components: {
    [name: string]: {
      description: string;
      props: Record<string, PropDef>;
      actions?: string[];            // 可触发的 action
    };
  };
}

// API Endpoint (视图模式)
interface APIEndpoint {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  description: string;
  params?: ParamDef[];
  response?: string;                 // 响应类型描述
}

// 视图示例 (few-shot)
interface ViewExample {
  description: string;               // 场景描述
  prompt: string;                    // 用户提示词
  view: object;                      // 生成的视图数据
}
```

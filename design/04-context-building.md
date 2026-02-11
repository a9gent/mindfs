# Agent 上下文构建

对应代码：`server/internal/context/`

---

## 上下文组织原则

**仅新建 Session 时构建初始上下文**，恢复对话时 Agent 已有上下文（通过 resume 或 exchanges），只需传递新消息。

1. **路径优先，内容按需**：只传文件路径，让 Agent 自己读取内容（Agent 有文件访问能力）
2. **选中内容例外**：用户高亮选中的内容需要直接传，因为这是 UI 状态，Agent 无法获取
3. **语义优先**：传 userDescription（用户对目录的描述），不传目录结构（Agent 可自己 ls）
4. **关联优先**：recent session 只取与当前目录/文件关联的 Session
5. **Agent 能力自知**：Agent 内置能力不用传，只传目录自定义 skill

---

## 客户端上下文 (Client Context)

由前端收集，随消息一起发送到服务端：

```typescript
interface ClientContext {
  // 位置上下文
  current_root: string;              // 当前管理目录 ID
  current_path?: string;             // 当前选中的目录/文件路径

  // 选中内容 (仅当用户有选中时传)
  selection?: {
    file_path: string;               // 文件路径
    start: number;                   // 选中起始位置
    end: number;                     // 选中结束位置
    text: string;                    // 选中的文本内容
  };

  // 当前视图 (视图模式下有用)
  current_view?: {
    rule_id: string;                 // 当前视图规则 ID
    version: string;                 // 当前视图版本
  };
}
```

---

## 服务端上下文 (Server Context)

由服务端根据输入模式构建：

```typescript
interface ServerContext {
  // 通用上下文 (所有模式)
  common: {
    root_path: string;               // 管理目录绝对路径
    user_description?: string;       // 用户对目录的描述 (来自 config.json)
    related_sessions?: SessionBrief[]; // 关联的最近 Session (同目录/同文件)
  };

  // 视图模式专用
  view?: {
    catalog: ComponentCatalog;       // 组件白名单 (json-render catalog)
    registry_schema: RegistrySchema; // 组件 props schema
    server_apis: APIEndpoint[];      // 可用的 Server API 列表
    current_view?: ViewDefinition;   // 当前视图定义 (用于修改)
    view_examples?: ViewExample[];   // 视图示例 (few-shot)
  };

  // 技能模式专用 (仅目录自定义 skill)
  skill?: {
    directory_skills?: SkillBrief[]; // 目录自定义 skill 列表 (.mindfs/skills/)
  };
}
```

---

## 各模式上下文详情

### 对话模式 (chat)

| 上下文项 | 是否需要 | 说明 |
|---------|---------|------|
| 目录路径 | ✓ | Agent 工作目录 |
| userDescription | ✓ | 目录语义描述，Agent 无法自己获取 |
| 文件路径 | ✓ | 当前选中文件，Agent 可自己读取内容 |
| 选中内容 | ✓ | UI 状态，Agent 无法获取 |
| 目录结构 | ✗ | Agent 可自己 ls |
| 文件内容 | ✗ | Agent 可自己 cat |
| 关联 Session | ✓ | 提供历史上下文参考 |

### 视图模式 (view)

| 上下文项 | 是否需要 | 说明 |
|---------|---------|------|
| 组件 Catalog | ✓ | Agent 不知道有哪些组件可用 |
| 组件 Schema | ✓ | Agent 不知道组件 props 定义 |
| Server API 列表 | ✓ | Agent 不知道有哪些 action 可用 |
| 当前视图 | ✓ | 修改时需要参考 |
| 视图示例 | ✓ | few-shot 提高生成质量 |
| 目录结构 | ✗ | Agent 可自己 ls |
| userDescription | ✓ | 理解目录用途 |

### 技能模式 (skill)

| 上下文项 | 是否需要 | 说明 |
|---------|---------|------|
| Agent 内置能力 | ✗ | Agent 自己知道 |
| 目录自定义 skill | ✓ | Agent 不知道目录有哪些自定义 skill |
| 目录结构 | ✗ | Agent 可自己 ls |
| userDescription | ✓ | 理解目录用途 |

---

## 上下文构建流程

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     用户发送消息 (新建 Session)                          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Client 收集上下文                                                       │
│  - 当前目录/文件路径                                                     │
│  - 选中内容 (如有)                                                       │
│  - 当前视图信息 (视图模式)                                               │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Server 构建服务端上下文 (根据 mode)                                      │
│                                                                         │
│  通用:                                                                   │
│    - 读取 userDescription                                               │
│    - 查找关联 Session (同目录/同文件)                                    │
│                                                                         │
│  if mode == "view":                                                     │
│    - 加载 catalog + registry schema                                     │
│    - 加载 server API 列表                                               │
│    - 读取当前视图路由配置                                               │
│    - 加载 few-shot 示例                                                 │
│                                                                         │
│  if mode == "skill":                                                    │
│    - 扫描目录自定义 skill (.mindfs/skills/)                             │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  构建 Agent 提示词                                                       │
│                                                                         │
│  System Prompt:                                                         │
│    - 工作目录: {root_path}                                              │
│    - 目录描述: {userDescription}                                        │
│    - 能力边界 (视图模式: catalog/apis)                                   │
│    - 输出格式要求                                                        │
│                                                                         │
│  User Prompt:                                                           │
│    - 用户消息                                                            │
│    - 当前文件路径 (如有)                                                 │
│    - 选中内容 (如有)                                                     │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  发送到 Agent 进程                                                       │
└─────────────────────────────────────────────────────────────────────────┘


┌─────────────────────────────────────────────────────────────────────────┐
│                     用户发送消息 (恢复/继续 Session)                      │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  直接发送用户消息到 Agent 进程                                            │
│  (Agent 已有上下文，无需重新构建)                                         │
│                                                                         │
│  仅传递:                                                                 │
│    - 用户消息                                                            │
│    - 选中内容 (如有，因为是新的 UI 状态)                                  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 关联 Session 查找规则

**优先级**: 文件关联 > 同目录文件关联 > 同管理目录

```typescript
function findRelatedSessions(
  rootId: string,
  currentPath?: string,
  limit: number = 3
): SessionBrief[] {
  const allSessions = loadSessions(rootId);

  // 按优先级分组
  const fileRelated: SessionBrief[] = [];      // 优先级 1: 涉及当前文件
  const dirRelated: SessionBrief[] = [];       // 优先级 2: 涉及同目录文件
  const rootRelated: SessionBrief[] = [];      // 优先级 3: 同管理目录

  for (const s of allSessions) {
    if (currentPath && s.related_files.includes(currentPath)) {
      fileRelated.push(s);
    } else if (currentPath && s.related_files.some(f => dirname(f) === dirname(currentPath))) {
      dirRelated.push(s);
    } else {
      rootRelated.push(s);
    }
  }

  // 按优先级合并，每组内按时间排序
  const sortByTime = (a: SessionBrief, b: SessionBrief) =>
    new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();

  return [
    ...fileRelated.sort(sortByTime),
    ...dirRelated.sort(sortByTime),
    ...rootRelated.sort(sortByTime)
  ].slice(0, limit);
}
```

---

## 数据结构定义

```typescript
// Session 摘要 (用于关联 Session 列表)
interface SessionBrief {
  key: string;
  type: "chat" | "view" | "skill";
  name: string;
  status: "active" | "idle" | "closed";
  updated_at: string;
  related_files: string[];           // 关联文件路径列表
}

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

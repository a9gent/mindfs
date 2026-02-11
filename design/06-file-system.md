# 文件系统管理

对应代码：`server/internal/fs/`

---

## .mindfs/ 完整结构

```
.mindfs/
├── config.json                  # 目录配置 (Agent 偏好等)
├── view-router.json             # 视图路由配置
├── view-preference.json         # 用户视图选择偏好
├── views/                       # 视图文件（扁平存放）
│   ├── file-list.json
│   ├── markdown.json
│   ├── novels-reader.json
│   └── ...
├── sessions/                    # Session 数据 (无 index.json，直接扫描)
│   ├── session-001.json
│   └── session-002.json
├── file-meta.json               # 文件元数据 (来源 Session 等)
├── history.jsonl                # 审计日志
└── skills/                      # 技能包
    └── novel-reader/
        ├── config.json
        └── handlers.js
```

---

## config.json

目录配置文件，存储 Agent 偏好和用户描述：

```json
{
  "viewCreateAgent": "claude",
  "defaultAgent": "claude",
  "userDescription": "这是一个小说目录，用于按章节阅读与追踪进度。"
}
```

---

## file-meta.json

文件元数据，记录文件来源和创建信息：

```json
{
  "novels/erta/chapter1.txt": {
    "source_session": "session-001",
    "created_at": "2024-01-31T10:00:00Z",
    "created_by": "agent"
  },
  "novels/erta/chapter2.txt": {
    "source_session": "session-001",
    "created_at": "2024-01-31T10:00:05Z",
    "created_by": "agent"
  }
}
```

### 文件元数据模型

```typescript
interface FileMeta {
  path: string;
  source_session?: string;         // 生成此文件的 Session key
  created_at: string;
  created_by: "user" | "agent";
}
```

---

## related_files 获取方式

| 来源 | 触发时机 | 关系类型 |
|-----|---------|---------|
| 文件系统监听 (fsnotify) | Agent 创建文件时 | output |
| Agent 输出解析 | 解析 stdout 中的文件操作 | output |
| 用户消息解析 | 解析用户消息中的文件引用 | mentioned |
| 技能参数 | 执行技能时指定的输入文件 | input |

**不侵入 Agent**：通过 fsnotify 监听目录变化 + 解析 Agent 输出，自动追踪文件创建。

---

## 文件创建追踪

Agent 创建文件时，通过以下方式追踪（不侵入 Agent）：

1. **fsnotify 监听**: 监听工作目录，检测文件创建事件
2. **SessionUpdate 解析**: 解析 `tool_call` 中的文件操作
3. **自动关联**: 将新文件关联到当前活跃 Session

```go
func (w *FileWatcher) Watch(rootPath string, sessionKey string) {
    watcher, _ := fsnotify.NewWatcher()
    watcher.Add(rootPath)

    for event := range watcher.Events {
        if event.Op&fsnotify.Create != 0 {
            w.onFileCreated(event.Name, sessionKey)
        }
    }
}
```

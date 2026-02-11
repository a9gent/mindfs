# Session 生命周期管理

对应代码：`server/internal/session/`

---

## Session 数据模型

```typescript
interface Session {
  key: string;                       // MindFS 内部 ID
  type: "chat" | "view" | "skill";   // 对话 / 生成视图 / 执行技能
  agent: string;                     // 使用的 Agent (claude/codex/gemini)
  agent_session_id?: string;         // Agent 原生 session-id (用于恢复)
  name: string;                      // AI 生成的摘要，如 "下载小说"
  status: "active" | "idle" | "closed";
  created_at: string;
  updated_at: string;
  closed_at?: string;
  summary?: SessionSummary;          // 关闭时生成
  exchanges: Exchange[];             // 对话记录 (降级恢复用)
  related_files: RelatedFile[];      // 关联文件
  generated_view?: string;           // 生成的视图规则 id
}

interface SessionSummary {
  title: string;           // AI 生成的标题
  description: string;     // 简短描述
  key_actions: string[];   // 关键操作列表
  outputs: string[];       // 输出文件/视图
  generated_at: string;
}

interface Exchange {
  role: "user" | "agent";
  content: string;
  timestamp: string;
}

interface RelatedFile {
  path: string;
  relation: "input" | "output" | "mentioned";
  created_by_session: boolean;
}
```

### Session 类型说明

| 类型 | 图标 | 典型内容 | 关联产物 |
|-----|------|---------|---------|
| chat | 💬 | 问答对话 | 可能有文件输出 |
| view | 🎨 | 视图生成过程 | 视图文件 |
| skill | ⚡ | 技能执行过程 | 文件输出 |

---

## 状态流转

```
┌─────────┐    创建     ┌─────────┐
│  (无)   │ ──────────→ │ active  │
└─────────┘             └────┬────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              │ 10分钟无操作  │ 用户关闭     │ 进程崩溃
              ▼              ▼              ▼
        ┌─────────┐    ┌─────────┐    ┌─────────┐
        │  idle   │    │ closed  │    │ closed  │
        └────┬────┘    └─────────┘    └─────────┘
             │
             │ 30分钟无操作 或 用户关闭
             ▼
        ┌─────────┐
        │ closed  │
        └─────────┘
```

### 状态定义

| 状态 | 说明 | Agent 进程 | 可恢复 |
|-----|------|-----------|-------|
| active | 活跃中，用户正在交互 | 运行中 | - |
| idle | 空闲，暂无交互 | 运行中（可能被回收） | - |
| closed | 已关闭 | 已终止 | ✓ |

---

## 超时配置

```json
// ~/.config/mindfs/config.json
{
  "session": {
    "idle_timeout_minutes": 10,      // active → idle
    "close_timeout_minutes": 30,     // idle → closed
    "max_idle_sessions": 3           // 最多保持 3 个 idle 进程
  }
}
```

---

## 空闲检测逻辑

```go
func (m *SessionManager) checkIdleSessions() {
    now := time.Now()

    for _, s := range m.sessions {
        idleMinutes := now.Sub(s.LastActivity).Minutes()

        switch s.Status {
        case "active":
            if idleMinutes >= m.config.IdleTimeoutMinutes {
                s.Status = "idle"
                m.notifyStatusChange(s)
            }
        case "idle":
            if idleMinutes >= m.config.CloseTimeoutMinutes {
                m.closeSession(s, "timeout")
            }
        }
    }

    // 如果 idle 进程超过限制，关闭最老的
    m.enforceMaxIdleSessions()
}
```

---

## Session 恢复机制

**优先使用 Agent 原生恢复，失败则用 exchanges 构建上下文**：

```typescript
async function resumeSession(session: Session): Promise<AgentProcess> {
  // 1. 优先尝试 Agent 原生恢复
  if (session.agent_session_id) {
    try {
      return await agentPool.resume(session.agent, session.agent_session_id);
    } catch (e) {
      // 原生恢复失败，降级到方案 2
    }
  }

  // 2. 降级：用 exchanges 构建上下文
  const context = buildContextFromExchanges(session.exchanges);
  const process = await agentPool.create(session.agent);
  await process.send(context);
  return process;
}
```

**各 Agent 恢复支持**：

| Agent | 原生 resume | 降级方案 |
|-------|------------|---------|
| Claude Code | ✓ `--resume` | ✓ exchanges |
| Codex | ? 待确认 | ✓ exchanges |
| Gemini CLI | ? 待确认 | ✓ exchanges |

从 closed 状态恢复：

1. **优先原生恢复**: 使用 `agent_session_id` 调用 Agent 的 `--resume` 机制
2. **降级恢复**: 原生恢复失败时，用 `exchanges` 构建上下文发送给新进程
3. **状态更新**: 恢复成功后状态变为 `active`

---

## Session 存储

**不使用 index.json**，直接扫描 `sessions/` 目录：
- Session 数量通常不多（几十到几百个）
- 避免维护索引一致性的复杂度
- 如后续量大，再加 index.json 或 SQLite

**session-001.json 示例**:

```json
{
  "key": "session-001",
  "type": "skill",
  "name": "下载小说",
  "status": "closed",
  "created_at": "2024-01-31T10:00:00Z",
  "updated_at": "2024-01-31T10:05:00Z",
  "closed_at": "2024-01-31T10:05:00Z",
  "summary": {
    "title": "下载《江湖风云录》3章",
    "description": "下载了《江湖风云录》共 3 章到 novels/erta/ 目录",
    "key_actions": [
      "创建目录 novels/erta/",
      "下载 chapter1-3.txt",
      "生成小说阅读器视图 v1"
    ],
    "outputs": ["novels/erta/ch1.txt", "novels/erta/ch2.txt", "novels/erta/ch3.txt"],
    "generated_at": "2024-01-31T10:05:00Z"
  },
  "exchanges": [
    {
      "role": "user",
      "content": "帮我下载《江湖风云录》",
      "timestamp": "2024-01-31T10:00:00Z"
    },
    {
      "role": "agent",
      "content": "好的，正在下载...\\n✓ chapter1.txt (12KB)\\n✓ chapter2.txt (15KB)\\n✓ chapter3.txt (14KB)\\n下载完成，共 3 章",
      "timestamp": "2024-01-31T10:03:00Z"
    }
  ],
  "related_files": [
    { "path": "novels/erta/ch1.txt", "relation": "output", "created_by_session": true },
    { "path": "novels/erta/ch2.txt", "relation": "output", "created_by_session": true },
    { "path": "novels/erta/ch3.txt", "relation": "output", "created_by_session": true }
  ],
  "generated_view": "novels-reader-v1"
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

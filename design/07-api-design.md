# API 设计

对应代码：`server/internal/api/`

---

## REST API

### Session 相关

| 端点 | 方法 | 描述 |
|-----|------|------|
| `/api/sessions` | GET | 获取 Session 列表 |
| `/api/sessions/:key` | GET | 获取 Session 详情 |
| `/api/sessions` | POST | 创建新 Session |
| `/api/sessions/:key/message` | POST | 发送消息到 Session |

### 视图相关

| 端点 | 方法 | 描述 |
|-----|------|------|
| `/api/view/routes` | GET | 获取匹配的视图路由列表（含视图数据） |
| `/api/view/preference` | POST | 保存用户视图选择偏好 |

### 文件相关

| 端点 | 方法 | 描述 |
|-----|------|------|
| `/api/file` | GET | 获取文件内容 |
| `/api/file/meta` | GET | 获取文件元数据 (来源 Session 等) |
| `/api/tree` | GET | 获取目录树 |

---

## WebSocket 消息协议

WebSocket 用于实时双向通信，包括 Session 交互、流式输出、视图更新等。

### 消息格式

```typescript
// 客户端 → 服务端
interface WSRequest {
  id: string;                    // 请求 ID，用于关联响应
  type: string;                  // 消息类型
  payload: Record<string, any>;  // 消息内容
}

// 服务端 → 客户端
interface WSResponse {
  id?: string;                   // 关联的请求 ID (推送消息无此字段)
  type: string;                  // 消息类型
  payload: Record<string, any>;  // 消息内容
  error?: {                      // 错误信息 (仅错误时)
    code: string;
    message: string;
  };
}
```

### 消息类型

**Session 相关**:

| 类型 | 方向 | 描述 | Payload |
|-----|------|------|---------|
| `session.create` | C→S | 创建 Session | `{ type, agent, root_id }` |
| `session.created` | S→C | Session 已创建 | `{ session_key, name }` |
| `session.message` | C→S | 发送消息 | `{ session_key, content, context }` |
| `session.stream` | S→C | 流式响应块 | `{ session_key, chunk }` |
| `session.done` | S→C | 响应完成 | `{ session_key, summary? }` |
| `session.close` | C→S | 关闭 Session | `{ session_key }` |
| `session.closed` | S→C | Session 已关闭 | `{ session_key, summary }` |
| `session.error` | S→C | Session 错误 | `{ session_key, error }` |

**视图相关**:

| 类型 | 方向 | 描述 | Payload |
|-----|------|------|---------|
| `view.update` | S→C | 视图更新推送 | `{ root_id, view }` |

**文件相关**:

| 类型 | 方向 | 描述 | Payload |
|-----|------|------|---------|
| `file.created` | S→C | 文件创建通知 | `{ path, session_key, size }` |
| `file.changed` | S→C | 文件变更通知 | `{ path, change_type }` |

---

## 流式输出协议

Agent 响应通过 WebSocket 流式推送，基于 ACP 协议的 SessionUpdate 消息。

### SessionUpdate 类型

```typescript
// Agent 输出的增量更新
type SessionUpdate =
  | { type: "agent_message_chunk"; textDelta: string }           // 文本增量
  | { type: "agent_thought_chunk"; textDelta: string }           // 思考过程增量
  | { type: "tool_call"; toolCallId: string; name: string; args: any }  // 工具调用开始
  | { type: "tool_call_update"; toolCallId: string; status: "running" | "complete"; result?: any }  // 工具状态更新
  | { type: "agent_message_complete" };                          // 消息完成

// 前端展示用的流式块 (从 SessionUpdate 转换)
type StreamChunk =
  | { type: "text"; content: string }                           // 文本内容
  | { type: "thinking"; content: string }                       // 思考过程
  | { type: "progress"; task: string; percent: number }         // 任务进度
  | { type: "file_start"; path: string; size?: number }         // 开始写文件
  | { type: "file_progress"; path: string; percent: number }    // 文件写入进度
  | { type: "file_done"; path: string; size: number }           // 文件写入完成
  | { type: "tool_call"; tool: string; args: any }              // 工具调用
  | { type: "tool_result"; tool: string; result: any }          // 工具结果
  | { type: "permission_request"; id: string; description: string; options: any[] }  // 权限请求
  | { type: "error"; code: string; message: string };           // 错误
```

### SessionUpdate → StreamChunk 转换

Server 将 ACP 协议的 SessionUpdate 转换为前端友好的 StreamChunk：

```go
func convertToStreamChunk(update SessionUpdate) []StreamChunk {
    switch update.Type {
    case "agent_message_chunk":
        return []StreamChunk{{Type: "text", Content: update.TextDelta}}

    case "agent_thought_chunk":
        return []StreamChunk{{Type: "thinking", Content: update.TextDelta}}

    case "tool_call":
        chunks := []StreamChunk{{Type: "tool_call", Tool: update.Name, Args: update.Args}}
        // 识别文件操作工具
        if isFileWriteTool(update.Name) {
            path := extractFilePath(update.Args)
            chunks = append(chunks, StreamChunk{Type: "file_start", Path: path})
        }
        return chunks

    case "tool_call_update":
        if update.Status == "complete" {
            chunks := []StreamChunk{{Type: "tool_result", Tool: update.ToolCallId, Result: update.Result}}
            // 文件操作完成
            if path, size := extractFileResult(update.Result); path != "" {
                chunks = append(chunks, StreamChunk{Type: "file_done", Path: path, Size: size})
            }
            return chunks
        }
        return nil
    }
    return nil
}
```

### 流式输出示例

```
← session.stream { session_key: "s1", chunk: { type: "text", content: "好的，" } }
← session.stream { session_key: "s1", chunk: { type: "text", content: "正在下载..." } }
← session.stream { session_key: "s1", chunk: { type: "tool_call", tool: "write_file", args: { path: "ch1.txt" } } }
← session.stream { session_key: "s1", chunk: { type: "file_start", path: "ch1.txt" } }
← session.stream { session_key: "s1", chunk: { type: "tool_result", tool: "write_file", result: { success: true, size: 12000 } } }
← session.stream { session_key: "s1", chunk: { type: "file_done", path: "ch1.txt", size: 12000 } }
← session.stream { session_key: "s1", chunk: { type: "text", content: "\n下载完成！" } }
← session.done { session_key: "s1" }
```

---

## 错误处理

### 错误码定义

```typescript
// 错误码格式: {模块}.{类型}
const ErrorCodes = {
  // Session 相关
  "session.not_found": "Session 不存在",
  "session.already_closed": "Session 已关闭",
  "session.resume_failed": "Session 恢复失败",

  // Agent 相关
  "agent.not_available": "Agent 不可用",
  "agent.process_crashed": "Agent 进程崩溃",
  "agent.timeout": "Agent 响应超时",
  "agent.invalid_response": "Agent 响应格式错误",

  // 视图相关
  "view.not_found": "视图不存在",
  "view.invalid_schema": "视图 Schema 无效",
  "view.generation_failed": "视图生成失败",

  // 文件相关
  "file.not_found": "文件不存在",
  "file.permission_denied": "文件权限不足",
  "file.read_failed": "文件读取失败",

  // Skill 相关
  "skill.not_found": "Skill 不存在",
  "skill.permission_denied": "Skill 权限不足",
  "skill.execution_failed": "Skill 执行失败",

  // 通用
  "internal_error": "内部错误",
  "invalid_request": "请求参数无效",
  "rate_limited": "请求过于频繁",
} as const;
```

### 错误响应格式

```typescript
// REST API 错误响应
interface APIError {
  error: {
    code: string;           // 错误码
    message: string;        // 用户可读的错误信息
    details?: any;          // 详细信息（调试用）
    retry_after?: number;   // 重试等待秒数（限流时）
  };
}

// WebSocket 错误消息
interface WSError {
  type: "error";
  payload: {
    code: string;
    message: string;
    context?: {             // 错误上下文
      session_key?: string;
      path?: string;
    };
  };
}
```

### 错误恢复策略

| 错误码 | 自动恢复 | 用户操作 |
|-------|---------|---------|
| agent.timeout | 自动重试 1 次 | 提示重新发送 |
| agent.process_crashed | 自动重启进程 | 提示继续对话 |
| session.resume_failed | 降级到 exchanges | 提示上下文可能不完整 |
| view.generation_failed | 保持当前视图 | 提示重新生成 |
| file.not_found | - | 刷新文件树 |

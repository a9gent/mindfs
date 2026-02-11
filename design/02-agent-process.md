# Agent 进程管理

对应代码：`server/internal/agent/`

---

## 通信协议：ACP + ndJSON

采用 Agent Client Protocol (ACP) 标准协议，通过 stdin/stdout 进行双向通信：

- **消息格式**: ndJSON (Newline-Delimited JSON)，每行一个完整 JSON 对象
- **协议层**: 基于 JSON-RPC 风格的请求/响应/通知模式
- **流式输出**: 通过 `SessionNotification` 消息推送增量内容

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        通信架构                                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  MindFS Server                              Agent Process               │
│  ┌─────────────┐                           ┌─────────────┐              │
│  │             │  ── stdin (ndJSON) ──→    │             │              │
│  │  Transport  │                           │   Claude/   │              │
│  │   Handler   │  ←── stdout (ndJSON) ──   │   Codex/    │              │
│  │             │                           │   Gemini    │              │
│  └─────────────┘  ←── stderr (debug) ───   └─────────────┘              │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 消息类型

**请求消息 (Server → Agent)**:

```typescript
interface PromptRequest {
  jsonrpc: "2.0";
  method: "prompt";
  id: string;
  params: {
    sessionId: string;
    content: ContentBlock[];  // 文本、图片等
  };
}
```

**通知消息 (Agent → Server)**:

```typescript
interface SessionNotification {
  jsonrpc: "2.0";
  method: "session.update";
  params: {
    sessionId: string;
    update: SessionUpdate;
  };
}

type SessionUpdate =
  | { type: "agent_message_chunk"; textDelta: string }
  | { type: "agent_thought_chunk"; textDelta: string }
  | { type: "tool_call"; toolCallId: string; name: string; args: any }
  | { type: "tool_call_update"; toolCallId: string; status: string; result?: any }
  | { type: "agent_message_complete" };
```

---

## 响应结束检测

**不使用显式 End Marker**，而是基于 idle 超时检测：

```go
type ResponseReader struct {
    idleTimeout time.Duration  // 默认 500ms
    lastChunk   time.Time
}

func (r *ResponseReader) IsComplete() bool {
    // 无活跃工具调用 + 超过 idle 超时 = 响应完成
    return len(r.activeToolCalls) == 0 &&
           time.Since(r.lastChunk) > r.idleTimeout
}
```

**优势**:
- 不依赖 Agent 输出特定标记
- 兼容各种 Agent 实现
- 自然处理流式输出

---

## Transport Handler 抽象

不同 Agent 有不同的行为特征，通过 Transport Handler 抽象层适配：

```go
type TransportHandler interface {
    // 初始化超时 (Agent 启动时间)
    GetInitTimeout() time.Duration

    // Idle 超时 (响应结束检测)
    GetIdleTimeout() time.Duration

    // 工具调用超时
    GetToolCallTimeout(toolName string) time.Duration

    // 过滤 stdout 行 (移除调试输出)
    FilterStdoutLine(line string) (string, bool)

    // 处理 stderr
    HandleStderr(line string) error

    // 判断是否为长时间运行的工具
    IsLongRunningTool(toolName string) bool
}
```

**各 Agent 配置**:

| Agent | 初始化超时 | Idle 超时 | 特殊处理 |
|-------|----------|----------|---------|
| Claude | 10s | 500ms | 无 |
| Codex | 30s | 500ms | 过滤 spinner 输出 |
| Gemini | 120s | 500ms | 过滤调试日志 |

---

## Agent 配置

```json
// ~/.config/mindfs/agents.json
{
  "agents": {
    "claude": {
      "command": "claude",
      "args": ["--output-format", "stream-json"],
      "sessionArgs": ["--resume"],
      "probeArgs": ["--version"],
      "cwdTemplate": "{root}/.mindfs",
      "addDirArgs": ["--add-dir", "{root}"],
      "transport": {
        "initTimeout": 10000,
        "idleTimeout": 500,
        "toolTimeout": 120000
      }
    },
    "codex": {
      "command": "codex",
      "args": ["--output-format", "json"],
      "sessionArgs": [],
      "probeArgs": ["--help"],
      "transport": {
        "initTimeout": 30000,
        "idleTimeout": 500,
        "filterPatterns": ["^\\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]"]
      }
    },
    "gemini": {
      "command": "gemini",
      "args": ["--format", "json"],
      "transport": {
        "initTimeout": 120000,
        "idleTimeout": 500,
        "filterPatterns": ["^\\[DEBUG\\]", "^\\[INFO\\]"]
      }
    }
  }
}
```

---

## 进程生命周期

```
┌─────────┐   spawn    ┌─────────────┐   initialize   ┌─────────┐
│  (无)   │ ─────────→ │  starting   │ ─────────────→ │  ready  │
└─────────┘            └─────────────┘                └────┬────┘
                              │                            │
                              │ 超时/失败                   │ prompt
                              ▼                            ▼
                       ┌─────────────┐              ┌─────────────┐
                       │   failed    │              │  streaming  │
                       └─────────────┘              └──────┬──────┘
                                                          │
                                          ┌───────────────┼───────────────┐
                                          │               │               │
                                          │ idle 超时     │ 错误          │ 用户取消
                                          ▼               ▼               ▼
                                    ┌─────────┐    ┌─────────────┐  ┌─────────────┐
                                    │  ready  │    │   failed    │  │  cancelled  │
                                    └─────────┘    └─────────────┘  └─────────────┘
```

---

## 进程池管理

```go
type ProcessPool struct {
    processes map[string]*AgentProcess  // sessionKey → process
    handlers  map[string]TransportHandler
    mu        sync.RWMutex
}

// 创建或获取进程
func (p *ProcessPool) GetOrCreate(sessionKey, agent, rootPath string) (*AgentProcess, error)

// 发送消息并流式接收响应
func (p *ProcessPool) SendStream(sessionKey string, content []ContentBlock, onChunk func(SessionUpdate)) error

// 优雅关闭进程
func (p *ProcessPool) Close(sessionKey string) error
```

---

## 权限请求处理

Agent 可能请求用户确认某些操作（如文件写入、命令执行）：

```typescript
// Agent → Server
interface PermissionRequest {
  jsonrpc: "2.0";
  method: "requestPermission";
  id: string;
  params: {
    type: "file_write" | "command_exec" | "network";
    description: string;
    options: PermissionOption[];
  };
}

// Server → Agent
interface PermissionResponse {
  jsonrpc: "2.0";
  id: string;
  result: {
    outcome: {
      optionId: "proceed_once" | "proceed_always" | "cancel";
    };
  };
}
```

**处理流程**:
1. Agent 发送 `requestPermission` RPC 请求
2. Server 通过 WebSocket 推送给前端
3. 用户在 UI 中选择操作
4. Server 返回 `PermissionResponse` 给 Agent

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

---

## 错误处理与重试

| 错误类型 | 处理策略 |
|---------|---------|
| 初始化超时 | 重试 3 次，指数退避 (1s, 2s, 4s) |
| 进程崩溃 | 自动重启，保留 session 上下文 |
| 响应超时 | 发送取消请求，等待 2s 后强制终止 |
| 权限请求超时 | 默认拒绝，通知用户 |

---

## 优雅关闭

```go
func (p *AgentProcess) Shutdown() error {
    // 1. 发送取消请求
    p.sendCancel()

    // 2. 等待优雅退出 (2s)
    select {
    case <-p.done:
        return nil
    case <-time.After(2 * time.Second):
    }

    // 3. SIGTERM
    p.cmd.Process.Signal(syscall.SIGTERM)

    // 4. 等待 1s
    select {
    case <-p.done:
        return nil
    case <-time.After(1 * time.Second):
    }

    // 5. SIGKILL
    return p.cmd.Process.Kill()
}
```

---

## Agent 可用性探测

Server 启动时和定期探测所有配置的 Agent 可用性：

```go
type AgentStatus struct {
    Name      string `json:"name"`
    Available bool   `json:"available"`
    Version   string `json:"version,omitempty"`
    Error     string `json:"error,omitempty"`
    LastProbe time.Time `json:"last_probe"`
}

func (p *AgentPool) ProbeAgent(name string) AgentStatus {
    config := p.configs[name]
    cmd := exec.Command(config.Command, config.ProbeArgs...)

    output, err := cmd.Output()
    if err != nil {
        return AgentStatus{
            Name:      name,
            Available: false,
            Error:     err.Error(),
            LastProbe: time.Now(),
        }
    }

    return AgentStatus{
        Name:      name,
        Available: true,
        Version:   parseVersion(output),
        LastProbe: time.Now(),
    }
}
```

### 探测时机

| 时机 | 说明 |
|-----|------|
| Server 启动 | 探测所有配置的 Agent |
| 定时探测 | 每 5 分钟重新探测 |
| 手动触发 | 用户点击刷新按钮 |
| 使用失败后 | Agent 进程启动失败时立即重新探测 |

### API

```
GET /api/agents
Response: {
  "agents": [
    { "name": "claude", "available": true, "version": "1.0.0", "last_probe": "..." },
    { "name": "codex", "available": false, "error": "command not found", "last_probe": "..." }
  ]
}
```

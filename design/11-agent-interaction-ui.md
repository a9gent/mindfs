# Agent 交互 UI

对应代码：`web/src/components/AgentFloatingPanel.tsx`, `web/src/components/stream/`, `web/src/components/dialog/`

---

## Agent 交互浮框

Agent 交互不再占用主视图，而是以浮框形式叠加，保持文件/自定义视图始终可见。

### 浮框收起状态（气泡）

有活跃 Session 时，主视图右下角显示气泡提示：

```
┌─────────────────────────────────────────────────────────────────┐
│                         主视图                                   │
│                                                                 │
│   [文件内容/自定义视图保持不变]                                   │
│                                                                 │
│                                                                 │
│                                      ┌─────────────────┐        │
│                                      │ 💬 下载小说      │        │
│                                      │    活跃中...    │        │
│                                      └─────────────────┘        │
│                                           ↑ 点击展开浮框         │
└─────────────────────────────────────────────────────────────────┘
```

### 浮框展开状态（占主视图 80%）

```
┌─────────────────────────────────────────────────────────────────┐
│                         主视图                                   │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ Session: 下载小说 [⚡ 技能] [Claude]              [_ 收起]   │ │
│ ├─────────────────────────────────────────────────────────────┤ │
│ │                                                             │ │
│ │ [我] 帮我下载《江湖风云录》                        10:00:00  │ │
│ │                                                             │ │
│ │ [Claude] 好的，正在搜索资源...                     10:00:02  │ │
│ │                                                             │ │
│ │ ┌─────────────────────────────────────────────────────┐    │ │
│ │ │ ⏳ 正在下载                                          │    │ │
│ │ │ ✓ chapter1.txt    12KB                              │    │ │
│ │ │ ✓ chapter2.txt    15KB                              │    │ │
│ │ │ ◐ chapter3.txt    60%  ████████░░░░                 │    │ │
│ │ └─────────────────────────────────────────────────────┘    │ │
│ │                                                             │ │
│ ├─────────────────────────────────────────────────────────────┤ │
│ │ 关联文件: ch1.txt ch2.txt ch3.txt                           │ │
│ ├─────────────────────────────────────────────────────────────┤ │
│ │ [继续对话...]                                       [发送]  │ │
│ └─────────────────────────────────────────────────────────────┘ │
│         ↑ 点击浮框外部区域，浮框收起为气泡                        │
└─────────────────────────────────────────────────────────────────┘
```

### 浮框交互规则

**核心原则**: 浮框 = 交互（需要输入），主视图 = 查看（只读内容）

| 操作 | 行为 | 说明 |
|-----|------|------|
| ActionBar 发送消息 | 浮框自动展开 | 显示新 Session 或当前 Session |
| 点击浮框外部 | 浮框收起为气泡 | |
| 点击气泡 | 浮框展开 | |
| 点击浮框内关联文件 | 主视图切换到该文件，浮框收起 | |
| 点击**活跃** Session (active/idle) | **浮框展开** | 可继续交互 |
| 点击**已关闭** Session (closed) | **主视图展示历史** | 只读，类似查看文件 |
| 点击 [收起] 按钮 | 浮框收起为气泡 | |
| Agent 任务完成 | 保持展开，用户手动收起 | |
| 无活跃 Session | 不显示气泡 | |
| 已关闭 Session 点击 [恢复] | 恢复后浮框展开 | 状态变为 active |

### 浮框内 ActionBar

浮框内有独立的输入框，用于继续当前 Session 对话：
- 仅显示输入框 + 发送按钮
- 不显示视图选择、模式选择（这些在主 ActionBar）

---

## 流式消息渲染

### 组件目录结构

```
web/src/components/
├── stream/                      # 流式消息相关组件
│   ├── StreamMessage.tsx        # 流式消息容器
│   ├── TextChunk.tsx            # 文本块渲染
│   ├── ThinkingBlock.tsx        # 思考过程（可折叠）
│   ├── ToolCallCard.tsx         # 工具调用卡片
│   ├── FileProgressList.tsx     # 文件操作进度列表
│   └── ProgressBar.tsx          # 通用进度条
├── dialog/
│   └── PermissionDialog.tsx     # 权限请求对话框
└── session/
    ├── AgentFloatingPanel.tsx   # Agent 交互浮框
    ├── SessionBubble.tsx        # 收起状态气泡
    └── ChatHistory.tsx          # 对话历史列表
```

### 前端渲染规则

| 块类型 | 渲染方式 |
|-------|---------|
| text | 追加到对话气泡 |
| thinking | 折叠显示（可展开） |
| progress | 进度条组件 |
| file_start/progress/done | 文件下载列表组件 |
| tool_call/result | 工具调用卡片（可折叠） |
| permission_request | 权限请求对话框 |
| error | 错误提示 |

### StreamMessage 组件

```tsx
interface StreamMessageProps {
  chunks: StreamChunk[];
  isStreaming: boolean;
}

function StreamMessage({ chunks, isStreaming }: StreamMessageProps) {
  // 按类型分组渲染
  const grouped = groupChunks(chunks);

  return (
    <div className="stream-message">
      {grouped.map((group, i) => {
        switch (group.type) {
          case "text":
            return <TextChunk key={i} content={group.content} />;
          case "thinking":
            return <ThinkingBlock key={i} content={group.content} />;
          case "tool_calls":
            return <ToolCallCard key={i} calls={group.calls} />;
          case "files":
            return <FileProgressList key={i} files={group.files} />;
        }
      })}
      {isStreaming && <StreamingIndicator />}
    </div>
  );
}
```

### ToolCallCard 组件

```tsx
interface ToolCall {
  id: string;
  name: string;
  args: any;
  status: "running" | "complete" | "error";
  result?: any;
}

function ToolCallCard({ call }: { call: ToolCall }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="tool-call-card">
      <div className="tool-header" onClick={() => setExpanded(!expanded)}>
        <span className="tool-icon">{getToolIcon(call.name)}</span>
        <span className="tool-name">{formatToolName(call.name)}</span>
        <span className="tool-status">
          {call.status === "running" && <Spinner />}
          {call.status === "complete" && "✓"}
          {call.status === "error" && "✗"}
        </span>
        <span className="expand-icon">{expanded ? "▼" : "▶"}</span>
      </div>
      {expanded && (
        <div className="tool-details">
          <div className="tool-args">
            <label>参数</label>
            <pre>{JSON.stringify(call.args, null, 2)}</pre>
          </div>
          {call.result && (
            <div className="tool-result">
              <label>结果</label>
              <pre>{JSON.stringify(call.result, null, 2)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

---

## 权限对话框

### PermissionDialog 组件

```tsx
interface PermissionRequest {
  id: string;
  type: "file_write" | "command_exec" | "network";
  description: string;
  options: Array<{
    id: string;
    label: string;
    description?: string;
  }>;
}

function PermissionDialog({
  request,
  onResponse,
}: {
  request: PermissionRequest;
  onResponse: (optionId: string) => void;
}) {
  return (
    <div className="permission-dialog-overlay">
      <div className="permission-dialog">
        <div className="permission-icon">
          {getPermissionIcon(request.type)}
        </div>
        <div className="permission-title">
          {getPermissionTitle(request.type)}
        </div>
        <div className="permission-description">
          {request.description}
        </div>
        <div className="permission-options">
          {request.options.map((opt) => (
            <button
              key={opt.id}
              className={`permission-option ${opt.id === "cancel" ? "cancel" : "primary"}`}
              onClick={() => onResponse(opt.id)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
```

---

## AgentFloatingPanel 组件

```tsx
interface AgentFloatingPanelProps {
  session: Session;
  chunks: StreamChunk[];
  isStreaming: boolean;
  onSend: (message: string) => void;
  onCollapse: () => void;
  onFileClick: (path: string) => void;
}

function AgentFloatingPanel({
  session,
  chunks,
  isStreaming,
  onSend,
  onCollapse,
  onFileClick,
}: AgentFloatingPanelProps) {
  const [input, setInput] = useState("");

  return (
    <div className="floating-panel">
      {/* 头部 */}
      <div className="panel-header">
        <span className="session-name">{session.name}</span>
        <span className="session-type">{getTypeIcon(session.type)}</span>
        <span className="agent-name">{session.agent}</span>
        <button className="collapse-btn" onClick={onCollapse}>
          _ 收起
        </button>
      </div>

      {/* 对话历史 */}
      <div className="chat-history">
        {session.exchanges.map((ex, i) => (
          <div key={i} className={`message ${ex.role}`}>
            {ex.role === "agent" ? (
              <StreamMessage chunks={parseContent(ex.content)} isStreaming={false} />
            ) : (
              <div className="user-message">{ex.content}</div>
            )}
          </div>
        ))}
        {/* 当前流式响应 */}
        {isStreaming && (
          <div className="message agent">
            <StreamMessage chunks={chunks} isStreaming={true} />
          </div>
        )}
      </div>

      {/* 关联文件 */}
      {session.related_files.length > 0 && (
        <div className="related-files">
          关联文件:
          {session.related_files.map((f) => (
            <span
              key={f.path}
              className="file-link"
              onClick={() => onFileClick(f.path)}
            >
              {basename(f.path)}
            </span>
          ))}
        </div>
      )}

      {/* 输入框 */}
      <div className="panel-input">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="继续对话..."
          onKeyDown={(e) => {
            if (e.key === "Enter" && input.trim()) {
              onSend(input);
              setInput("");
            }
          }}
        />
        <button onClick={() => { onSend(input); setInput(""); }}>
          发送
        </button>
      </div>
    </div>
  );
}
```

---

## WebSocket 消息处理 Hook

```tsx
function useSessionStream(sessionKey: string) {
  const [chunks, setChunks] = useState<StreamChunk[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);

  useEffect(() => {
    const ws = getWebSocket();

    const handleMessage = (event: MessageEvent) => {
      const msg = JSON.parse(event.data);

      if (msg.type === "session.stream" && msg.payload.session_key === sessionKey) {
        const chunk = msg.payload.chunk;
        setChunks((prev) => [...prev, chunk]);

        if (chunk.type === "permission_request") {
          setPermissionRequest(chunk);
        }
      }

      if (msg.type === "session.done" && msg.payload.session_key === sessionKey) {
        setIsStreaming(false);
      }
    };

    ws.addEventListener("message", handleMessage);
    return () => ws.removeEventListener("message", handleMessage);
  }, [sessionKey]);

  const respondToPermission = (optionId: string) => {
    if (permissionRequest) {
      sendWSMessage({
        type: "permission.response",
        payload: {
          request_id: permissionRequest.id,
          option_id: optionId,
        },
      });
      setPermissionRequest(null);
    }
  };

  return { chunks, isStreaming, permissionRequest, respondToPermission };
}
```

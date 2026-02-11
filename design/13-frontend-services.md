# 前端服务层

对应代码：`web/src/services/`

---

## 服务模块概览

```
web/src/services/
├── session.ts          # Session 管理
├── view.ts             # 视图管理
├── agents.ts           # Agent 状态
├── skills.ts           # 技能调用
├── context.ts          # 上下文收集
├── error.ts            # 错误处理
└── connection.ts       # WebSocket 连接
```

---

## session.ts - Session 管理

```typescript
interface SessionService {
  // 创建 Session
  create(type: SessionType, agent: string, rootId: string): Promise<Session>;

  // 发送消息
  sendMessage(sessionKey: string, content: string, context: ClientContext): Promise<void>;

  // 获取 Session 列表
  list(rootId: string): Promise<Session[]>;

  // 获取 Session 详情
  get(sessionKey: string): Promise<Session>;

  // 关闭 Session
  close(sessionKey: string): Promise<void>;

  // 恢复 Session
  resume(sessionKey: string): Promise<void>;
}

// 使用示例
const sessionService = new SessionService();

// 创建新 Session
const session = await sessionService.create('chat', 'claude', 'root-001');

// 发送消息
await sessionService.sendMessage(session.key, '帮我下载小说', {
  current_root: 'root-001',
  current_path: 'novels/'
});
```

---

## view.ts - 视图管理

```typescript
interface ViewService {
  // 获取匹配的视图路由
  getRoutes(path: string): Promise<{ current: ViewRoute, alternatives: ViewRoute[] }>;

  // 保存用户视图选择偏好
  savePreference(path: string, viewId: string): Promise<void>;

  // 生成新视图
  generate(prompt: string, context: ClientContext): Promise<ViewDefinition>;
}

// 使用示例
const viewService = new ViewService();

// 获取当前路径的视图
const { current, alternatives } = await viewService.getRoutes('novels/erta/ch1.txt');

// 切换视图
await viewService.savePreference('novels/erta/ch1.txt', 'markdown-viewer');
```

---

## agents.ts - Agent 状态

```typescript
interface AgentService {
  // 获取所有 Agent 状态
  getStatus(): Promise<AgentStatus[]>;

  // 探测 Agent 可用性
  probe(agentName: string): Promise<AgentStatus>;

  // 获取可用的 Agent 列表
  getAvailable(): Promise<string[]>;
}

interface AgentStatus {
  name: string;
  available: boolean;
  version?: string;
  error?: string;
  last_probe: string;
}

// 使用示例
const agentService = new AgentService();

// 获取所有 Agent 状态
const statuses = await agentService.getStatus();

// 过滤可用的 Agent
const available = statuses.filter(s => s.available).map(s => s.name);
```

---

## skills.ts - 技能调用

```typescript
interface SkillService {
  // 获取目录自定义 Skill 列表
  list(rootId: string): Promise<SkillBrief[]>;

  // 执行 Skill
  execute(rootId: string, skillId: string, params: Record<string, any>): Promise<any>;
}

interface SkillBrief {
  id: string;
  name: string;
  description: string;
  params?: ParamDef[];
}

// 使用示例
const skillService = new SkillService();

// 获取技能列表
const skills = await skillService.list('root-001');

// 执行技能
const result = await skillService.execute('root-001', 'download', {
  url: 'https://example.com/novel.txt'
});
```

---

## context.ts - 上下文收集

```typescript
interface ContextService {
  // 收集客户端上下文
  collect(): ClientContext;

  // 获取当前选中内容
  getSelection(): SelectionContext | null;
}

interface ClientContext {
  current_root: string;
  current_path?: string;
  selection?: SelectionContext;
  current_view?: {
    rule_id: string;
    version: string;
  };
}

interface SelectionContext {
  file_path: string;
  start: number;
  end: number;
  text: string;
}

// 使用示例
const contextService = new ContextService();

// 收集上下文
const context = contextService.collect();

// 发送消息时附带上下文
await sessionService.sendMessage(sessionKey, message, context);
```

---

## error.ts - 错误处理

```typescript
interface ErrorService {
  // 处理 API 错误
  handle(error: APIError): void;

  // 显示错误提示
  show(code: string, message: string, options?: ErrorOptions): void;

  // 获取错误恢复策略
  getRecoveryStrategy(code: string): RecoveryStrategy | null;
}

interface APIError {
  code: string;
  message: string;
  details?: any;
  retry_after?: number;
}

interface ErrorOptions {
  type: 'toast' | 'modal';
  duration?: number;
  retryable?: boolean;
}

interface RecoveryStrategy {
  autoRetry: boolean;
  retryDelay?: number;
  userAction?: string;
}

// 使用示例
const errorService = new ErrorService();

try {
  await sessionService.sendMessage(sessionKey, message, context);
} catch (error) {
  errorService.handle(error as APIError);
}
```

---

## connection.ts - WebSocket 连接

```typescript
interface ConnectionService {
  // 连接 WebSocket
  connect(): Promise<WebSocket>;

  // 断开连接
  disconnect(): void;

  // 发送消息
  send(message: WSRequest): void;

  // 监听消息
  on(type: string, handler: (payload: any) => void): () => void;

  // 获取连接状态
  getStatus(): ConnectionStatus;
}

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

interface WSRequest {
  id: string;
  type: string;
  payload: Record<string, any>;
}

// 使用示例
const connectionService = new ConnectionService();

// 连接
await connectionService.connect();

// 监听 Session 流式输出
const unsubscribe = connectionService.on('session.stream', (payload) => {
  const { session_key, chunk } = payload;
  // 处理流式块
  handleStreamChunk(session_key, chunk);
});

// 发送消息
connectionService.send({
  id: generateId(),
  type: 'session.message',
  payload: {
    session_key: sessionKey,
    content: message,
    context
  }
});

// 取消监听
unsubscribe();
```

---

## 状态管理

使用 React Context + Hooks 管理全局状态：

```typescript
// web/src/services/store.ts
interface AppState {
  sessions: Session[];
  currentSession?: Session;
  agents: AgentStatus[];
  connection: ConnectionStatus;
}

const AppContext = createContext<AppState | null>(null);

export function useAppState() {
  const context = useContext(AppContext);
  if (!context) throw new Error('useAppState must be used within AppProvider');
  return context;
}

export function useSessions() {
  const { sessions } = useAppState();
  return sessions;
}

export function useCurrentSession() {
  const { currentSession } = useAppState();
  return currentSession;
}

export function useAgents() {
  const { agents } = useAppState();
  return agents;
}

export function useConnection() {
  const { connection } = useAppState();
  return connection;
}
```

---

## 服务初始化

```typescript
// web/src/services/index.ts
export class Services {
  session: SessionService;
  view: ViewService;
  agents: AgentService;
  skills: SkillService;
  actions: ActionService;
  context: ContextService;
  error: ErrorService;
  connection: ConnectionService;

  constructor() {
    this.connection = new ConnectionService();
    this.error = new ErrorService();
    this.context = new ContextService();
    this.session = new SessionService(this.connection, this.error);
    this.view = new ViewService(this.connection, this.error);
    this.agents = new AgentService(this.connection, this.error);
    this.skills = new SkillService(this.connection, this.error);
    this.actions = new ActionService(this.connection, this.error);
  }

  async initialize() {
    await this.connection.connect();
    // 初始化其他服务
  }
}

// 全局单例
export const services = new Services();
```

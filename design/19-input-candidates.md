# 19. 输入候选集（Slash / File Reference）

对应代码：`server/internal/api/`、`web/src/components/ActionBar.tsx`、`web/src/services/`

---

## 背景

当前输入框只支持纯文本。后续需要支持两类输入增强：

1. `/skill`：给用户提供 slash 候选补全，减少手输成本
2. `@file`：给用户提供文件候选补全，稳定引用指定 root 下的文件

本期目标不是富文本编辑器，也不是后端执行内置命令通道，而是：

- 统一候选集模型
- 统一候选查询接口
- 前端统一补全交互
- 选中后写入结构化消息 token

---

## 设计目标

1. `/` 与 `@` 共用一套候选框架，不拆成两套系统
2. 候选集只保留两种类型：`skill`、`file`
3. 前端选中候选后，写入统一文本协议，不传额外 sidecar 数据结构
4. 后端只负责候选集注册与查询，不负责执行 slash 命令
5. `file` 候选仅搜索指定 `root`，忽略隐藏目录与隐藏文件

---

## 非目标

本期不做：

1. 后端解析 `[read file: ...]` 后自动注入文件内容到 prompt
2. `/skill` 的独立执行通道
3. 富文本 token/chip 输入框
4. 多种候选类型（如 session、agent、root）
5. 文件候选的全局索引缓存与 watcher 增量维护

---

## 候选集模型

统一候选对象：

```ts
type CandidateType = "file" | "skill";

interface CandidateItem {
  type: CandidateType;
  name: string;
  description?: string;
}
```

字段语义：

| 字段 | 说明 |
|------|------|
| `type` | 候选类型，当前仅 `file` / `skill` |
| `name` | 插入消息时使用的核心值；`file` 为相对 root 的路径，`skill` 为 slash 名称 |
| `description` | 候选说明；`file` 为空，`skill` 可放命令说明 |

示例：

```json
[
  {
    "type": "file",
    "name": "design/18-view-plugin.md"
  },
  {
    "type": "skill",
    "name": "status",
    "description": "Show current agent status"
  }
]
```

---

## 触发规则

前端根据当前 token 选择候选类型：

| 触发符 | 候选类型 | 查询参数 |
|--------|----------|----------|
| `@` | `file` | `type=file` |
| `/` | `skill` | `type=skill` |

说明：

- `@des` → 查询文件候选
- `/sta` → 查询 skill 候选
- 查询接口统一，只有 `type` 不同

---

## 消息协议

前端展示仍采用熟悉的输入方式：

- 选择文件候选时，UI 表现为 `@path`
- 选择 skill 候选时，UI 表现为 `/name`

但真正写入消息内容时，统一转换为固定语法：

```text
[read file: design/18-view-plugin.md]
[use skill: status]
```

组合消息示例：

```text
请先阅读 [read file: design/18-view-plugin.md]，然后执行 [use skill: status]
```

### 选择这种协议的原因

1. 保留固定语法，避免 `@` / `/` 在普通文本中的歧义
2. 历史消息可稳定回放
3. 可读性比纯协议 token 更好
4. 当前无需引入额外 JSON sidecar

---

## 后端职责

后端只做两件事：

1. 注册候选集 provider
2. 根据 `type + q + root` 查询候选

本期后端不做：

- slash command 执行
- message token 解析
- `[read file: ...]` 自动展开为上下文内容

也就是说，当前阶段的 `[read file: ...]` 与 `[use skill: ...]` 只是发送给 agent 的固定语法文本。

后端不负责解释这两种语法，只负责候选提供。

---

## Candidate Registry

后端统一通过 registry 注册候选 provider。

```go
type CandidateType string

const (
    CandidateFile  CandidateType = "file"
    CandidateSkill CandidateType = "skill"
)

type CandidateItem struct {
    Type        CandidateType `json:"type"`
    Name        string        `json:"name"`
    Description string        `json:"description,omitempty"`
}

type CandidateProvider interface {
    Type() CandidateType
    Search(ctx context.Context, rootID string, query string) ([]CandidateItem, error)
}

type CandidateRegistry struct {
    providers map[CandidateType]CandidateProvider
}
```

Registry 对外提供两个方法：

```go
func (r *CandidateRegistry) Register(p CandidateProvider)
func (r *CandidateRegistry) Search(ctx context.Context, t CandidateType, rootID, query string) ([]CandidateItem, error)
```

### 初始 Provider

#### 1. FileCandidateProvider

职责：

- 搜索指定 `root` 下的文件
- 忽略隐藏目录、隐藏文件
- 返回相对 `root` 的路径

约束：

- 只返回文件，不返回目录
- 不读取文件内容
- 每次请求时扫描 root；后续性能不足时再升级为索引缓存

#### 2. SkillCandidateProvider

职责：

- 提供 slash 候选集合
- `name` 对应 `/skill` 中的 skill 名称
- `description` 为说明文本

候选来源：

- 按当前 agent 扫描预定义 skill 目录
- 汇总为统一的 `skill` 候选集合

本期不要求这些 skill 可被后端执行，仅作为输入补全候选。

### Skill 扫描规则

`SkillCandidateProvider` 按当前 agent 选择不同的扫描目录：

#### Codex

按顺序扫描以下目录：

1. `~/.codex/skills`
2. `~/.codex/skills/.system`
3. `~/.agents/skills`
4. `<root>/.codex/skills`

说明：

- `~/.codex/skills/.system` 作为额外扫描目录参与候选汇总
- 但 `~/.codex/skills` 根目录中的 `.system` 本身不作为一个普通 skill 候选返回

#### Claude

按顺序扫描以下目录：

1. `~/.claude/skills`
2. `<root>/.claude/skills`
3. `~/.claude/plugins/marketplaces/<marketplace>/skills`

说明：

- `~/.claude/plugins/marketplaces/` 下的每个一级子目录都视为一个 marketplace
- 对每个 marketplace，继续扫描其下的 `skills/` 目录
- 中间的 marketplace 目录名本身不作为 skill 候选返回

#### Gemini

按顺序扫描以下目录：

1. `~/.gemini/skills`
2. `~/.agents/skills`
3. `<root>/.gemini/skills`

### Skill 去重规则

当多个目录中出现同名 skill 时，按扫描顺序保留第一项，后续同名项忽略。

示例：

- `status` 同时存在于 `~/.codex/skills` 与 `<root>/.codex/skills`
- 最终只保留 `~/.codex/skills/status`

### Skill 候选字段

- `name`：skill 名称（即 slash 名称，不带 `/`）
- `description`：从 skill 目录下的 `SKILL.md` 提取；取不到时为空

### Skill Description 提取规则

每个 skill 目录按如下规则提取 `description`：

1. 读取 `<skillDir>/SKILL.md`
2. 如果文件开头存在 frontmatter，优先读取其中的 `description`
3. 如果 frontmatter 中没有 `description`，则 `description` 为空

示例：`~/.agents/skills/code-simplifier/SKILL.md`

```md
---
name: code-simplifier
description: Code refinement expert that improves clarity, consistency, and maintainability while preserving exact functionality.
allowed-tools: Read, Edit, Glob, Grep
---
```

则候选项为：

```json
{
  "type": "skill",
  "name": "code-simplifier",
  "description": "Code refinement expert that improves clarity, consistency, and maintainability while preserving exact functionality."
}
```

---

## 文件候选搜索规则

搜索范围：

- 指定 `root` 下的所有非隐藏文件

### 过滤规则

搜索过程中，以下路径直接忽略：

#### 1. 隐藏路径

- 任一路径段以 `.` 开头的目录
- 任一路径段以 `.` 开头的文件

示例：

- `.git/`
- `.next/`
- `.mindfs/`
- `.specify/`
- `.vscode/`

#### 2. 常见依赖 / 构建 / 缓存目录

以下目录及其整棵子树直接忽略：

- `node_modules/`
- `dist/`
- `build/`
- `coverage/`
- `.next/`
- `.nuxt/`
- `.turbo/`
- `.cache/`

#### 3. 常见系统垃圾文件

- `.DS_Store`
- `Thumbs.db`

`file` 与 `skill` 的搜索规则保持一致，统一只对 `name` 字段做匹配。

排序规则采用轻量自定义评分，不依赖第三方 fuzzy 库：

1. `name` 前缀匹配
2. `name` 子串匹配

同层内排序：

1. `name` 更短优先
2. 字典序稳定兜底

返回数量建议限制为前 `20` 项。

---

## API 设计

统一查询接口：

```http
GET /api/candidates?root=mindfs&type=file&q=design/18
GET /api/candidates?root=mindfs&type=skill&agent=codex&q=sta
```

返回：

```json
[
  {
    "type": "file",
    "name": "design/18-view-plugin.md",
    "description": ""
  },
  {
    "type": "file",
    "name": "design/14-json-render-refactoring.md",
    "description": ""
  }
]
```

参数说明：

| 参数 | 必填 | 说明 |
|------|------|------|
| `root` | 是 | 指定搜索 root |
| `type` | 是 | `file` 或 `skill` |
| `agent` | `type=skill` 时必填 | 当前 agent，用于决定 skill 扫描目录 |
| `q` | 否 | 当前 token 中去掉触发符后的查询文本 |

错误处理：

- `root` 不存在 → `404`
- `type` 不支持 → `400`
- provider 未注册 → `400`

---

## 前端框架

前端只保留一套补全控制器，按当前 token 的触发符决定查询的 `type`。

### 1. Tokenizer

识别当前光标所在 token：

```ts
type ActiveToken =
  | { trigger: "@"; type: "file"; query: string; start: number; end: number }
  | { trigger: "/"; type: "skill"; query: string; start: number; end: number }
  | null;
```

### 2. Suggestion Controller

当 `ActiveToken != null` 时：

- 调用 `/api/candidates?root=...&type=...&q=...`
- 拿到统一候选列表
- 用统一 popup 渲染

### 3. 插入规则

选择候选后，不直接插入 `@path` 或 `/status`，而是插入固定语法：

| 候选类型 | 插入文本 |
|----------|----------|
| `file` | `[read file: <name>]` |
| `skill` | `[use skill: <name>]` |

示例：

- 选择文件 `design/18-view-plugin.md`
  → 插入 `[read file: design/18-view-plugin.md]`
- 选择 skill `status`
  → 插入 `[use skill: status]`

### 4. 发送逻辑

发送时不再构造额外的 `context.mentions` 或 `context.commands`。

直接发送：

```json
{
  "content": "请看 [read file: design/18-view-plugin.md]，然后执行 [use skill: status]"
}
```

---

## 交互流程

```text
用户在输入框输入 @des
    │
    ▼
前端 tokenizer 识别当前 token = file
    │
    ▼
请求 GET /api/candidates?root=...&type=file&q=des
    │
    ▼
后端 FileCandidateProvider 返回候选列表
    │
    ▼
前端 popup 展示候选
    │
    ▼
用户选中 design/18-view-plugin.md
    │
    ▼
输入框写入 [read file: design/18-view-plugin.md]
    │
    ▼
用户发送消息
    │
    ▼
后端原样将 content 发给 agent
```

slash skill 的流程完全相同，只是 `type=skill`，插入文本变成 `[use skill: name]`。

---

## 实施顺序

1. 后端新增 `CandidateRegistry`
2. 实现 `FileCandidateProvider`
3. 实现 `SkillCandidateProvider`
4. 新增 `/api/candidates`
5. 前端输入框增加 token 识别与统一 popup
6. 前端选中候选后插入 `[read file: ...]` / `[use skill: ...]`

---

## 后续演进

后续如果需要更强能力，可以在此基础上演进：

1. 后端解析 `[read file: ...]` 并自动注入文件内容
2. `skill` 候选升级为真正的 builtin command 执行通道
3. 文件候选从实时扫描升级为 root 级内存索引
4. 扩展候选类型：`dir`、`session`、`agent`

本期先只做统一候选框架，不提前引入这些复杂度。

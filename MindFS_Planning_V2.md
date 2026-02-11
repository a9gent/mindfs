# MindFS 产品规划与技术架构 V2

**核心定位**：Agent 远程访问网关 + 结果可视化平台

**核心理念**：
- Server 作为 Agent 能力与本地资源（网络、存储、计算、文件）的载体
- Client 作为远程访问接口（手机/平板/其他设备）
- Agent 交互与文件系统并重：Agent 执行任务 → 结果落地到文件 → UI 智能展示
- 通过"路由规则 + AI 生成视图"解决普通文件目录过于单调的问题

---

## 一、核心流程

```
用户 (手机/平板/其他设备)
        ↓
    MindFS Client (Web)
        ↓
    MindFS Server (本地工作站)
        ↓
    Agent (Claude/Codex/Gemini) + 本地资源
        ↓
    结果写入文件 → UI 智能展示
```

**典型场景**：
```
用户: "帮我下载 xx 小说"
    ↓
Agent 执行下载 → 文件落地到 novels/erta/
    ↓
用户打开目录 → 自动展示小说阅读器 UI
```

---

## 二、界面布局

### 整体结构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                MindFS                                        │
├────────────┬─────────────────────────────────────────┬──────────────────────┤
│  文件树     │              主视图                      │   Session 列表       │
│            │                                         │                      │
│ ▼ novels   │  ┌───────────────────────────────────┐  │ ● 下载小说           │
│   ▼ erta   │  │                                   │  │   活跃 · 2分钟前     │
│     ch1 ◆  │  │    [根据上下文动态切换]             │  │   📄 3 个文件        │
│     ch2 ◆  │  │                                   │  │                      │
│     ch3    │  │    - 文件内容                      │  │ ○ 分析代码           │
│ ▶ code     │  │    - AI 生成的自定义视图           │  │   1小时前            │
│ ▶ reports  │  │                                   │  │   📄 1 个文件        │
│            │  │    Agent 交互以浮框形式叠加        │  │                      │
│            │  │                                   │  │ ○ 整理笔记           │
│            │  ├───────────────────────────────────┤  │   昨天               │
│            │  │  [← 上一章]   1/3   [下一章 →]    │  │                      │
│            │  └───────────────────────────────────┘  │                      │
├────────────┴─────────────────────────────────────────┴──────────────────────┤
│ [●] Connected  [小说阅读器 · v2 ▼]  [输入...]       [对话 · Claude ▼] [发送] │
└─────────────────────────────────────────────────────────────────────────────┘

◆ = 文件由当前选中 Session 生成
◇ = 文件由其他 Session 生成

快捷操作栏位于主视图底部，属于视图的一部分，跟随视图切换。
Agent 交互以浮框形式叠加在主视图上，不打断当前视图。
```

### Agent 交互浮框

Agent 交互不再占用主视图，而是以浮框形式叠加，保持文件/自定义视图始终可见。

#### 浮框收起状态（气泡）

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

#### 浮框展开状态（占主视图 80%）

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

#### 浮框交互规则

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

#### 浮框内 ActionBar

浮框内有独立的输入框，用于继续当前 Session 对话：
- 仅显示输入框 + 发送按钮
- 不显示视图选择、模式选择（这些在主 ActionBar）

### 主视图状态（不含 Agent 交互）

Agent 交互改为浮框后，主视图只有以下状态：

| 状态 | 触发 | 内容 |
|-----|------|------|
| 1. 文件内容 | 点击文件 | 文件预览/渲染 |
| 2. Session 历史 | 点击已关闭 Session | 历史对话 + 摘要 |
| 3. 关联视图 | 点击关联文件列表 | 文件和 Session 关系 |
| 4. AI 生成视图 | 匹配到自定义视图 | 小说阅读器等 |

### 主视图的五种状态

#### 状态 1: 文件内容（点击文件树中的文件）

```
┌─────────────────────────────────────────────────────────────────┐
│  novels/erta/chapter1.txt                      [来源: 下载小说]  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  第一章 初入江湖                                                 │
│                                                                 │
│  那是一个风雨交加的夜晚...                                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                                          ↑
                              点击可跳转到生成此文件的 Session
```

#### 状态 2: Session 历史（点击已关闭的 Session）

```
┌─────────────────────────────────────────────────────────────────┐
│  Session: 下载小说 [⚡ 技能] [Claude]              [已关闭]      │
├─────────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ 📋 摘要                                                    │  │
│  │ 下载了《江湖风云录》共 3 章到 novels/erta/ 目录              │  │
│  │ • 创建目录 novels/erta/                                   │  │
│  │ • 下载 chapter1-3.txt                                     │  │
│  │ • 生成小说阅读器视图 v1                                    │  │
│  └───────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│  关联文件: ch1.txt, ch2.txt, ch3.txt              [查看全部 →]   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  [我] 帮我下载《江湖风云录》                                      │
│                                                                 │
│  [Agent] 好的，正在下载...                                       │
│          ✓ chapter1.txt (12KB)                                  │
│          ✓ chapter2.txt (15KB)                                  │
│          ✓ chapter3.txt (14KB)                                  │
│          下载完成，共 3 章                                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

#### 状态 3: 文件 + Session 关联视图

```
┌─────────────────────────────────────────────────────────────────┐
│  Session: 下载小说 → 关联文件                                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  输出文件 (3)                                                    │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ 📄 chapter1.txt    12KB    2分钟前    [打开]              │  │
│  │ 📄 chapter2.txt    15KB    2分钟前    [打开]              │  │
│  │ 📄 chapter3.txt    14KB    2分钟前    [打开]              │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  生成的视图                                                      │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ 🎨 小说阅读器 v1    novels/**    [切换到此视图]            │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

#### 状态 4: AI 生成的自定义视图（如小说阅读器）

```
┌─────────────────────────────────────────────────────────────────┐
│  《江湖风云录》                              章节 1/3  [目录 ☰]   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│                      第一章 初入江湖                              │
│                                                                 │
│      那是一个风雨交加的夜晚，少年李云站在破庙门前，                  │
│  望着远处的灯火，心中充满了对未来的憧憬...                          │
│                                                                 │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│           [← 上一章]      1 / 3      [下一章 →]                  │  ← 快捷操作栏（视图的一部分）
└─────────────────────────────────────────────────────────────────┘
```

### 交互流程

```
┌─────────────┐      点击文件       ┌─────────────┐
│   文件树     │ ─────────────────→ │  文件内容    │  (主视图)
└─────────────┘                    └──────┬──────┘
                                          │ 点击 [来源: Session]
                                          ▼
                                   ┌─────────────┐
                                   │ Session历史  │  (主视图，只读)
                                   └─────────────┘

┌─────────────┐
│ Session列表  │
└──────┬──────┘
       │
       ├─── 点击活跃 Session (active/idle) ───→ 【浮框展开】(可交互)
       │
       └─── 点击已关闭 Session (closed) ─────→ 【主视图】Session 历史 (只读)
                                                    │
                                                    │ 点击 [↻ 恢复]
                                                    ▼
                                              【浮框展开】(恢复后可交互)
```

**设计原则**:
- **浮框** = 需要交互（输入、继续对话）
- **主视图** = 只读查看（文件内容、历史记录）

### 文件树中的 Session 关联标记

```
▼ novels
  ▼ erta
    ch1.txt ◆              ← ◆ 表示由当前选中 Session 生成
    ch2.txt ◆
    ch3.txt ◆
    readme.md              ← 无标记，非 Agent 生成
▶ code
  app.ts ◇                 ← ◇ 表示由其他 Session 生成
```

**Hover 文件时显示来源**:
```
┌────────────────────────┐
│ chapter1.txt           │
│ 来源: 下载小说          │
│ 创建: 2分钟前           │
└────────────────────────┘
```

### Session 列表设计

```
┌──────────────────────────┐
│ ● 下载小说 [Claude]      │  ← 活跃
│   活跃 · 2分钟前          │
│   📄 ch1 ch2 ch3        │
│                          │
│ ○ 分析代码 [Claude]      │  ← 已关闭
│   1小时前  [↻ 恢复]       │
│   📄 report.md          │
│                          │
│ ○ 旧对话 [Codex]         │  ← 已关闭
│   3天前   [↻ 恢复]        │  ← 所有 Session 都可恢复
└──────────────────────────┘
```

### 目录设置面板

**入口**: 右侧边栏顶部的设置图标 (⚙️)，或文件树中目录右键菜单

```
┌──────────────────────────────────────────────────────────────────────────┐
│  目录设置: novels                                              [✕ 关闭]  │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  目录描述 (userDescription)                                              │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ 这是一个小说目录，用于按章节阅读与追踪进度。                          │  │
│  │ 主要存放网络小说，按作品分目录。                                     │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│  💡 描述会作为 Agent 上下文，帮助 Agent 理解目录用途                      │
│                                                                          │
│  ─────────────────────────────────────────────────────────────────────   │
│                                                                          │
│  默认 Agent                                                              │
│  [Claude ▼]                                                              │
│                                                                          │
│  视图生成 Agent                                                          │
│  [Claude ▼]                                                              │
│                                                                          │
│  ─────────────────────────────────────────────────────────────────────   │
│                                                                          │
│  目录路径                                                                │
│  /Users/xxx/novels                                                       │
│                                                                          │
│  创建时间                                                                │
│  2024-01-31 10:00:00                                                     │
│                                                                          │
│                                                    [保存]  [取消]        │
└──────────────────────────────────────────────────────────────────────────┘
```

**设置项说明**:

| 设置项 | 说明 | 存储位置 |
|-------|------|---------|
| userDescription | 目录用途描述，作为 Agent 上下文 | .mindfs/config.json |
| defaultAgent | 对话/技能模式默认 Agent | .mindfs/config.json |
| viewCreateAgent | 视图生成默认 Agent | .mindfs/config.json |

**触发入口**:

1. **右侧边栏设置图标**: 点击 ⚙️ 打开当前目录设置
2. **文件树右键菜单**: 右键目录 → "目录设置"
3. **首次添加目录**: 添加新目录后自动弹出设置面板

### Session 恢复机制

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

### ActionBar 设计

ActionBar 位于界面底部，负责输入交互，不包含快捷操作（快捷操作在主视图底部）。

#### 三种输入模式 + Agent 选择

通过发送按钮旁的下拉框切换模式和 Agent（左右分栏）：

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│ [●] Connected  [小说阅读器 ▼] [v2 ▼]  [输入...]           [对话 · Claude ▼] [发送]  │
└─────────────────────────────────────────────────────────────────────────────────────┘
                                                                    │
                                            ┌───────────────────────┴───────────────────────┐
                                            │  模式              Agent                      │
                                            │ ─────────────────────────────────────────────│
                                            │  ● 对话            ● Claude  ✓               │
                                            │  ○ 生成视图        ○ Codex   ✓               │
                                            │  ○ 执行技能        ○ Gemini  ✗               │
                                            └───────────────────────────────────────────────┘
```

#### 按钮文字联动

| 模式 | 按钮显示 |
|-----|---------|
| 对话 | `对话 · Claude ▼` |
| 生成视图 | `视图 · Claude ▼` |
| 执行技能 | `技能 · Codex ▼` |

#### 记住用户选择

每种模式记住用户选择的 Agent：

```json
// ~/.config/mindfs/preferences.json
{
  "mode_agent": {
    "chat": "claude",
    "view": "claude",
    "skill": "codex"
  }
}
```

#### 模式 1: 对话（默认）

```
┌───────────────────────────────────────────────────────────────────────────────────────┐
│ [●] Connected  [小说阅读器 · v2 ▼]  [输入消息...]        [对话 · Claude ▼] [发送]      │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

#### 模式 2: 生成视图

```
┌───────────────────────────────────────────────────────────────────────────────────────┐
│ [●] Connected  [小说阅读器 · v2 ▼]  [描述视图...]        [视图 · Claude ▼] [生成]      │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

#### 模式 3: 执行技能

切换到此模式时，输入框前出现 Skill 下拉框，合并展示 Agent 能力和当前目录 Skill：

```
┌───────────────────────────────────────────────────────────────────────────────────────┐
│ [●] Connected  [小说阅读器 · v2 ▼]  [下载 ▼] [参数...]   [技能 · Codex ▼] [执行]       │
└───────────────────────────────────────────────────────────────────────────────────────┘
                                          │
                              ┌───────────┴───────────┐
                              │ Agent 能力            │
                              │   ○ 下载              │
                              │   ○ 搜索              │
                              │   ○ 分析代码          │
                              │ ───────────────────── │
                              │ 当前目录              │  ← 仅当目录有 Skill 时显示
                              │   ○ 生成摘要          │
                              │   ○ 导出 PDF          │
                              │ ───────────────────── │
                              │ + 查看全部技能...      │
                              └───────────────────────┘
```

#### Skill 下拉框内容

合并展示 Agent 能力和当前目录 Skill：

```typescript
interface SkillOption {
  id: string;
  name: string;           // 显示名称
  description?: string;   // 简短描述（hover 显示）
  source: "agent" | "directory";  // 来源
  params?: ParamDef[];    // 参数定义（用于输入框提示）
}
```

#### 输入框 Placeholder 联动

| 模式 | Skill | Placeholder |
|-----|-------|-------------|
| 对话 | - | "输入消息..." |
| 生成视图 | - | "描述你想要的视图..." |
| 执行技能 | 下载 | "输入 URL 或资源名称..." |
| 执行技能 | 搜索 | "输入搜索关键词..." |
| 执行技能 | 分析代码 | "选择要分析的范围（可选）..." |

#### ActionBar 状态联动

**选中文件时**:
```
┌───────────────────────────────────────────────────────────────────────────────────────┐
│ [●] Connected  [小说阅读器 · v2 ▼]  [输入消息...]        [对话 · Claude ▼] [发送]      │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

**选中 Session 时**:
```
┌───────────────────────────────────────────────────────────────────────────────────────┐
│ [●] 下载小说 (活跃)                     [继续对话...]        [对话 · Claude ▼] [发送]  │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

**新建 Session**:
无 Session 选中时，输入消息自动创建新 Session，名称由 AI 生成。

---

## 三、Agent 交互设计

### 区分普通交互 vs UI 更新

通过 ActionBar 的模式下拉框区分：

| 模式 | 描述 | 示例 |
|-----|------|------|
| 对话 | 普通 Agent 交互 | "这个文件讲了什么" |
| 生成视图 | 触发 ViewCreateSkill | "小说阅读器，增加夜间模式" |
| 执行技能 | 调用已注册的 Skill | 选择"下载" + 输入参数 |

另外，Agent 也可以主动建议生成视图：

| 触发方式 | 描述 | 示例 |
|---------|------|------|
| 用户选择模式 | 切换到"生成视图"模式 | 用户主动选择 |
| Agent 建议 | 结构性变化后 Agent 询问 | "已下载到 novels/，是否生成阅读器视图？" |
| 用户确认 | Agent 建议后用户同意 | 用户点击"是"或回复确认 |

### 交互流程示例

**普通交互（对话模式）**:
```
用户: "这个文件讲了什么"
Agent: [分析并回答]
→ 不触发 UI 更新
```

**执行技能（技能模式）**:
```
用户: 选择 [执行技能] → [下载] → 输入 "江湖风云录 小说"
Agent: [下载完成，创建了 novels/erta/ 目录]
Agent: "已下载到 novels/erta/，是否生成阅读器视图？"
用户: "好的"
→ 触发 ViewCreateSkill
```

**生成视图（视图模式）**:
```
用户: 选择 [生成视图] → 输入 "把这个目录改成看板风格"
→ 直接触发 ViewCreateSkill
```

### Agent 交互初始上下文

**仅新建 Session 时构建初始上下文**，恢复对话时 Agent 已有上下文（通过 resume 或 exchanges），只需传递新消息。

#### 上下文组织原则

1. **路径优先，内容按需**：只传文件路径，让 Agent 自己读取内容（Agent 有文件访问能力）
2. **选中内容例外**：用户高亮选中的内容需要直接传，因为这是 UI 状态，Agent 无法获取
3. **语义优先**：传 userDescription（用户对目录的描述），不传目录结构（Agent 可自己 ls）
4. **关联优先**：recent session 只取与当前目录/文件关联的 Session
5. **Agent 能力自知**：Agent 内置能力不用传，只传目录自定义 skill

#### 客户端上下文 (Client Context)

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

#### 服务端上下文 (Server Context)

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

#### 各模式上下文详情

**对话模式 (chat)**:

| 上下文项 | 是否需要 | 说明 |
|---------|---------|------|
| 目录路径 | ✓ | Agent 工作目录 |
| userDescription | ✓ | 目录语义描述，Agent 无法自己获取 |
| 文件路径 | ✓ | 当前选中文件，Agent 可自己读取内容 |
| 选中内容 | ✓ | UI 状态，Agent 无法获取 |
| 目录结构 | ✗ | Agent 可自己 ls |
| 文件内容 | ✗ | Agent 可自己 cat |
| 关联 Session | ✓ | 提供历史上下文参考 |

**视图模式 (view)**:

| 上下文项 | 是否需要 | 说明 |
|---------|---------|------|
| 组件 Catalog | ✓ | Agent 不知道有哪些组件可用 |
| 组件 Schema | ✓ | Agent 不知道组件 props 定义 |
| Server API 列表 | ✓ | Agent 不知道有哪些 action 可用 |
| 当前视图 | ✓ | 修改时需要参考 |
| 视图示例 | ✓ | few-shot 提高生成质量 |
| 目录结构 | ✗ | Agent 可自己 ls |
| userDescription | ✓ | 理解目录用途 |

**技能模式 (skill)**:

| 上下文项 | 是否需要 | 说明 |
|---------|---------|------|
| Agent 内置能力 | ✗ | Agent 自己知道 |
| 目录自定义 skill | ✓ | Agent 不知道目录有哪些自定义 skill |
| 目录结构 | ✗ | Agent 可自己 ls |
| userDescription | ✓ | 理解目录用途 |

#### 上下文构建流程

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

#### 关联 Session 查找规则

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

#### 目录自定义 Skill 调用机制

**核心思路**: Agent 启动目录设为 .mindfs/，通过 --add-dir 添加用户目录，Agent 可自己发现 skill

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     Agent 启动与 Skill 发现                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  启动命令:                                                               │
│  claude --cwd /path/to/.mindfs --add-dir /path/to/user-dir             │
│                                                                         │
│  目录结构:                                                               │
│  .mindfs/                    ← Agent 工作目录                           │
│  ├── config.json             ← Agent 可读取 userDescription             │
│  ├── skills/                 ← Agent 可 ls 发现可用 skill               │
│  │   ├── download/                                                      │
│  │   │   └── config.json     ← Agent 可 cat 了解参数                    │
│  │   └── summarize/                                                     │
│  │       └── config.json                                                │
│  └── ...                                                                │
│                                                                         │
│  /path/to/user-dir/          ← 通过 --add-dir 添加，Agent 可访问        │
│  ├── novels/                                                            │
│  └── code/                                                              │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**好处**:
1. Agent 可自己 `ls skills/` 发现可用 skill
2. Agent 可自己 `cat skills/xxx/config.json` 了解 skill 参数
3. 不需要在上下文中传递 skill 列表
4. 不需要 MCP Server，简化架构
5. Agent 可读取 config.json 获取 userDescription

**Skill 执行方式**:

Agent 发现 skill 后，通过 Server API 调用执行（skill 执行涉及权限控制、审计等，不能让 Agent 直接执行）：

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Skill 执行流程                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  1. Agent 发现 skill                                                    │
│     $ ls skills/                                                        │
│     download/  summarize/                                               │
│                                                                         │
│  2. Agent 了解 skill 参数                                               │
│     $ cat skills/download/config.json                                   │
│     { "name": "下载", "params": [{ "name": "url", "type": "string" }] } │
│                                                                         │
│  3. Agent 调用 Server API 执行                                          │
│     POST http://localhost:8080/api/skills/download/execute              │
│     { "params": { "url": "https://..." } }                              │
│                                                                         │
│  4. Server 执行 skill 并返回结果                                         │
│     - 权限校验                                                          │
│     - 执行 handler                                                      │
│     - 记录审计日志                                                       │
│     - 返回结果给 Agent                                                   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**Agent 配置**:

```json
// ~/.config/mindfs/agents.json
{
  "agents": {
    "claude": {
      "command": "claude",
      "cwdTemplate": "{root}/.mindfs",      // 工作目录模板
      "addDirArgs": ["--add-dir", "{root}"], // 添加用户目录
      "sessionArgs": ["--stdin", "--no-exit"],
      "probeArgs": ["--version"]
    },
    "codex": {
      "command": "codex",
      "cwdTemplate": "{root}/.mindfs",
      "addDirArgs": ["--include", "{root}"], // Codex 可能用不同参数
      "sessionArgs": ["--interactive"],
      "probeArgs": ["--help"]
    }
  }
}
```

**启动流程**:

```go
func (p *AgentPool) CreateProcess(agent string, rootPath string) (*AgentProcess, error) {
    config := p.configs[agent]

    // 构建工作目录
    cwd := strings.Replace(config.CwdTemplate, "{root}", rootPath, -1)

    // 构建参数
    args := make([]string, 0)
    args = append(args, config.SessionArgs...)
    for _, arg := range config.AddDirArgs {
        args = append(args, strings.Replace(arg, "{root}", rootPath, -1))
    }

    cmd := exec.Command(config.Command, args...)
    cmd.Dir = cwd

    // ... 启动进程
}
```

**Skill 执行 API**:

```go
// POST /api/skills/:id/execute
func (h *Handler) ExecuteSkill(w http.ResponseWriter, r *http.Request) {
    skillID := chi.URLParam(r, "id")
    rootID := r.URL.Query().Get("root")

    var req struct {
        Params map[string]any `json:"params"`
    }
    json.NewDecoder(r.Body).Decode(&req)

    // 1. 加载 skill 配置
    skill, err := h.skillLoader.Load(rootID, skillID)
    if err != nil {
        http.Error(w, "skill not found", 404)
        return
    }

    // 2. 权限校验
    if err := h.permChecker.Check(skill.Permissions); err != nil {
        http.Error(w, "permission denied", 403)
        return
    }

    // 3. 执行 skill
    result, err := skill.Execute(req.Params)
    if err != nil {
        http.Error(w, err.Error(), 500)
        return
    }

    // 4. 记录审计日志
    h.audit.Log(AuditEntry{
        Type:    "skill",
        Action:  "execute",
        SkillID: skillID,
        Params:  req.Params,
        Result:  result,
    })

    json.NewEncoder(w).Encode(result)
}
```

**降级方案** (Agent 不支持 --add-dir 时):

如果 Agent 不支持 --add-dir 或类似机制，降级为在提示词中传递 skill 列表：

```typescript
// 在 System Prompt 中添加
const skillPrompt = `
你可以调用以下目录自定义技能 (通过 POST /api/skills/{id}/execute):

${skills.map(s => `- ${s.id}: ${s.description}
  参数: ${JSON.stringify(s.params)}`).join('\n')}
`;
```

#### 目录自定义 Skill 列表

```typescript
// 仅列出目录自定义 skill，不包含 Agent 内置能力
interface SkillBrief {
  id: string;                        // skill ID
  name: string;                      // 显示名称
  description: string;               // 简短描述
  params?: ParamDef[];               // 参数定义
}

// 扫描 .mindfs/skills/ 目录获取
function loadDirectorySkills(rootPath: string): SkillBrief[] {
  const skillsDir = path.join(rootPath, ".mindfs/skills");
  if (!fs.existsSync(skillsDir)) return [];

  return fs.readdirSync(skillsDir)
    .filter(name => fs.statSync(path.join(skillsDir, name)).isDirectory())
    .map(name => {
      const config = JSON.parse(
        fs.readFileSync(path.join(skillsDir, name, "config.json"), "utf-8")
      );
      return {
        id: name,
        name: config.name,
        description: config.description,
        params: config.params
      };
    });
}
```

#### 数据结构定义

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

---

## 四、视图路由系统

### 目录结构

```
.mindfs/
├── view-router.json                    # 路由配置
├── view-preference.json         # 用户选择偏好
└── views/                       # 视图文件（扁平存放）
    ├── file-list.json           # 系统默认: 文件列表
    ├── markdown.json            # 系统默认: Markdown
    ├── novels-reader.json       # 路径规则: novels/**
    ├── code-viewer.json         # 路径规则: code/** 或 *.ts/*.js
    └── root.json                # 根目录视图
```

### view-router.json 路由配置

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

### 匹配规则类型

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

### view-preference.json

```json
{
  "last_selected": {
    "novels/erta/readme.md": "markdown-viewer",
    "novels/erta": "novels-reader"
  }
}
```

### 路由解析逻辑

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

### 多视图切换 UI

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

## 六、数据模型

### Session

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

### Session 视图布局（含摘要）

```
┌─────────────────────────────────────────────────────────────────┐
│  Session: 下载小说 [⚡ 技能]                          [关闭 ✕]   │
├─────────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ 📋 摘要                                                    │  │
│  │ 下载了《江湖风云录》共 3 章到 novels/erta/ 目录              │  │
│  │ • 创建目录 novels/erta/                                   │  │
│  │ • 下载 chapter1-3.txt                                     │  │
│  │ • 生成小说阅读器视图 v1                                    │  │
│  └───────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│  关联文件: ch1.txt, ch2.txt, ch3.txt              [查看全部 →]   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  [我] 帮我下载《江湖风云录》                                      │
│                                                                 │
│  [Agent] 好的，正在下载...                                       │
│          ✓ chapter1.txt (12KB)                                  │
│          ✓ chapter2.txt (15KB)                                  │
│          ✓ chapter3.txt (14KB)                                  │
│          下载完成，共 3 章                                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 文件元数据

```typescript
interface FileMeta {
  path: string;
  source_session?: string;         // 生成此文件的 Session key
  created_at: string;
  created_by: "user" | "agent";
}
```

---

## 七、目录结构

### .mindfs/ 完整结构

```
.mindfs/
├── config.json                  # 目录配置 (Agent 偏好等)
├── view-router.json                    # 视图路由配置
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

### Session 存储

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
      "content": "好的，正在下载...\n✓ chapter1.txt (12KB)\n✓ chapter2.txt (15KB)\n✓ chapter3.txt (14KB)\n下载完成，共 3 章",
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

### related_files 获取方式

| 来源 | 触发时机 | 关系类型 |
|-----|---------|---------|
| 文件系统监听 (fsnotify) | Agent 创建文件时 | output |
| Agent 输出解析 | 解析 stdout 中的文件操作 | output |
| 用户消息解析 | 解析用户消息中的文件引用 | mentioned |
| 技能参数 | 执行技能时指定的输入文件 | input |

**不侵入 Agent**：通过 fsnotify 监听目录变化 + 解析 Agent 输出，自动追踪文件创建。

### config.json

```json
{
  "viewCreateAgent": "claude",
  "defaultAgent": "claude",
  "userDescription": "这是一个小说目录，用于按章节阅读与追踪进度。"
}
```

### file-meta.json

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

---

## 八、Agent 进程管理

### 通信协议：ACP + ndJSON

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

### 消息类型

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

### 响应结束检测

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

### Transport Handler 抽象

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

### Agent 配置

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

### 进程生命周期

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

### 进程池管理

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

### 权限请求处理

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

### 文件创建追踪

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

### 错误处理与重试

| 错误类型 | 处理策略 |
|---------|---------|
| 初始化超时 | 重试 3 次，指数退避 (1s, 2s, 4s) |
| 进程崩溃 | 自动重启，保留 session 上下文 |
| 响应超时 | 发送取消请求，等待 2s 后强制终止 |
| 权限请求超时 | 默认拒绝，通知用户 |

### 优雅关闭

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

---

## 九、审计日志

### history.jsonl 记录内容

```jsonl
{"ts":1706698800,"type":"session","action":"create","session":"session-001","session_type":"skill","actor":"user"}
{"ts":1706698801,"type":"session","action":"message","session":"session-001","role":"user","content_hash":"abc123","actor":"user"}
{"ts":1706698805,"type":"file","action":"create","path":"novels/erta/ch1.txt","session":"session-001","actor":"agent","size":12000}
{"ts":1706698810,"type":"view","action":"generate","rule":"novels-reader","version":"v1","session":"session-001","actor":"agent"}
{"ts":1706698900,"type":"session","action":"close","session":"session-001","actor":"system"}
{"ts":1706699000,"type":"file","action":"open","path":"novels/erta/ch1.txt","actor":"user"}
{"ts":1706699100,"type":"view","action":"switch","rule":"novels-reader","from":"v1","to":"v2","actor":"user"}
```

### 操作类型

| 类型 | 操作 | 说明 |
|-----|------|------|
| **session** | create, message, close, resume | Session 生命周期 |
| **file** | open, create, delete, rename | 文件操作 |
| **view** | generate, switch, revert | 视图操作 |
| **skill** | execute, cancel | 技能执行 |
| **dir** | add, remove | 管理目录 |

---

## 十、API 设计

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

### WebSocket 消息协议

WebSocket 用于实时双向通信，包括 Session 交互、流式输出、视图更新等。

#### 消息格式

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

#### 消息类型

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

### 流式输出协议

Agent 响应通过 WebSocket 流式推送，基于 ACP 协议的 SessionUpdate 消息。

#### SessionUpdate 类型

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

#### SessionUpdate → StreamChunk 转换

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

#### 流式输出示例

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

#### 前端渲染规则

| 块类型 | 渲染方式 |
|-------|---------|
| text | 追加到对话气泡 |
| thinking | 折叠显示（可展开） |
| progress | 进度条组件 |
| file_start/progress/done | 文件下载列表组件 |
| tool_call/result | 工具调用卡片（可折叠） |
| permission_request | 权限请求对话框 |
| error | 错误提示 |

#### 前端流式组件设计

**组件目录结构**:

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

**StreamMessage 组件**:

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

**ToolCallCard 组件**:

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

**PermissionDialog 组件**:

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

**AgentFloatingPanel 组件**:

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

**WebSocket 消息处理 Hook**:

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

---

## 十一、Agent 可用性探测

### 探测机制

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

### 前端展示

**Agent 选择下拉框**:

```
┌───────────────────────────────────────────────┐
│  模式              Agent                      │
│ ─────────────────────────────────────────────│
│  ● 对话            ● Claude  ✓  v1.0.0       │
│  ○ 生成视图        ○ Codex   ✗  未安装        │
│  ○ 执行技能        ○ Gemini  ✓  v2.1.0       │
│                    ─────────────────────────  │
│                    [↻ 刷新]                   │
└───────────────────────────────────────────────┘
```

**不可用 Agent 的处理**:
- 显示 ✗ 和错误原因（hover 显示详情）
- 禁止选择不可用的 Agent
- 如果当前选中的 Agent 变为不可用，自动切换到第一个可用的

---

## 十二、Session 生命周期

### 状态流转

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

### 超时配置

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

### 空闲检测逻辑

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

### 恢复 Session

从 closed 状态恢复：

1. **优先原生恢复**: 使用 `agent_session_id` 调用 Agent 的 `--resume` 机制
2. **降级恢复**: 原生恢复失败时，用 `exchanges` 构建上下文发送给新进程
3. **状态更新**: 恢复成功后状态变为 `active`

---

## 十三、错误处理

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

### 前端错误展示

| 错误类型 | 展示方式 | 示例 |
|---------|---------|------|
| 临时错误 | Toast 通知（3秒自动消失） | 网络超时 |
| 可恢复错误 | Toast + 重试按钮 | Agent 响应超时 |
| 阻断性错误 | 模态对话框 | Agent 不可用 |
| Session 错误 | 浮框内错误提示 | Session 恢复失败 |

### 错误恢复策略

| 错误码 | 自动恢复 | 用户操作 |
|-------|---------|---------|
| agent.timeout | 自动重试 1 次 | 提示重新发送 |
| agent.process_crashed | 自动重启进程 | 提示继续对话 |
| session.resume_failed | 降级到 exchanges | 提示上下文可能不完整 |
| view.generation_failed | 保持当前视图 | 提示重新生成 |
| file.not_found | - | 刷新文件树 |

### 错误边界组件

```tsx
// 主视图错误边界
<ErrorBoundary
  fallback={<ViewErrorFallback onRetry={reload} />}
  onError={(error) => audit.log({ type: "error", error })}
>
  <MainView />
</ErrorBoundary>

// 浮框错误边界
<ErrorBoundary
  fallback={<SessionErrorFallback onClose={closePanel} />}
>
  <AgentFloatingPanel />
</ErrorBoundary>
```

---

## 十四、实施优先级

### P0 - 核心功能

1. **ActionBar 对话功能**: 实现用户与 Agent 的对话入口
2. **Session 管理**: 创建、查看、继续 Session
3. **文件-Session 关联**: 记录文件来源，支持双向跳转

### P1 - 视图系统

1. **视图路由**: 基于路径/类型的规则匹配
2. **多视图切换**: 下拉框切换，记住用户选择
3. **版本管理**: 回退、重新生成

### P2 - 体验优化

1. **任务状态**: 执行进度、完成通知
2. **移动端适配**: 响应式布局
3. **认证**: Token 认证支持远程访问

---

## 十五、与 V1 的主要变化

| 方面 | V1 | V2 |
|-----|----|----|
| 核心定位 | AI 增强的文件管理器 | Agent 远程访问网关 |
| Agent 角色 | 仅用于生成 UI | 用户交互的主要对象 |
| Session 定义 | 用户操作序列 | 与 Agent 的对话会话 |
| UI 生成触发 | 目录加入管理时 | 用户触发或 Agent 建议 |
| 视图管理 | 单一 view-router.json | 路由规则 + 偏好 |
| 文件关联 | 无 | 记录来源 Session |
| ActionBar | 装饰性输入框 | Agent 对话入口 |

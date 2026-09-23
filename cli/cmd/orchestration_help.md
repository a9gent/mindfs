# 任务与会话编排

## 工作流

### 父会话：编排与验收

1. 确认用户目标，查询已有任务组、任务、可用模板和 agent。
2. 创建关联本会话的任务组，填写共享上下文。
3. 拆分任务、建立依赖，明确输入、验收标准及分支/集成策略；每项指定 task_template_id。
4. publish 当前计划，首次等待用户在前端确认。
5. 收到任务报告后，通过 `-to-task` 答复或发送新的执行要求。无法自主决定时与用户交流。
6. 全部任务完成后整体验收；需要修改时，通过 `-to-task` 说明修正或复核要求。上游改动影响哪些下游任务，由父会话判断并逐个发消息安排，不需要重新执行的任务保持原结果。
7. 验收通过后，对任务组 complete，提交最终结果。

### 任务会话：执行与交付

1. 读取任务输入、模板要求、共享上下文和依赖结果。
2. 执行并验证；需要答复或遇到无法继续的问题时，通过 `-from-task` 报告，并结束本轮等待父会话回复。
3. 当前阶段完成后，通过 `-from-task` 发送带 `completed: true` 的结果和证据，随后结束本轮。
4. 收到新消息时，按消息要求继续、修正或重新验证，完成后再次提交结果。

## CLI 用法

`<root-id>` 是项目 ID；`<current-session-key>` 是父会话标识，均从会话首条消息附带的 `MindFS context` 中获取。下列尖括号内容需要替换为实际值。

### 发现与查询

```bash
mindfs <root-id> -task-groups
mindfs <root-id> -tasks
mindfs <root-id> -tasks -cursor <next_cursor>
mindfs -agents
mindfs -task-templates
mindfs <root-id> -task-group <group-id> -graph
mindfs <root-id> -task-group <group-id> -context
mindfs <root-id> -task-group <group-id> -messages
mindfs <root-id> -task <task-id> -status
mindfs <root-id> -task <task-id> -context
mindfs <root-id> -task <task-id> -result
mindfs <root-id> -task <task-id> -messages
```

-task-group 接受任务组 ID；-task 接受任务 ID、项目内编号 12 或 '#12'（# 前需 shell 引号）。
JSON 中的 group_id、depends_on 使用真实 ID，不是任务编号。
-tasks 包含任务组中的任务，-task-groups 可用于按 session_key 识别当前会话已有的任务组。

`-tasks` 按创建时间倒序，每页最多返回 20 条。响应中的 `next_cursor` 是本页最后一条任务的 `task_number`，将其传给 `-cursor` 获取下一页，例如 `-cursor 192`；`next_cursor` 为空表示没有下一页。游标任务不存在时会返回错误，此时不带 `-cursor` 重新查询。
同一会话可以发起多个独立任务组。依赖只能连接同一任务组内的任务，不支持跨组依赖。

| 查询 | 何时使用 |
| --- | --- |
| `-task-groups` | 开始编排或恢复工作时，查找当前父会话已有的任务组。 |
| `-tasks` | 查看项目任务概况，定位需要检查或调整的任务。 |
| `-task-templates` | 创建任务前选择模板并取得模板 ID。 |
| `-agents` | 创建或修改任务执行配置前，查询可用 agent 和模型。 |
| 任务组 `graph` / `status` | 查看 DAG、任务进度和最新计划版本，准备发布或验收。 |
| 任务 `status` | 检查状态和执行记录，决定下一步操作。 |
| `context` | 执行前或恢复工作时读取任务组约定；任务 context 用于读取该任务上下文。 |
| 任务 `result` | 读取交付证据，进行集成、验收或确认返工对象。 |
| `messages` | 收到问题通知或恢复工作时，查询待处理消息。 |

### JSON 输入约定

通过标准输入提交一个 JSON 对象，支持 heredoc、管道或文件重定向：

```bash
mindfs <root-id> -task-create < task.json
cat task.json | mindfs <root-id> -task-create
```

查询命令不读取标准输入。创建、修改、交付等需要请求内容的操作必须提供 JSON；
发布、暂停、恢复等允许省略请求内容，无输入时按空对象处理。

省略字段表示不修改；空字符串/false/空数组是显式赋值，含义取决于字段。
请求提交后可删除临时 JSON 文件；后续状态通过查询命令读取。CLI 不自动删除文件。

### 从普通会话创建任务组

何时使用：用户提出一个需要拆分、协调和整体验收的新目标时创建。继续已有目标时先查询并使用原任务组。

```bash
mindfs <root-id> -task-group-create <<'JSON'
{"session_key":"<current-session-key>","title":"用户管理功能","project_context":"分页从 1 开始；提交前运行相关测试。"}
JSON
```

session_key 必须指向本项目内已有的普通聊天会话。title 便于识别；project_context 可省略。
返回的 `id` 用作后续命令中的 `<group-id>`。

已完成的任务组可以追加任务，追加成功后自动重新激活，保留已有交付结果；新增任务仍需发布，已确认过的任务组无需重复首次确认。已取消的任务组不能追加任务。

### 模板选择（必填）

何时使用：创建任务前查询并选择执行模板；需要单独指定 agent、模型时查询 `-agents`。

先运行 mindfs -task-templates 查询可用模板。
每个新任务必须显式指定 task_template_id，独立任务、组内任务和批量建图均适用。

### 创建任务

何时使用：新增一个执行单元，或在已有任务组中补充一项工作。已有任务仅需调整要求时用 `update`，已执行任务需补充要求时用 `-to-task`。

```bash
mindfs <root-id> -task-create <<'JSON'
{"group_id":"<group-id>","task_template_id":"<template-id>","input":"实现查询接口并运行相关测试","agent":"<available-agent>","model":"<available-model>","create_worktree":true,"worktree_branch_mode":"new","worktree_branch":"feature/query","depends_on":[]}
JSON
```

省略 group_id 创建独立普通任务。task_template_id 必填，agent/model 可省略；agent/model
未指定时沿用选中模板配置，可通过 -agents 查询可用配置。
create_worktree 决定工作区隔离；worktree_branch_mode=new 新建分支（名称省略则生成），
existing 使用已有分支（worktree_branch 必填）。关闭配置不会删除已有 worktree。
如何集成、提交和合并代码由父会话明确，系统不自动合并分支。

#### 编写 input

`input` 是普通文本，没有固定格式或自动组装规则。建议写清楚：工作目标、范围与约束、必要资料或上游任务 ID、交付内容和验收方式。只引用相关上下文，不复制整个会话。

例如：

```text
目标：实现用户列表查询接口。
范围：仅修改用户模块，保持现有响应格式。
依据：读取上游任务 task_abc123 的交付结果，沿用其数据结构。
交付：接口实现、相关测试及验证结果。
验收：覆盖分页边界与空列表场景，相关测试通过。
```

创建时填写完整要求；修改时 `input` 会整体替换原内容，应保留仍然有效的要求，而非只填写新增的一句话。

#### 填写依赖任务 ID

先创建上游任务 A，从 `-task-create` 返回 JSON 的 `task.id` 取得实际 ID。例如响应片段：

```json
{"task":{"id":"task_abc123","task_number":12,"group_id":"group_example"}}
```

再创建下游任务 B，将 A 的 `task.id` 填入 `depends_on`：

```bash
mindfs <root-id> -task-create <<'JSON'
{"group_id":"group_example","task_template_id":"<template-id>","input":"基于上游结果开发接口","depends_on":["task_abc123"]}
JSON
```

上例 ID 仅作演示，必须替换为实际返回值。已有任务可通过 `mindfs <root-id> -tasks` 查询，从 `items` 中按 `group_id`、`task_number` 和 `input_summary` 找到目标，取该项的 `id`。也可查询任务组 `graph`，读取 `tasks[].task.id`。

`depends_on` 只能填写同组上游任务的实际 ID，不能填写任务编号、标题或自行起的名称。没有依赖时省略或填 `[]`；多个上游填多个 ID。任务 `update` 中的 `depends_on` 使用相同规则。

### 原子批量建图

何时使用：一次拆分出多个有依赖的任务，或向已有计划追加一批任务。`plan` 创建新任务，不替换已有 DAG；修改已有节点用 `update`。

```bash
mindfs <root-id> -task-group <group-id> -plan <<'JSON'
{"tasks":[{"ref":"db","task_template_id":"<template-id>","input":"完成数据库迁移"},{"ref":"api","task_template_id":"<template-id>","input":"实现查询接口","depends_on":["db"]}]}
JSON
```

一次 1–100 个任务；每个任务必须指定 task_template_id，可单独指定 agent/model/worktree。
ref 仅在本次请求内有效，可向前引用；返回实际任务 ID。错误整批回滚，禁止循环依赖。

### 修改任务

何时使用：首次发布前根据用户反馈补充输入、验收要求或依赖；发布后尚未执行时调整 agent、模型、worktree 或分支；启动准备失败后修正配置。已开始执行的任务不通过 `update` 改写执行要求，统一使用 `-to-task` 发送要求。

```bash
mindfs <root-id> -task <task-id> -update <<'JSON'
{"input":"补充验收要求","depends_on":["<upstream-id>"],"agent":"<agent>","model":"<model>","create_worktree":false}
JSON
```

支持 input、depends_on、agent、model、create_worktree、worktree_branch_mode、worktree_branch。
执行配置及依赖限首次执行前修改，准备失败允许修正。修改已发布未执行的任务会撤出调度，
需再次发布。-delete 仅删除未执行、未发布、无工作区且未被引用的任务。

### 发布任务组

何时使用：任务及依赖已准备好时发布；新增任务或修改未执行任务后，再次发布当前计划。先用 `graph` 获取最新 `plan_version`。

```bash
mindfs <root-id> -task-group <group-id> -publish <<'JSON'
{"plan_version":3}
JSON
```

首次发布后，等待用户在前端确认。确认后，可在原需求范围内调整任务并再次发布。

### 报告与回复

消息会自动送达目标会话：空闲时处理，忙碌时等待；处理成功后自动记录完成，处理失败时保留消息并记录失败状态。`messages` 查询仅用于查看，不会领取或确认消息。

#### 任务向父会话报告

何时使用：执行任务需要确认约定或报告进展时。`<task-id>` 是发送任务的 ID，来自执行提示中的 `task_id`。父会话也可从创建响应的 `task.id` 或 `-tasks` 返回的 `items[].id` 获取。

```bash
mindfs <root-id> -from-task <task-id> <<'JSON'
{"message":"需要确认分页约定"}
JSON
```

报告会自动发给该任务所属任务组的父会话，无需提供任务组 ID。需要等待答复或执行遇到问题时，在报告中说明并结束本轮；交付时使用同一命令，并在消息中设置 `completed: true`。

#### 父会话向任务回复

何时使用：答复任务提问或补充执行约定。`<task-id>` 是目标任务的 ID，从收到的消息提示中的 `task_id` 获取，或查询 `-tasks` 的 `items[].id`。不要使用消息事件自身的 `id`。

```bash
mindfs <root-id> -to-task <task-id> <<'JSON'
{"message":"页码从 1 开始，默认每页 20 条"}
JSON
```

目标任务及其所属任务组由任务 ID 确定，无需填写 group-id 或收件人字段。已有会话的消息通过会话队列处理：空闲时继续对话，执行中则排队，不受任务并发限制；尚未创建会话的任务在首次执行时读取消息。修正、复核、重试都通过消息说明，无需专用操作。已取消的任务不接受新要求。

### 任务交付

何时使用：当前阶段完成并验证后，用 `-from-task` 发送交付消息；父会话的整体验收使用任务组 `complete`。

```bash
mindfs <root-id> -from-task <task-id> <<'JSON'
{"message":"完成接口；提交 abc123；测试通过；无遗留问题","completed":true}
JSON
```

设置 `completed: true` 表示当前阶段完成，系统按模板推进，最后阶段完成后任务才完成；省略或设为 false 表示普通报告。
交付结果应说明改动、文件或提交、验证结果及遗留问题。
正常任务完成不逐个唤醒父会话；直接依赖任务会收到上游结果，全部完成后触发整体验收。

### 发送修正或复核要求

何时使用：交付未满足目标，或上游改动可能影响下游时。父会话明确哪些任务需要重新执行，并通过 `-to-task` 发送具体要求；不需要重做的任务无需额外确认操作。

```bash
mindfs <root-id> -to-task <task-id> <<'JSON'
{"message":"上游接口已修改，请读取其最新结果，修正分页边界并运行相关测试；完成后提交验证结论。"}
JSON
```

已有会话通过会话队列处理新要求，保留历史结果，不重新等待任务调度。需要等待上游结果时，由父会话在上游完成后发送要求。未收到新要求的下游任务不会被自动改为待复核或重新执行。

### 整体验收

何时使用：所有任务交付完成，父会话确认集成结果满足用户目标后。发现问题则先返工具体任务，验收通过后再完成任务组。

```bash
mindfs <root-id> -task-group <group-id> -complete <<'JSON'
{"plan_version":3,"message":"集成测试通过，需求均已验收；交付说明……"}
JSON
```

全部任务完成并处理完待办消息后，检查实际交付和集成验证结果。验收通过后，携带最新 plan_version 和验收说明提交 complete。

### 任务操作

使用 `mindfs <root-id> -task <task-id> -<操作>`，需要内容时通过标准输入提交 JSON。

| 操作 | 何时使用 | 请求内容 |
| --- | --- | --- |
| `cancel` | 某项工作不再需要，终止该任务。 | 原因 `message`。 |
| `delete` | 清理误建或不再需要的草稿任务；仅限未执行、未发布、无工作区且未被引用的任务。 | 无。 |

### 任务组操作

使用 `mindfs <root-id> -task-group <group-id> -<操作>`，需要内容时通过标准输入提交 JSON。

| 操作 | 何时使用 | 请求内容 |
| --- | --- | --- |
| `pause` | 临时暂停整个计划的新任务执行，已运行任务可结束本轮。 | 可省略。 |
| `resume` | 决定继续暂停的计划，或已排除父会话消息处理失败的原因。 | 可省略。 |
| `cancel` | 整个目标不再需要，取消任务组及未完成任务。 | 原因 `message`。 |
| `complete` | 所有任务完成且整体验收通过，结束整个目标。 | 最新 `plan_version`、验收说明 `message`。 |

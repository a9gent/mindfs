# 远程 Vibe Coding 项目对比研究

对比项目：MindFS、HAPI、Happy、Paseo、Codeg、Orca  
评测日期：2026-08-04  
评测对象：本地仓库当前检出版本 + 截至评测日的 Android 分发渠道

## 1. 结论先行

这六个项目覆盖的是同一条用户旅程的不同部分，不宜只用“功能多少”排一个总榜：

- **MindFS** 最像轻量的远程 AI 工作站：Agent 覆盖广，Codex/Claude 走专门 SDK，任务看板、长期 Shell、项目文件、本地服务公网访问和 Agent 配置管理都在一个体积很小的部署中。它在本次最实用的两个差异项——**任务看板**和**一键远程访问本地服务**——上最突出。
- **Paseo** 的优势是接入深度和完整的多端 Agent 运行平台：Daemon 直接拉起并连接本机 Agent CLI，Claude、Codex、OpenCode、Pi 等使用各自原生接口，只有 Copilot 和自定义 ACP Agent 使用 ACP；远程终端、原生移动端、E2EE Relay、工作区脚本和 Worktree 服务编排都很完整。缺点是支持的默认 Agent 数量少于 MindFS/Codeg；Service Proxy 只是本地路由，不算产品自带的本地服务公网访问。
- **Codeg** 是六者中最完整的桌面工程工作台和多 Agent 协作台：编辑器、Diff、Git、Worktree、终端、会话聚合、`@` 委派、自动化、MCP/Skills、Office 和科研能力都很强。它的远程能力依赖自建可达地址与 Token，没有 MindFS/Paseo/HAPI 那样的内置 E2EE Relay；Claude/Codex 通过 ACP Adapter，而非直接使用其原生 SDK。
- **Orca** 是最偏“并行 Agent 舰队”的重型工程工作台：底层以 PTY 托管原生 CLI/TUI，任何终端 CLI 都能手动运行，约 35 个内置 Agent 另有启动、Prompt 注入、状态识别和恢复增强；这与 SDK/API/ACP 的结构化接入有本质区别。并行 Worktree、Agent/Workspace Kanban、任务追踪器、终端分屏、编辑器、Git Review 和编排 DAG 连成一套。它也支持桌面、无头 Server 和原生移动 Companion，但远程连接必须已有 LAN、Tailscale、SSH 隧道或反向代理，官方明确没有云中继；Electron 安装包约 200 MB，不能算轻量。
- **HAPI** 最适合“保留官方终端体验，需要时手机接管”的自托管场景。它具有优秀的本地/远程 Handoff、真正的远程 PTY、文件浏览、PWA、Telegram、语音和轻量单机 Hub。它不是任务管理平台，也没有本地开发服务代理。
- **Happy** 的强项是开箱即用的托管云、多端原生 App 和应用层 E2EE。它对普通用户的远程接管门槛最低，文件、Worktree、一次性 Shell RPC 和远程 Agent CLI 也已比根 README 展示的更丰富；但核心状态会以密文形式存储在中心服务器，任务看板、本地服务代理和完整工程工作台不是其重点。

### 四个最直接问题

| 问题 | MindFS | HAPI | Happy | Paseo | Codeg | Orca |
|---|---|---|---|---|---|---|
| 能否只通过本机端口使用 | **能**，默认 7331 | **能**，Hub 端口 3006 | **能**，运行 `happy server` | **能**，Daemon 端口 6767 | **能**，Server 端口 3080 | **能**，`orca serve --port 6768` |
| 安装后能否免网络配置远程访问 | **能**，绑定 Relay | **能**，`--relay` + 扫码 | **能**，默认云服务 | **能**，E2EE Relay + 扫码 | **不能**，需自行提供可达地址 | **不能**，需 LAN、Tailscale、隧道或反代 |
| 项目/会话数据是否默认存云端 | **不存** | **不存** | **存密文** | **不存** | **不存** | **不存**；仅匿名遥测元数据 |
| 文件、Git View、Worktree | **三者都有，且与任务关联** | **都有，Git 较基础** | **都有，以 Session 为中心** | **三者都强，Checkout 生命周期完整** | **三者都强，Git 图形客户端最完整** | **三者都强，以并行 Worktree 和 Review 为核心** |

### 按需求直接选择

| 你的首要需求 | 更合适的项目 | 原因 |
|---|---|---|
| 轻量自托管，同时要任务看板、文件和远程开发服务 | **MindFS** | 唯一把看板、长期 Shell、文件关联和 Relay 服务暴露放在同一轻量包中 |
| 追求 Claude/Codex 原生能力和完整跨端 Agent 平台 | **Paseo** | Daemon 与 Agent CLI 直连、原生移动端、E2EE Relay、成熟终端与 Worktree 服务编排 |
| 同时跑多个原生 CLI Agent，并用 Worktree、看板和任务追踪器管理产出 | **Orca** | 不要求 ACP；并行 Worktree、原生 TUI、Git Review、Kanban 与编排 DAG 最成体系 |
| 多 Agent 委派、Git/编辑器和专业产物工作台 | **Codeg** | `@` 协作、会话聚合、Monaco、Git、Worktree、Office/MCP/Skills 最完整 |
| 保留本地官方 CLI，用手机临时审批和接管 | **HAPI** | Handoff 是核心设计，部署轻，远程 PTY/PWA/Telegram 实用 |
| 不想部署远程入口，直接使用云同步和手机 App | **Happy** | 托管云 + iOS/Android/Web + 应用层 E2EE，用户接入路径最短 |

## 2. 评测方法与边界

本报告采用四类证据：

- **代码确认**：存在对应的数据模型、处理器、协议或 UI 实现。
- **配置确认**：项目内置注册表、默认配置或构建脚本明确支持。
- **文档宣称**：README 或项目文档描述，但本轮未端到端运行验证。
- **未见**：在 README、相关文档和关键词代码检索中均未找到；不等同于永久不支持。

本轮主体是**静态仓库研究，不是六套产品的完整真机横评**。没有登录各项目云服务，没有在六个平台分别完成弱网、断线、多设备冲突和长时间压力测试，因此“稳定性”仅依据可观察的恢复设计、测试资产和部署复杂度，不给出伪精确的性能分数。Paseo 的本地 Web UI 例外做了针对性真机核验：用隔离 Home 启动 `--web-ui` 后，本地端口根路径返回 HTTP 200。

评测快照：

| 项目 | 本地版本/提交 | 最近提交日期 |
|---|---|---|
| MindFS | `v0.4.5-4-g29b5cac` | 2026-07-31 |
| HAPI | `6174016` | 2026-07-31 |
| Happy | `80cc6ac` | 2026-07-30 |
| Paseo | `v0.2.5-6-gb6f1274f4` | 2026-07-30 |
| Codeg | `0.21.9` / `93f738e` | 2026-07-27 |
| Orca | `1.4.168-rc.1` / `9f638da` | 2026-08-04 |

符号说明：**强** = 能力完整或有明显差异化；**有** = 能完成主要任务；**部分** = 有相关能力但边界明显；**未见** = 本轮未找到产品级支持。

## 3. 24 维度总览

| 维度 | MindFS | HAPI | Happy | Paseo | Codeg | Orca |
|---|---|---|---|---|---|---|
| 1. Agent 支持与接入质量 | **强**：18 个；Codex/Claude 专门 SDK，其余 ACP | **强**：7 个可新建；按 Agent 混合原生、结构化协议和 ACP | **有**：5 个命名入口 + 通用 ACP；Claude/Codex 专门实现 | **强**：Daemon 直连 Agent CLI；5 个默认主力 + OMP，仅 Copilot/自定义 Agent 走 ACP | **强（广度）**：12 个 + 自定义；统一 ACP/Adapter，特有扩展补齐 | **强（终端兼容）**：任意终端 CLI 可运行；约 35 个内置 Agent 有增强集成，不要求 ACP |
| 2. 单 Agent 配置管理 | **强**：为同一 Agent 备份多套配置，新增 API Provider（Base URL/API Key）并一键切换 | **基础**：可切模型、Effort 和模式；未见独立的 Provider/Profile 保存与切换 | **部分**：可设 Agent 模型/权限默认值，Claude 可注入 Base URL 等环境变量；缺少统一 Profile 切换 | **强但偏手工**：同一 Agent 可建多 Profile，分别配置端点、凭据、环境变量和模型 | **强**：图形化管理 API URL/Key/模型，并绑定到单个 Agent；部分 Agent 双向同步原生配置 | **有（账号）**：Claude/Codex 多账号热切换和用量；供应商端点仍主要由 CLI 自身配置 |
| 3. 会话管理 | **强**：搜索、Fork、外部会话双向导入/同步、绑定恢复 | **强**：本地/远程 Handoff、恢复、Codex 同步/导入 | **强**：云同步、Handoff、Fork、远程创建/监控 | **强**：导入原生会话、恢复、统一生命周期 | **强**：聚合多 CLI 历史、搜索、导入、恢复、Fork | **强**：Orca 会话历史、恢复、休眠与持续终端；外部历史导入依 Agent 而异 |
| 4. 纯本地端口访问 | **是**：`127.0.0.1:7331`，无需账号 | **是**：本机 Hub 端口 `3006` | **是**：`happy server` 在 `127.0.0.1:3005` 同时提供 Server + Web App | **是**：Daemon 在 `127.0.0.1:6767`，可开启内置 Web UI | **是**：`codeg-server` 端口 `3080`，使用 Token | **是**：`orca serve --port 6768`，服务监听 6768 |
| 5. 安装后免网络配置远程访问 | **是**：网页绑定并登录 Relay，无需开端口 | **是**：`hapi hub --relay` 输出 URL/二维码；远程新建还需 Runner | **是**：默认 Happy Cloud + 账号配对，无需自建入口 | **是**：内置 E2EE Relay + 二维码配对 | **否**：必须自行提供公网地址、VPN、隧道或反向代理 | **否**：无云 Relay；需 LAN、Tailscale、SSH 隧道或反代 |
| 6. 项目/会话数据云端存储 | **否**：业务数据保存在项目 `.mindfs/`；Relay 仅用于连接 | **否**：会话存在本机 SQLite；Relay 不持久化 | **是（默认）**：中心云保存应用层 E2EE 密文；可改自托管 | **否**：Agent/Timeline 保存在 Daemon 主机；Relay 只转发密文 | **否**：无托管后端，数据库和文件在 Codeg 主机 | **否**：桌面主机是数据源；PostHog 仅接收匿名产品遥测，不含内容 |
| 7. 多端同步 | **有**：Web/PWA、Android、Harmony，多浏览器实时同步 | **有**：Web/PWA、Telegram Mini App，多客户端 SSE 同步 | **强**：iOS、Android、Web、CLI，中心云实时同步 | **强**：iOS、Android、Web、Electron、CLI | **有**：桌面/Web/Server、开源 iOS/Android 客户端；移动端仍标为测试阶段 | **强但直连**：桌面/无头 Server/iOS/Android；多主机配对，无中心云同步 |
| 8. 本地服务远程访问 | **强**：Relay 内配置地址即可获得公网域名 | **未见** | **未见** | **不计入**：Service Proxy 只是本地/Worktree 服务路由；公网仍由用户配置 DNS、TLS 与反代 | **未见通用代理** | **不计入**：可做 SSH 端口转发和 Worktree 浏览器；没有产品托管公网入口 |
| 9. 项目文件、Git View、Worktree | **强**：多项目文件预览；状态/Diff/历史/Commit；任务 Worktree | **有**：受限文件浏览；状态/Diff；新建 Worktree Session | **有**：文件读写/搜索；状态/Diff；Worktree 创建与清理 | **强**：文件浏览编辑；完整 Checkout/Git/Forge；Worktree 生命周期 | **强**：Monaco；完整 Git 客户端；一键 Worktree + 会话 | **强**：编辑器/文件树；Git Diff/Review/合并；并行隔离 Worktree 是核心 |
| 10. 文件—会话—任务关联 | **强**：数据库显式保存 task、related files、related worktree，支持双向跳转 | **部分**：文件与 Diff 以 Session/CWD 为入口，没有独立任务关联 | **部分**：文件/Git/Worktree 依附 Session，没有统一任务实体 | **有**：Agent—Workspace—Checkout—Timeline 关联强，没有看板任务实体 | **有**：会话文件、Diff、Worktree、自动化 Run 可关联，没有 MindFS 式任务看板关系 | **强**：GitHub/Linear/Jira 任务—Workspace/Worktree—Agent 会话—Diff/Review 连通，并可同步状态 |
| 11. 命令与终端 | **强**：命令卡片 + 每 Session 长期 Shell、多 Shell/Windows | **强**：远程 PTY、输入/Resize/关闭，POSIX PTY 与 ConPTY | **部分**：会话级 `bash` RPC；未见面向用户的持续远程 PTY 工作台 | **强**：低延迟持续终端、快照恢复、CLI 管理、性能/背压设计 | **强**：PTY、多终端标签、WebSocket 输出和尺寸控制 | **强**：原生 PTY/TUI、WebGL、无限分屏、持久滚动记录、SSH 终端 |
| 12. 任务看板与并发 | **强**：本地任务 Kanban；模板、阶段、队列、Worktree、Agent/模型 | **部分**：并发 Session、Worktree、Scratchlist/Todo，不是看板 | **部分**：并发 Session、Worktree、Rig 活动，不是看板 | **部分**：Agent/Workspace/Checkout、Schedule/Loop，不是 Kanban | **有**：自动化、后台任务、Worktree 隔离，但不是统一 Kanban | **强**：Workspace/Agent Kanban、外部任务状态同步、并行 Worktree 与编排 DAG |
| 13. 多 Agent 协作 | **有**：任务阶段可换 Agent、会话内切换、Subagent 展示 | **部分**：Peer 消息、Codex Collaboration、并发 Session；缺少统一委派台 | **部分**：Side Chat、Happy Agent CLI、Rig 活动；不是通用 `@` 委派 | **强**：创建/发送/等待 Agent 工具、Handoff/Loop Skills、子 Agent | **强**：`@` 多 Agent 并行委派、子会话实时汇流 | **强**：Prompt fan-out、隔离 Worktree、线程消息、任务 DAG、Decision Gate 与结果择优合并 |
| 14. 移动端体验与通知 | **有**：Android/PWA、移动布局、Web Push、Webhook 脚本 | **有**：PWA、Telegram、Push、语音；无原生 App | **强**：成熟 iOS/Android/Web、Push、移动优先 | **强**：原生 iOS/Android、语音、Push、跨平台统一 UI | **有**：原生客户端 + 消息渠道；移动端官方描述仍在测试 | **有（Beta）**：原生 iOS/Android Companion、文件/Git/终端/语音/通知；不是完整编辑器 |
| 15. 扩展能力 | **强**：文件视图插件、Agent 生成插件、Skills 输入、定时/Webhook | **有**：MCP Bridge、Telegram、语音和 Hub API | **有**：通用 ACP、Happy Agent CLI、Rig 协议；缺少统一插件市场 | **强**：自定义 Provider、MCP、Skills、CLI、Schedule、工作区脚本 | **强**：MCP/Skills、插件安装、Office、科研技能、自动化、聊天渠道 | **强**：Skills、MCP、Orca CLI、定时自动化、Computer Use、设计模式及任务/Git 平台集成 |
| 16. 连接安全与本地数据保护 | **有条件**：E2EE 默认关闭；可启用配对加密，局域网可启 TLS | **强**：Relay WireGuard+TLS；本地库明文，由 OS 保护 | **强**：云端内容为应用层 E2EE 密文 | **强**：Relay 默认 E2EE；直连和公开服务需用户设防 | **有**：Token 认证；无内置 E2EE Relay，TLS/隧道由用户负责 | **有条件**：设备凭据/E2EE 配对；无 Relay，网络路径与 TLS 由用户负责；内容留本机 |
| 17. 安装、轻量化与稳定性 | **强**：8.5–9.3 MB 发布包、15–16 MB 二进制、无 Node/Docker 运行依赖 | **强**：单包/单二进制 Hub + SQLite，零配置 Relay | **有**：托管使用简单；CLI 需 Node，也支持本机 `happy server` | **有**：桌面/CLI/Docker 完整但 Electron 与整体系统较重 | **有**：Tauri/Rust Server/Docker，功能面大、依赖与部署复杂度高于前两者 | **偏重**：Electron 桌面包约 190–208 MB；功能密、发布快，需关注回归 |
| 18. Android 国内直接安装 | **可用 PWA**：无 APK，不需要应用商店 | **可用 PWA**：无原生 App / APK | **较差**：官方原生版仅见 Google Play；可退回 Web App | **可下载 APK**：GitHub Release 有 APK，但最新版本可能晚一拍 | **可下载 APK**：独立 GitHub Release，附 SHA-256；仍属测试版 | **可下载 APK**：官方 GitHub 直接提供 Beta APK，不依赖 Google Play |
| 19. 导入与无缝恢复对话 | **强**：浏览并导入外部 CLI 会话，继续运行；还能回到原 CLI 恢复并双向同步 | **有**：同一 HAPI 会话可本地/远程无缝 Handoff；Codex 有历史导入/同步，其他 Agent 以 HAPI 内会话恢复为主 | **有（自有会话）**：云端历史、Handoff 和 `happy resume` 完整；未见统一导入任意外部 CLI 历史 | **强**：各 Provider 提供可导入会话列表、导入和原生 Session 恢复 | **强**：扫描多种 CLI 本地历史，导入/恢复；ACP Agent 还可走 `session/load` | **强**：AI Vault 扫描 Claude/Codex/OpenCode 等原生历史并按原生 Resume 命令恢复；具体深度依 CLI |
| 20. 会话 Fork 与 Subagent 识别 | **强**：可从历史回复 Fork；自动发现 Codex/Claude Subagent | **有**：Codex/Claude/Cursor 子任务可识别展示；统一会话 Fork 较弱，主要依 Agent 自身或导入 Codex 时 Fork | **强**：Claude/Codex 支持整段或指定位置 Fork；可跟踪 Claude/Codex Subagent 状态 | **强**：Fork/回退及 Fork Context；统一展示 Paseo Subagent 与 Provider 原生 Subagent | **强**：ACP `session/fork`、从当前 Turn Fork；多种 Agent 的子会话可展开查看 | **强但语义不同**：可把截取上下文 Fork 到新 Workspace；识别 Claude/Codex Subagent，但不保证调用各 CLI 原生 Fork |
| 21. 自定义 ACP Agent | **是**：额外 `agents.json` 定义命令、参数和 ACP 协议 | **未见**：内置 Agent 可走 ACP，但没有用户注册任意 ACP CLI 的产品入口 | **是**：`happy acp -- custom-agent --flag` | **是**：`extends: "acp"` + `command`，并可配置模型、环境变量和 MCP 能力 | **强**：图形化/注册表保存自定义 ACP Agent，支持命令、分发方式、图标和 Skills 声明 | **未见专用 ACP 接入**：任意 CLI 可在终端运行，但不会因此获得结构化 ACP 会话集成 |
| 22. 项目文件上传与下载 | **强**：文件树可上传到当前目录并下载到浏览器/系统 Downloads，支持移动壳与 E2EE 路径 | **强**：Session 目录上传（单文件上限 50 MB）和文件页下载 | **部分**：项目文件可远程读写，聊天附件可加密上传/下载；未见通用“项目文件下载到设备”的完整入口 | **强**：本地/远程 Workspace 支持二进制上传、下载和目录文件操作 | **强**：Web/移动远程附件上传、项目文件访问与下载；有上传隔离和配额 | **强**：本地/SSH/移动 Runtime 支持项目文件上传、流式下载及文件拖放 |
| 23. 图片输入 | **强**：消息和任务都可直接附图 | **有**：Composer 可附图/拖放，上传后以附件路径交给 Agent；实际视觉理解取决于 Agent | **有（实验）**：移动/Web 图片选择与加密附件链路完整，但受 `expImageUpload` 和 Agent 能力门控 | **强**：Composer 图片附件、上传和 Provider 能力协商；移动端可选择/拍摄图片 | **强**：聊天图片附件、拖放/粘贴和远程上传；各 Agent 最终支持度取决于 Adapter | **强**：桌面粘贴/选择图片，移动端相册/拍照/文件上传；以临时文件路径注入原生 CLI |
| 24. Agent 控制通道 | **结构化混合**：Codex/Claude 专用 SDK，其余主要 ACP；不托管 Agent 原生 TUI | **双通道**：本地模式运行原生 TUI，远程模式切 Claude SDK、Codex app-server、ACP 等结构化接口 | **结构化混合**：Claude 专门实现、Codex app-server、通用 ACP；重点是把事件转成 Happy 会话 | **原生结构化接口优先**：Claude Agent SDK、Codex app-server/SDK、OpenCode API、Pi/OMP RPC；“Direct Provider”不是 PTY/TUI，ACP 仅用于部分 Provider | **统一结构化协议**：ACP/Adapter 是 Agent 主控制面；PTY 是独立工程终端 | **PTY/TUI 优先**：真实 Shell 中直接运行 CLI，字节流和按键原样传输；已知 Agent 再叠加启动、Hook 与历史增强 |

## 4. 六者共同具备的基础能力（精简）

下面这些能力六个项目都有，差别主要在完成度、接入方式和使用边界，因此不再逐产品重复展开。具体强弱仍以第 3 节的 24 维总览为准。

| 共同能力 | 六者共同基线 | 仍需注意的差别 |
|---|---|---|
| 本地服务入口 | 都能在开发机启动本地服务并通过端口访问 | 端口、认证方式以及 Web UI 是否随服务启动不同 |
| 会话管理 | 都能保存、查看和继续由产品管理的 Agent 会话 | “继续产品内会话”不等于“导入任意外部 CLI 历史并恢复同一底层 Session” |
| 多端使用 | 都能从桌面、浏览器或移动设备查看并控制开发会话 | Happy 依赖默认云同步；MindFS、HAPI、Paseo 可用 Relay；Codeg、Orca 主要依赖自建直连 |
| 项目文件与 Git | 都能访问项目文件和 Git 状态，并提供某种 Worktree 工作流 | Git 历史、Review、合并、批量文件操作及 Worktree 生命周期完整度差异明显 |
| 命令执行 | 都能让 Agent 执行命令，并把结果带回会话 | MindFS、HAPI、Paseo、Codeg、Orca 有更明确的持续 PTY；Happy 更偏会话级命令 RPC |
| 并发与子任务 | 都支持多会话并行，并能承接 Agent 自身的子任务或子 Agent 信息 | 原生 Subagent 识别、跨 Agent 委派、统一看板和任务 DAG 不是同一能力 |
| 文件与图片输入 | 都存在文件上传、附件或图片输入链路 | “UI 可附图”不保证 Agent 收到原始视觉内容；项目文件下载到设备的完整度也不同 |
| 扩展与自动化 | 都能通过 Agent、Skills、MCP、脚本或定时任务中的至少一种方式扩展 | 是否允许用户注册任意 ACP Agent、是否有图形化管理以及自动化深度不同 |
| 数据保护 | 都有本机数据和访问控制机制 | 是否使用云端、是否默认 E2EE、TLS/公网入口由谁负责，是更关键的差异 |

共同能力不建议只看“有/没有”。真机验证应优先检查：恢复后 Session ID 是否不变、图片传入的是原图还是路径、下载是否能落到移动设备、Worktree 是否真正隔离，以及 Subagent 是否可回溯到父会话。

## 5. 影响选型的关键差异

### 5.1 Agent 控制通道、接入与配置

“直接运行 Agent CLI”至少有两种完全不同的含义：**PTY/TUI 托管**是把 CLI 当终端程序操作；**原生结构化接口**则可能同样启动 CLI 进程，但通过 SDK、App Server、RPC 或 JSON 事件与它通信。是否启动了 CLI 进程，不能判断它属于哪一类，关键要看控制通道传的是终端字节流还是结构化消息。

| 控制通道 | 实际传输 | 主要优势 | 主要代价 |
|---|---|---|---|
| PTY / 原生 TUI | 按键、字符流、ANSI 控制序列和终端尺寸 | 官方终端体验保真；新 CLI 不需要协议即可运行；Slash Command 和交互菜单天然可用 | 工具调用、权限、模型、Token、父子会话等语义通常要靠 Hook、进程检测或终端解析补齐；自动化和跨端 UI 容易受 TUI 版本变化影响 |
| Agent 原生 SDK / App Server / RPC / API | 消息、事件、Tool Call、权限请求、模型和 Session ID 等结构化对象 | 能可靠做会话恢复、权限 UI、图片、工具进度、Subagent 和数据统计；移动端不必重放整屏终端 | 每个 Agent 都要单独适配并追随上游接口；没有接口的功能无法凭空获得 |
| ACP / 通用 Adapter | 标准化 Session、Prompt、Tool Call、权限和能力协商 | 一套客户端可接多个 Agent，最适合用户自定义 Agent | 能力受协议与 Agent 实现共同限制；Codex、Claude 没有官方原生 ACP 时需要第三方 Adapter，并可能损失专有能力 |

| 项目 | 主 Agent 控制通道 | 对实际使用的影响 |
|---|---|---|
| MindFS | Codex/Claude 专用 SDK；其他 Agent 主要 ACP | 结构化会话和工程 UI 较稳定，同时避免把 Codex/Claude 强压进第三方 ACP；维护两类接入栈 |
| HAPI | **双通道**：本地原生 TUI；远程使用 Claude SDK、Codex app-server、ACP/结构化协议 | 本地保留官方 CLI 体验，离开电脑后切结构化远程控制；同一 Agent 的本地和远程能力可能不完全一致 |
| Happy | Claude/Codex 专门结构化实现，其他可走 ACP | 云同步和移动 UI 能得到结构化事件；不是通用的远程原生 TUI 工作台 |
| Paseo | **Direct Provider 是结构化直连，不是终端托管**：Claude Agent SDK、Codex app-server/SDK、OpenCode API、Pi/OMP RPC；部分 Provider 使用 ACP | 保留原生 Session 和专有能力，同时统一映射成 Paseo Timeline；每个 Direct Provider 都需独立维护 |
| Codeg | ACP/Adapter 为 Agent 主控制面，PTY 作为独立终端 | 多 Agent 接入模型统一、自定义 ACP 最完整；Claude/Codex 的专有能力取决于 Adapter 补齐程度 |
| Orca | PTY 托管原生 CLI/TUI；约 35 个已知 Agent 叠加命令模板、Prompt 注入、Hook、进程识别和历史恢复 | 任意 CLI 可以先运行，但未登记 CLI 主要只是普通终端程序；只有已知 Agent 才能获得较完整的状态、恢复、Subagent 和通知增强 |

因此，Orca 的“任意 CLI”优势主要是**兼容入口没有协议门槛**，不是“任意 CLI 自动获得完整 Agent 集成”。Paseo 的“Direct”则是**绕开 ACP、使用各 Agent 的原生结构化接口**，也不等于把 TUI 画面搬到客户端。

#### Agent 范围、配置与自定义 ACP

| 项目 | Agent 接入重点 | 单 Agent 配置 | 自定义 ACP Agent |
|---|---|---|---|
| MindFS | Codex/Claude 走专门 SDK，其余主要走 ACP | 多配置备份、API Provider 与一键切换 | **支持**：额外 agents.json 定义命令、参数和协议 |
| HAPI | 按 Agent 混合原生 TUI、专门集成与 ACP | 模型、Effort、模式等基础项 | **未见用户注册入口** |
| Happy | Claude/Codex 专门实现，另有通用 ACP 命令 | 模型、权限默认值和部分环境变量 | **支持**：happy acp -- custom-agent --flag |
| Paseo | Daemon 直连各 Agent CLI，自定义/Copilot 可走 ACP | Profile 可分别配置端点、凭据、环境和模型 | **支持**：extends: "acp" + command |
| Codeg | 统一 ACP/Adapter，专用扩展补齐差异 | 图形化 API URL、Key、模型和 Agent 绑定 | **最完整**：图形化注册、保存并立即加载 |
| Orca | 任意 CLI 可在 PTY 中运行；约 35 个内置 Agent 有增强集成 | Claude/Codex 多账号热切换；端点主要交给 CLI | **未见结构化 ACP 接入**；终端能运行不等于 ACP 集成 |

**直接判断：** 重视 Codex/Claude 原生能力，优先看 MindFS、HAPI、Happy、Paseo、Orca；重视统一 ACP 和自定义 Agent 管理，Codeg 最完整。Orca 的优势是绕开协议适配层，但因此也没有结构化自定义 ACP 管理。

### 5.2 远程入口、云端存储与安全责任

| 项目 | 安装后免网络配置远程访问 | 业务数据云端存储 | 安全责任边界 |
|---|---|---|---|
| MindFS | **有**：账号绑定 Relay | **无**：业务数据在项目 .mindfs | E2EE 可启用；局域网 TLS 仍需配置 |
| HAPI | **有**：Relay URL/二维码 | **无**：本机 SQLite | Relay 为 WireGuard + TLS；本地库由 OS 保护 |
| Happy | **有**：默认 Happy Cloud | **有**：云端保存应用层 E2EE 密文 | 使用最省配置，但依赖中心云；也可自托管 |
| Paseo | **有**：E2EE Relay + 配对 | **无**：数据在 Daemon 主机 | Relay 只转发密文；直连公开服务由用户设防 |
| Codeg | **无**：需 VPN、隧道或反代 | **无**：数据在 Codeg 主机 | Token 认证；TLS 和公网入口由用户负责 |
| Orca | **无**：需 LAN、Tailscale、SSH 或反代 | **无**：桌面/Server 主机是数据源 | 设备凭据与配对；网络路径和 TLS 由用户负责 |

MindFS 的 Relay、Paseo 的 Relay 和 HAPI 的 Relay 是产品远程能力；Paseo 的 Service Proxy 以及 Orca 的端口转发只是把本地服务路由到已有网络路径，不能算产品提供了公网入口。用户自己配置 DNS、TLS 和反向代理时，远程可达性来自用户基础设施。

### 5.3 文件、Git、Worktree、任务与并发工作流

| 项目 | 文件/Git/Worktree 完整度 | 文件—会话—任务关系 | 看板与并发特点 |
|---|---|---|---|
| MindFS | 文件预览、Git 状态/Diff/历史/Commit、任务 Worktree | **最显式**：Task、相关文件、Worktree 双向关联 | 本地任务 Kanban、模板、阶段和队列 |
| HAPI | 受限文件浏览、Git 状态/Diff、Worktree Session | 主要以 Session/CWD 关联，无独立任务实体 | 并发 Session + Scratchlist/Todo，不是 Kanban |
| Happy | 文件读写/搜索、Git 状态/Diff、Worktree | 文件/Git 依附 Session | 并发 Session、Side Chat、Rig 活动 |
| Paseo | 文件编辑、Checkout/Git/Forge、完整 Worktree 生命周期 | Agent—Workspace—Checkout—Timeline 关系强 | Schedule/Loop 与 Agent 编排，不是传统 Kanban |
| Codeg | Monaco、完整 Git 客户端、一键 Worktree | 会话、Diff、Worktree、自动化 Run 可关联 | 后台任务和多 Agent 委派，无统一 Kanban |
| Orca | 编辑器、Git Diff/Review/合并、隔离 Worktree | 外部任务—Workspace—Agent—Diff/Review 连通 | Workspace/Agent Kanban、任务 DAG 和结果择优合并 |

文件传输方面，MindFS、HAPI、Paseo、Codeg、Orca 都有明确的项目文件下载入口；Happy 的项目文件可远程读写，聊天附件可加密上传/下载，但本轮未见把任意项目文件保存到手机 Downloads 或分享面板的完整入口。

### 5.4 外部对话导入、无缝恢复、Fork 与 Subagent

这里严格区分四件事：发现外部历史、恢复同一个底层 Session、从某个节点 Fork、识别 Agent 自己创建的 Subagent。

| 项目 | 外部历史与底层 Session 恢复 | Fork | Subagent 识别 |
|---|---|---|---|
| MindFS | **强**：外部 CLI 会话导入、继续、回原 CLI 恢复并双向同步 | 指定历史回复 Fork | Codex/Claude |
| HAPI | Codex 有导入/同步；产品内会话可本地/远程 Handoff | 统一 Fork 较弱，部分依 Agent 自身 | Claude、Codex、Cursor 子任务 |
| Happy | 体系内 Handoff、云同步和 happy resume 完整；未见统一外部历史导入台 | Claude/Codex 可整段或指定位置 Fork | Claude/Codex 状态跟踪 |
| Paseo | 多 Provider 提供原生历史导入和 Session 恢复 | Fork Context；Claude/Codex 回退使用非破坏式 Fork | 平台 Subagent + Provider 原生 Subagent |
| Codeg | 多 CLI 历史聚合；支持 ACP session/load，依 Adapter 降级 | ACP session/fork、当前 Turn Fork & Send | 多种 Agent 子会话 |
| Orca | AI Vault 扫描历史并生成原生 Resume 命令 | 把有界上下文带到新 Workspace，不保证原生 Session Fork | Claude/Codex，依历史与 Hook |

**直接判断：** 外部历史集中导入优先看 MindFS、Paseo、Codeg、Orca；运行中桌面与手机交接，HAPI、Happy 更直接；统一观察平台 Subagent 与 Provider 原生 Subagent，Paseo 最完整。Orca 的 Fork 是工作区级分支，不应和每个 CLI 的原生 session/fork 混为一谈。

### 5.5 安装体量与 Android 国内分发

| 项目 | 运行与安装特征 | Android 国内直接安装 |
|---|---|---|
| MindFS | 发布包约 8.5–9.3 MB，单二进制，无 Node/Docker 运行依赖 | **PWA 可用**，无 APK，不依赖应用商店 |
| HAPI | 单包/单二进制 Hub + SQLite，Relay 配置少 | **PWA 可用**，无原生 APK |
| Happy | 托管使用简单；CLI 需要 Node | 原生包官方仅见 Google Play；国内更现实的是 Web App |
| Paseo | 桌面、CLI、Docker 完整，Electron 体系相对较重 | GitHub Release 有 APK，但可能晚于最新桌面版本 |
| Codeg | Tauri/Rust Server/Docker，能力面广、部署复杂度较高 | 独立 GitHub Release 提供 APK 和 SHA-256，仍属测试阶段 |
| Orca | Electron 桌面约 190–208 MB，功能密度高 | GitHub 直接提供 Android Beta APK，包体约 120 MB |

**直接判断：** 追求轻量部署优先看 MindFS、HAPI；需要国内可直接下载的原生 Android，Codeg、Orca、Paseo 更合适；Happy 的原生 Android 分发最不友好，MindFS/HAPI 则以 PWA 绕开商店。
## 6. 六个项目的实用优缺点

### MindFS

**优势**

- 远程开发闭环覆盖最均衡：Agent、看板、Shell、文件、本地服务、通知和 Relay 都有。
- 18 个 Agent，且 Codex/Claude 采用专门 SDK。
- 任务、会话、文件、Worktree 是显式关联的数据模型。
- 发布包非常小，跨平台原生服务、无运行时依赖。
- 配置备份/切换和 Agent 安装更新对多账号用户实用。

**限制与风险**

- E2EE 默认关闭，远程部署需要用户主动开启。
- iOS 主要依赖 PWA，原生移动覆盖不如 Happy/Paseo。
- README 的“Web 全部内嵌单二进制”与当前发布结构不符。
- 18 个 Agent 的体验可能不一致；应重点实测 Codex/Claude 与 2–3 个 ACP Agent。

### HAPI

**优势**

- 本地官方 CLI 与远程控制 Handoff 设计清晰。
- 自建 Hub、SQLite 和 E2EE Relay 兼顾数据所有权与易用性。
- 远程 PTY、文件浏览、Push、Telegram 和语音很实用。
- 部署轻，适合个人服务器、工作站或长期运行的开发机。

**限制与风险**

- 没有任务看板、本地服务代理和完整文件—任务关联。
- PWA 在 iOS 后台同步受限，没有原生移动 App。
- 各 Agent 的本地/远程接入路径不同，部分 TUI 命令不能远程使用。
- Agent 安装、登录和 Provider 配置主要由用户在主机上完成。

### Happy

**优势**

- 托管云让远程可达、多端同步和通知最省心。
- 应用层 E2EE 能保护中心服务器上的会话数据。
- iOS/Android/Web 产品路径成熟。
- 当前代码已有文件读写/搜索、Git Diff、Worktree、Fork、Side Chat 和远程 Agent CLI。

**限制与风险**

- 中心服务器仍持有加密数据副本，不是纯本地数据模型。
- 缺少本地服务代理、任务看板和完整工程工作台。
- 根 README 明显落后于当前代码，支持范围和部署架构容易被误判。
- 供应商 Token 注册到 Happy Cloud 的具体加密与服务端权限边界应单独审计。

### Paseo

**优势**

- Daemon 与本机 Agent CLI 直连；Claude/Codex 等主力 Agent 使用各自原生接口，接入保真度高。
- 原生移动端、Web、Electron、CLI 和 E2EE Relay 组成完整多端系统。
- 终端、Agent 生命周期、Workspace/Checkout、Schedule 和协议兼容设计成熟。
- 具备 Worktree 服务路由，能将开发服务纳入 Workspace 生命周期，但不提供公网入口。
- 安全文档对 Relay、直连、DNS Rebinding 和客户端权限边界说明最具体。

**限制与风险**

- 默认 Agent 覆盖少于 MindFS/Codeg。
- Provider 配置强但偏 JSON/运维用户，认证仍需各 Agent CLI 自行完成。
- Service Proxy 只解决本地路由；公网 DNS、TLS、反代和访问控制均由用户自行解决。
- 没有 Kanban 式任务看板。

### Codeg

**优势**

- 最完整的桌面工程工作区：编辑器、实时 Diff、Git、Worktree、终端和丰富预览。
- 12 个内置 Agent + 自定义 Agent，可安装和锁定大部分 Adapter 版本。
- `@` 多 Agent 委派和子会话汇流最直观。
- 会话聚合、自动化、聊天渠道、MCP/Skills、Office 与科研工作流形成明显差异化。
- Tauri 桌面与 Rust Server 共用核心，桌面和自托管模式覆盖完整。

**限制与风险**

- Claude/Codex 依赖 `claude-acp`/`codex-acp` Adapter，能力和兼容性多一层依赖。
- 缺少内置 Relay 和通用本地服务公网代理；远程网络由用户解决。
- 移动客户端仍处测试阶段。
- 功能面最宽，学习成本、安装体积和维护复杂度也更高。

### Orca

**优势**

- 不要求 ACP；任意 Agent CLI/TUI 都能先作为终端程序运行，约 35 个已知 Agent 还能获得启动、状态和恢复增强，Claude/Codex 的原生交互更容易保留。
- 并行 Worktree、Git Review、Workspace/Agent Kanban、外部任务状态和编排 DAG 构成六者中最完整的 Agent 舰队工作流。
- 编辑器、终端分屏、SSH Workspace、内嵌浏览器设计模式和任务平台集成适合真实工程项目。
- Claude/Codex 多账号热切换与本地用量查看很实用。
- iOS/Android Companion 和 GitHub 直链 APK，国内 Android 安装不依赖 Google Play。

**限制与风险**

- 没有官方云 Relay；跨网络必须自行配置 Tailscale、LAN、SSH 隧道、VPN 或反向代理。
- 不提供产品托管的本地服务公网 URL，端口转发也依赖用户网络基础设施。
- Electron 桌面包约 200 MB，移动 APK 约 120 MB，明显不属于轻量路线。
- Agent 配置偏“沿用 CLI 原生配置 + Claude/Codex 账号切换”，不擅长集中管理多个 API 供应商/Base URL。
- 并行扇出会放大 CPU、内存和 Token 消耗；快速发布节奏也要求在目标系统和 CLI 版本上做回归测试。

## 7. 建议的下一轮真机实测

静态研究已经能确定产品边界，但以下问题必须通过统一脚本实测才能下最终排名：

1. **Codex/Claude 保真度**：新建会话、工具调用、计划、提问、权限、图片、上下文余量、Fork/Resume 各跑一次。
2. **Handoff**：桌面启动任务，手机审批并追加要求，再返回终端继续，检查是否为同一底层 Session。
3. **断网恢复**：运行 20 分钟任务，中断手机网络和主机网络各一次，观察消息去重和权限请求恢复。
4. **本地服务代理**：启动 Vite + WebSocket 服务，验证手机、公网域名、热更新、认证和关闭后的路由回收。
5. **文件操作**：手机搜索文件、查看 Diff、编辑或下载大文件，验证二进制文件与路径越界保护。
6. **终端**：执行交互式命令、持续日志、10 MB 输出和窗口 Resize，检查内存、丢帧及重连缓冲。
7. **并发任务**：3 个 Agent 同时修改不同 Worktree，检查通知、CPU/内存和产物归属。
8. **配置切换**：在两个 Provider/Profile 间切换并新建会话，确认旧会话是否受影响、密钥是否只留在主机。
9. **移动端后台**：锁屏 10 分钟后触发权限请求，比较 Push 到达率和点击后的定位准确性。
10. **升级兼容**：分别升级 Codex/Claude CLI 和项目客户端，检查旧会话是否还能恢复。
11. **Orca 编排**：同一 Prompt 扇出 3 个原生 CLI 到独立 Worktree，验证 DAG 依赖、Decision Gate、看板状态同步、结果对比和最终合并。
12. **历史导入与恢复**：先在官方 Claude/Codex CLI 创建含工具调用和图片的会话，再由六个产品导入并继续，核对底层 Session ID、历史完整性和能否回原 CLI 接续。
13. **Fork 与 Subagent**：从中间 Turn Fork，确认后续消息没有串入；同时启动两个原生 Subagent，检查父子关系、状态、日志和恢复后的识别。
14. **自定义 ACP**：用同一个最小 ACP Fixture 注册到 MindFS/Happy/Paseo/Codeg，验证初始化、模型列表、权限请求、文件能力和 `session/load/fork`；HAPI/Orca 记录为不适用对照。
15. **双向文件传输**：手机向项目上传 1 KB 文本、20 MB 图片和 100 MB 二进制，再下载校验 SHA-256，测试路径越界、重名、断线和取消。
16. **图片输入**：相册、相机、剪贴板各发一张图给 Claude/Codex，检查 Agent 实际收到的是原图、压缩图还是仅路径，并验证恢复和 Fork 后能否继续引用。
17. **Agent 控制通道**：用同一 Claude/Codex 任务分别测试 PTY/TUI 与 SDK/App Server/ACP 路径，记录权限请求、Tool Call、模型切换、图片、Subagent、Token、断线恢复是否为结构化事件，以及 CLI 升级后是否仍兼容。

真机结果建议继续写入本文件，在总览表中新增“实测通过/失败”和复现步骤，而不要覆盖本轮静态结论。

## 8. 主要证据索引

### MindFS

- `../mindfs/README.zh.md`：功能、访问模式、安装和 CLI 参数
- `../mindfs/agents.json`：18 个 Agent、协议类型、安装与配置备份定义
- `../mindfs/server/internal/api/agent_config.go` 与 `../mindfs/web/src/services/agentConfig.ts`：单 Agent 配置备份、API Provider 和切换实现
- `../mindfs/go.mod`：Codex SDK、Claude Agent SDK、ACP SDK、PTY、E2EE/Relay 相关依赖
- `../mindfs/server/internal/session/manager.go`：任务、相关文件和 Worktree 持久化
- `../mindfs/server/internal/kanban/`：任务模板、队列、阶段和任务存储
- `../mindfs/server/internal/gitview/`：Git Status、Diff、Commit、历史与 Worktree 操作
- `../mindfs/server/internal/commandexec/`：命令与长期 Shell
- `../mindfs/server/internal/relay/services.go`：本地服务 Relay
- `../mindfs/web/src/services/session.ts`：外部会话导入、批量导入与 Session Fork
- `../mindfs/web/src/services/upload.ts` 与 `download.ts`：项目文件上传、下载及移动壳桥接
- `../mindfs/scripts/build-all.sh` 与 `../mindfs/server/app/server.go`：发布结构和外置 Web 静态资源

### HAPI

- `../hapi/README.md`：产品定位和主要功能
- `../hapi/AGENTS.md`：整体架构、数据流和关键模块
- `../hapi/shared/src/modes.ts`：当前 Agent 枚举及可新建列表
- `../hapi/shared/src/flavors.ts` 与 `../hapi/hub/src/sync/sessionCache.ts`：会话级模型、Effort 和模式切换
- `../hapi/cli/README.md`：各 Agent 的接入方式、恢复和 Runner
- `../hapi/docs/guide/how-it-works.md`：Handoff、权限和多端流程
- `../hapi/docs/guide/why-hapi.md`：数据位置、Relay 与 Happy 的架构差异
- `../hapi/hub/README.md`：文件、终端、Push、API 与传输安全边界
- `../hapi/web/src/components/CodexSessionSyncDialog.tsx`：Codex 外部历史导入与同步
- `../hapi/web/src/chat/subagentTool.ts` 与 `ToolCard/codexAgents.ts`：Claude/Codex Subagent 识别
- `../hapi/web/src/components/AssistantChat/` 与 `routes/sessions/file.tsx`：附件/图片输入、文件上传与下载

### Happy

- `../happy/README.md`：托管移动端定位和基础 Handoff
- `../happy/packages/happy-server/README.md`：零知识同步、自托管与数据存储
- `../happy/packages/happy-agent/README.md`：远程 Agent 控制 CLI
- `../happy/packages/happy-wire/README.md`：加密 Wire 协议
- `../happy/packages/happy-cli/src/`：Claude/Codex/Gemini/OpenClaw/Agy 接入、文件与 Shell RPC
- `../happy/packages/happy-cli/src/index.ts`：Claude 的 `--claude-env` 和自定义 API 端点启动参数
- `../happy/packages/happy-cli/src/commands/server.ts`：本地 `happy server`、端口和 Web App 自托管流程
- `../happy/packages/happy-app/sources/sync/serverConfig.ts`：默认云地址与自定义 Server 切换
- `../happy/packages/happy-app/sources/`：移动端、文件、Worktree、Fork、Rig 和配置 UI
- `../happy/packages/happy-cli/README.md` 与 `src/agent/acp/`：通用及自定义 ACP CLI 入口
- `../happy/packages/happy-cli/src/claude/utils/claudeSessionFork.ts` 与 `src/codex/codexThreadFork.ts`：Claude/Codex 会话 Fork
- `../happy/packages/happy-cli/src/api/apiSession.ts` 与 App `SessionView.tsx`：加密附件和实验性图片输入

### Paseo

- `../paseo/README.zh-CN.md`：产品范围和客户端覆盖
- `../paseo/docs/providers.md`：Direct 与 ACP 两种 Provider 接入模式
- `../paseo/docs/custom-providers.md`：自定义 Provider、Profile 和 API 端点
- `../paseo/docs/service-proxy.md`：工作区服务代理和公网安全边界
- `../paseo/docs/development.md`：Daemon Web UI 的开启方式
- `../paseo/SECURITY.md`：E2EE Relay、直连、认证和数据所有权
- `../paseo/docs/architecture.md`、`data-model.md`：Daemon、协议与本地持久化
- `../paseo/docs/terminal-performance.md`：终端流、背压与性能约束
- `../paseo/public-docs/custom-providers.md`：用户自定义 ACP Agent
- `../paseo/public-docs/orchestration.md` 与 `docs/agent-lifecycle.md`：Paseo/Provider Subagent 识别与展示
- `../paseo/packages/server/src/server/agent/activity-curator.ts`：会话 Fork Context

### Codeg

- `../codeg/docs/readme/README.zh-CN.md`：工作区、协作、移动端、自动化和安全定位
- `../codeg/AGENTS.md`：Tauri/Server 双模式架构
- `../codeg/src-tauri/src/acp/registry.rs`：12 个内置 ACP Agent 与 Adapter 注册表
- `../codeg/src-tauri/src/acp/connection.rs`：ACP 生命周期和 Codex/Agent 专用扩展
- `../codeg/src/components/settings/edit-model-provider-dialog.tsx` 与 `acp-agent-settings.tsx`：API URL/Key/模型 Provider 管理及单 Agent 绑定
- `../codeg/src-tauri/src/web/auth.rs`：Web/WS Token 认证
- `../codeg/src-tauri/src/bin/codeg_server.rs`：默认端口、数据目录和 Server 启动
- `../codeg/src-tauri/src/terminal/`：PTY 终端
- `../codeg/src/components/files/` 与 `src-tauri/src/web/handlers/files.rs`：文件、编辑与预览
- `../codeg/docs/CLIENT-PRIVACY.md`：移动客户端数据与 Token 存储
- `../codeg/src-tauri/src/acp/fork.rs` 与 `src/i18n/messages/zh-CN.json`：ACP Session Fork、Fork & Send 和 Subagent UI
- `../codeg/src-tauri/src/commands/custom_agents.rs`：自定义 ACP Agent 注册、保存和立即加载
- `../codeg/src-tauri/src/web/handlers/files.rs`：远程附件上传、隔离和配额边界
- `../codeg/src-tauri/src/web/handlers/workspace_files.rs` 与 `src/components/layout/aux-panel-file-tree-tab.tsx`：项目文件/目录下载接口与客户端入口
- `../codeg/src/components/chat/message-input.tsx` 与 `src-tauri/src/acp/prompt_hydration.rs`：图片选择、粘贴、拖放及 ACP Prompt 附件转换

### Orca

- `../orca/README.md` 与 `../orca/docs/readme/README.zh-CN.md`：产品定位、原生 CLI、并行 Worktree、移动端、终端、Git 与安装方式
- `../orca/docs/reference/headless-linux-server.md`：`orca serve`、6768 端口、LAN/Tailscale/反向代理和配对地址要求
- `../orca/src/renderer/src/components/dashboard-popout/AgentKanbanBoard.tsx` 与 `../orca/src/renderer/src/components/sidebar/WorkspaceKanbanDrawer.tsx`：Agent/Workspace Kanban
- `../orca/src/renderer/src/components/TaskPage.tsx`：GitHub/Linear/Jira 等任务页面与工程任务入口
- `../orca/skills/orchestration/SKILL.md`：Agent 线程消息、任务 DAG、依赖、Decision Gate 和 Coordinator Loop
- `../orca/src/main/claude-accounts/` 与 `../orca/src/main/codex-accounts/`：Claude/Codex 多账号隔离与运行时切换
- `../orca/src/main/ai-vault/`：原生 Agent 历史扫描、Resume 与 Claude/Codex Subagent 识别
- `../orca/src/shared/tui-agent-config.ts` 与 `tui-agent-startup.ts`：约 35 个已知 Agent 的命令、Prompt 注入模式和启动计划
- `../orca/src/main/daemon/pty-subprocess.ts`：Shell、环境、工作目录和 `node-pty` 原生 TUI 托管链路
- `../orca/src/renderer/src/components/terminal-pane/pty-connection.ts`：手工输入已知 Agent 命令后的进程/Pane 归属识别
- `../orca/src/renderer/src/components/terminal-pane/terminal-agent-session-fork.ts`：上下文式 Agent Session Fork
- `../orca/src/renderer/src/runtime/runtime-file-client.ts`：本地/远程文件上传和流式下载
- `../orca/mobile/src/session/mobile-image-attachment.ts`：移动端图片上传与原生终端路径注入
- [Orca Mobile 文档](https://www.onorca.dev/docs/mobile)：直连主机、无云 Relay、移动功能边界和 Android APK
- [Orca Telemetry 文档](https://www.onorca.dev/docs/telemetry)：匿名遥测字段、明确不采集的内容和关闭方式
- [Orca GitHub Releases](https://github.com/stablyai/orca/releases)：桌面安装包、Android APK、版本与体积

### Android 分发

- [Paseo v0.2.4](https://github.com/getpaseo/paseo/releases/tag/v0.2.4)、[Paseo v0.2.5](https://github.com/getpaseo/paseo/releases/tag/v0.2.5)、[Codeg Android](https://github.com/xintaofei/codeg-android/releases/latest)、[Orca Android v0.0.36](https://github.com/stablyai/orca/releases/tag/mobile-android-v0.0.36)：APK 直接下载与版本同步情况

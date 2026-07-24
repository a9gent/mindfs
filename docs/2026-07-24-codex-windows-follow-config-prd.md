# Codex Windows「跟随配置」导致箭头/模型菜单不可用 — 需求文档

## 1. 背景

MindFS 在 2026-07-20/21 引入并加固了 Codex「跟随配置」（commits `f8eadb7`、`253dd34`）：

- Codex 未 pin model 时，省略 model 覆盖，由 Codex 读取自身 `config.toml`
- UI 提供「跟随配置」选项，空字符串表示 follow

用户反馈：

- **Linux**：Codex 与「跟随配置」可正常使用
- **Windows AMD**：引入该能力后 Codex 直接异常，**Agent 下拉里的展开箭头（chevron）都出不来**

本需求从第一性原理定义：为何 follow-config 改动会在 Windows 上表现为「箭头消失」，以及正确修复边界。

## 2. 现象拆解（第一性原理）

### 2.1 UI 箭头从哪里来

`AgentSelector` 中每个 agent 行的右侧箭头只在 `hasModelOptions` 为真时渲染：

```text
hasModelOptions =
  models.length > 0
  || modes.length > 0
  || efforts.length > 0
  || supports_fast_service
```

箭头不是独立功能，而是 **probe 成功后能力列表** 的副产品。

因此「箭头出不来」在逻辑上等价于：

1. Codex probe 失败（`available=false` / `models=[]`），或
2. probe 从未拿到模型列表（`ListModels` / `RuntimeDefaults` 失败），或
3. 前端未收到 agents 状态更新（次要路径，本次不作为主因）

### 2.2 跟随配置依赖的运行时能力

「跟随配置」正确工作至少需要 Codex app-server 能：

| 能力 | 用途 | 失败时用户感知 |
|------|------|----------------|
| 启动 `codex app-server` | 一切基础 | Codex unavailable |
| `config/read` | 读取 config.toml 当前 model（展示「当前配置: xxx」） | follow 副文案空白 / probe 报错 |
| `model/list` | 填充模型列表与 efforts | **无箭头、无模型菜单** |
| `thread/start` 时省略 model | 真正 follow config.toml | 会话用错模型或启动失败 |

### 2.3 为何 Linux 可用、Windows 不可用

代码审查锁定跨平台差异点不在 UI 分支，而在 **Codex 子进程环境变量构造**：

1. `server/internal/agent/codex/session.go` 的 `buildCodexClientEnv` **始终返回非 nil map**（至少写入 `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`）。
2. `codex-go-sdk` 的 `AppServerExec.start()` 约定：

```text
if envOverride != nil {
  // 完全替换进程环境，不再继承 os.Environ()
  env = only keys in envOverride
}
```

3. 因此 app-server 实际只带着 originator（以及 agent 定义里显式配置的 env），**丢失**：

| 变量 | Linux 缺失影响 | Windows 缺失影响 |
|------|----------------|------------------|
| `PATH` | 子进程找 node/工具困难 | 同上，且 npm shim / `.cmd` 更依赖 PATH |
| `HOME` | 部分程序可用 `getpwuid` 回退 | Windows 无同等可靠回退 |
| `USERPROFILE` | 通常不需要 | **决定 `~/.codex` 与用户配置目录** |
| `APPDATA` / `LOCALAPPDATA` | 通常不需要 | Node / 安装器 / 缓存路径 |
| `SystemRoot` / `ComSpec` | 无 | 系统调用与 shell 基础 |
| `CODEX_HOME`（若用户设置） | 配置根目录错位 | 同左 |

父进程 `exec.LookPath("codex")` 仍用 **MindFS 自身环境**，所以「看起来已安装」仍可能为 true；但真正启动的 app-server 环境是残缺的。  
Unix 上 Codex/Node 常能从 passwd 回退 home，因此可能「半残但可用」；Windows 上缺少 `USERPROFILE`/`PATH` 时，`config/read` 与 `model/list` 更容易整体失败 → `models=[]` → **箭头消失**。

这与「加了跟随配置之后才坏」时间线一致：follow-config 依赖并强化了 probe 的 `RuntimeDefaults`/`ListModels` 路径，而 Codex client identity 改造（`2ceaa54`）引入的「始终非 nil Env」是环境被清空的根因；Windows 用户在 follow-config 功能落地后首次密集触发该路径。

## 3. 用户目标

1. Windows（含 AMD64）上 Codex 与 Linux 一样可 probe 成功：模型列表、effort、fast service 正常。
2. Agent 选择器 Codex 行右侧箭头正常显示，可展开模型子菜单。
3. 「跟随配置」在 Windows 上可选中、可持久、发送时省略 model 覆盖，并读取用户 `config.toml`（默认位于 `%USERPROFILE%\.codex\config.toml`，或 `CODEX_HOME`）。
4. 不破坏已有 follow-config 空字符串语义（pin / follow / inherit）。
5. 不因修复环境而把 agent 自定义 env 覆盖语义改坏。

## 4. 非目标

1. 不重做 follow-config 的 pin/follow 状态机（已在 `2026-07-21-codex-follow-config-*` 定义）。
2. 不修改 `codex-go-sdk` 上游（可在 MindFS 侧保证传入语义正确；若未来 fork SDK 再议）。
3. 不解决用户未安装 Codex、PATH 本身未配置等环境问题。
4. 不在本次做前端视觉改版。
5. 不启动 dev server、不打包；以类型检查与单元测试验证。

## 5. 需求明细

### R1. Codex 子进程必须继承宿主环境（P0）

- 当 agent 未声明额外 env、或只需要注入 originator 时，app-server **必须继承** MindFS 进程的环境变量全集。
- 允许在继承基础上 **覆盖/追加** 键：
  - `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`（默认 `codex-tui`）
  - agent 定义 / runtime 中的显式 `Env`
- **禁止** 用「仅含少数 key 的 map」整体替换进程环境。

验收：

- `buildCodexClientEnv(nil)` / `buildCodexClientEnv(map{})` 传入 SDK 后，不得触发「全量替换为仅 originator」。
- 有自定义 `Env{"FOO":"bar"}` 时，子进程既有宿主 `PATH`/`USERPROFILE`（若宿主有），也有 `FOO=bar`。

### R2. 与 SDK 替换语义对齐，且保留 MindFS client identity（P0）

SDK 行为：

- `envOverride == nil` → 使用 `os.Environ()`，缺失时补 originator 为 SDK 默认 **`codex_cli_rs`**
- `envOverride != nil` → **只使用 map 内容**

MindFS 需要 originator 为 **`codex-tui`**（client identity，commit `2ceaa54`）。因此 **不能** 用 `Env=nil` 走 SDK 默认 originator。

统一策略（成熟且不过度设计）：

1. **始终** 传 `merge(os.Environ(), custom overlays)` 的完整 map。
2. 若 merge 后 originator 仍为空，写入 `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=codex-tui`。
3. 禁止只传 originator 或只传业务键的残缺 map。


### R2 附注：分支差异

- **官方 `origin/main`**：无强制 `codex-tui` originator 时，空 env 传 `nil` 即可继承宿主环境。
- **自定义分支（含 client identity）**：若必须注入 `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=codex-tui`，则应始终 merge 完整宿主环境，避免 SDK 默认 `codex_cli_rs` 与残缺 map。

### R3. Windows 配置路径语义（P0）

- follow-config 读取的配置根目录与 Codex CLI 一致：
  - `CODEX_HOME` 优先
  - 否则 `%USERPROFILE%\.codex`（Windows）/ `$HOME/.codex`（Unix）
- MindFS 不得因清空 env 导致 Codex 找不到该目录。
- 文档与 i18n 中的 `~/.codex/config.toml` 对 Windows 用户含义为用户主目录下的 `.codex\config.toml`（展示文案可保持现有，不必本次改文案）。

### R4. 能力列表恢复后 UI 自动恢复（P0）

- probe 成功返回非空 models（或 supports_fast_service/efforts）后，前端无需额外改动即可显示箭头（现有 `hasModelOptions` 逻辑保持）。
- 不新增「强制显示箭头」的前端 hack。

### R5. 回归保护（P0）

至少覆盖：

1. 无自定义 env 时，传给 client 的 Env 为「完整宿主环境 + originator=codex-tui」。
2. 有自定义 env 时，merge 后仍含宿主关键键（测试用 `t.Setenv` 注入 marker）。
3. originator 默认与显式覆盖行为保持不变。
4. 既有 follow-config 相关 Go/TS 语义测试不回归。

### R6. 可观测性（P1）

- 若 Codex 启动失败，错误信息应能指向命令启动/环境问题（沿用现有 verbose/log；不强制新日志字段）。
- 可选：在 env 被清空类错误时日志可辨识（非必须）。

## 6. 成功标准

| ID | 标准 | 优先级 |
|----|------|--------|
| S1 | Windows 上 Codex `installed=true` 且 probe 后 `available=true`，`models.length > 0`（在 Codex 已正确安装且 config 可用的前提下） | P0 |
| S2 | Agent 下拉 Codex 行显示展开箭头 | P0 |
| S3 | 可选「跟随配置」；发送时不强制 pin model | P0 |
| S4 | Linux 行为不回退 | P0 |
| S5 | 单元测试覆盖 env merge / host inheritance 语义 | P0 |
| S6 | `web` typecheck 与相关 Go test 通过 | P0 |

## 7. 风险与约束

### 高风险

- **H1 环境被整体替换**：现状根因；必须修。
- **H2 自定义 env 覆盖宿主同名键**：merge 时自定义优先是正确语义，但测试需覆盖。

### 中风险

- **M1 SDK 未来改变 `envOverride==nil` 语义**：MindFS 侧注释标明契约；测试锁行为。
- **M2 仅修 MindFS 而用户本机 Codex 未装好**：超出范围，需在文档区分。

### 低风险

- **L1 i18n 仍写 `~/.codex`**：Windows 用户可理解；本次可不改。
- **L2 历史 session 仍 pin 旧模型**：follow-config 既有语义，非本次回归。

## 8. 开放问题

无。下列事项均已由代码契约确定，不阻塞开发：

1. SDK 对 `envOverride != nil` 的全量替换行为 — 已在 vendor 模块源码确认。
2. UI 箭头依赖 models 列表 — 已在 `AgentSelector` 确认。
3. originator 默认值 SDK 在 `envOverride==nil` 时也会注入 — 已在 `AppServerExec.start` 确认。

## 9. 范围边界小结

```text
In scope:
  - Codex client env 构造（MindFS codex runtime）
  - 相关单元测试
  - 文档（本 PRD + 技术方案）

Out of scope:
  - 前端 hasModelOptions hack
  - follow-config 状态机重写
  - 修改 codex-go-sdk 发布版本
  - 安装器 / PATH 引导 UI
```

## 10. 对抗式审查记录

### 审查轮次 1（2026-07-24）

| 级别 | 问题 | 处置 |
|------|------|------|
| 高 | 根因不仅是 `buildCodexClientEnv` 默认非 nil；**agent config 切换 / API provider 写入的部分 env map** 经 `SetAgentEnv` 传入后，同样会触发 SDK 全量替换，只保留少量业务键 | 纳入 R1/R2：任何非 nil `Env` 必须基于宿主 `os.Environ()` merge |
| 高 | 时间线：env 替换自 `2ceaa54`（client identity）已存在；follow-config 强化了 probe/ListModels 路径，使 Windows 用户表现为「加了跟随配置后箭头没了」 | 背景补充：功能暴露点 vs 根因引入点分离，修复仍落在 env 构造 |
| 中 | 若修复时「有自定义 env 只传自定义 map」，Windows 在切过 provider/backup 后仍坏 | R1 验收明确 merge |
| 中 | 既有单测需改为断言「宿主 env + originator」而非残缺 map | R5 |
| 低 | i18n 仍写 `~/.codex` | 保持，非阻塞 |
| 低 | 无真实 Windows 主机做 e2e | 以契约单测 + 代码路径证明；文档标明 |

### 审查结论

- 无开放阻塞问题。
- 可进入技术方案。


### 审查轮次 2（方案收敛后）

| 级别 | 问题 | 处置 |
|------|------|------|
| 高 | 若 `Env=nil` 则 SDK originator 为 `codex_cli_rs`，破坏 MindFS `codex-tui` 身份 | R2 改为始终 full-merge，禁止默认 nil |
| 中 | R5 验收文案仍写 nil | 已改为完整宿主环境语义 |

审查结论：无开放阻塞问题，可开发。

# MindFS

[English](./README.md) | [简体中文](./README.zh.md) | [官网](https://github.com/shuguangnet/mindfs) | [Discord](https://discord.gg/YPJMqeWSn) | [Twitter](https://x.com/yandc18) | [【微信群】](#微信群)

> **AI Agent 远程访问网关 · 结果可视化**

通过 MindFS 随时随地访问个人 ai agent 和工作站数据。

---

## 界面预览

<p align="center">
  <img src="docs/images/mindfs-desktop.webp" alt="MindFS 桌面端界面" width="92%" />
</p>
<p align="center">
  <img src="docs/images/mindfs-mobile.webp" alt="MindFS 移动端界面" width="92%" />
</p>

---

## 特性

### Agent 会话

- **多 Agent 支持**：Claude Code · OpenAI Codex · Gemini CLI · Cursor · Copilot · Cline · Augment · Kimi · Kiro · Qwen · Qoder · OMP · Pi · Hermes · Reasonix · OpenCode · OpenClaw，自动探测已安装的 Agent。
- **实时流式输出**：逐 token 推送，工具调用、思考过程、权限请求均以结构化卡片实时渲染，上下文窗口实时余量。
- **灵活切换**：会话中随时切换 Agent 或模型，多 Agent 共享同一上下文，无需重新描述背景。
- **会话搜索**：支持按会话标题或对话内容搜索，并可直接跳转到命中的会话和片段。
- **外部会话双向导入同步**：可浏览受支持 Agent CLI 的已有会话，选择后导入到 MindFS，并作为原生 MindFS 会话继续使用，同时 MindFS 中的会话亦可在cli中恢复。后续亦可双向同步。
- **绑定持久化与恢复**：MindFS 会持久化内部会话与底层 Agent 会话的绑定关系，服务重启后可恢复该关联；后续消息在条件允许时会继续落到同一个 Agent 会话上。
- **富媒体输入**：支持在消息中直接附带文件和图片。
- **多端同步**：同一实例可同时在多个设备上访问，会话状态实时同步。
- **配置备份和切换**：agent配置可备份，备份后可以一键切换配置，解决 多账号/多apikey 切换的麻烦。
- **subagent**：codex/claudecode subagent 自动发现和展示。
- **会话 fork**: 可从历史回复 fork 出新的会话。
- **定时任务**：在指定时间触发 Agent 执行任务。
- **codex 远程登录**: 通过/login 命令实现 codex 远程登录。

### 文件访问

- **多 Project**：同时托管多个目录，会话按 Project 独立组织，互不干扰。
- **数据自托管**：所有对话历史、文件元数据、视图配置均存储在 Project 目录的 `.mindfs/` 子目录下，迁移和备份只需复制目录本身。
- **文件树浏览**：完整的目录树导航，支持文件预览，Markdown、图片、代码均有对应渲染器。支持 git status, git worktree。

### 交互优化

- **`/` 斜杠命令**：输入 `/` 触发命令候选列表，快速执行预设操作。
- **`@` 文件引用**：输入 `@` 触发文件路径补全，将任意文件作为上下文附件发送给 Agent。
- **`#` 快捷提示词**：输入 `#` 触发已收藏的快截提示词输入。
- **文件与会话双向跳转**：打开文件可跳转到产生它的会话；打开会话可查看所有相关文件。
- **Android, 浏览器应用（PWA）**：可安装到桌面或手机，体验更优。
- **手机界面优化**：底部操作栏拇指可及，界面更简洁。
- **通知推送**：会话状态变化时通过 Web Push 推送通知（ios 需要添加到主屏幕）。
- **用户习惯适配**：左右侧边栏位置可交换、单项目/多项目会话列表可切换。

### 访问模式

- **本地模式**：服务启动后即可在局域网内通过浏览器访问，无需任何账号或配置。
- **Relay 远程模式**：无需开放防火墙端口，通过relayer从公网任意设备访问本地实例，实现随时随地的 agent 访问。（本地模式页面中点击绑定按钮）
- **私有通道**：通过私有通道（tailscale等），直接通过 ip:port 访问。
- **端到端加密**：会话、文件支持端到端加密保护。

### 插件系统

- **定制视图**：插件是一种针对文件的定制视图，按照「传入文件内容 → 解析 → 渲染界面」的框架运行。
- **Agent 生成插件**：向 Agent 发送「实现一个 txt 小说阅读器」，Agent 即可生成对应插件，此后所有 txt 文件将以小说阅读方式呈现。
- **交互闭环**：实现「定制插件 → 浏览文件 → Agent 交互」的完整闭环。

### 命令执行
- **卡片输出**：命令执行结果以卡片模式呈现，更加清晰。
- **历史候选**：输入匹配到历史命令后自动弹出候选列表，快捷输入。
- **屏幕宽度适配**: 命令输出适配屏幕宽度，结果展示更加友好。
- **shell类型可续**：命令执行shell可选，Windows不用烦恼shell类型。
- **会话保持**：每个session一个长期 shell，更加方便的实现 tmux 效果。

### 远程访问本地服务
- **一键暴露**：Relay模式下，MindFS 中配置本地服务地址后，就可以将本地服务暴露给公网。
- **公网域名**：通过唯一公网域名直达本地服务。

### 安装运行

- **单二进制**：生产构建是一个静态编译的单二进制文件，内嵌所有 Web 资源，安装包小于 10M。
- **零依赖**：宿主机无需安装 Node.js、Docker 或任何守护进程管理器。
- **多平台**：支持 macOS（Intel + Apple Silicon）、Linux（x86-64、ARM64、ARMv7）、Windows（x86-64、ARM64）。

---

## 快速上手

### 前置条件

MindFS 本身不包含 AI 模型，需要在本机安装至少一个 Agent CLI。按需选择：

| Agent | 安装 |
|-------|------|
| **Claude Code** | https://code.claude.com/docs/en/quickstart |
| **OpenAI Codex** | https://developers.openai.com/codex/cli |
| **Gemini CLI** | https://geminicli.com/ |
| **Cursor** | https://cursor.com/cn/cli |
| **GitHub Copilot** | https://github.com/features/copilot/cli |
| **Cline** | https://cline.bot/kanban |
| **Augment** | https://www.augmentcode.com/product/CLI |
| **Kiro** | https://kiro.dev/cli/ |
| **OpenCode** | https://opencode.ai/ |
| **OpenClaw** | https://docs.openclaw.ai/ |
| **Kimi** | https://www.kimi.com/code/docs/kimi-cli/guides/getting-started.html |
| **Qwen** | https://qwen.ai/qwencode |
| **Qoder** | https://docs.qoder.com/cli/quick-start |
| **OMP** | https://github.com/can1357/oh-my-pi（`omp acp`） |
| **Pi** | https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent, and acp adatper: https://github.com/svkozak/pi-acp |
| **Hermes** | https://hermes-agent.nousresearch.com/docs/user-guide/features/acp |
| **Reasonix** | https://github.com/esengine/DeepSeek-Reasonix |

MindFS 已整理常见流行 Agent，在本地 UI 中可以直接安装和更新。打开文件树菜单，选择 **Agent 安装和更新**，即可按当前平台生成安装/更新命令；命令会进入 MindFS 命令执行模式，方便你在当前工作区中确认并运行。

安装好 Agent 后，即可启动 MindFS 并通过浏览器与之交互。



### 安装

**macOS / Linux**
```bash
curl -fsSL https://raw.githubusercontent.com/shuguangnet/mindfs/main/scripts/install.sh | bash
```

自定义安装路径：
```bash
curl -fsSL https://raw.githubusercontent.com/shuguangnet/mindfs/main/scripts/install.sh | bash -s -- --prefix your/path
```

**Windows（PowerShell）**
```powershell
irm https://raw.githubusercontent.com/shuguangnet/mindfs/main/scripts/install.ps1 | iex
```

安装脚本会自动检测系统和架构，先从 [`release-notes.md`](https://raw.githubusercontent.com/shuguangnet/mindfs/main/release-notes.md) 第一行读取最新版本号，再从 [GitHub Releases](https://github.com/shuguangnet/mindfs/releases) 下载对应的二进制包并完成安装。这个入口适合个人机器或普通用户级安装，默认安装到 `~/.local`。

### 卸载

卸载命令会删除已安装的二进制、内置 Web 资源、内置默认 `agents.json`，并移除安装脚本添加的 PATH 项。默认保留用户配置和项目 `.mindfs/` 数据。

**macOS / Linux**
```bash
installer="${TMPDIR:-/tmp}/mindfs-install.sh"
curl -fsSL https://raw.githubusercontent.com/shuguangnet/mindfs/main/scripts/install.sh -o "$installer"
bash "$installer" --uninstall
```

**Windows（PowerShell）**
```powershell
$Installer = Join-Path $env:TEMP "mindfs-install.ps1"
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/shuguangnet/mindfs/main/scripts/install.ps1" -OutFile $Installer
& $Installer -Uninstall
```

如需同时删除用户级 MindFS 配置和日志，macOS/Linux 追加 `--purge`，Windows 追加 `-Purge`。项目目录中的 `.mindfs/` 不会被自动删除。

**从源码编译**（需要 Go 1.22+、Node.js 20+）
```bash
git clone https://github.com/shuguangnet/mindfs.git
cd mindfs
make build      # 产物为 ./mindfs
```

**打包 release 并一键部署（Linux 服务器）**
```bash
git clone https://github.com/shuguangnet/mindfs.git
cd mindfs
make build-all VERSION=v0.3.8

# 将 dist/mindfs_v0.3.8_linux_amd64.tar.gz 拷到目标服务器后执行
bash scripts/deploy-release.sh \
  --archive dist/mindfs_v0.3.8_linux_amd64.tar.gz \
  --service-name mindfs-17331 \
  --addr 127.0.0.1:17331 \
  --agent-config /etc/mindfs/agents-empty.json \
  --env OPENAI_API_KEY=your_key
```

**空白 Linux 服务器一键部署最新 release**
```bash
curl -fsSL https://raw.githubusercontent.com/shuguangnet/mindfs/main/scripts/deploy-release.sh | bash
```

如果要指定端口、服务名或环境变量：
```bash
curl -fsSL https://raw.githubusercontent.com/shuguangnet/mindfs/main/scripts/deploy-release.sh | bash -s -- \
  --service-name mindfs-17331 \
  --addr 127.0.0.1:17331 \
  --agent-config /etc/mindfs/agents-empty.json \
  --env OPENAI_API_KEY=your_key
```

脚本地址：
- `https://raw.githubusercontent.com/shuguangnet/mindfs/main/scripts/deploy-release.sh`

如果服务器里已经安装了 `codex` 或其他 agent，但 MindFS 仍显示“未安装”，常见原因不是某个配置目录缺失，而是 `mindfs` 的 systemd 服务进程 `PATH` 没包含这些 agent 可执行文件所在目录，例如 `~/.local/bin`、`~/go/bin`、`~/.cargo/bin`、`~/.bun/bin`。`deploy-release.sh` 生成的 service 会显式写入一组常见用户级安装目录：

```ini
Environment=PATH=/root/.local/bin:/root/bin:/root/.npm-global/bin:/root/.yarn/bin:/root/.config/yarn/global/node_modules/.bin:/root/.bun/bin:/root/go/bin:/root/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
```

这样 `mindfs` 用 `exec.LookPath(...)` 探测时，就能识别大多数通过用户级方式安装的 agent，而不只是 `codex`。

部署脚本会完成这些动作：
- 解压 release 到 `INSTALL_DIR/releases/<version>`
- 更新 `INSTALL_DIR/current` 软链接
- 写入/更新 systemd service
- 可选写入环境变量文件并重启服务

如果 release 包已经在机器上，也可以直接用 Makefile：
```bash
make deploy-release \
  ARCHIVE=dist/mindfs_v0.3.8_linux_amd64.tar.gz \
  SERVICE_NAME=mindfs-17331 \
  ADDR=127.0.0.1:17331 \
  AGENT_CONFIG=/etc/mindfs/agents-empty.json
```

### 启动

```bash
mindfs                        # 托管当前目录
mindfs /path/to/your/project  # 托管指定目录
mindfs -addr :9000 /path/to/your/project # 指定端口
```

在浏览器中打开（默认端口） [http://localhost:7331](http://localhost:7331)。

#### HTTPS (TLS)

启用 HTTPS，使用自动生成的自签名证书（重启后可复用）：

```bash
mindfs -tls
mindfs -tls -addr :9000 /path/to/your/project
```

在浏览器中打开 [https://localhost:7331](https://localhost:7331)。自动生成的证书包含 `localhost`、`127.0.0.1`、`::1` 以及所有非回环网卡 IP 的 SAN，局域网内其他设备访问时不会出现证书名称不匹配警告。证书存储在用户配置目录下（如 Linux 的 `~/.config/mindfs/`）。

使用自定义证书和私钥文件：

```bash
mindfs -tls -cert /path/to/cert.pem -key /path/to/key.pem
```

MindFS 会自动探测已安装 Agent 的可用性，通常需要大约一分钟。

### 通过 relayer远程访问

1. 本地模式打开 mindfs 页面，点击左下角绑定按钮。
2. 登录 relayer，确认绑定。
3. 打开节点。

### 自定义 ACP Agent

MindFS 可以额外加载一个 `agents.json`，用于支持实现 ACP 协议的自定义 Agent CLI。适合测试新的 Agent，或把项目专用 Agent 定义放在内置默认配置之外。

```json
{
  "agents": [
    {
      "name": "my-agent",
      "brief": "显示在安装/更新列表中的简短说明。",
      "command": "my-agent",
      "protocol": "acp",
      "args": ["--acp"]
    }
  ]
}
```

启动 MindFS 时指定额外配置：

```bash
mindfs -agent-config /path/to/agents.json
```

这个额外配置既可以新增 Agent，也可以用相同 `name` 覆盖已有定义。

### MindFS CLI 命令说明

```bash
mindfs [flags] [root]
```

`root` 是要托管的目录。未指定时，MindFS 只打开服务，不新增托管目录。

默认情况下，`mindfs` 会启动或复用后台服务并自动打开浏览器。传入 `root` 时才会注册目录；如果所选监听地址上已经有 MindFS 服务在运行，命令会复用该服务并新增该目录。

#### 常用命令

```bash
mindfs
mindfs /path/to/project
mindfs -addr :9000 /path/to/project
mindfs -foreground /path/to/project
mindfs -status
mindfs -version
mindfs -update
mindfs -uninstall
mindfs -stop
mindfs -restart
mindfs -remove /path/to/project
mindfs -agent-config /path/to/agents.json
```

#### 参数说明

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `-addr string` | `127.0.0.1:7331` | 监听地址。使用 `:7331` 或 `0.0.0.0:7331` 可允许局域网访问。 |
| `-foreground` | `false` | 前台运行服务，不启动后台进程。适合开发、调试或配合进程管理器使用。 |
| `-status` | `false` | 查看后台服务状态、PID、访问地址和日志文件路径。 |
| `-version` | `false` | 查看当前 MindFS 版本。 |
| `-update` | `false` | 检查并安装最新 MindFS 版本。更新后需要手动重启 MindFS。 |
| `-uninstall` | `false` | 打印当前平台的卸载命令。 |
| `-stop` | `false` | 停止所选监听地址对应的后台服务。 |
| `-restart` | `false` | 如后台服务已存在则先停止，再重新启动。 |
| `-remove` | `false` | 从托管目录列表中移除 `root`。服务运行中时通过本地 API 移除；服务未运行时从本地注册表移除。 |
| `-config string` | 空 | 从 JSON 文件读取启动参数。可参考 [`config.json`](./config.json) 模板；命令行显式传入的参数优先。 |
| `-agent-config string` | 空 | 加载一个额外的 `agents.json` 文件。 |
| `-no-relayer` | `false` | 禁用 Relay 集成。本地访问和私有网络访问仍可使用。 |
| `-e2ee` | `false` | 启用敏感数据端到端加密。<br>启用时，CLI 会输出配对密钥。<br>配对码也可以作为一种认证手段，未配对前端无法访问节点内容。<br>局域网访问需要开启 `-tls` 才能正常使用。 |
| `-web-push` | `true` | 启用 PWA Web Push 通知。VAPID key 会在首次启动时自动生成。 |
| `-tls` | `false` | 启用 HTTPS。如未指定 `-cert` 和 `-key`，MindFS 会生成并复用本地自签名证书。 |
| `-cert string` | 空 | TLS 证书文件，PEM 格式。需配合 `-tls` 使用；为空时自动生成。 |
| `-key string` | 空 | TLS 私钥文件，PEM 格式。需配合 `-tls` 使用；为空时自动生成。 |

---

## 参与贡献

欢迎提交 Pull Request。对于较大的改动，请先开 Issue 讨论方案。

## 微信群

<p align="center">
  <img src="docs/images/mindfs-wechat-group.webp" alt="MindFS 微信群" width="360" />
</p>

---

## 许可证

[AGPL v3](LICENSE)

## 友情链接
<a href="https://linux.do">Linux.do</a>

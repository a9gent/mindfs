# MindFS

[English](./README.md) | [简体中文](./README.zh.md)

> **AI Agent 远程访问网关 · 结果可视化**

通过 MindFS 随时随地访问个人 ai agent 和工作站数据。

---

## 界面预览

<p align="center">
  <img src="docs/images/mindfs-desktop.webp" alt="MindFS 桌面端界面" width="72%" />
</p>
<p align="center">
  <img src="docs/images/mindfs-mobile.webp" alt="MindFS 移动端界面" width="72%" />
</p>

---

## 特性

### Agent 会话

- **多 Agent 支持**：Claude Code · OpenAI Codex · Gemini CLI · Cursor · GitHub Copilot · Cline · Augment · Kimi · Kiro · Qwen · Qoder · Pi · OpenCode · OpenClaw，自动探测已安装的 Agent。
- **实时流式输出**：逐 token 推送，工具调用、思考过程、权限请求均以结构化卡片实时渲染，上下文窗口实时余量。
- **灵活切换**：会话中随时切换 Agent 或模型，多 Agent 共享同一上下文，无需重新描述背景。
- **会话搜索**：支持按会话标题或对话内容搜索，并可直接跳转到命中的会话和片段。
- **外部会话双向导入**：可浏览受支持 Agent CLI 的已有会话，选择后导入到 MindFS，并作为原生 MindFS 会话继续使用，同时 MindFS 中的会话亦可在cli中恢复。
- **绑定持久化与恢复**：MindFS 会持久化内部会话与底层 Agent 会话的绑定关系，服务重启后可恢复该关联；后续消息在条件允许时会继续落到同一个 Agent 会话上。
- **富媒体输入**：支持在消息中直接附带文件和图片。
- **多端同步**：同一实例可同时在多个设备上访问，会话状态实时同步。

### 文件访问

- **多 Project**：同时托管多个目录，会话按 Project 独立组织，互不干扰。
- **数据自托管**：所有对话历史、文件元数据、视图配置均存储在 Project 目录的 `.mindfs/` 子目录下，迁移和备份只需复制目录本身。
- **文件树浏览**：完整的目录树导航，支持文件预览，Markdown、图片、代码均有对应渲染器。

### 交互优化

- **`/` 斜杠命令**：输入 `/` 触发命令候选列表，快速执行预设操作。
- **`@` 文件引用**：输入 `@` 触发文件路径补全，将任意文件作为上下文附件发送给 Agent。
- **`#` 快捷提示词**：输入 `#` 触发已收藏的快截提示词输入。
- **文件与会话双向跳转**：打开文件可跳转到产生它的会话；打开会话可查看所有相关文件。
- **浏览器应用（PWA）**：可安装到桌面或手机主屏幕，体验更优。
- **手机界面优化**：底部操作栏拇指可及，界面更简洁。

### 访问模式

- **本地模式**：服务启动后即可在局域网内通过浏览器访问，无需任何账号或配置。
- **Relay 远程模式**：无需开放防火墙端口，通过relayer从公网任意设备访问本地实例，实现随时随地的 agent 访问。（本地模式页面中点击绑定按钮）
- **私有通道**：通过私有通道（tailscale等），直接通过 ip:port 访问。
- **端到端加密**：会话、文件支持端到端加密保护。

### 插件系统

- **定制视图**：插件是一种针对文件的定制视图，按照「传入文件内容 → 解析 → 渲染界面」的框架运行。
- **Agent 生成插件**：向 Agent 发送「实现一个 txt 小说阅读器」，Agent 即可生成对应插件，此后所有 txt 文件将以小说阅读方式呈现。
- **交互闭环**：实现「定制插件 → 浏览文件 → Agent 交互」的完整闭环。

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
| **Pi** | https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent, and acp adatper: https://github.com/svkozak/pi-acp |

安装好 Agent 后，即可启动 MindFS 并通过浏览器与之交互。

### 安装

**macOS / Linux**
```bash
curl -fsSL https://raw.githubusercontent.com/a9gent/mindfs/main/scripts/install.sh | bash
```

自定义安装路径：
```bash
curl -fsSL https://raw.githubusercontent.com/a9gent/mindfs/main/scripts/install.sh | bash -s -- --prefix your/path
```

**Windows（PowerShell）**
```powershell
irm https://raw.githubusercontent.com/a9gent/mindfs/main/scripts/install.ps1 | iex
```

安装脚本会自动检测系统和架构，从 [GitHub Releases](https://github.com/a9gent/mindfs/releases) 下载对应的二进制包并完成安装。

**从源码编译**（需要 Go 1.22+、Node.js 20+）
```bash
git clone https://github.com/a9gent/mindfs.git
cd mindfs
make build      # 产物为 ./mindfs
```

### 启动

```bash
mindfs                        # 托管当前目录
mindfs /path/to/your/project  # 托管指定目录
mindfs -addr :9000 /path/to/your/project # 指定端口
```

在浏览器中打开（默认端口） [http://localhost:7331](http://localhost:7331)。

MindFS 会自动探测已安装 Agent 的可用性，通常需要大约一分钟。

### 通过 relayer远程访问

1. 本地模式打开 mindfs 页面，点击左下角绑定按钮。
2. 登录 relayer，确认绑定。
3. 打开节点。

### 常用命令

```
mindfs [flags] [root]

Flags:
  -addr string   监听地址（默认 ":7331"）
  -no-relayer    禁用 Relay 集成
  -remove        从运行中的服务器移除托管目录
```

---

## 参与贡献

欢迎提交 Pull Request。对于较大的改动，请先开 Issue 讨论方案。

---

## 许可证

[AGPL v3](LICENSE)

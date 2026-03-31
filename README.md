# MindFS

> **AI Agent Remote Access Gateway · Result Visualization**

Access your personal AI agents and workstation data anywhere, anytime through MindFS.

---

## Features

### Agent Sessions

- **Multi-Agent support**: Claude Code · OpenAI Codex · Gemini CLI · Cursor · GitHub Copilot · Cline · Augment · Kimi · Kiro · Qwen · OpenCode · OpenClaw — installed agents are detected automatically.
- **Real-time streaming**: Token-by-token output pushed to the browser; tool calls, thought traces, and permission prompts rendered as structured, collapsible cards.
- **Flexible switching**: Switch agents or models mid-session; all agents share the same context — no need to re-explain the background.
- **Rich media input**: Attach files and images directly in your messages.
- **Multi-device sync**: Access the same instance from multiple devices simultaneously with live session sync.

### File Access

- **Multiple projects**: Manage several directories at once; sessions are organized per project and stay independent.
- **Self-hosted data**: All conversation history, file metadata, and view config are stored under the project's `.mindfs/` subdirectory — migration and backup is just a folder copy.
- **File tree browser**: Full directory navigation with file preview; Markdown, images, and code all have dedicated renderers.

### Interaction

- **`/` slash commands**: Type `/` to trigger a command palette and quickly run preset operations.
- **`@` file references**: Type `@` to trigger path completion and attach any file as context for the agent.
- **Bidirectional file–session linking**: Jump from a file to the session that created it, or from a session to all files it touched.
- **Browser app (PWA)**: Install to desktop or mobile home screen for a native-like experience — no app store required.
- **Mobile-optimized UI**: Bottom action bar within thumb reach, independent panel swipe navigation, input box adapts to the soft keyboard.

### Access Modes

- **Local mode**: Accessible in the browser on the local network immediately after startup — no account or configuration needed.
- **Relay remote mode**: Access your local instance from anywhere on the public internet without opening firewall ports, via an encrypted tunnel through [a9gent.com](https://a9gent.com). Click the bind button in the local UI to activate.
- **Private channel**: Use a private network (e.g. Tailscale) and access directly via `ip:port`.

### Plugin System

- **Custom views**: A plugin is a custom view for a file, following the pattern: receive file content → parse → render UI.
- **Agent-generated plugins**: Tell the agent "implement a txt novel reader" and it generates the plugin — all txt files are then displayed as a reading experience.
- **Interaction loop**: Plugins can register action buttons that send structured commands to the agent, completing the loop: customize plugin → browse file → agent interaction.

### Installation

- **Single binary**: The production build is a statically compiled binary with all web assets embedded.
- **Zero dependencies**: No Node.js, Docker, or daemon manager required on the host.
- **Cross-platform**: macOS (Intel + Apple Silicon), Linux (x86-64, ARM64, ARMv7), Windows (x86-64, ARM64).

---

## Quick Start

### Prerequisites

MindFS does not include any AI model — you need at least one Agent CLI installed locally. Choose what works for you:

| Agent | Install |
|-------|---------|
| **Claude Code** | https://claude.ai/code |
| **OpenAI Codex** | https://github.com/openai/codex |
| **Gemini CLI** | https://github.com/google-gemini/gemini-cli |
| **Cursor** | https://www.cursor.com |
| **GitHub Copilot** | https://github.com/features/copilot |
| **Cline** | https://github.com/clinebot/cline |
| **Kimi** | https://kimi.moonshot.cn |
| **Qwen** | https://github.com/QwenLM/qwen-agent |

Once an agent is installed, start MindFS and interact with it through the browser.

### Install

**macOS / Linux**
```bash
curl -fsSL https://raw.githubusercontent.com/a9gent/mindfs/main/scripts/install.sh | bash
```

Custom install path:
```bash
curl -fsSL https://raw.githubusercontent.com/a9gent/mindfs/main/scripts/install.sh | bash -s -- --prefix ~/.local
```

**Windows (PowerShell)**
```powershell
irm https://raw.githubusercontent.com/a9gent/mindfs/main/scripts/install.ps1 | iex
```

The install script auto-detects your OS and architecture, then downloads the matching binary from [GitHub Releases](https://github.com/a9gent/mindfs/releases).

**Build from source** (requires Go 1.22+, Node.js 20+)
```bash
git clone https://github.com/a9gent/mindfs.git
cd mindfs
make build      # output: ./mindfs
make build-all  # cross-compile all platforms into dist/
```

### Run

```bash
mindfs                        # manage current directory
mindfs /path/to/your/project  # manage a specific directory
mindfs -addr :9000 /path/to/your/project  # custom port
```

Open [http://localhost:7331](http://localhost:7331) in your browser.

### Enable Remote Access (Optional)

1. Open MindFS in local mode and click the bind button in the bottom-left corner.
2. Log in to [a9gent.com](https://a9gent.com) and confirm the binding.
3. Open your node — it is now accessible from any device.

### CLI Reference

```
mindfs [flags] [root]

Flags:
  -addr string   Listen address (default ":7331")
  -no-relayer    Disable relay integration
  -remove        Unregister a managed directory from a running server
```

---

## Contributing

Pull requests are welcome. For larger changes, please open an issue first to discuss the approach.


---

## License

[AGPL v3](LICENSE)

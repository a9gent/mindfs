module mindfs

go 1.23.0

toolchain go1.23.3

require (
	github.com/coder/acp-go-sdk v0.6.3
	github.com/fanwenlin/codex-go-sdk v0.0.0
	github.com/fsnotify/fsnotify v1.7.0
	github.com/go-chi/chi/v5 v5.0.10
	github.com/gorilla/websocket v1.5.1
	github.com/roasbeef/claude-agent-sdk-go v0.0.0
	modernc.org/sqlite v1.34.5
)

require (
	github.com/dustin/go-humanize v1.0.1 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	github.com/ncruces/go-strftime v0.1.9 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	golang.org/x/net v0.17.0 // indirect
	golang.org/x/sys v0.22.0 // indirect
	golang.org/x/text v0.13.0 // indirect
	gopkg.in/yaml.v3 v3.0.1 // indirect
	modernc.org/libc v1.55.3 // indirect
	modernc.org/mathutil v1.6.0 // indirect
	modernc.org/memory v1.8.0 // indirect
)

replace github.com/fanwenlin/codex-go-sdk => github.com/yandc/codex-go-sdk v0.0.0-20260228040055-048c8cdcd868

replace github.com/roasbeef/claude-agent-sdk-go => github.com/yandc/claude-agent-sdk-go v0.0.0-20260228035121-e62f66408bee

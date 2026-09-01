module mindfs

go 1.25.0

require (
	github.com/SherClockHolmes/webpush-go v1.4.0
	github.com/coder/acp-go-sdk v0.13.5
	github.com/creack/pty v1.1.24
	github.com/fanwenlin/codex-go-sdk v0.0.0
	github.com/fsnotify/fsnotify v1.10.1
	github.com/go-chi/chi/v5 v5.0.10
	github.com/gorilla/websocket v1.5.1
	github.com/hashicorp/yamux v0.1.2
	github.com/roasbeef/claude-agent-sdk-go v0.0.0-20260423113330-380f586b1dc2
	github.com/robfig/cron/v3 v3.0.1
	github.com/shirou/gopsutil/v4 v4.26.7
	golang.org/x/crypto v0.50.0
	golang.org/x/sys v0.43.0
	golang.org/x/text v0.36.0
	gopkg.in/yaml.v3 v3.0.1
	modernc.org/sqlite v1.34.5
)

require (
	github.com/dustin/go-humanize v1.0.1 // indirect
	github.com/ebitengine/purego v0.10.2 // indirect
	github.com/go-ole/go-ole v1.2.6 // indirect
	github.com/golang-jwt/jwt/v5 v5.2.1 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/lufia/plan9stats v0.0.0-20211012122336-39d0f177ccd0 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	github.com/ncruces/go-strftime v0.1.9 // indirect
	github.com/power-devops/perfstat v0.0.0-20240221224432-82ca36839d55 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	github.com/tklauser/go-sysconf v0.3.16 // indirect
	github.com/tklauser/numcpus v0.11.0 // indirect
	github.com/yusufpapurcu/wmi v1.2.4 // indirect
	golang.org/x/net v0.52.0 // indirect
	modernc.org/libc v1.55.3 // indirect
	modernc.org/mathutil v1.6.0 // indirect
	modernc.org/memory v1.8.0 // indirect
)

replace github.com/fanwenlin/codex-go-sdk => github.com/yandc/codex-go-sdk v0.0.0-20260901035144-3e51ee3c924c

replace github.com/coder/acp-go-sdk => github.com/yandc/acp-go-sdk v0.0.0-20260709074204-a1ec7b200d08

replace github.com/roasbeef/claude-agent-sdk-go => github.com/yandc/claude-agent-sdk-go v0.0.0-20260831075240-a5d51881486c

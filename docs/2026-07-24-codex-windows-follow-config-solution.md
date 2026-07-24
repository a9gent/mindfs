# Codex Windows「跟随配置」箭头不可用 — 技术解决方案

## 1. 问题陈述

Windows 上 Codex Agent 选择器无展开箭头，与 Linux 正常形成对比。箭头依赖 probe 返回的 `models/modes/efforts/supports_fast_service`。根因是 MindFS 构造 Codex app-server 环境时，把「部分 env map」交给 `codex-go-sdk`，SDK 在 `envOverride != nil` 时 **完全替换** 子进程环境，导致 Windows 丢失 `PATH`/`USERPROFILE`/`APPDATA`/`SystemRoot` 等，app-server 无法完成 `model/list` 与 `config/read`。

## 2. 设计原则

1. **对齐 SDK 契约，不 fork SDK**。
2. **任何非 nil Env 必须是「宿主完整环境 + overlay」**，绝不能只有少数业务键。
3. **保持 MindFS originator = `codex-tui`**（client identity，见 `2ceaa54`），不能退回 SDK 默认 `codex_cli_rs`。
4. **最小 diff**：只改 Codex client env 构造与对应测试。
5. 不改 follow-config 状态机与前端箭头条件。

## 3. SDK 契约

`AppServerExec.start()`：

```text
env := os.Environ()
if envOverride != nil {
    env = only keys from envOverride   // full replace
}
if originator missing:
    env += CODEX_INTERNAL_ORIGINATOR_OVERRIDE=codex_cli_rs
```

| 传入 `options.Env` | 子进程环境 | originator |
|--------------------|------------|------------|
| `nil` | `os.Environ()` | SDK 默认 **`codex_cli_rs`** |
| 非 nil 部分 map | 仅 map | 若 map 含 MindFS 值则 `codex-tui`，但 **丢宿主 env**（现状 bug） |
| 非 nil **完整 merge map** | 宿主 + overlay | 可强制 `codex-tui`（目标） |

结论：**不能**为了继承环境而传 `nil`（会丢掉 `codex-tui` 身份）；必须传 **merge(os.Environ(), overrides + originator)**。

## 4. 目标实现

### 4.1 上游 `origin/main` 兼容策略

官方分支当前 `newClient` 直接传 `opts.Env`，**没有** MindFS `codex-tui` identity 强制注入。因此：

```go
func buildCodexClientEnv(base map[string]string) map[string]string {
	if len(base) == 0 {
		return nil // SDK 继承 os.Environ()
	}
	env := environToMap(os.Environ())
	for key, value := range base {
		env[key] = value
	}
	return env
}
```

| base | 传给 SDK |
|------|----------|
| nil / 空 | `nil` → 完整宿主环境 |
| 非空 | `merge(os.Environ(), base)` → 宿主 + overlay |

`newClient` 改为：

```go
Env: buildCodexClientEnv(opts.Env),
```

### 4.2 自定义分支（含 client identity）备注

若分支已强制 `ORIGINATOR=codex-tui` 且始终传非 nil map，则必须改为 **始终 merge 完整宿主环境**（不能只传 originator）。该逻辑已合入 `zhengjiabo/main`。

### 4.3 文件

- 改：`server/internal/agent/codex/session.go`
- 改：`server/internal/agent/codex/session_test.go`
- 文档：本文件 + PRD

## 5. 为何修复 Windows 箭头

```text
修复前:
  Env = {ORIGINATOR: codex-tui}          // 或 provider 的少量键
  SDK replace → 无 PATH / USERPROFILE
  probe ListModels/config.read 失败
  models=[] → hasModelOptions=false → 无箭头

修复后:
  Env = full host + ORIGINATOR=codex-tui (+ overlays)
  app-server 可解析 %USERPROFILE%\.codex 与 PATH
  models 有数据 → 箭头恢复；跟随配置可用
  client identity 仍为 codex-tui
```

## 6. 否决的方案

| 方案 | 原因 |
|------|------|
| 默认传 `nil` | SDK originator 变为 `codex_cli_rs`，回退 client identity |
| 前端强制显示箭头 | 掩盖 probe 失败 |
| 仅 Windows 拷贝白名单键 | 易漏 `SystemRoot`/`NODE_*` 等 |
| 改 SDK merge 语义 | 不必要；MindFS 侧 merge 足够 |

## 7. 测试计划

### 7.1 单元测试

1. `TestBuildCodexClientEnvIncludesHostEnvironment`
   - `t.Setenv("MINDFS_CODEX_ENV_MARKER", "1")`
   - `buildCodexClientEnv(nil)` 含 marker 与默认 originator
2. `TestBuildCodexClientEnvOverlaysCustomKeys`
   - base `FOO=bar` → 结果含 FOO 与 marker
3. `TestBuildCodexClientEnvPreservesExplicitOriginator`
4. 既有 client info / version 解析测试保留

### 7.2 命令

```bash
go test ./server/internal/agent/codex/ -count=1
cd web && npm run typecheck
```

### 7.3 Windows 手工（有条件）

Codex 已安装 → Agent 下拉有箭头 → 跟随配置可选 → 发送不强制 pin。

## 8. 回滚

回滚 `session.go` / `session_test.go` 即可。

## 9. 风险

| 风险 | 级 | 缓解 |
|------|----|------|
| 完整 env 传入子进程含敏感变量 | 低 | 与 SDK `nil` 路径一致 |
| Windows env 大小写重复键 | 低 | 与历史 map 语义一致，不 case-fold |
| merge 分配开销 | 低 | 仅 client 创建时一次 |

## 10. 对抗式审查记录

### 轮次 1

| 级 | 问题 | 处置 |
|----|------|------|
| 高 | 初版方案「空 overrides → nil」会让 SDK 写入 `codex_cli_rs`，破坏 `codex-tui` 身份 | 改为始终 merge 完整宿主环境并强制 MindFS originator |
| 高 | provider/backup 部分 env 同样 wipe | merge 覆盖该路径 |
| 中 | `buildCodexClientInfo` 对 nil env | 新语义下 env 恒非 nil，更简单 |
| 低 | `strings.Cut` 需 Go 1.18+ | 模块为 go 1.25，OK |

### 轮次 2

| 级 | 问题 | 处置 |
|----|------|------|
| 中 | `os.Environ()` 在测试中依赖 `t.Setenv` | 单测使用 `t.Setenv` 注入 marker |
| 低 | originator 已在 host 中被设为其它值 | 空才填默认；显式 base 覆盖 host |

### 结论

无开放阻塞问题，可实施。

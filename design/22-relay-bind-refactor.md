# Relay 绑定流程改造设计

## 1. 目标

在现有 relay 实现基础上，把“relayer 生成 bind-code，MindFS 主动提交 bind-code 完成绑定”改成下面这条主流程：

1. `mindfs server` 启动
2. 如果本地已有 `device_token`，直接连接 relayer
3. 如果没有凭证，且未指定 `--no-relayer`，则生成纯内存 `pending_code`
4. CLI 打开页面
5. 用户在 relayer 页面确认该 `pending_code`
6. 本地 server 轮询 relayer，拿到 `device_token/node_id/endpoint`
7. 本地落盘凭证并建立正式 WS 连接

这份文档只描述变更设计，不改 [21-relay-website.md](./21-relay-website.md)。

---

## 2. 复用

下面这些逻辑直接复用：

- `RelayCredentials`
- `CredentialsStore`
- `device_token/node_id/endpoint` 的持久化格式
- `Service.Run()` 的正式 relay WS/yamux 长连接
- `runSession()` 的 HTTP/WS 转发
- 拿到新凭证后重启 relay session 的 manager 机制

结论：

- 正式 relay 连接链路不重写
- 只改“如何获取 `device_token`”

---

## 3. 修改

### 3.1 删除旧 bind-code 主链路

下面这些不再保留：

- CLI `--bind-code`
- 本地 `/api/relay/bind`
- `ParseBindCode()` 作为主流程的一部分

如果代码里还有这些实现，直接删掉，不做兼容方案。

### 3.2 增加 `--no-relayer`

新增参数：

```text
mindfs --no-relayer [root]
```

行为：

- 不生成 `pending_code`
- 不轮询 relayer
- 不请求 `device_token`
- 不建立 relay WS 连接
- 只打开 localhost

### 3.3 修改 manager 启动逻辑

`Manager.Start()` 改成：

1. 读取本地凭证
2. 如果已有有效凭证，直接启动正式 relay session
3. 如果没有凭证且指定了 `--no-relayer`，直接返回
4. 如果没有凭证且未指定 `--no-relayer`，生成 `pending_code`
5. 启动后台轮询，直到获取 `device_token` 或失败

---

## 4. 新增

### 4.1 本地内存态

本地 server 需要新增：

- `pendingCode`
- `pendingCodeCreatedAt`
- `pendingState`
- `lastBindError`
- `noRelayer`

约束：

- 同一时刻只有一个有效 `pending_code`
- `pending_code` 只存在内存中
- server 重启后旧 code 失效
- 绑定成功后立即清空 `pending_code`

### 4.2 新增 `/api/relay/status`

`pending_code` 不挂在 `/api/dirs`，单独通过 relay 状态接口下发：

```text
GET /api/relay/status
```

未绑定时：

```json
{
  "relay_bound": false,
  "pending_code": "pc_xxx",
  "node_id": "",
  "relay_base_url": ""
}
```

绑定后：

```json
{
  "relay_bound": true,
  "pending_code": "",
  "node_id": "node_abc123",
  "relay_base_url": "https://relay.mindfs.com/n/node_abc123"
}
```

说明：

- 这些字段是 server 级状态，不属于单个 root
- 前端和 CLI 通过这个接口判断 relay 当前状态

### 4.3 localhost 前端

不通过接口判断是否绑定，只看当前页面 URL：

- 如果当前 URL 是 relayer 域名且路径匹配 `/n/{node_id}`，认为当前已在 relayer 页面
- 否则认为当前在 localhost 页面

在 localhost 页面中：

- 文件树底部增加“绑定 relayer”或“打开 relayer”按钮
- 按钮所需的 `pending_code/node_id/relay_base_url` 都来自 `/api/relay/status`

### 4.4 relayer 接口

relayer 侧新增：

查询：

```text
GET /api/bind/poll?code={pending_code}
```

确认：

```text
POST /api/bind/confirm
```

确认成功后，`poll` 返回：

```json
{
  "status": "confirmed",
  "device_token": "dev_xxx",
  "node_id": "node_abc123",
  "endpoint": "wss://relay.mindfs.com/ws/connector"
}
```

---

## 5. 页面打开规则

CLI 在 add root 成功后：

- 如果指定了 `--no-relayer`，打开：

```text
http://localhost:7331/?root=<root_id>
```

- 如果未指定 `--no-relayer` 且当前已有 relay 凭证，打开：

```text
https://relay.mindfs.com/n/<node_id>?root=<root_id>
```

- 如果未指定 `--no-relayer` 且当前还未绑定，打开：

```text
http://localhost:7331/?root=<root_id>
```

`root_id` 使用 add root 后 server 返回的实际 id。

---

## 6. 轮询策略

绑定前只用 HTTP 轮询，不增加预认证 WS。

建议：

- 默认每 `2s` 轮询一次
- 成功后立即停止
- 过期/撤销后停止
- `429` 时退避

---

## 7. 安全基线

- `pending_code` 必须是高熵随机值
- `pending_code` 仅短期有效
- `confirm` 必须要求用户登录
- `poll` 必须限流
- 同一个 `pending_code` 只能成功领取一次正式凭证

---

## 8. 测试

至少补这些测试：

- 无凭证启动时生成 `pending_code`
- `--no-relayer` 启动时不生成 `pending_code`
- 轮询成功后能落盘 `device_token`
- 已有凭证时直接连接 relay
- `/api/relay/status` 能返回 `pending_code/relay_bound/node_id/relay_base_url`

---

## 9. 结论

这次改造只做一件事：把“获取 `device_token` 的入口”从 bind-code 改成 pending-code 轮询。

明确原则：

- 旧 bind-code 链路不保留
- 增加 `--no-relayer`
- 增加 `/api/relay/status`
- `pending_code` 通过 `/api/relay/status` 下发
- 正式 relay 连接逻辑继续复用现有实现

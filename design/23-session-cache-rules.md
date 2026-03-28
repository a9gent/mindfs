# Session 缓存规则

## 目标

Session 数据分成两层：

- 持久化 base：带稳定序号的正式会话历史
- 内存运行态：建立在当前 base 之上的流式 UI 状态

系统应避免通用 merge 语义。只允许两种操作：

- 持久化缓存 append
- 内存流式 append

## 正式 Exchange 规则

正式 exchange 定义为 `seq > 0` 的项。

规则：

- 只有正式 exchange 可以进入持久化 session 缓存
- 只有正式 exchange 参与增量恢复
- 正式 exchange 按绝对 `seq` 排序
- 前端 `syncSession` 只能把正式增量 append 到持久化 base，不能做任意 merge

## Pending User 规则

`pendingUser` 是一个临时展示项，用于处理“当前轮还在运行，但正式 user exchange 还没有完整进入持久化历史”的窗口。

规则：

- `pendingUser.seq = 0`
- `seq = 0` 表示临时 UI 项，不属于正式历史
- `seq = 0` 的项不能写入持久化缓存
- `seq = 0` 的项不能参与正式增量 append
- `seq = 0` 的项只允许显示在 session 时间线尾部

当后续正式 user exchange 以 `seq > 0` 到达后，这个 `seq = 0` 的临时项应自然从重建后的展示状态中消失。

## 持久化缓存规则

持久化缓存只能由正式 exchange 构成。

规则：

- 读取持久化 base
- 计算 `baseSeq`，即当前正式历史中的最大 `seq`
- 向后端请求 `baseSeq` 之后的增量
- 只 append 新返回的 `seq > 0` exchange
- 将新的正式 base 写回持久化缓存

持久化缓存层明确禁止：

- 存储 `pendingUser`
- 存储没有正式序号的 thought/tool 流式项
- 对不同语义的 exchange 做通用 merge

## 内存运行态规则

内存 session 运行态表示当前 UI 正在使用的会话状态。

规则：

- websocket 流式事件只 append 到内存 session 状态
- 流式事件不写持久化缓存
- 切换 session 时，如果内存里已经有 exchanges，就不能重建这条 session
- 不允许把内存运行态和后端 session payload 做通用 merge

## Session 切换规则

切换到某条 session 时：

- 如果这条 session 已经在内存中且已有 exchanges，直接使用内存 session
- 此时不再向后端请求增量
- 只有当这条 session 不在内存中时，前端才允许执行一次“首次加载”式的 sync

## 重连规则

重连恢复针对绑定中的 session，也就是当前 root 下蓝点绑定的那条 session。

规则：

- `ws.connected` 只刷新列表数据
- `ws.reconnected` 才允许恢复当前绑定 session
- 重连恢复统一通过 `syncSession` 执行

对于重连恢复：

- 如果存在正式增量（`seq > 0`），则基于新的正式 base 重建并更新内存
- 如果不存在正式增量，且内存中已经有这条 session，则保持内存完全不动
- 如果不存在正式增量，且内存中没有这条 session，则可以应用返回的展示态 session，这样尾部 `pendingUser(seq=0)` 仍可见

## 明确禁止的行为

以下行为明确禁止：

- 给临时项伪造正式序号
- 在确认增量之前，先用持久化 base 覆盖内存 session
- 把 `seq = 0` 的项当成普通 exchange 参与持久化缓存 merge
- 用一个通用 merge 函数同时处理持久化 base、临时 UI 项、流式运行态

## 心智模型

正确的心智模型是：

- 正式历史：按 `seq > 0` append
- 临时 pending user：`seq = 0`，只在尾部展示
- 流式运行态：只在内存 append
- 重连时如果没有正式增量：保持现有内存不动


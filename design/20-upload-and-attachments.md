# 20. 文件上传与会话附件

对应代码：`server/internal/api/`、`server/internal/api/usecase/`、`web/src/components/FileTree.tsx`、`web/src/components/ActionBar.tsx`、`web/src/components/SessionViewer.tsx`

---

## 背景

当前系统具备目录浏览、文件预览、会话消息展示与输入增强协议，但还没有“上传文件”能力。

本期需要补齐两条不同语义的上传链路：

1. 目录视图上传：作为文件管理能力，直接写入当前目录
2. 输入框上传：作为消息附件能力，发送时写入 `.mindfs/upload/` 并注入到当前消息

这两条链路都叫“上传”，但目标、存储位置、和 Session 的关系都不同，设计上必须明确拆开。

---

## 设计目标

1. 目录上传与输入框上传使用统一底层上传能力，但保留不同业务语义
2. 目录上传的文件立即出现在当前目录树中
3. 输入框上传支持多文件
4. 输入框上传的文件统一保存到 `.mindfs/upload/`，按日期分桶
5. 输入框上传结果沿用 [19-input-candidates.md](./19-input-candidates.md) 的文本协议，不引入额外 sidecar
6. 用户消息中支持图片附件预览

---

## 非目标

本期不做：

1. 拖拽上传
2. 断点续传
3. 上传进度条
4. 输入框富文本附件 chip
5. 自动把目录上传文件注入到当前消息
6. 对所有二进制附件做专门预览，除图片外先只显示文件附件信息

---

## 术语

### 1. 目录上传

用户在目录视图中点击右上角 `+` 按钮，把本地文件保存到“当前选中的目录”。

特点：

- 属于文件系统管理操作
- 文件物理位置就是当前目录
- 不自动关联到当前 Session
- 上传完成后应刷新目录树

### 2. 输入附件上传

用户在输入框中选择文件；发送消息时再上传到 `.mindfs/upload/`，并把引用写入当前消息内容。

特点：

- 属于消息输入增强操作
- 文件物理位置固定在 `.mindfs/upload/`
- 会参与当前这次消息发送
- 支持多文件

---

## 目录结构

输入附件上传统一写入：

```text
.mindfs/upload/YYYY-MM-DD/<generated-name>
```

示例：

```text
.mindfs/upload/2026-03-09/screenshot-01.png
.mindfs/upload/2026-03-09/spec-v2.pdf
```

说明：

1. 日期使用本地服务端日期，格式固定为 `YYYY-MM-DD`
2. 同名文件需要重命名或加唯一后缀，避免覆盖
3. `.mindfs/upload/` 是保留附件目录，不参与现有 meta/session 语义，但仍然是 root 内可引用文件

目录视图上传不使用该目录，直接保存到用户当前选中的目录。

---

## 交互设计

### 目录视图上传

入口：

- 在目录视图右上角增加 `+` 按钮

行为：

1. 用户当前选中某个目录，或当前目录面板已有明确上下文目录
2. 点击 `+` 后打开系统文件选择器
3. 选中文件后上传到当前目录
4. 上传成功后刷新该目录列表
5. 新文件在文件树中立即可见

失败反馈：

- 当前目录不存在或不可写
- 同名覆盖冲突
- 文件过大
- 上传失败

目录上传不自动往输入框插入任何 token。

### 输入框附件上传

入口：

- 输入框支持文件选择按钮
- 支持一次选择多个文件

行为：

1. 用户在 ActionBar 中选择一个或多个文件
2. 用户点击发送时，前端先上传这些文件到 `.mindfs/upload/YYYY-MM-DD/`
3. 上传成功后，把每个文件转换为统一文本 token
4. token 与用户原始输入拼接成最终消息，再发给后端
5. 上传失败则本次发送中止，保留输入内容，提示用户重试

多文件示例：

```text
请分析这些文件：
[read file: .mindfs/upload/2026-03-09/a.pdf]
[read file: .mindfs/upload/2026-03-09/b.png]
[read file: .mindfs/upload/2026-03-09/c.csv]
```

---

## 输入协议

输入附件上传严格复用 [19-input-candidates.md](./19-input-candidates.md) 的固定文本协议。

插入规则：

- 普通文件：`[read file: path]`
- 图片文件：`[read file: path]`

说明：

1. 本期不新增 `[upload file: ...]` 或 `[image: ...]` 之类的新协议
2. 上传行为只是帮助用户生成稳定文件路径与引用文本
3. Agent 收到的仍然是普通文本消息

---

## 消息展示

### 用户消息中的附件展示

Session 展示层需要识别用户消息中的上传附件引用，并渲染附件区域。

建议规则：

1. 用户消息正文仍显示原始文本
2. 如果消息中存在 `.mindfs/upload/...` 的 `[read file: ...]` token，则提取为附件列表
3. 图片附件在消息下方显示图片预览
4. 非图片附件显示文件卡片或文件名列表

### 图片预览范围

本期仅要求支持“输入框上传的图片附件”在 Session 中显示预览。

不要求：

1. 自动预览目录上传的图片
2. 自动预览 agent 输出文本中任意图片路径

---

## 数据模型建议

当前 `session.Exchange` 中只有字符串 `Content`：

```go
type Exchange struct {
    Seq       int
    Role      string
    Agent     string
    Content   string
    Timestamp time.Time
}
```

本期采用“文本协议 + 前端解析”落地，不修改 Session 持久化模型，也不新增附件 sidecar。

说明：

1. 输入附件不写入 `Session.related_files`
2. 用户消息展示所需附件信息，统一从消息文本中的 `[read file: ...]` token 解析
3. 本期不在 `Exchange` 中持久化附件元数据

---

## API 设计

建议新增统一上传接口：

```text
POST /api/upload?root=<rootId>
```

`multipart/form-data` 参数：

- `files`: 一个或多个文件
- `dir`: 可选，目标目录，相对 root 路径；不传时默认上传到 `.mindfs/upload/YYYY-MM-DD/`

规则：

- 传 `dir`：把文件保存到指定目录
- 不传 `dir`：把文件保存到 `.mindfs/upload/YYYY-MM-DD/`
- 如果要上传到 root 根目录，显式传 `dir=.`

### 目录上传

语义：

- 把文件保存到当前目录

约束：

- `dir` 必填
- 必须通过 root 路径校验
- 不能写出 root 外

返回示例：

```json
{
  "files": [
    {
      "path": "design/demo.png",
      "name": "demo.png",
      "mime": "image/png",
      "size": 18273
    }
  ]
}
```

### 输入附件上传

语义：

- 把文件保存到 `.mindfs/upload/YYYY-MM-DD/`

约束：

- 不传 `dir`
- 支持多文件
- 不关联 session

返回示例：

```json
{
  "files": [
    {
      "path": ".mindfs/upload/2026-03-09/a.pdf",
      "name": "a.pdf",
      "mime": "application/pdf",
      "size": 81920
    },
    {
      "path": ".mindfs/upload/2026-03-09/b.png",
      "name": "b.png",
      "mime": "image/png",
      "size": 32512
    }
  ]
}
```

---

## 前端职责

### FileTree

`web/src/components/FileTree.tsx`

需要增加：

1. 顶部 `+` 按钮
2. 当前目录上下文判断
3. 上传成功后的目录刷新

### ActionBar

`web/src/components/ActionBar.tsx`

需要增加：

1. 文件选择入口
2. 多文件上传
3. 发送前暂存待上传文件
4. 发送时调用不带 `dir` 的上传接口
5. 上传结果转 `[read file: ...]` token，并与原始输入拼接后发送

### SessionViewer

`web/src/components/SessionViewer.tsx`

需要增加：

1. 从用户消息中提取 `.mindfs/upload/` 附件 token
2. 图片附件渲染预览
3. 非图片附件渲染文件列表或卡片

---

## 后端职责

### API 层

`server/internal/api/http.go`

需要增加：

1. 上传路由
2. `multipart/form-data` 解析
3. 文件数量、大小、参数合法性校验

### Usecase 层

`server/internal/api/usecase/fs.go`

需要增加：

1. 保存到当前目录的上传流程
2. 保存到 `.mindfs/upload/YYYY-MM-DD/` 的附件上传流程
3. 同名冲突处理
4. mime / size / path 返回

---

## 风险与待确认项

### 1. 当前目录的定义

目录上传时，“当前目录”建议按目录树当前选中目录决定；若当前选中的是文件，则取该文件所在目录。

### 2. 同名文件策略

建议默认不覆盖，自动改名。

例如：

```text
image.png
image (1).png
image (2).png
```

### 3. 隐藏目录可见性

输入附件上传虽然写入 `.mindfs/upload/`，但该目录是否在普通文件树中默认显示，需要单独决定。

建议：

- 默认继续遵循隐藏目录规则
- 但上传后的 token 仍可正常引用与预览

### 4. 附件上传时机

输入附件建议在“点击发送”时才真正上传，而不是选中文件后立即上传。

这样可以避免：

- 用户选中文件后取消发送，产生孤儿文件
- 用户修改输入或切换会话时，前端还要维护待清理状态
- 上传成功但消息发送失败时，附件与消息脱节

---

## 推荐实施顺序

1. 后端新增统一上传接口
2. 目录视图接入传 `dir` 的上传调用
3. ActionBar 接入待上传文件暂存
4. 发送链路接入不传 `dir` 的上传调用并生成 token
5. SessionViewer 增加图片附件展示

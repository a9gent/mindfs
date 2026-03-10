# 20. 文件上传与会话附件

对应代码：`server/internal/api/`、`server/internal/api/usecase/`、`web/src/components/FileTree.tsx`、`web/src/components/ActionBar.tsx`、`web/src/components/SessionViewer.tsx`

---

## 背景

当前系统具备目录浏览、文件预览、会话消息展示与输入增强协议，但还没有“上传文件”能力。

本期需要补齐两条不同语义的上传链路：

1. 目录视图上传：作为文件管理能力，直接写入当前目录
2. 输入框上传：作为会话附件能力，写入 `.mindfs/upload/` 并注入到当前消息

这两条链路都叫“上传”，但目标、存储位置、和 Session 的关系都不同，设计上必须明确拆开。

---

## 设计目标

1. 目录上传与输入框上传使用统一底层上传能力，但保留不同业务语义
2. 目录上传的文件立即出现在当前目录树中
3. 输入框上传支持多文件
4. 输入框上传的文件统一保存到 `.mindfs/upload/`，按日期分桶
5. 输入框上传结果沿用 [19-input-candidates.md](./19-input-candidates.md) 的文本协议，不引入额外 sidecar
6. Session 中支持图片附件预览

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

用户在输入框中选择文件，把文件保存到 `.mindfs/upload/`，并把引用写入当前输入内容。

特点：

- 属于消息输入增强操作
- 文件物理位置固定在 `.mindfs/upload/`
- 会和当前消息、当前 Session 发生关联
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
3. `.mindfs/upload/` 属于系统保留目录，但仍然是 root 内可引用文件

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
2. 文件保存到 `.mindfs/upload/YYYY-MM-DD/`
3. 上传成功后，把每个文件转换为统一文本 token
4. token 追加写入输入框，参与本次发送
5. 发送后，附件文件应记录到当前 Session 的关联信息中

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

## Session 展示

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

本期可先采用“文本协议 + 前端解析”落地，不强制修改 Session 持久化模型。

可选增强：

```go
type ExchangeAttachment struct {
    Path     string `json:"path"`
    Name     string `json:"name"`
    Mime     string `json:"mime,omitempty"`
    IsImage  bool   `json:"is_image,omitempty"`
    Source   string `json:"source,omitempty"` // input_upload / dir_upload
}
```

是否引入该结构可在实现阶段决定：

- 如果追求最小改动：仅解析文本 token
- 如果追求稳定展示：在 Exchange 中补附件元数据

---

## API 设计

建议新增统一上传接口：

```text
POST /api/upload?root=<rootId>&mode=<dir|attachment>
```

`multipart/form-data` 参数：

- `files`: 一个或多个文件
- `dir`: 当前目录，相对 root 路径；仅 `mode=dir` 时必填

### mode=dir

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

### mode=attachment

语义：

- 把文件保存到 `.mindfs/upload/YYYY-MM-DD/`

约束：

- 忽略 `dir`
- 支持多文件

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
3. 上传结果转 `[read file: ...]` token
4. token 插入输入框

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

### 4. Session 关联

输入附件上传完成并发送后，建议把文件加入 Session `related_files`，方便追踪。

目录上传不自动加入 `related_files`。

---

## 推荐实施顺序

1. 后端新增统一上传接口
2. 目录视图接入 `mode=dir`
3. ActionBar 接入 `mode=attachment`
4. 输入框 token 插入
5. SessionViewer 增加图片附件展示

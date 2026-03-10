# MindFS 设计文档索引

本目录包含 MindFS V2 的完整设计文档，按模块拆分，便于开发时查阅。

---

## 核心架构

- **[01-overview.md](./01-overview.md)** - 核心定位、理念、流程、实施优先级、V1-V2变化

---

## 后端模块 (server/)

- **[02-agent-process.md](./02-agent-process.md)** - Agent 进程管理、ACP 通信协议、Transport Handler
- **[03-session-management.md](./03-session-management.md)** - Session 生命周期、状态流转、数据模型
- **[04-context-building.md](./04-context-building.md)** - Agent 上下文构建、初始上下文、Session 独立性
- **[05-view-routing.md](./05-view-routing.md)** - 视图路由系统、匹配规则、视图数据模型
- **[06-file-system.md](./06-file-system.md)** - 文件系统管理、.mindfs/ 目录结构、文件元数据
- **[07-api-design.md](./07-api-design.md)** - REST API + WebSocket 协议 + 错误处理 + 错误码定义
- **[08-audit-log.md](./08-audit-log.md)** - 审计日志、操作类型
- **[09-skills.md](./09-skills.md)** - 技能系统、目录自定义 Skill

---

## 前端模块 (web/)

- **[10-ui-layout.md](./10-ui-layout.md)** - 界面布局、三栏结构、ActionBar、目录设置面板
- **[11-agent-interaction-ui.md](./11-agent-interaction-ui.md)** - Agent 交互浮框、流式输出渲染、权限对话框
- **[12-view-renderer.md](./12-view-renderer.md)** - 视图渲染系统、组件 Catalog、Registry、动态组件加载
- **[13-frontend-services.md](./13-frontend-services.md)** - 前端服务层、状态管理、WebSocket Hook
- **[19-input-candidates.md](./19-input-candidates.md)** - Slash / File Reference 候选集、统一补全框架
- **[20-upload-and-attachments.md](./20-upload-and-attachments.md)** - 目录上传、输入附件上传、图片附件展示

---

## 文档特点

- **与代码对应**：每个文档都标注了对应的代码目录
- **前后端分离**：后端 (02-09) 和前端 (10-13) 模块清晰分离
- **无通用部分**：数据模型、目录结构、错误码等已融入相关模块
- **便于查阅**：按功能模块组织，方便开发时快速定位

---

## 快速导航

### 我想了解...

- **整体架构** → 01-overview.md
- **Agent 如何通信** → 02-agent-process.md
- **Session 如何管理** → 03-session-management.md
- **上下文如何构建** → 04-context-building.md
- **视图如何路由** → 05-view-routing.md
- **文件如何组织** → 06-file-system.md
- **API 如何设计** → 07-api-design.md
- **日志如何记录** → 08-audit-log.md
- **技能如何调用** → 09-skills.md
- **界面如何布局** → 10-ui-layout.md
- **浮框如何交互** → 11-agent-interaction-ui.md
- **视图如何渲染** → 12-view-renderer.md
- **前端如何组织** → 13-frontend-services.md
- **输入候选如何组织** → 19-input-candidates.md
- **文件上传与附件如何组织** → 20-upload-and-attachments.md

---

## 原始文档

完整的原始文档：[../MindFS_Planning_V2.md](../MindFS_Planning_V2.md)
